// Listenr content script — extraction + synced highlighting.
// Runs on every page; idle until the service worker messages it.
(function () {
  if (window.__listenrLoaded) return;
  window.__listenrLoaded = true;

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','NAV','HEADER','FOOTER','ASIDE','FORM','BUTTON','SVG','CANVAS','SELECT','TEXTAREA','SUP']);

  // Containers whose text is navigational / non-prose — skip everything inside them.
  // IMPORTANT: keep these selectors specific. Broad [class*="..."] patterns risk
  // matching legitimate article content wrappers (e.g. "subscriber-content" on
  // paid news sites would match [class*="subscribe"] and hide the whole article).
  // Text-level noise (ads, "Also Read" links) is handled separately by NOISE_TEXT
  // and the link-density check inside extract() — not here.
  const SKIP_CONTAINER = [
    // HTML semantic landmarks — always non-article
    'nav', 'header', 'footer', 'aside', 'figure',
    // Wikipedia chrome
    '.navbox', '.infobox', '.sidebar', '.reflist', '.references',
    '.mw-editsection', '.hatnote', '.thumb', '.toc',
    '.mw-jump-link', '.metadata', '.navigation-not-searchable',
    // Ad slots — specific enough to not collide with article class names
    '[class*="ad-slot"]', '[class*="ad_slot"]',
    '[class*="advertisement"]', '[id*="advertisement"]',
    '[id*="dfp"]', '[class*="dfp-"]',
    // Social share bars
    '[class*="social-share"]', '[class*="share-bar"]', '[class*="sharebar"]',
    // Comment sections
    '[id="comments"]', '#disqus_thread', '.disqus-container',
  ].join(',');

  // Ordered list of CSS selectors for finding the article body, most reliable first.
  // We pick the first one that contains at least 3 <p> elements.
  const ARTICLE_ROOT_SELECTORS = [
    '[itemprop="articleBody"]',   // schema.org — used by most major news sites
    'article',
    '[role="article"]',
    // Common CMS / news site class names
    '.artText',                   // Economic Times, Times of India (classic theme)
    '.article-section__body__news', // ETBrandEquity, ETCIO, etc. (Times Internet "article-section" theme)
    '.article-body','.article__body','.articleBody','.article-content',
    '.story-body','.story-content','.story__body','.story__content',
    '.post-content','.post-body','.entry-content','.entry-body',
    '.content-body','.body-content','.main-content',
    '#article-body','#story-body','#article-content','#main-content',
    'main','[role="main"]',
    '#mw-content-text',           // Wikipedia
  ];

  let els = [];          // DOM element per block
  let texts = [];        // normalized text per block (matches what TTS receives)
  let curBlock = -1;
  let savedHTML = null;  // original innerHTML of the block being word-split
  let wordSpans = [];    // {start, end, el} for current block

  // ---- highlight styles ----
  function injectStyle() {
    if (document.getElementById('__listenr_style')) return;
    const s = document.createElement('style');
    s.id = '__listenr_style';
    s.textContent = `
      .__lr-block{background:rgba(19,176,184,.14)!important;box-shadow:0 0 0 2px rgba(19,176,184,.30)!important;border-radius:4px!important;transition:background .15s;}
      .__lr-word{background:#ffd84d!important;color:#1a1a1a!important;border-radius:3px!important;box-shadow:0 0 0 2px #ffd84d!important;}
    `;
    document.documentElement.appendChild(s);
  }

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  // Walk up from each <p> tag and score ancestor elements by how much paragraph
  // text they contain vs their total HTML size. The most text-dense container
  // that isn't a skip zone is likely the article body.
  // Used as a last resort when none of ARTICLE_ROOT_SELECTORS matches.
  function findDensestRoot() {
    const goodPs = [...document.querySelectorAll('p')].filter(p =>
      !p.closest(SKIP_CONTAINER) && (p.innerText || '').trim().length > 40
    );
    if (goodPs.length < 3) return null;

    const scores = new Map();
    goodPs.forEach(p => {
      let el = p.parentElement;
      let depth = 0;
      // Walk up max 10 levels — avoids scoring the whole <body>
      while (el && el !== document.body && depth < 10) {
        scores.set(el, (scores.get(el) || 0) + (p.innerText || '').trim().length);
        el = el.parentElement;
        depth++;
      }
    });

    let best = null, bestScore = 0;
    scores.forEach((textLen, el) => {
      if (el.closest(SKIP_CONTAINER)) return;
      // Ratio of good paragraph text to element HTML size — higher = more article-like
      const score = textLen / Math.max(el.innerHTML.length, 1);
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return best;
  }

  // Find the most likely article body element on the page.
  function findRoot() {
    for (const sel of ARTICLE_ROOT_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        // Normally require at least 3 real <p> elements to count as an article
        // body. Some sites (e.g. the Economic Times network) render the whole
        // article as flat text with no <p> tags at all, so also accept a match
        // that simply contains a lot of text — these selectors are specific
        // enough (schema.org markup, <article>, or named CMS classes) that a
        // large amount of text under them is a reliable signal on its own.
        if (el.querySelectorAll('p').length >= 3 || (el.innerText || '').trim().length > 500) return el;
      } catch (e) {}
    }
    return findDensestRoot() || document.body;
  }

  // Patterns that indicate a paragraph is noise, not article content.
  // Matches things like "Also Read: ...", "Follow us on", "Subscribe now", etc.
  const NOISE_TEXT = /^(also read|read also|read more|also see|also watch|follow us|subscribe|sign in|log in|advertisement|sponsored|promoted|tags:|share this|related:|you may also|don't miss)/i;

  // Some sites (e.g. the Economic Times network) inject "Read more at: <url>"
  // into every paragraph's DOM text as an anti-scraping measure. It's not real
  // content, so strip it out before we read/highlight anything.
  const READ_MORE_INLINE = /\s*read more at:?\s*https?:\/\/\S+/gi;

  // Block-level tags that mark the boundary of a run of "flat" inline content.
  // We stop a run here and leave these children exactly as they are — <ul>/<ol>
  // already get walked for their <li> items by the normal extract() pass below.
  const FLAT_RUN_BOUNDARY = new Set(['UL','OL','BLOCKQUOTE','FIGURE','TABLE','H1','H2','H3','H4','H5','H6','P','DIV']);

  // Some sites (e.g. the Economic Times network) don't wrap article paragraphs
  // in real <p> tags at all — the whole article is one flat <div> full of text,
  // links and <strong> tags, with paragraph breaks marked only by two <br> in a
  // row. Our normal node walk below only recognizes actual <p>/<li>/heading
  // elements, so on a page like that it silently drops almost the entire
  // article. This detects that pattern and wraps each <br><br>-separated run of
  // inline content in a real <span>, so it becomes a normal block that reading,
  // highlighting, and click-to-read all already know how to handle.
  function expandFlatTextRuns(root) {
    if (root.dataset.__lrExpanded) return; // already processed this root once
    root.dataset.__lrExpanded = '1';

    const structured = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dd,dt');
    const structuredLen = [...structured].reduce((n, el) => n + (el.innerText || '').length, 0);
    const totalLen = (root.innerText || '').length;
    // If the existing structured elements already cover most of the root's
    // text, there's no flat text to rescue — leave the DOM untouched.
    if (totalLen === 0 || structuredLen / totalLen > 0.6) return;

    let run = [];
    function flushRun() {
      if (!run.length) return;
      const text = run.map(n => n.textContent || '').join('').trim();
      if (text.length > 20) {
        const span = document.createElement('span');
        span.className = '__lr-flatpara';
        run[0].before(span);
        run.forEach(n => span.appendChild(n));
      } else {
        run.forEach(n => n.remove());
      }
      run = [];
    }

    // Snapshot childNodes first since we move nodes into new spans as we go.
    [...root.childNodes].forEach((node) => {
      // Sites like this one litter the article with ad-slot markers such as
      // <!-- PROMOSLOT -->. Comment.textContent returns that literal text, so
      // if we left these in a run they'd get read aloud as "PROMOSLOT".
      if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return; }
      if (node.nodeType === Node.ELEMENT_NODE && FLAT_RUN_BOUNDARY.has(node.tagName)) {
        flushRun();
        return; // leave this block-level child exactly where it is
      }
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
        const prev = run[run.length - 1];
        // Two <br> back to back is this site's paragraph break, not a real line break.
        if (prev && prev.nodeType === Node.ELEMENT_NODE && prev.tagName === 'BR') {
          run.pop();
          prev.remove();
          flushRun();
          node.remove();
          return;
        }
      }
      run.push(node);
    });
    flushRun();
  }

  function extract() {
    els = []; texts = [];
    const seen = new Set();
    const root = findRoot();
    expandFlatTextRuns(root);

    const nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dd,dt,.__lr-flatpara');
    nodes.forEach((el) => {
      if (SKIP.has(el.tagName)) return;
      if (el.closest(SKIP_CONTAINER)) return;
      // skip elements whose text is mostly inside a nested block we already take
      if (el.querySelector('p,li,h1,h2,h3,h4,h5,h6,blockquote')) return;
      if (!visible(el)) return;

      // strip wiki reference superscripts like [1][2] and "Read more at:" boilerplate
      let t = norm((el.innerText || '').replace(/\[\d+\]/g, '').replace(READ_MORE_INLINE, ''));

      // Raise the minimum length to filter out labels, category names, etc.
      if (t.length < 20) return;
      if (/^\[\d+\]$/.test(t)) return;
      if (NOISE_TEXT.test(t)) return;

      // Skip paragraphs that are mostly hyperlinks — they're navigation/related links.
      // Ignore anchors whose visible text is itself a raw URL: real editorial links
      // use descriptive anchor text, so a raw URL is always boilerplate (e.g. the
      // "Read more at:" link above) and shouldn't count against real content.
      const linkChars = [...el.querySelectorAll('a')].reduce((n, a) => {
        const at = (a.innerText || '').trim();
        if (/^https?:\/\//i.test(at)) return n;
        return n + at.length;
      }, 0);
      if (linkChars / Math.max(t.length, 1) > 0.6) return;

      if (seen.has(t)) return;
      seen.add(t);
      els.push(el);
      texts.push(t);
    });

    if (texts.length < 2) {
      const raw = norm(root.innerText).split(/(?<=[.!?])\s+/).filter(s => s.length > 30);
      // fall back to whole-body sentences with no element refs
      els = []; texts = raw;
    }
    return texts;
  }

  function restoreBlock() {
    if (curBlock >= 0 && els[curBlock] && savedHTML !== null) {
      els[curBlock].classList.remove('__lr-block');
      els[curBlock].innerHTML = savedHTML;
    } else if (curBlock >= 0 && els[curBlock]) {
      els[curBlock].classList.remove('__lr-block');
    }
    savedHTML = null;
    wordSpans = [];
  }

  function clearAll() {
    restoreBlock();
    curBlock = -1;
  }

  // Split block into per-word spans aligned to the normalized text, so
  // boundary charIndex values line up with what TTS is speaking.
  function prepareWords(el, text) {
    savedHTML = el.innerHTML;
    const frag = document.createDocumentFragment();
    wordSpans = [];
    const re = /\S+/g;
    let m, last = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      span.textContent = m[0];
      frag.appendChild(span);
      wordSpans.push({ start: m.index, end: m.index + m[0].length, el: span });
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    el.innerHTML = '';
    el.appendChild(frag);
  }

  function highlightBlock(index) {
    injectStyle();
    restoreBlock();
    curBlock = index;
    const el = els[index];
    if (!el) return;
    el.classList.add('__lr-block');
    prepareWords(el, texts[index] || norm(el.innerText));
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 60) {
      window.scrollTo({ top: window.scrollY + r.top - innerHeight * 0.35, behavior: 'smooth' });
    }
  }

  let lastWordEl = null;
  function highlightWord(index, charIndex) {
    if (index !== curBlock) return;
    if (lastWordEl) lastWordEl.classList.remove('__lr-word');
    let hit = null;
    for (const w of wordSpans) {
      if (charIndex >= w.start && charIndex < w.end) { hit = w; break; }
      if (charIndex < w.start) { hit = w; break; }
    }
    if (hit) { hit.el.classList.add('__lr-word'); lastWordEl = hit.el; }
  }

  // Safe wrapper: after an extension reload the runtime connection is lost.
  // chrome.runtime.id becomes undefined, and sendMessage throws "Extension context invalidated".
  // Checking id first (and catching just in case) keeps the page error-free.
  function safeSend(msg) {
    try {
      if (!chrome.runtime?.id) return; // context invalidated — bail silently
      chrome.runtime.sendMessage(msg);
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.cmd) {
      case 'extract':   sendResponse({ blocks: extract() }); break;
      case 'hlBlock':   highlightBlock(msg.index); break;
      case 'hlWord':    highlightWord(msg.index, msg.charIndex); break;
      case 'clear':     clearAll(); break;
      case 'ping':      sendResponse({ ok: true }); break;
    }
    return true;
  });

  // ---- click-to-read: jump to the word the user clicks ----
  function blockIndexOf(node) {
    for (let i = 0; i < els.length; i++) {
      if (els[i] && (els[i] === node || els[i].contains(node))) return i;
    }
    return -1;
  }
  function charOffsetAt(blockEl, x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    }
    if (!range) return 0;
    const pre = document.createRange();
    try { pre.setStart(blockEl, 0); pre.setEnd(range.startContainer, range.startOffset); }
    catch (e) { return 0; }
    return norm(pre.toString()).length;
  }
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest('a,button,input,textarea,select,label,[role="button"],[contenteditable]')) return;
    const idx = blockIndexOf(e.target);
    if (idx < 0) return;
    let sc = charOffsetAt(els[idx], e.clientX, e.clientY);
    const t = texts[idx] || '';
    while (sc > 0 && /\S/.test(t[sc - 1])) sc--;   // snap to start of clicked word
    safeSend({ cmd: 'jumpTo', index: idx, startChar: sc });
  }, true);
})();

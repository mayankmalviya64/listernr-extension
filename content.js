// Listenr content script — extraction + synced highlighting.
// Runs on every page; idle until the service worker messages it.
(function () {
  if (window.__listenrLoaded) return;
  window.__listenrLoaded = true;

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','NAV','HEADER','FOOTER','ASIDE','FORM','BUTTON','SVG','CANVAS','SELECT','TEXTAREA','SUP']);
  // Containers whose text is navigational / non-prose — skip anything inside them.
  const SKIP_CONTAINER = 'nav,header,footer,aside,.navbox,.infobox,.sidebar,.reflist,.references,.mw-editsection,.hatnote,.thumb,.toc,.mw-jump-link,.metadata,.navigation-not-searchable,figure';

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

  function extract() {
    els = []; texts = [];
    const seen = new Set();
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('#mw-content-text') ||
      document.body;
    const nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dd,dt');
    nodes.forEach((el) => {
      if (SKIP.has(el.tagName)) return;
      if (el.closest(SKIP_CONTAINER)) return;
      // skip elements whose text is mostly inside a nested block we already take
      if (el.querySelector('p,li,h1,h2,h3,h4,h5,h6,blockquote')) return;
      if (!visible(el)) return;
      // strip wiki reference superscripts like [1][2] before normalizing
      let t = norm((el.innerText || '').replace(/\[\d+\]/g, ''));
      if (t.length < 2) return;
      if (/^\[\d+\]$/.test(t)) return;
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
    chrome.runtime.sendMessage({ cmd: 'jumpTo', index: idx, startChar: sc });
  }, true);
})();

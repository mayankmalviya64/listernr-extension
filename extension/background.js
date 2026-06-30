// Listenr service worker — coordinates popup, content script (highlighting),
// and the offscreen document (speech). Holds playback state.

let S = {
  tabId: null,
  blocks: [],
  current: 0,
  playing: false,
  rate: 2,
  voiceURI: '',
  voices: [],
  startChar: 0,       // char offset to begin the current block at (click-to-read)
  lastCharIndex: 0,   // most recent word-boundary char offset within the current speech segment
  error: null,        // null | 'protected' | 'notext'
  status: 'idle'      // idle | playing | paused | finished
};

// ---------- offscreen lifecycle ----------
let creating = null;
async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  } catch (e) {}
  if (creating) { await creating; return; }
  try {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Text-to-speech playback for reading pages aloud.'
    });
    await creating;
  } catch (e) {
    // Already exists (race) — fine.
  } finally {
    creating = null;
  }
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
}

// ---------- content script messaging ----------
function toContent(msg) {
  if (S.tabId == null) return;
  chrome.tabs.sendMessage(S.tabId, msg).catch(() => {});
}

// ---------- state broadcast ----------
function broadcast() {
  chrome.runtime.sendMessage({ from: 'sw', type: 'state', state: publicState() }).catch(() => {});
}
function publicState() {
  return {
    total: S.blocks.length, current: S.current, playing: S.playing,
    rate: S.rate, error: S.error, status: S.status
  };
}

// ---------- core playback ----------
function isProtected(url) {
  return !url || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/.test(url) ||
    /^https:\/\/chromewebstore\.google\.com/.test(url);
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;
  S.tabId = tab.id;
  if (isProtected(tab.url)) { S.error = 'protected'; return false; }
  S.error = null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'extract' });
    S.blocks = (res && res.blocks) || [];
  } catch (e) {
    // content script not present (e.g. injected before load) — try inject
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'extract' });
      S.blocks = (res && res.blocks) || [];
    } catch (e2) { S.error = 'protected'; return false; }
  }
  if (!S.blocks.length) { S.error = 'notext'; return false; }
  return true;
}

async function speakCurrent() {
  if (S.current < 0) S.current = 0;
  if (S.current >= S.blocks.length) {
    S.playing = false; S.status = 'finished';
    toContent({ cmd: 'clear' });
    broadcast();
    return;
  }
  S.playing = true; S.status = 'playing';
  toContent({ cmd: 'hlBlock', index: S.current });
  const text = S.blocks[S.current].slice(S.startChar || 0);
  await toOffscreen({ cmd: 'speak', text, voiceURI: S.voiceURI, rate: S.rate });
  broadcast();
}

async function play() {
  if (!S.blocks.length || S.error) {
    const ok = await loadTab();
    if (!ok) { broadcast(); return; }
  }
  await speakCurrent();
}

async function pause() {
  S.playing = false; S.status = 'paused';
  await toOffscreen({ cmd: 'stop' });
  broadcast();
}

async function toggle() {
  if (S.playing) return pause();
  return play();
}

async function next() {
  if (!S.blocks.length) { await loadTab(); }
  S.current = Math.min(S.blocks.length - 1, S.current + 1);
  S.startChar = 0; S.lastCharIndex = 0;
  if (S.playing) await speakCurrent();
  else { toContent({ cmd: 'hlBlock', index: S.current }); broadcast(); }
}

async function prev() {
  if (!S.blocks.length) { await loadTab(); }
  S.current = Math.max(0, S.current - 1);
  S.startChar = 0; S.lastCharIndex = 0;
  if (S.playing) await speakCurrent();
  else { toContent({ cmd: 'hlBlock', index: S.current }); broadcast(); }
}

function clampRate(r) { return Math.min(4, Math.max(1, Math.round(r * 10) / 10)); }

// Restart speech from the char position we last heard — used when rate changes mid-playback.
function resumeFromCurrentChar() {
  S.startChar = (S.startChar || 0) + S.lastCharIndex;
  S.lastCharIndex = 0;
}

async function changeRate(delta) {
  S.rate = clampRate(S.rate + delta);
  chrome.storage.local.set({ rate: S.rate });
  if (S.playing) {
    // Keyboard shortcut — apply immediately, resume from current word
    resumeFromCurrentChar();
    await speakCurrent();
  } else broadcast();
}

// Timer for debouncing slider rate changes while dragging
let rateRestartTimer = null;

async function jumpTo(index, startChar) {
  if (!S.blocks.length || S.status === 'idle') return; // only after a session has started
  S.current = Math.max(0, Math.min(S.blocks.length - 1, index));
  S.startChar = Math.max(0, startChar || 0);
  S.lastCharIndex = 0;
  await speakCurrent();
}

// ---------- message routing ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // From offscreen (speech events)
  if (msg.from === 'offscreen') {
    if (msg.type === 'voices') {
      if (msg.voices && msg.voices.length) {
        S.voices = msg.voices;
        // On macOS, lock to Samantha — no voice choice for the user
        chrome.runtime.getPlatformInfo().then(info => {
          if (info.os === 'mac') {
            const sam = msg.voices.find(v => v.name === 'Samantha');
            if (sam) S.voiceURI = sam.voiceURI;
          }
          broadcast();
        });
      }
    } else if (msg.type === 'boundary') {
      S.lastCharIndex = msg.charIndex;  // keep track of where TTS currently is
      toContent({ cmd: 'hlWord', index: S.current, charIndex: msg.charIndex + (S.startChar || 0) });
    } else if (msg.type === 'end') {
      if (S.playing) { S.current++; S.startChar = 0; S.lastCharIndex = 0; speakCurrent(); }
    } else if (msg.type === 'error') {
      S.playing = false; S.status = 'paused'; broadcast();
    }
    return;
  }

  // From popup
  switch (msg.cmd) {
    case 'init':
      (async () => {
        await ensureOffscreen();
        toOffscreen({ cmd: 'getVoices' });
        const st = await chrome.storage.local.get(['rate']);
        if (st.rate) S.rate = Number(st.rate);
        // If we're already reading the active tab, just resume the live state.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const sameTab = tab && tab.id === S.tabId;
        if (!(S.playing && sameTab)) {
          S.current = 0; S.status = 'idle';
          await loadTab();
        }
        sendResponse({ state: publicState() });
        broadcast();
      })();
      return true;
    case 'getState': sendResponse({ state: publicState() }); return true;
    case 'toggle': toggle(); break;
    case 'play': play(); break;
    case 'pause': pause(); break;
    case 'next': next(); break;
    case 'prev': prev(); break;
    case 'jumpTo': jumpTo(msg.index, msg.startChar); break;
    case 'rateDown': changeRate(-0.1); break;
    case 'rateUp':   changeRate(0.1);  break;
    case 'setRate':
      S.rate = Number(msg.rate);
      chrome.storage.local.set({ rate: S.rate });
      if (S.playing) {
        // Slider may fire many events while dragging — snapshot position now and
        // only restart once the user stops moving the slider (200ms of silence).
        const resumeAt = (S.startChar || 0) + S.lastCharIndex;
        clearTimeout(rateRestartTimer);
        rateRestartTimer = setTimeout(() => {
          if (!S.playing) { broadcast(); return; }
          S.startChar = resumeAt;
          S.lastCharIndex = 0;
          speakCurrent();
        }, 200);
        broadcast(); // update rate display in popup immediately
      } else broadcast();
      break;
  }
});

// ---------- keyboard shortcuts ----------
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-play') toggle();
  else if (command === 'rate-up') changeRate(0.1);
  else if (command === 'rate-down') changeRate(-0.1);
});

// Stop & clear highlight when the user navigates or switches tabs.
chrome.tabs.onActivated.addListener(() => {
  if (S.playing) pause();
  toContent({ cmd: 'clear' });
  S.blocks = []; S.current = 0; S.error = null;
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === S.tabId && info.status === 'loading') {
    S.blocks = []; S.current = 0; S.error = null;
    if (S.playing) pause();
  }
});

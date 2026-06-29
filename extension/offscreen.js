// Listenr offscreen document — owns the Web Speech API (speechSynthesis).
// Exposes all system voices (Microsoft + Google) and word-boundary events,
// and keeps speaking even when the popup is closed.

const synth = window.speechSynthesis;
let current = null;
let keepAlive = null;
let estTimer = null;

function send(msg) {
  chrome.runtime.sendMessage(Object.assign({ from: 'offscreen' }, msg));
}

function listVoices() {
  const vs = synth.getVoices().map(v => ({
    name: v.name, lang: v.lang, voiceURI: v.voiceURI,
    localService: v.localService, default: v.default
  }));
  send({ type: 'voices', voices: vs });
}

// Voices load asynchronously in Chrome.
synth.onvoiceschanged = listVoices;

function speak(text, voiceURI, rate) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = Math.min(4, Math.max(0.5, Number(rate) || 1));
  if (voiceURI) {
    const v = synth.getVoices().find(x => x.voiceURI === voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
  }
  u.onboundary = (e) => {
    if (u !== current) return;
    if (e.name === 'word' || e.name === undefined) {
      stopEstimator(); // real boundaries available — drop the estimate
      send({ type: 'boundary', charIndex: e.charIndex });
    }
  };
  u.onend = () => {
    if (u !== current) return;
    stopKeepAlive(); stopEstimator(); send({ type: 'end' });
  };
  u.onerror = (e) => {
    if (u !== current) return;
    stopKeepAlive(); stopEstimator();
    // 'interrupted'/'canceled' happen on our own cancel() — not real errors
    if (e.error && e.error !== 'interrupted' && e.error !== 'canceled') {
      send({ type: 'error', error: e.error });
    }
  };
  current = u;          // claim ownership BEFORE cancelling old utterances
  synth.cancel();       // stale utterance's onend now fails the (u !== current) guard
  synth.speak(u);
  startKeepAlive();
  // Online voices (Google) don't fire word-boundary events — estimate them by timing.
  const isLocal = u.voice ? u.voice.localService : false;
  if (!isLocal) startEstimator(u, text, u.rate);
}

// Chrome stops long utterances after ~15s; pause/resume keeps it alive.
function startKeepAlive() {
  stopKeepAlive();
  keepAlive = setInterval(() => {
    if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
  }, 9000);
}
function stopKeepAlive() { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } }

// Approximate word-highlighting for voices that don't emit boundary events.
function startEstimator(u, text, rate) {
  stopEstimator();
  const words = [];
  const re = /\S+/g; let m;
  while ((m = re.exec(text)) !== null) words.push({ start: m.index, end: re.lastIndex });
  if (!words.length) return;
  const cps = 15 * (rate || 1);   // rough chars-per-second for English TTS
  const t0 = performance.now();
  let lastIdx = -1;
  estTimer = setInterval(() => {
    if (u !== current) { stopEstimator(); return; }
    if (synth.paused) return;
    const chars = ((performance.now() - t0) / 1000) * cps;
    let idx = words.findIndex(w => chars < w.end);
    if (idx < 0) idx = words.length - 1;
    if (idx !== lastIdx) { lastIdx = idx; send({ type: 'boundary', charIndex: words[idx].start }); }
  }, 90);
}
function stopEstimator() { if (estTimer) { clearInterval(estTimer); estTimer = null; } }

function stop() { stopKeepAlive(); stopEstimator(); synth.cancel(); current = null; }

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  switch (msg.cmd) {
    case 'speak': speak(msg.text, msg.voiceURI, msg.rate); break;
    case 'stop': stop(); break;
    case 'getVoices': listVoices(); break;
  }
});

// Voices may already be available at load.
setTimeout(listVoices, 100);

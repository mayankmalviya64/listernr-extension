// Listenr popup — thin UI over the service worker.
const $ = (id) => document.getElementById(id);
let voicesRendered = false;

function send(msg) { return chrome.runtime.sendMessage(msg); }

function setStatus(text, color) {
  $('statusText').textContent = text;
  $('dot').style.background = color || '#9aabc4';
}
function setPlayIcon(p) {
  $('icoPlay').style.display = p ? 'none' : 'block';
  $('icoPause').style.display = p ? 'block' : 'none';
}
function updateRateLabel(rate) {
  $('rateLabel').textContent = rate + '×';
  const pct = ((rate - 1) / 3) * 100;
  $('rate').style.background = `linear-gradient(90deg,#13b0b8 0%,#0e7fb8 ${pct}%,#dbe6f3 ${pct}%,#dbe6f3 100%)`;
}
function showError(kind) {
  $('main').style.display = 'none';
  const err = $('err'); err.style.display = 'flex';
  if (kind === 'protected') {
    err.style.background = '#fdeef0'; err.style.border = '1.5px solid #f6d2d8';
    $('eicon').style.background = '#fbdce1'; $('eicon').style.color = '#d8453c';
    $('etitle').style.color = '#b23a36';
    $('etitle').textContent = "Listenr can’t read this page";
    $('emsg').textContent = 'Browser system pages (chrome://, extensions, web store) are protected and can’t be accessed.';
  } else {
    err.style.background = '#fff7ed'; err.style.border = '1.5px solid #fbe2c4';
    $('eicon').style.background = '#fcecd2'; $('eicon').style.color = '#d98b1f';
    $('etitle').style.color = '#a96612';
    $('etitle').textContent = 'No readable text found';
    $('emsg').textContent = 'This page doesn’t have article-style content for Listenr to read.';
  }
}

function renderVoices(voices, voiceURI) {
  const sel = $('voice');
  if (!voices || !voices.length) return;
  // Re-render only if list changed.
  if (voicesRendered && sel.options.length === voices.length + 1) { sel.value = voiceURI || ''; return; }
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'System default';
  sel.appendChild(def);
  // Group: local voices first, then network (Google) voices.
  voices.slice().sort((a, b) => (b.localService === a.localService ? 0 : b.localService ? 1 : -1))
    .forEach((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      const tag = v.localService ? '' : ' · online';
      o.textContent = `${v.name}${v.lang ? ' · ' + v.lang : ''}${tag}`;
      sel.appendChild(o);
    });
  sel.value = voiceURI || '';
  voicesRendered = true;
}

function render(s) {
  if (!s) return;
  if (s.error) { showError(s.error); return; }
  $('err').style.display = 'none';
  $('main').style.display = 'flex';

  renderVoices(s.voices, s.voiceURI);
  updateRateLabel(s.rate);
  if (document.activeElement !== $('rate')) $('rate').value = s.rate;
  setPlayIcon(s.playing);

  if (s.status === 'finished') setStatus('Finished reading the page', '#13b8b0');
  else if (s.status === 'playing') setStatus(`Reading block ${s.current + 1} of ${s.total}`, '#13b8b0');
  else if (s.status === 'paused') setStatus(`Paused at block ${s.current + 1} of ${s.total}`, '#e9a23b');
  else setStatus(s.total ? `Ready — ${s.total} blocks. Press Play.` : 'Loading page text…', '#9aabc4');
}

// Live updates from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.from === 'sw' && msg.type === 'state') render(msg.state);
});

// Controls.
$('toggle').addEventListener('click', () => send({ cmd: 'toggle' }));
$('next').addEventListener('click', () => send({ cmd: 'next' }));
$('prev').addEventListener('click', () => send({ cmd: 'prev' }));
$('rate').addEventListener('input', (e) => { updateRateLabel(Number(e.target.value)); send({ cmd: 'setRate', rate: Number(e.target.value) }); });
$('voice').addEventListener('change', (e) => send({ cmd: 'setVoice', voiceURI: e.target.value }));

// Boot.
send({ cmd: 'init' }).then((r) => { if (r && r.state) render(r.state); });
// Ask again shortly in case voices arrived late.
setTimeout(() => send({ cmd: 'getState' }).then((r) => r && r.state && render(r.state)), 500);

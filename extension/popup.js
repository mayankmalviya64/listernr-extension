// Listenr popup — thin UI over the service worker.
const $ = (id) => document.getElementById(id);

function send(msg) { return chrome.runtime.sendMessage(msg); }

function setStatus(text, color) {
  $('statusText').textContent = text;
  $('dot').style.background = color || '#9aabc4';
}

function setPlayIcon(playing) {
  $('icoPlay').style.display = playing ? 'none' : 'block';
  $('icoPause').style.display = playing ? 'block' : 'none';
}

// Format 2 → "2×", 1.75 → "1.75×", 2.1 → "2.1×"
function fmtRate(r) {
  return (Math.round(r * 100) / 100) + '×';
}

function updateRateDisplay(rate) {
  $('rateLabel').textContent = fmtRate(rate);
  // Sync the hidden preset picker to the nearest exact preset (if any)
  const picker = $('ratePicker');
  const match = [...picker.options].find(o => Math.abs(Number(o.value) - rate) < 0.001);
  if (match) picker.value = match.value;
  // Update slider fill gradient
  const pct = ((rate - 1) / 3) * 100;
  $('rate').style.background = `linear-gradient(90deg,#13b0b8 0%,#0e7fb8 ${pct}%,#dbe6f3 ${pct}%,#dbe6f3 100%)`;
  if (document.activeElement !== $('rate')) $('rate').value = rate;
}

function showError(kind) {
  $('main').style.display = 'none';
  const err = $('err'); err.style.display = 'flex';
  if (kind === 'protected') {
    err.style.background = '#fdeef0'; err.style.border = '1.5px solid #f6d2d8';
    $('eicon').style.background = '#fbdce1'; $('eicon').style.color = '#d8453c';
    $('etitle').style.color = '#b23a36';
    $('etitle').textContent = "Listenr can't read this page";
    $('emsg').textContent = "Browser system pages (chrome://, extensions, web store) are protected and can't be accessed.";
  } else {
    err.style.background = '#fff7ed'; err.style.border = '1.5px solid #fbe2c4';
    $('eicon').style.background = '#fcecd2'; $('eicon').style.color = '#d98b1f';
    $('etitle').style.color = '#a96612';
    $('etitle').textContent = 'No readable text found';
    $('emsg').textContent = "This page doesn't have article-style content for Listenr to read.";
  }
}

function render(s) {
  if (!s) return;
  if (s.error) { showError(s.error); return; }
  $('err').style.display = 'none';
  $('main').style.display = 'flex';
  updateRateDisplay(s.rate);
  setPlayIcon(s.playing);
  if (s.status === 'finished') setStatus('Finished reading the page', '#13b8b0');
  else if (s.status === 'playing') setStatus(`Reading block ${s.current + 1} of ${s.total}`, '#13b8b0');
  else if (s.status === 'paused') setStatus(`Paused at block ${s.current + 1} of ${s.total}`, '#e9a23b');
  else setStatus(s.total ? `Ready — ${s.total} blocks. Press Play.` : 'Loading page text…', '#9aabc4');
}

// Live state updates from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.from === 'sw' && msg.type === 'state') render(msg.state);
});

// Play / Pause
$('toggle').addEventListener('click', () => send({ cmd: 'toggle' }));

// Speed slider — fine-grained control
$('rate').addEventListener('input', (e) => {
  const r = Number(e.target.value);
  updateRateDisplay(r);
  send({ cmd: 'setRate', rate: r });
});

// Speed ± buttons (0.1× step each)
$('rateDown').addEventListener('click', () => send({ cmd: 'rateDown' }));
$('rateUp').addEventListener('click',   () => send({ cmd: 'rateUp' }));

// Speed pill → opens native OS preset picker via showPicker()
// Using a hidden <select> avoids custom-dropdown clipping inside the extension popup window.
$('rateLabel').addEventListener('click', () => {
  const picker = $('ratePicker');
  try { picker.showPicker(); } catch (_) {}
});

$('ratePicker').addEventListener('change', (e) => {
  const r = Number(e.target.value);
  send({ cmd: 'setRate', rate: r });
  updateRateDisplay(r);
});

// Boot — ask service worker for current state.
send({ cmd: 'init' }).then((r) => { if (r && r.state) render(r.state); });
// Check again shortly in case voices / blocks resolved after the first response.
setTimeout(() => send({ cmd: 'getState' }).then((r) => r && r.state && render(r.state)), 500);

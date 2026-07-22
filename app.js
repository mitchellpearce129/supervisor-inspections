// app.js — UI wiring, state, trace manager (spec §6).
import * as dsp from './dsp.js';
import * as audio from './audio.js';
import { Plot, TRACE_COLORS } from './plot.js';
import { traceToFrd, downloadText, downloadCanvasPng, safeName } from './export.js';
import * as cal from './cal.js';
import { passesTweeterGate } from './safety.js';
import { session } from './session.js';

// Register the service worker so REWMitch installs as a PWA and runs offline.
// Relative path → scope is the hosting directory (works under a GitHub Pages
// subpath). Harmless on localhost/Electron; silently skipped over file://.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
  });
}

const $ = (sel) => document.querySelector(sel);
const state = {
  ctx: null,
  micStream: null,
  stopMeter: null,
  mode: 'standard',
  view: 'mag',
  current: null,      // latest live result
  traces: [],         // held traces
  colorIdx: 0,
  offset: { useRef: true, refChannel: 'L', averages: 8, dataA: null, dataB: null },
  maxHarmonic: 5,
  cal: null, // parsed mic calibration, or null
};

// Correction fn for the current cal file (dB to subtract at a given Hz), or null.
function calFn() {
  return state.cal ? (f) => cal.calValueAt(state.cal, f) : null;
}

// PRIORITY 0 tweeter gate now lives in safety.js (shared with the wizard).
// This reads the manual UI's selector; the wizard drives the gate with its own
// per-driver types.
function currentDriverType() {
  const el = $('#driverType');
  return el ? el.value : 'full';
}

const plot = new Plot($('#plot'));

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#tab-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'traces') renderTraceList();
    if (b.dataset.tab === 'measure') plot.refresh(); // canvas was 0×0 while hidden — re-measure now

  });
});

// ---------- Modes ----------
const MODE_HINTS = {
  standard: 'Gated far-field response. Mic at the listening position. Valid above the gate floor.',
  nearfield: 'Mic close to the cone — dodges the room, no calibration needed. Good for bass / baffle-step / sub hand-off. Gate widened automatically.',
  offset: 'The jewel: with the timing reference on, each capture is self-referenced against a fixed reference speaker, so play/record latency jitter cancels. Measures the acoustic z-offset in mm with an honest ± error bar.',
  distortion: 'THD vs frequency (Farina harmonic separation). White = fundamental, coloured = each harmonic at its true level below it. Good for gross breakup, not subtle stuff — limited by the mic\'s own distortion floor.',
  waterfall: 'Cumulative spectral decay from the same IR — shows resonant ringing: "did the notch actually kill it?"',
};
document.querySelectorAll('#modeRow .mode').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#modeRow .mode').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.mode = b.dataset.mode;
    $('#modeHint').textContent = MODE_HINTS[state.mode];
    if (state.mode === 'nearfield') { $('#gatePost').value = 20; updateGateFloor(); }
    renderModePanel();
  });
});
$('#modeHint').textContent = MODE_HINTS.standard;

// ---------- View toggles ----------
document.querySelectorAll('.view-toggle button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.view-toggle button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.view = b.dataset.view;
    drawAll();
  });
});

// ---------- Settings ----------
['#gatePost'].forEach((s) => $(s).addEventListener('input', updateGateFloor));
function updateGateFloor() {
  const post = parseFloat($('#gatePost').value) || 5;
  $('#gateFloor').textContent = Math.round(dsp.gateFloorHz(post));
}
function settings() {
  return {
    f1: parseFloat($('#f1').value),
    f2: parseFloat($('#f2').value),
    duration: parseFloat($('#duration').value),
    level: parseFloat($('#level').value),
    gatePre: parseFloat($('#gatePre').value),
    gatePost: parseFloat($('#gatePost').value),
    smoothing: parseInt($('#smoothing').value, 10),
  };
}
updateGateFloor();

// ---------- Init audio ----------
if (!window.isSecureContext) {
  $('#secureWarn').textContent = '⚠ Not a secure context — mic access will be blocked. Serve over HTTPS or http://localhost.';
}
$('#btnInit').addEventListener('click', async () => {
  try {
    $('#status').textContent = 'Requesting mic…';
    state.ctx = await audio.createAudioContext();
    state.micStream = await audio.getMicStream();
    session.ctx = state.ctx; session.micStream = state.micStream; // publish for the wizard
    $('#sampleRate').textContent = state.ctx.sampleRate;
    const info = audio.describeMicTrack(state.micStream);
    const flags = `AGC:${info.autoGainControl} · NS:${info.noiseSuppression} · EC:${info.echoCancellation}`;
    $('#micInfo').textContent = `${info.label || 'mic'}\n${flags}  (want all false — verify with the repeatability check)`;
    $('#status').textContent = `Ready · ${state.ctx.sampleRate} Hz.`;
    $('#btnPlay').disabled = false;
    $('#btnSanity').disabled = false;
    $('#btnInit').disabled = true;
    startMeter();
    renderModePanel();
    await populateInputs();
  } catch (e) {
    $('#status').textContent = 'Mic init failed: ' + e.message;
  }
});

async function populateInputs() {
  try {
    const inputs = await audio.listInputs();
    const sel = $('#inputDevice');
    const current = state.micStream.getAudioTracks()[0];
    const curId = current && current.getSettings ? current.getSettings().deviceId : null;
    sel.innerHTML = '';
    inputs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Input ${i + 1}`;
      if (d.deviceId === curId) o.selected = true;
      sel.appendChild(o);
    });
  } catch (_) { /* enumeration can fail on some browsers — leave default */ }
}

$('#inputDevice').addEventListener('change', async () => {
  const id = $('#inputDevice').value;
  try {
    if (state.stopMeter) state.stopMeter();
    if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = await audio.getMicStream(id);
    session.micStream = state.micStream; // keep the wizard's session in sync
    const info = audio.describeMicTrack(state.micStream);
    $('#micInfo').textContent = `${info.label || 'mic'}  (AGC:${info.autoGainControl} · NS:${info.noiseSuppression} · EC:${info.echoCancellation})`;
    startMeter();
  } catch (e) {
    $('#status').textContent = 'Device switch failed: ' + e.message;
  }
});

// ---------- Mic calibration file ----------
$('#calFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.cal = cal.parseCalFile(await file.text());
    session.cal = state.cal; // share the calibration with the wizard
    const sens = state.cal.sensFactor != null ? ` · Sens ${state.cal.sensFactor} dB` : '';
    $('#calStatus').textContent = `✓ ${file.name} · ${state.cal.points} points${sens}. Magnitude is now mic-corrected.`;
    $('#calStatus').classList.add('captured');
  } catch (err) {
    state.cal = null;
    $('#calStatus').textContent = `Could not read that file: ${err.message}`;
    $('#calStatus').classList.remove('captured');
  }
});
$('#calClear').addEventListener('click', () => {
  state.cal = null;
  session.cal = null;
  $('#calFile').value = '';
  $('#calStatus').textContent = 'No calibration loaded — measurements are relative (uncalibrated mic).';
  $('#calStatus').classList.remove('captured');
});

function startMeter() {
  if (state.stopMeter) state.stopMeter();
  state.stopMeter = audio.startLevelMeter(state.ctx, state.micStream, ({ peak }) => {
    $('#meterBar').style.width = Math.min(100, peak * 100) + '%';
    let txt = (20 * Math.log10(peak + 1e-6)).toFixed(0) + ' dB';
    if (peak > 0.98) txt = 'CLIP';
    else if (peak < 0.002) txt = 'silent';
    $('#meterText').textContent = txt;
  });
}

// ---------- Core measurement ----------
// Low-level: play the sweep and return the raw recording (+ the sweep/settings).
// Both the linear pipeline and the distortion pipeline build on this.
async function capture(label = 'Measuring…') {
  const s = settings();
  $('#measureStatus').textContent = label;
  const sr = state.ctx.sampleRate;
  const sweep = dsp.generateESS(s.f1, s.f2, s.duration, sr);
  const rec = await audio.playAndRecord(state.ctx, state.micStream, sweep, {
    tailSec: 1, level: s.level,
  });
  return { rec, sweep, sr, s };
}

// Linear measurement (FR / phase / group delay). Plays the sweep wrapped in a
// timing FRAME (start + end markers) and resamples the recording to undo any
// play/record clock drift before deconvolving against the BARE sweep. No-op when
// clocks are shared. (capture() above stays bare — distortion needs the raw sweep.)
function driftNote(comp) {
  if (comp.applied) return `· clock drift corrected ${comp.ppm >= 0 ? '+' : ''}${comp.ppm.toFixed(1)} ppm`;
  if (comp.reason && comp.reason.includes('deadband')) return '· clocks in sync';
  if (comp.reason && (comp.reason.includes('not found') || comp.reason.includes('implausible'))) return '· ⚠ drift not verified';
  return '';
}
async function measure(label = 'Measuring…') {
  const s = settings();
  $('#measureStatus').textContent = label;
  const sr = state.ctx.sampleRate;
  const sweep = dsp.generateESS(s.f1, s.f2, s.duration, sr);
  const frame = dsp.buildTimingFrame(sweep, sr);
  const rec = await audio.playAndRecord(state.ctx, state.micStream, frame.signal, { tailSec: 0.15, level: s.level });
  const comp = dsp.compensateDrift(rec, frame.expectedGap, dsp.estimateDrift(rec, frame.marker, sr));
  const ir = dsp.deconvolve(comp.recording, sweep);
  const peakIdx = dsp.findPeak(ir);
  const gated = dsp.gateIR(ir, peakIdx, sr, s.gatePre, s.gatePost);
  const spec = dsp.spectrum(gated, sr);
  let mag = spec.mag;
  if (state.cal) mag = cal.correctMagnitude(spec.freq, mag, state.cal); // mic-correct first
  if (s.smoothing > 0) mag = dsp.fractionalOctaveSmooth(spec.freq, mag, s.smoothing);
  mag = dsp.normaliseToBand(spec.freq, mag);
  const gd = dsp.groupDelayMs(spec.freq, spec.phase);
  $('#measureStatus').textContent = `Done · peak at ${(peakIdx / sr * 1000).toFixed(1)} ms · valid > ${Math.round(dsp.gateFloorHz(s.gatePost))} Hz ${driftNote(comp)}`;
  return { ir, peakIdx, freq: spec.freq, mag, phase: spec.phase, gd, sr };
}

$('#btnPlay').addEventListener('click', async () => {
  if (!(await passesTweeterGate(currentDriverType()))) return; // P0 safety gate — no audio unless confirmed
  $('#btnPlay').disabled = true;
  try {
    if (state.mode === 'distortion') {
      const cap = await capture('Playing sweep + recording…');
      const dist = dsp.harmonicDistortion(
        cap.rec, cap.sweep, cap.s.f1, cap.s.f2, cap.s.duration, cap.sr,
        { maxHarmonic: state.maxHarmonic, preMs: cap.s.gatePre, postMs: cap.s.gatePost, calFn: calFn() },
      );
      drawDistortion(dist);
      return;
    }
    const res = await measure('Playing sweep + recording…');
    if (state.mode === 'waterfall') { drawWaterfall(res); }
    else {
      state.current = { ...res, name: '(live)', color: '#ffffff', visible: true };
      $('#btnHold').disabled = false;
      drawAll();
    }
  } catch (e) {
    $('#measureStatus').textContent = 'Error: ' + e.message;
  } finally {
    $('#btnPlay').disabled = false;
  }
});

// ---------- Repeatability sanity check (spec §3 / milestone 1) ----------
$('#btnSanity').addEventListener('click', async () => {
  if (!(await passesTweeterGate(currentDriverType()))) return; // P0 safety gate
  $('#btnSanity').disabled = true;
  try {
    const a = await measure('Repeatability 1/2…');
    const b = await measure('Repeatability 2/2…');
    // Max deviation over the valid band.
    const floor = dsp.gateFloorHz(settings().gatePost);
    let maxDev = 0;
    for (let i = 0; i < a.freq.length; i++) {
      if (a.freq[i] < floor || a.freq[i] > 15000) continue;
      const d = Math.abs(a.mag[i] - b.mag[i]);
      if (d > maxDev) maxDev = d;
    }
    const verdict = maxDev < 1.0
      ? '✅ traces overlay — input looks clean.'
      : maxDev < 2.5
        ? '⚠ some drift — check level / room noise.'
        : '❌ big drift — the browser is likely still processing the input (AGC/NS/EC). Numbers not trustworthy.';
    $('#measureStatus').textContent = `Repeatability: max Δ ${maxDev.toFixed(2)} dB over the valid band. ${verdict}`;
    // Show both as overlay for eyeballing.
    state.traces = [
      { ...a, name: 'repeat-1', color: TRACE_COLORS[0], visible: true },
      { ...b, name: 'repeat-2', color: TRACE_COLORS[1], visible: true },
    ];
    state.current = null;
    drawAll();
  } catch (e) {
    $('#measureStatus').textContent = 'Error: ' + e.message;
  } finally {
    $('#btnSanity').disabled = false;
  }
});

// ---------- Hold / overlay ----------
$('#btnHold').addEventListener('click', () => {
  if (!state.current) return;
  const name = safeName($('#traceName').value || `trace-${state.traces.length + 1}`);
  const color = TRACE_COLORS[state.colorIdx++ % TRACE_COLORS.length];
  state.traces.push({ ...state.current, name, color, visible: true });
  $('#traceName').value = '';
  drawAll();
  renderTraceList();
});

// ---------- Drawing ----------
function phaseDeg(rad) {
  const out = new Float32Array(rad.length);
  for (let i = 0; i < rad.length; i++) {
    let d = (rad[i] * 180) / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    out[i] = d;
  }
  return out;
}

function drawAll() {
  const list = [...state.traces];
  if (state.current) list.push(state.current);
  const traces = list.map((t) => {
    let values;
    if (state.view === 'mag') values = t.mag;
    else if (state.view === 'phase') values = phaseDeg(t.phase);
    else values = t.gd;
    return { freq: t.freq, values, color: t.color, name: t.name, visible: t.visible };
  });

  if (state.view === 'mag') plot.setYRange(-30, 15, 'dB (relative)');
  else if (state.view === 'phase') plot.setYRange(-180, 180, 'phase (deg)');
  else {
    // auto y for group delay
    let lo = Infinity, hi = -Infinity;
    for (const t of list) for (let i = 0; i < t.freq.length; i++) {
      if (t.freq[i] < 100 || t.freq[i] > 15000) continue;
      if (t.gd[i] < lo) lo = t.gd[i]; if (t.gd[i] > hi) hi = t.gd[i];
    }
    if (!isFinite(lo)) { lo = -2; hi = 10; }
    const pad = (hi - lo) * 0.1 + 0.5;
    plot.setYRange(lo - pad, hi + pad, 'group delay (ms)');
  }
  plot.draw(traces);
}

function drawDistortion(d) {
  const traces = [];
  const shift = (arr) => {
    const v = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) v[i] = arr[i] - d.ref;
    return v;
  };
  traces.push({ freq: d.freq, values: shift(d.fundamentalDb), color: '#ffffff', name: 'fundamental', visible: true });
  d.harmonics.forEach((h, idx) => {
    traces.push({ freq: d.freq, values: shift(h.mag), color: TRACE_COLORS[idx], name: `H${h.n}`, visible: true });
  });
  plot.setYRange(-90, 5, 'dB (harmonics rel. fundamental)');
  plot.draw(traces);
  const topN = d.harmonics.length ? d.harmonics[d.harmonics.length - 1].n : 1;
  const m = d.maxThd;
  $('#measureStatus').textContent = m.pct > 0
    ? `Distortion: worst THD ${m.pct.toFixed(1)}% at ${Math.round(m.freq)} Hz · white = fundamental, coloured = H2–H${topN}.`
    : `Distortion computed (up to H${topN}) — THD too low or out of band to flag a peak.`;
}

function drawWaterfall(res) {
  const frames = dsp.waterfall(res.ir, res.peakIdx, res.sr);
  let ref = -Infinity;
  for (let i = 0; i < frames[0].mag.length; i++) if (frames[0].mag[i] > ref) ref = frames[0].mag[i];
  const traces = frames.map((f, idx) => {
    const vals = new Float32Array(f.mag.length);
    for (let i = 0; i < f.mag.length; i++) vals[i] = f.mag[i] - ref;
    const bright = Math.round(255 * (1 - idx / frames.length));
    return { freq: f.freq, values: vals, color: `rgba(${bright},${Math.round(bright * 0.6 + 60)},255,0.8)`, name: `${f.timeMs.toFixed(1)}ms`, visible: true };
  });
  plot.setYRange(-40, 5, 'CSD (dB, slices fade with time)');
  plot.draw(traces);
  $('#measureStatus').textContent = `Waterfall: ${frames.length} slices, brightest = t0.`;
}

// ---------- Mode panels ----------
function renderModePanel() {
  const el = $('#modePanel');
  el.innerHTML = '';
  el.className = '';

  if (state.mode === 'distortion') {
    el.className = 'card mode-panel';
    el.innerHTML = `
      <h2>Harmonic distortion (THD)</h2>
      <p class="hint">Harmonics separate into the pre-impulse region of the deconvolution.
        A longer sweep (7–10 s) and a healthy output level give cleaner separation.
        Numbers are only as clean as the mic's own distortion floor — read peaks, not decimals.</p>
      <label style="font-size:12px;color:var(--muted)">Highest harmonic
        <select id="maxHarm">
          <option value="3">H3</option>
          <option value="5" selected>H5</option>
          <option value="7">H7</option>
        </select>
      </label>`;
    const sel = $('#maxHarm');
    sel.value = String(state.maxHarmonic);
    sel.addEventListener('change', (e) => { state.maxHarmonic = parseInt(e.target.value, 10); });
    return;
  }

  if (state.mode !== 'offset') return;
  el.className = 'card mode-panel';
  const o = state.offset;
  const typeOpts = (sel) => [['woofer', 'Woofer'], ['midrange', 'Midrange'], ['tweeter', 'Tweeter ⚠']]
    .map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
  el.innerHTML = `
    <h2>Driver time-offset</h2>
    <label class="ref-toggle"><input type="checkbox" id="useRef"${o.useRef ? ' checked' : ''}/>
      Use timing reference (recommended)</label>
    <div id="refControls"${o.useRef ? '' : ' style="display:none"'}>
      <div class="ref-row">
        <label class="driver-type-row">Reference channel
          <select id="refChannel">
            <option value="L"${o.refChannel === 'L' ? ' selected' : ''}>Left = reference speaker</option>
            <option value="R"${o.refChannel === 'R' ? ' selected' : ''}>Right = reference speaker</option>
          </select></label>
        <label class="driver-type-row">Averages
          <input id="avgCount" type="number" min="1" max="32" value="${o.averages}"/></label>
      </div>
      <button id="testRef" class="secondary">Test reference</button>
      <p id="refTestStatus" class="hint">Plays only the marker on the reference speaker; confirms a stable arrival time.</p>
    </div>
    <p class="hint">Fixed mic <strong>and</strong> fixed reference speaker. Capture each driver alone
      (disconnect the others at the terminals). Nothing moves once you start.</p>
    <div class="offset-driver">
      <label class="driver-type-row">Driver A is a <select id="typeA">${typeOpts('tweeter')}</select></label>
      <button id="capA" class="secondary">Capture Driver A</button>
    </div>
    <div class="offset-driver">
      <label class="driver-type-row">Driver B is a <select id="typeB">${typeOpts('woofer')}</select></label>
      <button id="capB" class="secondary">Capture Driver B</button>
    </div>
    <p id="offA" class="hint">A: not captured</p>
    <p id="offB" class="hint">B: not captured</p>
    <div class="capture-row">
      <button id="computeOffset" class="primary" disabled>Compute offset</button>
      <button id="offsetRepeat" class="secondary">Repeatability (×2)</button>
    </div>
    <div id="offsetResult"></div>`;

  $('#useRef').addEventListener('change', (e) => {
    o.useRef = e.target.checked;
    $('#refControls').style.display = o.useRef ? '' : 'none';
    o.dataA = o.dataB = null; // captured data is method-specific — reset on switch
    $('#offA').textContent = 'A: not captured'; $('#offA').classList.remove('captured');
    $('#offB').textContent = 'B: not captured'; $('#offB').classList.remove('captured');
    $('#computeOffset').disabled = true;
    $('#offsetResult').innerHTML = '';
  });
  $('#refChannel').addEventListener('change', (e) => { o.refChannel = e.target.value; });
  $('#avgCount').addEventListener('change', (e) => { o.averages = Math.max(1, parseInt(e.target.value, 10) || 8); });
  $('#capA').addEventListener('click', () => captureDriver('A'));
  $('#capB').addEventListener('click', () => captureDriver('B'));
  $('#testRef').addEventListener('click', testReference);
  $('#offsetRepeat').addEventListener('click', offsetRepeat);
  $('#computeOffset').addEventListener('click', computeOffset);
}

// Build the stereo playback buffers for one self-referenced capture: marker on
// the reference channel at t=0, sweep on the other channel after a short gap.
function buildRefBuffers(sr, s) {
  const sweep = dsp.generateESS(s.f1, s.f2, s.duration, sr);
  const marker = dsp.generateRefMarker(sr);
  const gap = Math.round(0.008 * sr);
  const tauS = marker.length + gap;
  const total = tauS + sweep.length;
  const refCh = new Float32Array(total); refCh.set(marker, 0);
  const swpCh = new Float32Array(total); swpCh.set(sweep, tauS);
  const refIsLeft = state.offset.refChannel === 'L';
  return { left: refIsLeft ? refCh : swpCh, right: refIsLeft ? swpCh : refCh, sweep, marker, tauS };
}

async function oneRefCapture(label) {
  const s = settings();
  const sr = state.ctx.sampleRate;
  $('#measureStatus').textContent = label;
  const { left, right, sweep, marker, tauS } = buildRefBuffers(sr, s);
  const rec = await audio.playStereoAndRecord(state.ctx, state.micStream, left, right, { tailSec: 1, level: s.level });
  const res = dsp.selfReferencedOffset(rec, sweep, marker, sr);
  return { ...res, offsetSamples: res.offsetSamples - tauS, sr }; // physical per-driver readout (tauS cancels in B−A)
}

async function captureDriver(which) {
  const type = $('#type' + which) ? $('#type' + which).value : 'woofer';
  if (!(await passesTweeterGate(type))) return; // P0 safety gate — fires on the tweeter's capture
  const btn = $('#cap' + which);
  btn.disabled = true;
  try {
    if (state.offset.useRef) {
      const N = state.offset.averages;
      const sr = state.ctx.sampleRate;
      const offsets = [];
      for (let k = 0; k < N; k++) {
        const cap = await oneRefCapture(`Driver ${which}: capture ${k + 1}/${N}…`);
        if (cap.valid) offsets.push(cap.offsetSamples); // drop low-SNR / garbage captures
      }
      if (offsets.length < 3) {
        state.offset['data' + which] = null;
        $('#computeOffset').disabled = true;
        $('#off' + which).textContent = `${which}: ⚠ capture failed (${offsets.length}/${N} usable — bypass crossover, raise level, keep still)`;
        $('#off' + which).classList.remove('captured');
        return;
      }
      const { mean, std } = dsp.robustMeanStd(offsets);
      state.offset['data' + which] = { mean, std, sr };
      $('#off' + which).textContent = `${which}: ${offsets.length}/${N} caps · ${dsp.samplesToMm(mean, sr).toFixed(1)} mm (± ${dsp.samplesToMm(std, sr).toFixed(1)} mm)`;
    } else {
      const res = await measure(`Capturing driver ${which} (no reference)…`);
      state.offset['data' + which] = { legacy: true, ir: res.ir, sr: res.sr, peakIdx: res.peakIdx };
      $('#off' + which).textContent = `${which}: captured · peak ${(res.peakIdx / res.sr * 1000).toFixed(2)} ms (no reference)`;
    }
    $('#off' + which).classList.add('captured');
    if (state.offset.dataA && state.offset.dataB) $('#computeOffset').disabled = false;
  } catch (e) {
    $('#off' + which).textContent = `${which}: error ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function computeOffset() {
  const A = state.offset.dataA, B = state.offset.dataB;
  if (!A || !B) return;
  const sr = A.sr;
  if (!A.legacy && !B.legacy) {
    const zSamples = B.mean - A.mean;
    const zMm = dsp.samplesToMm(zSamples, sr);
    const stdMm = dsp.samplesToMm(Math.hypot(A.std, B.std), sr); // combined error bar
    const absMm = Math.abs(zMm);
    const dir = zMm >= 0 ? 'Driver B sits further back than Driver A' : 'Driver A sits further back than Driver B';
    const verdict = stdMm > 15
      ? '❌ error bar too large — not trustworthy. Check nothing moved and AGC/NS/EC are off.'
      : stdMm > Math.max(3, absMm * 0.5)
        ? '⚠ error bar is large relative to the offset — treat as rough.'
        : '✅ tight spread — trustworthy.';
    $('#offsetResult').innerHTML =
      `<p class="result-big">${absMm.toFixed(1)} mm <span class="pm">± ${stdMm.toFixed(1)} mm</span></p>
       <p class="hint">${dir}. z = ${zSamples.toFixed(2)} samples · ${(zSamples / sr * 1000).toFixed(3)} ms.<br>
       ${verdict}<br>Enter as the driver's Z position in VituixCAD.</p>`;
  } else {
    const r = dsp.driverOffset(A.ir, B.ir, sr);
    const dir = r.dMm >= 0 ? 'B further from the mic than A' : 'A further from the mic than B';
    $('#offsetResult').innerHTML =
      `<p class="result-big">${Math.abs(r.dMm).toFixed(1)} mm</p>
       <p class="hint">(No reference — absolute peak method, prone to ~0.2–0.3 ms latency jitter.)
       Δ ${r.dSamples.toFixed(2)} samples · ${r.dMs.toFixed(3)} ms · ${dir}.</p>`;
  }
}

async function testReference() {
  const btn = $('#testRef');
  btn.disabled = true;
  try {
    const sr = state.ctx.sampleRate;
    const marker = dsp.generateRefMarker(sr);
    const total = marker.length + Math.round(0.05 * sr);
    const refCh = new Float32Array(total); refCh.set(marker, 0);
    const silent = new Float32Array(total);
    const refIsLeft = state.offset.refChannel === 'L';
    const arrivals = [];
    for (let k = 0; k < 2; k++) {
      $('#refTestStatus').textContent = `Testing reference ${k + 1}/2…`;
      const rec = await audio.playStereoAndRecord(state.ctx, state.micStream,
        refIsLeft ? refCh : silent, refIsLeft ? silent : refCh, { tailSec: 0.3, level: settings().level });
      arrivals.push(dsp.crossCorrPeak(rec, marker) / sr * 1000);
    }
    const spread = Math.abs(arrivals[1] - arrivals[0]);
    $('#refTestStatus').textContent =
      `Marker detected at ${arrivals[0].toFixed(1)} & ${arrivals[1].toFixed(1)} ms (spread ${spread.toFixed(2)} ms). ` +
      (spread < 0.5 ? '✅ stable.' : '⚠ unstable — check the reference speaker/cable and that audio isn\'t rerouting.');
  } catch (e) {
    $('#refTestStatus').textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function offsetRepeat() {
  if (!state.offset.useRef) {
    $('#offsetResult').innerHTML = '<p class="hint">Turn on the timing reference for a meaningful repeatability check.</p>';
    return;
  }
  const type = $('#typeA') ? $('#typeA').value : 'woofer';
  if (!(await passesTweeterGate(type))) return; // P0 safety gate
  const btn = $('#offsetRepeat');
  btn.disabled = true;
  try {
    const sr = state.ctx.sampleRate;
    const r1 = await oneRefCapture('Repeatability 1/2…');
    const r2 = await oneRefCapture('Repeatability 2/2…');
    if (!r1.valid || !r2.valid) {
      $('#offsetResult').innerHTML = '<p class="hint">⚠ Couldn\'t get a clean capture (weak / low-SNR impulse). Bypass the crossover, raise the level slightly, keep the room quiet, and retry.</p>';
      return;
    }
    const diffMm = Math.abs(dsp.samplesToMm(r2.offsetSamples - r1.offsetSamples, sr));
    $('#offsetResult').innerHTML =
      `<p class="result-big">${diffMm.toFixed(1)} mm</p>
       <p class="hint">Same driver measured twice · difference.
       ${diffMm <= 15 ? '✅ pass — the reference is working.' : '⚠ over 15 mm — something moved or the reference is unstable.'}</p>`;
    $('#measureStatus').textContent = 'Repeatability done.';
  } catch (e) {
    $('#offsetResult').innerHTML = '<p class="hint">Error: ' + e.message + '</p>';
  } finally {
    btn.disabled = false;
  }
}

// ---------- Trace list / export ----------
function renderTraceList() {
  const el = $('#traceList');
  if (!state.traces.length) { el.innerHTML = '<p class="empty">No traces held yet.</p>'; return; }
  el.innerHTML = '';
  state.traces.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'trace-item';
    row.innerHTML = `
      <span class="trace-swatch" style="background:${t.color}"></span>
      <span class="trace-name">${t.name}</span>
      <button data-act="vis">${t.visible ? 'Hide' : 'Show'}</button>
      <button data-act="frd">.frd</button>
      <button data-act="del">✕</button>`;
    row.querySelector('[data-act="vis"]').addEventListener('click', () => { t.visible = !t.visible; drawAll(); renderTraceList(); });
    row.querySelector('[data-act="frd"]').addEventListener('click', () => downloadText(safeName(t.name) + '.frd', traceToFrd(t)));
    row.querySelector('[data-act="del"]').addEventListener('click', () => { state.traces.splice(i, 1); drawAll(); renderTraceList(); });
    el.appendChild(row);
  });
  const png = document.createElement('button');
  png.className = 'secondary';
  png.style.marginTop = '10px';
  png.textContent = 'Export plot as PNG';
  png.addEventListener('click', () => downloadCanvasPng($('#plot'), 'measurement.png'));
  el.appendChild(png);
}

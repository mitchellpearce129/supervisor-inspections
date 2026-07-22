// dsp.js — the measurement maths (spec §4).
// ESS generation, deconvolution, gating, spectrum, smoothing, phase/group-delay,
// driver time-offset, and a basic cumulative spectral decay.
//
// Design note: for the linear IR (FR / phase / group delay / offset) we use
// frequency-domain *regularised* deconvolution. Because we divide by the KNOWN
// sweep spectrum, absolute play/record latency is irrelevant — the impulse just
// lands later in the buffer and we window around its peak (spec §4.3).

import { fft, ifft, nextPow2 } from './fft.js';

const SPEED_OF_SOUND = 343; // m/s at ~20°C

// --- 1. Exponential sine sweep (Farina) ------------------------------------
export function generateESS(f1, f2, duration, sampleRate, fadeMs = 20) {
  const N = Math.round(duration * sampleRate);
  const w1 = 2 * Math.PI * f1;
  const w2 = 2 * Math.PI * f2;
  const L = Math.log(w2 / w1) / duration;      // sweep rate
  const K = w1 / L;                            // = w1 * T / ln(w2/w1)
  const sweep = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / sampleRate;
    sweep[n] = Math.sin(K * (Math.exp(t * L) - 1));
  }
  applyFades(sweep, Math.round((fadeMs / 1000) * sampleRate));
  return sweep;
}

function applyFades(buf, fn) {
  const N = buf.length;
  for (let i = 0; i < fn && i < N; i++) {
    const w = 0.5 * (1 - Math.cos((Math.PI * i) / fn)); // raised-cosine
    buf[i] *= w;
    buf[N - 1 - i] *= w;
  }
}

// --- 2. Deconvolution: recording ⊗ inverse(sweep) → impulse response --------
// Regularised inverse filter H = Rec · conj(S) / (|S|² + ε).
export function deconvolve(recording, sweep, regDb = -60) {
  const L = nextPow2(recording.length + sweep.length);
  const sr = new Float32Array(L), si = new Float32Array(L);
  const rr = new Float32Array(L), ri = new Float32Array(L);
  sr.set(sweep);
  rr.set(recording);
  fft(sr, si);
  fft(rr, ri);

  let maxMag2 = 0;
  for (let i = 0; i < L; i++) {
    const m = sr[i] * sr[i] + si[i] * si[i];
    if (m > maxMag2) maxMag2 = m;
  }
  const eps = maxMag2 * Math.pow(10, regDb / 10);

  const hr = new Float32Array(L), hi = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const denom = sr[i] * sr[i] + si[i] * si[i] + eps;
    hr[i] = (rr[i] * sr[i] + ri[i] * si[i]) / denom; // Re(Rec·conj(S))
    hi[i] = (ri[i] * sr[i] - rr[i] * si[i]) / denom; // Im(Rec·conj(S))
  }
  ifft(hr, hi);
  return hr; // real impulse response (imag ≈ 0)
}

// --- 3. Peak location (with sub-sample parabolic refinement) ----------------
export function findPeak(ir) {
  let idx = 0, max = 0;
  for (let i = 0; i < ir.length; i++) {
    const a = Math.abs(ir[i]);
    if (a > max) { max = a; idx = i; }
  }
  return idx;
}

// Sub-sample peak position via parabolic interpolation over |ir| — matters for
// the driver-offset "jewel" where we care about fractions of a sample.
export function findPeakSubSample(ir) {
  const i = findPeak(ir);
  if (i <= 0 || i >= ir.length - 1) return i;
  const a = Math.abs(ir[i - 1]), b = Math.abs(ir[i]), c = Math.abs(ir[i + 1]);
  const denom = a - 2 * b + c;
  if (denom === 0) return i;
  return i + (0.5 * (a - c)) / denom;
}

// --- 4. Gate / window the IR ------------------------------------------------
// A short post-window rejects room reflections but limits low-frequency validity
// to roughly f_low ≈ 1 / postSeconds (spec §4.4). preMs keeps a little of the
// leading edge; both edges get a raised-cosine taper to limit spectral leakage.
export function gateIR(ir, peakIdx, sampleRate, preMs = 1, postMs = 5) {
  const pre = Math.round((preMs / 1000) * sampleRate);
  const post = Math.round((postMs / 1000) * sampleRate);
  const start = Math.max(0, peakIdx - pre);
  const end = Math.min(ir.length, peakIdx + post);
  const len = end - start;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = ir[start + i];

  const hf = Math.min(pre, len);
  for (let i = 0; i < hf; i++) out[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / hf));
  const tf = Math.min(post, len);
  for (let i = 0; i < tf; i++) out[len - tf + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / tf));

  return out;
}

// Low-frequency validity limit for a given post-gate length (Hz).
export function gateFloorHz(postMs) {
  return postMs > 0 ? 1000 / postMs : Infinity;
}

// --- 5. Spectrum from the gated IR -----------------------------------------
export function spectrum(gated, sampleRate, pad = 4) {
  const L = nextPow2(gated.length * pad); // zero-pad → smoother frequency grid
  const re = new Float32Array(L), im = new Float32Array(L);
  re.set(gated);
  fft(re, im);
  const half = L >> 1;
  const freq = new Float32Array(half);
  const mag = new Float32Array(half);
  const phase = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    freq[i] = (i * sampleRate) / L;
    mag[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) + 1e-12);
    phase[i] = Math.atan2(im[i], re[i]);
  }
  return { freq, mag, phase, L };
}

// --- 6. Fractional-octave smoothing (power-averaged) -----------------------
export function fractionalOctaveSmooth(freq, magDb, fraction) {
  const n = freq.length;
  const out = new Float32Array(n);
  if (n < 2) return Float32Array.from(magDb);
  const factor = Math.pow(2, 1 / (2 * fraction)); // half-bandwidth ratio
  const df = freq[1] - freq[0];
  for (let i = 0; i < n; i++) {
    const f = freq[i];
    if (f <= 0) { out[i] = magDb[i]; continue; }
    const a = Math.max(0, Math.floor(f / factor / df));
    const b = Math.min(n - 1, Math.ceil((f * factor) / df));
    let sum = 0, cnt = 0;
    for (let k = a; k <= b; k++) { sum += Math.pow(10, magDb[k] / 10); cnt++; } // power avg
    out[i] = cnt ? 10 * Math.log10(sum / cnt) : magDb[i];
  }
  return out;
}

// Normalise a magnitude trace to ~0 dB over a reference band — this is a
// RELATIVE tool, so A/B overlays line up rather than floating apart.
export function normaliseToBand(freq, magDb, lo = 200, hi = 2000) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= lo && freq[i] <= hi) { sum += magDb[i]; cnt++; }
  }
  if (!cnt) return Float32Array.from(magDb);
  const ref = sum / cnt;
  const out = new Float32Array(magDb.length);
  for (let i = 0; i < magDb.length; i++) out[i] = magDb[i] - ref;
  return out;
}

// --- 7. Phase & group delay -------------------------------------------------
export function unwrap(phase) {
  const out = Float32Array.from(phase);
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > Math.PI) { out[i] -= 2 * Math.PI; d = out[i] - out[i - 1]; }
    while (d < -Math.PI) { out[i] += 2 * Math.PI; d = out[i] - out[i - 1]; }
  }
  return out;
}

// Group delay = −dφ/dω, returned in milliseconds.
export function groupDelayMs(freq, phase) {
  const up = unwrap(phase);
  const n = freq.length;
  const gd = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dw = 2 * Math.PI * (freq[i] - freq[i - 1]);
    gd[i] = dw !== 0 ? (-(up[i] - up[i - 1]) / dw) * 1000 : 0;
  }
  gd[0] = gd[1] || 0;
  return gd;
}

// --- 8. Driver time-offset (spec §5, "the jewel") --------------------------
// Two IRs at the same mic position → arrival-time difference → mm of z-offset.
export function driverOffset(irA, irB, sampleRate) {
  const pa = findPeakSubSample(irA);
  const pb = findPeakSubSample(irB);
  const dSamples = pb - pa;
  const dMs = (dSamples / sampleRate) * 1000;
  const dMm = (dMs / 1000) * SPEED_OF_SOUND * 1000;
  return { peakA: pa, peakB: pb, dSamples, dMs, dMm };
}

// --- 8b. Harmonic distortion (Farina method, spec §5) ----------------------
// With an exponential sweep, each harmonic order deconvolves into its OWN
// impulse response, arriving BEFORE the linear one by Δt_n = T·ln(n)/ln(f2/f1).
// We window each out separately and FFT it → the Nth-harmonic response indexed
// by the fundamental frequency (Farina's result — the same axis REW plots on).
//
// This needs the time-reversed *inverse filter* (not the frequency-domain
// division used for the linear IR), because that division smears the harmonics
// together. The inverse filter also whitens the sweep's pink spectrum: the
// reversed sweep is amplitude-modulated at +6 dB/octave (∝ instantaneous freq).

export function generateInverseFilter(sweep, f1, f2, duration, sampleRate) {
  const N = sweep.length;
  const L = Math.log(f2 / f1) / duration; // sweep rate (per second)
  const inv = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const tau = n / sampleRate;            // time into the REVERSED sweep
    inv[n] = sweep[N - 1 - n] * Math.exp(-tau * L); // +6 dB/oct whitening
  }
  return inv;
}

function fftConvolve(a, b) {
  const L = nextPow2(a.length + b.length);
  const ar = new Float32Array(L), ai = new Float32Array(L);
  const br = new Float32Array(L), bi = new Float32Array(L);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  const cr = new Float32Array(L), ci = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    cr[i] = ar[i] * br[i] - ai[i] * bi[i];
    ci[i] = ar[i] * bi[i] + ai[i] * br[i];
  }
  ifft(cr, ci);
  return cr;
}

// Returns { freq, fundamentalDb, ref, harmonics:[{n,mag}], thd, maxThd }.
// All spectra share ONE frequency grid (identical window length → directly
// comparable magnitudes, no interpolation needed).
export function harmonicDistortion(recording, sweep, f1, f2, duration, sampleRate, opts = {}) {
  const maxHarmonic = opts.maxHarmonic || 5;
  const preMs = opts.preMs != null ? opts.preMs : 1;
  const postMs = opts.postMs != null ? opts.postMs : 5;

  const inv = generateInverseFilter(sweep, f1, f2, duration, sampleRate);
  const full = fftConvolve(recording, inv);
  const linPeak = findPeak(full); // linear IR — strongest, latest major peak
  const ratio = Math.log(f2 / f1);

  const fund = gateIR(full, linPeak, sampleRate, preMs, postMs);
  const fSpec = spectrum(fund, sampleRate, 8);
  const freq = fSpec.freq;
  const fundamentalDb = fSpec.mag;

  const harmonics = [];
  for (let n = 2; n <= maxHarmonic; n++) {
    const dt = (duration * Math.log(n)) / ratio; // seconds before linear peak
    const idx = Math.round(linPeak - dt * sampleRate);
    if (idx < postMs * sampleRate / 1000) break;  // ran out of pre-impulse room
    const hIR = gateIR(full, idx, sampleRate, preMs, postMs);
    // Same gate + same pad ⇒ identical grid to the fundamental.
    harmonics.push({ n, mag: spectrum(hIR, sampleRate, 8).mag });
  }

  // Mic-correction: fundamental at f, but harmonic n at its true acoustic
  // frequency n·f (that's where the mic actually coloured it).
  const calFn = opts.calFn || null;
  if (calFn) {
    for (let i = 0; i < freq.length; i++) fundamentalDb[i] -= calFn(freq[i]);
    for (const h of harmonics) {
      for (let i = 0; i < freq.length; i++) h.mag[i] -= calFn(h.n * freq[i]);
    }
  }

  // Band reference so displayed harmonics sit at their true level BELOW the
  // fundamental (fundamental normalised to ~0 dB over 200 Hz–2 kHz).
  let sum = 0, cnt = 0;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 200 && freq[i] <= 2000) { sum += fundamentalDb[i]; cnt++; }
  }
  const ref = cnt ? sum / cnt : 0;

  // THD(%) vs fundamental frequency = √(Σ Hₙ²) / H₁ · 100.
  const lin = (db) => Math.pow(10, db / 20);
  const thd = new Float32Array(freq.length);
  const nyq = sampleRate / 2;
  let maxThd = { pct: 0, freq: 0 };
  for (let i = 0; i < freq.length; i++) {
    const h1 = lin(fundamentalDb[i]);
    let s = 0;
    for (const h of harmonics) s += Math.pow(lin(h.mag[i]), 2);
    const pct = h1 > 1e-9 ? (Math.sqrt(s) / h1) * 100 : 0;
    thd[i] = pct;
    // Only trust the band where the fundamental is well excited and the top
    // harmonic still fits under Nyquist.
    const f = freq[i];
    if (f >= Math.max(f1, 60) && f <= Math.min(f2, nyq / maxHarmonic) &&
        fundamentalDb[i] > ref - 30 && pct > maxThd.pct) {
      maxThd = { pct, freq: f };
    }
  }

  return { freq, fundamentalDb, ref, harmonics, thd, maxThd, linPeak, sampleRate };
}

// --- 8c. Acoustic timing reference (driver-offset-reference-spec P1) --------
// Self-referenced captures: in ONE recording we hear a fixed reference marker
// (a short HF chirp on the reference channel/speaker) AND the driver's swept
// response. Because both events share the same per-capture play/record latency,
// measuring the driver arrival RELATIVE to the reference arrival cancels that
// latency — which is the ~0.2–0.3 ms iOS jitter that made absolute peak-timing
// unusable. z_offset = (t_driverB − t_refB) − (t_driverA − t_refA).

// Short Hann-windowed 2–4 kHz chirp — sharp cross-correlation, easy to separate
// from the low-frequency start of the main sweep.
export function generateRefMarker(sampleRate, { f1 = 2000, f2 = 4000, durMs = 2 } = {}) {
  const N = Math.max(2, Math.round((durMs / 1000) * sampleRate));
  const T = N / sampleRate;
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / sampleRate;
    const phase = 2 * Math.PI * (f1 * t + ((f2 - f1) / (2 * T)) * t * t); // linear chirp
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));          // Hann
    out[n] = Math.sin(phase) * w;
  }
  return out;
}

// Shared peak-picking helpers (used by the marker cross-correlation, the driver
// IR peak finder, and drift estimation — factored per the drift-spec DRY note).
function xcorrArray(signal, template) {
  const n = signal.length;
  const L = nextPow2(signal.length + template.length);
  const sr = new Float32Array(L), si = new Float32Array(L);
  const tr = new Float32Array(L), ti = new Float32Array(L);
  sr.set(signal); tr.set(template);
  fft(sr, si); fft(tr, ti);
  const cr = new Float32Array(L), ci = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    cr[i] = sr[i] * tr[i] + si[i] * ti[i]; // Re(S·conj(T))
    ci[i] = si[i] * tr[i] - sr[i] * ti[i]; // Im(S·conj(T))
  }
  ifft(cr, ci);
  return { cr, n };
}
function parabolicSub(arr, idx) {
  if (idx > 0 && idx < arr.length - 1) {
    const a = Math.abs(arr[idx - 1]), b = Math.abs(arr[idx]), c = Math.abs(arr[idx + 1]);
    const den = a - 2 * b + c;
    if (den !== 0) return idx + (0.5 * (a - c)) / den;
  }
  return idx;
}
// Peak index + max + median noise floor over [start,end], excluding a guard band
// around the peak so the peak itself doesn't inflate the floor.
function peakAndFloor(arr, start, end, guard) {
  let idx = start, max = 0;
  for (let i = start; i <= end; i++) { const a = Math.abs(arr[i]); if (a > max) { max = a; idx = i; } }
  const mags = [];
  for (let i = start; i <= end; i++) { if (Math.abs(i - idx) <= guard) continue; mags.push(Math.abs(arr[i])); }
  mags.sort((a, b) => a - b);
  return { idx, max, noise: mags.length ? mags[Math.floor(mags.length / 2)] : 0 };
}

// Matched-filter cross-correlation: sub-sample lag where `template` best aligns
// inside `signal` (i.e. the template's arrival index). Parabolic-interpolated.
export function crossCorrPeak(signal, template) {
  const { cr, n } = xcorrArray(signal, template);
  let idx = 0, max = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(cr[i]); if (a > max) { max = a; idx = i; } }
  return parabolicSub(cr, idx);
}

// Cross-correlation peak WITH a prominence SNR (peak vs median correlation floor),
// so a marker that isn't clearly present can be rejected. Used by estimateDrift.
export function corrPeakWithSnr(signal, template, sampleRate, guardMs = 1) {
  const { cr, n } = xcorrArray(signal, template);
  const guard = Math.round((guardMs / 1000) * sampleRate);
  const { idx, max, noise } = peakAndFloor(cr, 0, n - 1, guard);
  const snrDb = noise > 0 ? 20 * Math.log10(max / noise) : Infinity;
  return { lag: parabolicSub(cr, idx), snrDb };
}

// Bounded, prominence-checked driver-arrival peak for the offset measurement.
// Searches only [refLag, refLag + maxMs] — a window RELATIVE to the reference
// marker, so it's immune to hardware play/record latency (which shifts the whole
// recording) and can never select the FFT circular-convolution wraparound tail.
// Also rejects captures whose peak isn't clearly above the local noise floor.
// Returns { pos (sub-sample), snrDb, valid }.
export function findDriverPeak(ir, sampleRate, { refLag = 0, maxMs = 40, minSnrDb = 12, guardMs = 1 } = {}) {
  const start = Math.max(0, Math.round(refLag));
  const end = Math.min(ir.length - 1, start + Math.round((maxMs / 1000) * sampleRate));
  const guard = Math.round((guardMs / 1000) * sampleRate);
  const { idx, max, noise } = peakAndFloor(ir, start, end, guard);
  const snrDb = noise > 0 ? 20 * Math.log10(max / noise) : Infinity;
  return { pos: parabolicSub(ir, idx), snrDb, valid: snrDb >= minSnrDb };
}

// One self-referenced capture → offset (samples) of driver arrival relative to
// the reference marker arrival, both measured inside the same recording.
export function selfReferencedOffset(recording, sweep, marker, sampleRate) {
  const ir = deconvolve(recording, sweep);
  // 1) Find the reference marker in an early, bounded window — latency-generous
  //    but well before the sweep's own pass through the marker's 2–4 kHz band,
  //    so the matched filter can't lock onto the sweep instead of the marker.
  const refWin = Math.min(recording.length, Math.round(0.5 * sampleRate)); // 500 ms
  const tRef = crossCorrPeak(recording.subarray(0, refWin), marker);
  // 2) The driver arrives ~tauS after the marker, so search a bounded window
  //    RELATIVE to tRef (latency-immune, wraparound-safe) with an SNR gate that
  //    flags scattered/garbage captures instead of turning them into kilometres.
  const peak = findDriverPeak(ir, sampleRate, { refLag: tRef, maxMs: 40, minSnrDb: 12 });
  return { tRef, tDriver: peak.pos, offsetSamples: peak.pos - tRef, snrDb: peak.snrDb, valid: peak.valid };
}

export function samplesToMm(samples, sampleRate, c = 343) {
  return (samples / sampleRate) * c * 1000;
}

export function meanStd(arr) {
  const n = arr.length;
  if (!n) return { mean: 0, std: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

// Median + MAD outlier rejection, then mean/std of the survivors — so one stray
// capture that slipped through the SNR gate can't drag the average.
export function robustMeanStd(arr) {
  if (!arr.length) return { mean: NaN, std: NaN, kept: 0 };
  const med = median(arr);
  const mad = median(arr.map((v) => Math.abs(v - med)));
  const sigma = 1.4826 * mad; // MAD → robust σ
  const keep = sigma > 0 ? arr.filter((v) => Math.abs(v - med) <= 3.5 * sigma) : arr.slice();
  const use = keep.length ? keep : arr;
  return { ...meanStd(use), kept: use.length };
}

// --- 8d. Clock-drift compensation (dual-marker) ----------------------------
// When play and record run on separate clocks (e.g. USB-C DAC out + phone mic
// in), the recording's timebase slowly stretches vs the known sweep, smearing
// phase/group-delay (worst at HF). A single start marker cancels a CONSTANT
// offset; drift is a SLOPE, so we place a SECOND marker at the end, measure how
// far the gap stretched, and resample the recording back to the play clock (same
// idea as REW's "adjust clock with acoustic reference"). Shared-clock case
// measures ~0 ppm and is skipped — no-op, no regression.

// Framed playback buffer: [lead][marker@p0][gap][sweep][tail][gap][marker@p1][trail].
export function buildTimingFrame(sweep, sampleRate, {
  leadMs = 50, gapMs = 50, tailMs = 150, trailMs = 50, markerOpts = {},
} = {}) {
  const marker = generateRefMarker(sampleRate, markerOpts);
  const ms = (m) => Math.round((m / 1000) * sampleRate);
  const lead = ms(leadMs), gap = ms(gapMs), tail = ms(tailMs), trail = ms(trailMs);
  const p0 = lead;
  const sweepStart = p0 + marker.length + gap;
  const p1 = sweepStart + sweep.length + tail + gap;
  const total = p1 + marker.length + trail;
  const signal = new Float32Array(total);
  signal.set(marker, p0);
  signal.set(sweep, sweepStart);
  signal.set(marker, p1);
  return { signal, marker, p0, p1, sweepStart, expectedGap: p1 - p0, sampleRate };
}

// Find both markers (head + tail windows) → measured gap + validity/SNR.
// NOTE: startWinMs is tighter than the spec's 500 ms so a SHORT sweep's own pass
// through the marker's 2–4 kHz band can't be mistaken for the start marker.
export function estimateDrift(recording, marker, sampleRate, {
  startWinMs = 300, endWinMs = 500, minSnrDb = 10,
} = {}) {
  const startWin = Math.min(recording.length, Math.round((startWinMs / 1000) * sampleRate));
  const endWin = Math.min(recording.length, Math.round((endWinMs / 1000) * sampleRate));
  const endStart = Math.max(0, recording.length - endWin);
  const { lag: t0, snrDb: snr0 } = corrPeakWithSnr(recording.subarray(0, startWin), marker, sampleRate);
  const { lag: t1r, snrDb: snr1 } = corrPeakWithSnr(recording.subarray(endStart), marker, sampleRate);
  const t1 = endStart + t1r;
  return { t0, t1, measuredGap: t1 - t0, snr0, snr1, valid: snr0 >= minSnrDb && snr1 >= minSnrDb };
}

// Arbitrary-ratio windowed-sinc resampler (4-term Blackman–Harris, 32 taps).
// Output length = round(N/ratio); source position for output m is m*ratio.
export function resampleWindowedSinc(x, ratio) {
  const N = x.length;
  if (ratio === 1) return x.slice();
  const newLen = Math.round(N / ratio);
  const y = new Float32Array(newLen);
  const P = 16;                          // half-width → 32 taps
  const cutoff = Math.min(1, 1 / ratio); // anti-alias only when downsampling (ρ>1)
  const sinc = (t) => (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t));
  const win = (t) => {
    if (Math.abs(t) > P) return 0;
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    const x0 = (Math.PI * t) / P;
    return a0 + a1 * Math.cos(x0) + a2 * Math.cos(2 * x0) + a3 * Math.cos(3 * x0);
  };
  for (let m = 0; m < newLen; m++) {
    const s = m * ratio;
    const i0 = Math.floor(s);
    let acc = 0, wsum = 0;
    for (let k = -P + 1; k <= P; k++) {
      const idx = i0 + k;
      if (idx < 0 || idx >= N) continue;
      const t = s - idx;
      const c = win(t) * cutoff * sinc(cutoff * t);
      acc += x[idx] * c;
      wsum += c;
    }
    y[m] = wsum !== 0 ? acc / wsum : 0;
  }
  return y;
}

// Deadband (skip when clocks effectively shared) + sanity ceiling (reject
// implausible ratios as bad captures). Returns the (possibly resampled) recording.
export function compensateDrift(recording, expectedGap, drift, {
  deadbandPpm = 2, maxDriftPpm = 5000,
} = {}) {
  if (!drift.valid) return { recording, applied: false, ppm: 0, reason: 'timing markers not found' };
  const ratio = drift.measuredGap / expectedGap;
  const ppm = (ratio - 1) * 1e6;
  if (Math.abs(ppm) > maxDriftPpm) return { recording, applied: false, ppm, reason: 'implausible drift; capture likely bad' };
  if (Math.abs(ppm) < deadbandPpm) return { recording, applied: false, ppm, reason: 'within deadband (shared clock)' };
  return { recording: resampleWindowedSinc(recording, ratio), applied: true, ppm, ratio };
}

// --- 9. Cumulative spectral decay (basic waterfall, spec §5) ---------------
// Successively shift the window into the IR tail and FFT each slice.
export function waterfall(ir, peakIdx, sampleRate, slices = 12, stepMs = 0.3, winMs = 5) {
  const step = Math.round((stepMs / 1000) * sampleRate);
  const win = Math.round((winMs / 1000) * sampleRate);
  const frames = [];
  for (let s = 0; s < slices; s++) {
    const start = peakIdx + s * step;
    const seg = new Float32Array(win);
    for (let i = 0; i < win && start + i < ir.length; i++) {
      const w = 0.5 * (1 + Math.cos((Math.PI * i) / win)); // decaying half-window
      seg[i] = ir[start + i] * w;
    }
    const { freq, mag } = spectrum(seg, sampleRate, 2);
    frames.push({ timeMs: (s * step * 1000) / sampleRate, freq, mag });
  }
  return frames;
}

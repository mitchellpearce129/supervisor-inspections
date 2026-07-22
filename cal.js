// cal.js — microphone calibration file support (spec §1, §8).
//
// Parses the common measurement-mic cal formats — miniDSP UMIK (.txt), REW /
// generic (.frd/.cal/.txt): whitespace- or comma-delimited "freq  gain(dB)
// [phase(deg)]" with * / # / ; comment lines. The UMIK files also carry a
// "Sens Factor =-x.xdB" header line (SPL sensitivity).
//
// A cal file records the MIC's own deviation from flat. To correct a
// measurement we SUBTRACT that deviation (REW's convention): if the mic reads
// +3 dB hot at 10 kHz, every measurement is +3 dB too high there, so we take
// 3 dB back off. This turns a relative trace into a calibrated-magnitude one.

export function parseCalFile(text) {
  const lines = text.split(/\r?\n/);
  const freq = [], mag = [], phase = [];
  let sensFactor = null, hasPhase = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const sm = line.match(/Sens(?:itivity)?\s*Factor\s*=\s*(-?\d+(?:\.\d+)?)/i);
    if (sm) { sensFactor = parseFloat(sm[1]); continue; }
    if (/^[*#;"]/.test(line)) continue; // comment / header line

    const nums = line.split(/[\s,]+/);
    const f = parseFloat(nums[0]);
    const m = parseFloat(nums[1]);
    if (Number.isNaN(f) || Number.isNaN(m)) continue;
    freq.push(f); mag.push(m);
    const p = parseFloat(nums[2]);
    if (!Number.isNaN(p)) { phase.push(p); hasPhase = true; } else phase.push(0);
  }

  if (freq.length < 2) throw new Error('no "freq  dB" data rows found');
  return { freq, mag, phase: hasPhase ? phase : null, sensFactor, points: freq.length };
}

// Linear interpolation of the cal curve at an arbitrary frequency, clamped at
// the ends (mic cal files rarely cover the full 20–20 k, so we hold the edge).
export function calValueAt(cal, f) {
  const xs = cal.freq, ys = cal.mag, n = xs.length;
  if (f <= xs[0]) return ys[0];
  if (f >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= f) lo = mid; else hi = mid;
  }
  const t = (f - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

// Corrected = measured − mic-deviation, over an arbitrary frequency grid.
export function correctMagnitude(freqArr, magDb, cal) {
  const out = new Float32Array(magDb.length);
  for (let i = 0; i < freqArr.length; i++) out[i] = magDb[i] - calValueAt(cal, freqArr[i]);
  return out;
}

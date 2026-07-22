// audio.js — Web Audio plumbing (spec §3).
// Full-duplex play + record, with the phone's call-processing DSP disabled and
// the actual sample rate read back (never assumed).

export async function createAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  // We *request* 48 kHz but must use whatever we actually get (spec §3).
  const ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.resume();
  return ctx;
}

// The single biggest validity lever we have in the browser (spec §3): kill AGC,
// noise suppression and echo cancellation. Safari's honouring of these is
// imperfect — that's exactly why app.js runs a repeatability sanity check.
export async function getMicStream(deviceId) {
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  if (deviceId) audioConstraints.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
}

// List audio input devices — e.g. to pick a UMIK-1 over the built-in mic.
// Labels only populate AFTER mic permission has been granted once.
export async function listInputs() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'audioinput');
}

// Report what the browser actually applied, so we can surface it to the user.
export function describeMicTrack(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return {};
  const s = track.getSettings ? track.getSettings() : {};
  return {
    label: track.label,
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.autoGainControl,
    sampleRate: s.sampleRate,
    channelCount: s.channelCount,
  };
}

// Play the sweep and capture the mic simultaneously. Returns the recorded
// Float32 buffer (mono). The mic path is routed through a muted gain node so the
// ScriptProcessor keeps firing without creating a feedback loop.
export async function playAndRecord(ctx, micStream, sweepBuffer, {
  tailSec = 1, level = 0.5, onLevel = null,
} = {}) {
  const sr = ctx.sampleRate;

  const buf = ctx.createBuffer(1, sweepBuffer.length, sr);
  buf.copyToChannel(sweepBuffer, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const outGain = ctx.createGain();
  outGain.gain.value = level;
  src.connect(outGain).connect(ctx.destination);

  const micSrc = ctx.createMediaStreamSource(micStream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // capture only — do not play the mic back

  const chunks = [];
  let recording = true;
  proc.onaudioprocess = (e) => {
    if (!recording) return;
    const d = e.inputBuffer.getChannelData(0);
    const c = new Float32Array(d.length);
    c.set(d);
    chunks.push(c);
    if (onLevel) {
      let mx = 0;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > mx) mx = a; }
      onLevel(mx);
    }
  };
  micSrc.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  const totalMs = (sweepBuffer.length / sr + tailSec) * 1000 + 200;
  return new Promise((resolve) => {
    src.start();
    setTimeout(() => {
      recording = false;
      try { proc.disconnect(); micSrc.disconnect(); mute.disconnect(); src.disconnect(); } catch (_) {}
      let len = 0;
      chunks.forEach((c) => { len += c.length; });
      const rec = new Float32Array(len);
      let off = 0;
      chunks.forEach((c) => { rec.set(c, off); off += c.length; });
      resolve(rec);
    }, totalMs);
  });
}

// Stereo play + mono record (driver-offset reference, P1). `left`/`right` are
// Float32Arrays of equal length — one carries the reference marker, the other
// the sweep. Records the mic in parallel and returns the mono recording.
export async function playStereoAndRecord(ctx, micStream, left, right, {
  tailSec = 1, level = 0.5, onLevel = null,
} = {}) {
  const sr = ctx.sampleRate;
  const len = Math.max(left.length, right.length);

  const buf = ctx.createBuffer(2, len, sr);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const outGain = ctx.createGain();
  outGain.gain.value = level;
  src.connect(outGain).connect(ctx.destination);

  const micSrc = ctx.createMediaStreamSource(micStream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const chunks = [];
  let recording = true;
  proc.onaudioprocess = (e) => {
    if (!recording) return;
    const d = e.inputBuffer.getChannelData(0);
    const c = new Float32Array(d.length);
    c.set(d);
    chunks.push(c);
    if (onLevel) {
      let mx = 0;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > mx) mx = a; }
      onLevel(mx);
    }
  };
  micSrc.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  const totalMs = (len / sr + tailSec) * 1000 + 200;
  return new Promise((resolve) => {
    src.start();
    setTimeout(() => {
      recording = false;
      try { proc.disconnect(); micSrc.disconnect(); mute.disconnect(); src.disconnect(); } catch (_) {}
      let n = 0;
      chunks.forEach((c) => { n += c.length; });
      const rec = new Float32Array(n);
      let off = 0;
      chunks.forEach((c) => { rec.set(c, off); off += c.length; });
      resolve(rec);
    }, totalMs);
  });
}

// Play a stereo buffer with NO recording (level-setting routine). Returns a
// promise that resolves when playback ends, plus a stop() to cut it short.
export function playStereoOnce(ctx, left, right, level = 0.5) {
  const len = Math.max(left.length, right.length);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = level;
  src.connect(g).connect(ctx.destination);
  const promise = new Promise((resolve) => { src.onended = resolve; });
  src.start();
  return { promise, stop: () => { try { src.stop(); } catch (_) {} } };
}

// Live input-level meter for the "arm" state (spec §6). Returns a stop handle.
export function startLevelMeter(ctx, micStream, onLevel) {
  const src = ctx.createMediaStreamSource(micStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let raf = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(data);
    let peak = 0, sum = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
      sum += data[i] * data[i];
    }
    onLevel({ peak, rms: Math.sqrt(sum / data.length) });
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => { cancelAnimationFrame(raf); try { src.disconnect(); } catch (_) {} };
}

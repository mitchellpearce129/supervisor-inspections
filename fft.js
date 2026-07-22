// fft.js — minimal radix-2 Cooley–Tukey FFT (in-place, complex).
// Owned deliberately (per spec §7): the transform is small and well understood,
// the DSP that uses it is the learning payload.

export function fft(re, im) { transform(re, im, false); }

export function ifft(re, im) {
  transform(re, im, true);
  const n = re.length;
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function transform(re, im, inverse) {
  const n = re.length;
  if (n === 0) return;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of 2, got ' + n);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] = re[a] + vr; im[a] = im[a] + vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

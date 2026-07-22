// export.js — save traces as .frd-style text and the plot as PNG (spec §6/§8).
// .frd format is the de-facto interchange for VituixCAD / REW: whitespace-
// delimited "freq  magnitude(dB)  phase(deg)" with a couple of comment lines.

export function traceToFrd(trace) {
  const lines = [
    `* Exported from REWMitch`,
    `* Trace: ${trace.name}`,
    `* Freq(Hz)  Mag(dB)  Phase(deg)`,
  ];
  const { freq, mag, phase } = trace;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] < 10 || freq[i] > 22000) continue;
    const ph = phase ? (phase[i] * 180 / Math.PI).toFixed(2) : '0.00';
    lines.push(`${freq[i].toFixed(2)}\t${mag[i].toFixed(3)}\t${ph}`);
  }
  return lines.join('\n');
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  triggerDownload(filename, URL.createObjectURL(blob));
}

export function downloadCanvasPng(canvas, filename) {
  canvas.toBlob((blob) => triggerDownload(filename, URL.createObjectURL(blob)), 'image/png');
}

function triggerDownload(filename, url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeName(s) {
  return s.replace(/[^\w.-]+/g, '_').slice(0, 60);
}

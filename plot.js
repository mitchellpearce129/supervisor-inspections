// plot.js — log-frequency canvas plotting with multi-trace overlay (spec §6).
// A small owned plotter keeps us dependency-thin and gives clean log-x control.

const MARGIN = { left: 52, right: 14, top: 14, bottom: 30 };

export class Plot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fMin = 20;
    this.fMax = 20000;
    this.yMin = -30;
    this.yMax = 15;
    this.yLabel = 'dB (relative)';
    this._traces = [];
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this._redraw(); });
    // A canvas constructed inside a hidden (display:none) tab measures 0×0 and
    // never re-measures on a plain tab switch — which left Measure-tab plots
    // drawing into a 1×1 buffer (blank). Observe the element so it re-sizes and
    // redraws whenever it actually gains/changes size (tab shown, rotate, resize).
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._resize(); this._redraw(); });
      this._ro.observe(this.canvas);
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
  }

  setYRange(min, max, label) {
    this.yMin = min; this.yMax = max;
    if (label) this.yLabel = label;
  }

  // traces: [{ freq, values, color, name, visible }]
  draw(traces) {
    this._traces = traces;
    this._resize();   // re-measure at draw time — the canvas may have been built
    this._redraw();   // while its tab was hidden (0×0); by now it's visible.
  }

  // Re-measure + repaint (e.g. when a tab becomes visible with traces already held).
  refresh() { this._resize(); this._redraw(); }

  _redraw() {
    const { ctx } = this;
    const traces = this._traces;
    const plotW = this.w - MARGIN.left - MARGIN.right;
    const plotH = this.h - MARGIN.top - MARGIN.bottom;
    const styles = getComputedStyle(document.documentElement);
    const grid = styles.getPropertyValue('--grid').trim() || '#333';
    const axis = styles.getPropertyValue('--axis').trim() || '#888';
    const bg = styles.getPropertyValue('--plot-bg').trim() || '#0d0d10';

    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = bg;
    ctx.fillRect(MARGIN.left, MARGIN.top, plotW, plotH);

    const x = (f) => {
      const t = (Math.log10(f) - Math.log10(this.fMin)) /
                (Math.log10(this.fMax) - Math.log10(this.fMin));
      return MARGIN.left + t * plotW;
    };
    const y = (v) => {
      const t = (v - this.yMin) / (this.yMax - this.yMin);
      return MARGIN.top + (1 - t) * plotH;
    };

    // Vertical grid: log decades + 1-2-5 minor lines.
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let dec = 10; dec <= this.fMax; dec *= 10) {
      for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const f = dec * m;
        if (f < this.fMin || f > this.fMax) continue;
        const px = x(f);
        ctx.strokeStyle = grid;
        ctx.lineWidth = m === 1 ? 1 : 0.4;
        ctx.beginPath();
        ctx.moveTo(px, MARGIN.top);
        ctx.lineTo(px, MARGIN.top + plotH);
        ctx.stroke();
        if (m === 1 || (m === 2 && dec >= 100) || (m === 5 && dec >= 100)) {
          ctx.fillStyle = axis;
          ctx.fillText(fmtHz(f), px, MARGIN.top + plotH + 4);
        }
      }
    }

    // Horizontal grid + y labels.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStep = niceStep(this.yMin, this.yMax);
    for (let v = Math.ceil(this.yMin / yStep) * yStep; v <= this.yMax; v += yStep) {
      const py = y(v);
      ctx.strokeStyle = grid;
      ctx.lineWidth = v === 0 ? 1 : 0.4;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, py);
      ctx.lineTo(MARGIN.left + plotW, py);
      ctx.stroke();
      ctx.fillStyle = axis;
      ctx.fillText(String(Math.round(v)), MARGIN.left - 6, py);
    }

    // Y-axis title.
    ctx.save();
    ctx.translate(12, MARGIN.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = axis;
    ctx.fillText(this.yLabel, 0, 0);
    ctx.restore();

    // Traces.
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top, plotW, plotH);
    ctx.clip();
    for (const tr of traces) {
      if (tr.visible === false) continue;
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < tr.freq.length; i++) {
        const f = tr.freq[i];
        if (f < this.fMin || f > this.fMax) continue;
        const px = x(f), py = y(tr.values[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

function fmtHz(f) {
  if (f >= 1000) return (f / 1000) + 'k';
  return String(f);
}

function niceStep(min, max) {
  const span = max - min;
  const raw = span / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return step * pow;
}

// Palette for named overlay traces (spec §6 — colour-coded).
export const TRACE_COLORS = [
  '#4ea1ff', '#ff6b6b', '#4ee39b', '#ffd166',
  '#c792ea', '#f78c6b', '#89ddff', '#ff9cee',
];

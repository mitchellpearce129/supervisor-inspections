// svg.js — simple in-app schematics (generated, never imported as assets).
// Colours come from CSS classes (.baffle/.drv/.drv.on/.lbl/.mic/.aim) so they
// stay theme-consistent. Front-view config icons, a top-down layout diagram,
// and nearfield insets.

function circle(cx, cy, r, role, active, letter) {
  const on = active.includes(role) ? ' on' : '';
  return `<circle class="drv${on}" cx="${cx}" cy="${cy}" r="${r}"/>` +
    (letter ? `<text class="drvl" x="${cx}" y="${cy + 3}" text-anchor="middle">${letter}</text>` : '');
}

// config: 2-way | 2.5-way | 3-way | MTM | coax. active: roles to highlight.
export function configIcon(config, active = []) {
  let inner = '';
  switch (config) {
    case '2-way':
      inner = circle(40, 26, 9, 'tweeter', active, 'T') + circle(40, 80, 24, 'woofer', active, 'W');
      break;
    case '2.5-way':
      inner = circle(40, 22, 8, 'tweeter', active, 'T') +
        circle(40, 58, 18, 'woofer', active, 'W') + circle(40, 96, 18, 'woofer', active, 'W');
      break;
    case '3-way':
      inner = circle(40, 20, 8, 'tweeter', active, 'T') +
        circle(40, 50, 14, 'midrange', active, 'M') + circle(40, 90, 22, 'woofer', active, 'W');
      break;
    case 'MTM':
      inner = circle(40, 28, 16, 'woofer', active, 'W') +
        circle(40, 60, 8, 'tweeter', active, 'T') + circle(40, 92, 16, 'woofer', active, 'W');
      break;
    case 'coax':
      inner = circle(40, 60, 30, 'woofer', active, 'W') + circle(40, 60, 9, 'tweeter', active, 'T');
      break;
    default:
      inner = circle(40, 60, 24, 'woofer', active, 'W');
  }
  return `<svg class="cfg-svg" viewBox="0 0 80 120" xmlns="http://www.w3.org/2000/svg">
    <rect class="baffle" x="8" y="6" width="64" height="108" rx="6"/>${inner}</svg>`;
}

// Top-down layout: driver-under-test speaker, mic on-axis at a distance, and
// (optionally) the fixed reference speaker.
export function layoutDiagram({ distanceLabel = '0.5–1 m', showReference = true } = {}) {
  const ref = showReference
    ? `<rect class="baffle" x="12" y="92" width="18" height="20" rx="3"/>
       <text class="lbl" x="21" y="88" text-anchor="middle">reference</text>`
    : '';
  return `<svg class="layout-svg" viewBox="0 0 210 120" xmlns="http://www.w3.org/2000/svg">
    <rect class="baffle" x="12" y="34" width="20" height="40" rx="3"/>
    <text class="lbl" x="22" y="28" text-anchor="middle">test speaker</text>
    <line class="aim" x1="160" y1="54" x2="40" y2="54" marker-end="url(#arr)"/>
    <text class="lbl" x="100" y="46" text-anchor="middle">on-axis</text>
    <text class="lbl" x="100" y="70" text-anchor="middle">${distanceLabel}</text>
    <circle class="mic" cx="166" cy="54" r="6"/>
    <line class="stand" x1="166" y1="60" x2="166" y2="104"/>
    <text class="lbl" x="166" y="116" text-anchor="middle">mic</text>
    ${ref}
    <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path class="arrh" d="M0,0 L6,3 L0,6 Z"/></marker></defs></svg>`;
}

// variant: 'cone' (mic at dust cap) | 'port' (mic at port mouth).
export function nearfieldInset(variant = 'cone') {
  if (variant === 'port') {
    return `<svg class="nf-svg" viewBox="0 0 140 80" xmlns="http://www.w3.org/2000/svg">
      <rect class="baffle" x="10" y="10" width="70" height="60" rx="5"/>
      <circle class="drv" cx="45" cy="40" r="14"/><circle class="port" cx="45" cy="40" r="7"/>
      <circle class="mic" cx="70" cy="40" r="5"/>
      <text class="lbl" x="108" y="37" text-anchor="middle">mic at</text>
      <text class="lbl" x="108" y="49" text-anchor="middle">port mouth</text></svg>`;
  }
  return `<svg class="nf-svg" viewBox="0 0 140 80" xmlns="http://www.w3.org/2000/svg">
    <rect class="baffle" x="10" y="8" width="70" height="64" rx="5"/>
    <circle class="drv on" cx="45" cy="40" r="26"/><circle class="port" cx="45" cy="40" r="8"/>
    <circle class="mic" cx="82" cy="40" r="5"/>
    <text class="lbl" x="112" y="37" text-anchor="middle">mic almost</text>
    <text class="lbl" x="112" y="49" text-anchor="middle">touching cone</text></svg>`;
}

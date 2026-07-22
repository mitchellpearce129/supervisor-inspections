// glossary.js — beginner-facing definitions (verbatim from the spec) plus an
// inline tap-to-expand "chip" so any term can be defined where it first appears.

export const GLOSSARY = {
  driver: { term: 'driver', def: 'One of the individual speaker cones/domes on the front of the box. A speaker usually has two or three, each handling a different slice of the sound.' },
  woofer: { term: 'woofer', def: 'The big driver. It makes the low sounds (bass) and often the lower-middle sounds too.' },
  midrange: { term: 'midrange', def: 'A medium driver that handles the middle sounds — mostly voices and most instruments. Only 3-way speakers have a dedicated one.' },
  tweeter: { term: 'tweeter', def: 'The small driver, usually a little dome. It makes the high sounds (cymbals, detail, "air").' },
  crossover: { term: 'crossover', def: "The circuit inside the speaker that splits the music up and sends the low part to the woofer, the highs to the tweeter, and so on, so each driver only plays the range it's good at." },
  crossoverFreq: { term: 'crossover frequency', def: 'The pitch (in Hz) where responsibility hands over from one driver to the next — e.g. a woofer might hand over to a tweeter at around 2,500 Hz. Right around this handover is where two drivers play at the same time and have to cooperate.' },
  onAxis: { term: 'on-axis', def: 'Directly in front of the speaker (or driver), aimed straight at it. Most measurements are taken on-axis because that\'s the speaker\'s "best seat".' },
  acousticCentre: { term: 'acoustic centre', def: "The point a driver's sound seems to leave from, which sits a little behind the visible cone and is different for each driver. Because the tweeter's and woofer's acoustic centres aren't in line, their sound reaches your ears at slightly different times — which is exactly what the offset test measures." },
  zOffset: { term: 'z-offset', def: "How much further back one driver's acoustic centre sits compared to another, measured in millimetres. Crossover software needs this number to line the drivers up in time." },
  impulseResponse: { term: 'impulse response', def: 'The speaker\'s reaction to a single, instant "tick" of sound. Almost everything else (frequency response, phase, decay) is worked out from it. The measurement finds it for you; you mostly care about when its peak arrives.' },
  phase: { term: 'phase', def: 'Where each pitch is in its up-and-down cycle at a given moment. On its own it\'s abstract; what matters here is whether two drivers are moving together (in phase, they reinforce) or against each other (out of phase, they cancel) around the crossover.' },
  groupDelay: { term: 'group delay', def: 'How long different pitches take to come out of the speaker. A little is normal and inaudible; the useful thing is the shape — a big bump can flag a resonance or a port effect.' },
  nearfield: { term: 'nearfield', def: "Measuring with the mic almost touching the driver (or in the port mouth). Getting this close mostly removes the room's influence, which is handy for checking bass tuning." },
  sweep: { term: 'sweep', def: 'The rising "whooosh" tone the app plays to test the speaker. The app compares what came back through the mic to what it sent out to work everything out.' },
  referenceSpeaker: { term: 'reference speaker', def: "A second speaker left switched on and unmoved during the offset/phase tests. It fires a fixed timing marker on every capture so the app can cancel out the tablet's own audio delay. Here it's simply your other speaker, left where it is." },
  terminals: { term: 'binding posts / terminals', def: 'The screw or clip connectors on the back of the speaker where the speaker wire attaches. "Disconnect at the terminals" means unscrew and detach the wire for the drivers you don\'t want playing.' },
  bypassCrossover: { term: 'bypass the crossover', def: "Wiring straight to one driver so the crossover isn't in the way, letting you measure that driver on its own. Only needed if your drivers can't be disconnected individually at the terminals. (Advanced.)" },
  repeatability: { term: 'repeatability check', def: "Measuring the same thing twice without changing anything, to see how much the number wobbles on its own. If it wobbles more than the thing you're trying to measure, don't trust the result yet." },
  calibration: { term: 'calibrated / uncalibrated mic', def: 'A calibrated mic comes with a correction file that makes its readings accurate in absolute terms. The tablet mic is uncalibrated, so trust comparisons and timing, not the exact loudness at each pitch.' },
  protectionCap: { term: 'protection capacitor (series cap)', def: 'A capacitor wired in line with the tweeter that blocks low frequencies (which is what damages tweeters) while letting the highs through. When you measure a tweeter with its normal crossover bypassed, this cap is what keeps it safe — a software frequency limit does not.' },
};

// Inline definition chip. `key` is a GLOSSARY key; `label` overrides the shown word.
export function chip(key, label) {
  const g = GLOSSARY[key];
  if (!g) return label || key;
  const text = label || g.term;
  return `<button type="button" class="chip" data-term="${key}">${text}<sup>?</sup></button>`;
}

// One delegated handler for every chip on the page: toggles an inline definition.
let inited = false;
export function initChips() {
  if (inited) return;
  inited = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const existing = btn.nextElementSibling;
    if (existing && existing.classList.contains('chip-def')) { existing.remove(); return; }
    const g = GLOSSARY[btn.dataset.term];
    if (!g) return;
    const def = document.createElement('span');
    def.className = 'chip-def';
    def.textContent = g.def;
    btn.insertAdjacentElement('afterend', def);
  });
}

export function renderGlossaryList() {
  return Object.values(GLOSSARY)
    .map((g) => `<div class="gloss-item"><strong>${g.term}</strong><span>${g.def}</span></div>`)
    .join('');
}

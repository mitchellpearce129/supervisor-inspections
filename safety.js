// safety.js — PRIORITY 0 tweeter protection gate, shared by the manual UI
// (app.js) and the wizard (wizard.js) so the safety logic lives in ONE place.
//
// Intercepts every capture/Play before any audio when a tweeter is the driver
// under test, and blocks until the user confirms a protection cap. A frequency
// range is NOT a safety measure and must never suppress this dialog.

export function isTweeter(type) { return type === 'tweeter'; }

// Blocking confirmation modal. Resolves true (Start test) or false (Cancel /
// backdrop). Creates NO audio. Re-shown on every press — no persistent opt-out.
export function showTweeterGate() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tw-title">
        <h2 class="modal-title" id="tw-title">⚠ Protect your tweeter before this test</h2>
        <p>You're about to send a test signal to a tweeter. With the crossover bypassed or the other
          drivers disconnected, the tweeter has none of its usual protection, and setting a frequency
          range does <strong>NOT</strong> protect it — a stray click, pop, or too-high level can destroy
          it in an instant.</p>
        <p>Before continuing, make sure a protection capacitor is wired in series with the tweeter (a
          suitable series cap acts as a high-pass filter that blocks the damaging low frequencies). If
          you're not sure one is in place, do not continue.</p>
        <p>Also check: volume is low to start, and the signal is going to the correct driver.</p>
        <details class="modal-help">
          <summary>What's a protection cap / how do I pick one?</summary>
          <p>The cap value sets how low a frequency gets through. A rough starting point is a value chosen
            to high-pass about an octave below your intended crossover — but this is guidance, not a
            guarantee. Always confirm against the tweeter's own ratings.</p>
        </details>
        <label class="modal-check">
          <input type="checkbox" id="tw-check" />
          <span>A protection capacitor is in series with the tweeter.</span>
        </label>
        <div class="modal-buttons">
          <button id="tw-cancel" class="secondary">Cancel</button>
          <button id="tw-start" class="primary" disabled>Start test</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const check = overlay.querySelector('#tw-check');
    const startBtn = overlay.querySelector('#tw-start');
    const done = (result) => { overlay.remove(); resolve(result); };
    check.addEventListener('change', () => { startBtn.disabled = !check.checked; });
    overlay.querySelector('#tw-cancel').addEventListener('click', () => done(false));
    startBtn.addEventListener('click', () => { if (check.checked) done(true); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); }); // backdrop = cancel (safe)
  });
}

// Returns true if safe to proceed (non-tweeter, or user confirmed); false if the
// user cancelled — callers must abort silently with no audio.
export async function passesTweeterGate(type) {
  if (!isTweeter(type)) return true;
  return showTweeterGate();
}

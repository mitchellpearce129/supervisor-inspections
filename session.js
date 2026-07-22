// session.js — shared audio session, set by app.js, read by the wizard.
// Keeps the two entry scripts decoupled while sharing one AudioContext + mic.
export const session = { ctx: null, micStream: null, cal: null };

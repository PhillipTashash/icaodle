// sfx.mjs — all game audio, in one place. ES module; nothing touches window/document at import time, so it is SSR-safe.
//
// Pack: "mechanical" (uisfx). The game is styled as an airport departure board (split-flap tiles, signage amber), and this
// pack's switches, relays and firm detents match that. Your own files in /sounds (correct, wrong, lost, skip, flap, streak1-5, end_game)
// still win over the pack when they exist; the pack's cues cover everything else and replace the old synthesized beeps.
export const PACK = "mechanical";
export const KEY = "icaodle:sound"; // localStorage: { enabled, volume }, saved on every change
export const DEFAULT_VOLUME = 0.2; // first visit: 20%

// What happened -> which sound. `file` = optional user-supplied /sounds/<file>.(wav|mp3|ogg); `cue` = uisfx semantic cue.
// One sound per interaction; outcomes are played by the caller only after the state change really happened.
export const EVENTS = {
  start: { cue: "start" },            // a game begins (daily difficulty or custom game)
  open: { cue: "open" },              // custom setup panel, results screen, review board
  back: { cue: "back" },              // custom setup -> menu, review Back, results -> menu
  forward: { cue: "forward" },        // review Next
  correct: { file: "correct", cue: "success" },   // a right trivia answer (a solved round uses streak1)
  streak1: { file: "streak1", cue: "success" },   // round solved, not on a streak yet
  streak2: { file: "streak2", cue: "streak" },    // 2 solved in a row
  streak3: { file: "streak3", cue: "streak" },    // 3 in a row
  streak4: { file: "streak4", cue: "streak" },    // 4 in a row
  streak5: { file: "streak5", cue: "achievement" }, // all 5 in a row (the end-of-game sound for a perfect run)
  endGame: { file: "end_game", cue: "complete" }, // the game is over and the last round wasn't a 5-in-a-row
  wrong: { file: "wrong", cue: "error" },         // wrong guess
  skip: { file: "skip", cue: "skip-next" },       // a guess passed with Skip
  lost: { file: "lost", cue: "blocked" },         // round lost (4th miss, or Skip on the last guess)
  flap: { file: "flap", cue: "typing", volume: 0.3 }, // each split-flap flip (typing = a brief key contact, never throttled)
  preview: { cue: "volume-change" },              // a short blip while dragging the volume slider, so you hear the level you are choosing
  tick: { file: "countdown", cue: "progress-step", tone: { freq: 660, dur: 0.14 } },   // lobby countdown: one beep each of the last 3 seconds
  minute: { file: "minute", cue: "notification", tone: { freq: 880, dur: 0.3 } }, // friend game: one beep as each minute of the 5 runs out
  go: { file: "go", cue: "start", tone: { freq: 1320, dur: 0.5 } },            // the lobby countdown hits zero and the friend game starts (a longer, higher beep)
  triviaWinner: { file: "trivia_winner_announce", cue: "notification" }, // the lobby trivia winner is announced...
  triviaLoser: { file: "trivia_loser_announce", cue: "blocked" }, // ...and what everyone else who played hears instead
  horn1: { file: "horn1", cue: "achievement" }, horn2: { file: "horn2", cue: "achievement" }, horn3: { file: "horn3", cue: "achievement" }, horn4: { file: "horn4", cue: "achievement" }, // ...with one of these horns on top
  soundOn: { cue: "toggle-on" },                  // sound switched back on (muting is silent: mute must be immediate)
};

const clamp = (v) => Math.min(1, Math.max(0, Number.isFinite(+v) ? +v : DEFAULT_VOLUME));
const fileNames = [...new Set(Object.values(EVENTS).map((e) => e.file).filter(Boolean))];

export function createSound({ createUISFX, storage = null, AudioContextCtor = null, fetchFile = (u) => globalThis.fetch?.(u) } = {}) {
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(KEY) || "null") || {}; } catch {}
  // the older on/off toggle stored localStorage.muted = "1"
  try { if (saved.enabled === undefined && storage?.getItem("muted") === "1") saved.enabled = false; } catch {}
  let enabled = saved.enabled !== false, volume = clamp(saved.volume ?? DEFAULT_VOLUME);
  let ui = null, ctx = null;
  const files = new Map(), active = new Set(); // decoded user files; user-file sources currently sounding
  const save = () => { try { storage?.setItem(KEY, JSON.stringify({ enabled, volume })); } catch {} };

  // Ask the server which files exist in /sounds (no 404 probing), then decode the ones the game uses.
  async function loadFiles(c) {
    let present = [];
    try { const r = await fetchFile("/api/sounds"); present = r?.ok ? await r.json() : []; } catch {}
    if (!Array.isArray(present)) present = []; // a non-list reply must not throw out of this background task
    for (const n of fileNames) {
      const f = ["wav", "mp3", "ogg"].map((e) => `${n}.${e}`).find((x) => present.includes(x));
      if (!f) continue;
      try {
        const r = await fetchFile(`/sounds/${f}`);
        if (r?.ok) { const buf = await c.decodeAudioData(await r.arrayBuffer()); if (c === ctx) files.set(n, buf); }
      } catch {}
    }
  }
  function playFile(n, vol = 1) {
    const b = files.get(n);
    if (!b || !ctx) return false;
    try {
      const s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = b; g.gain.value = vol * volume; s.connect(g); g.connect(ctx.destination);
      active.add(s); s.onended = () => active.delete(s); s.start();
      return true;
    } catch { return false; }
  }

  // A short synthesized beep for events with a `tone` and no file of their own (the cue is the fallback if the beep can't play): a square wave with a quick fade-out.
  function beep({ freq, dur }, vol = 1) {
    if (!ctx) return false;
    try {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
      o.type = "square"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.25 * vol * volume, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ctx.destination); active.add(o); o.onended = () => active.delete(o); o.start(t); o.stop(t + dur); // tracked so mute cuts it off at once
      return true;
    } catch { return false; }
  }

  // Lobby and round-map sounds, made here (no files) and kept quiet, since the map replays them. Filtered noise for the airy parts, soft sine and
  // triangle tones for the ticks and chimes. Each is tracked in `active`, so muting cuts it off at once.
  let noise = null;
  const noiseBuf = () => { if (noise && noise.sampleRate === ctx.sampleRate) return noise; noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 1.5), ctx.sampleRate); const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return noise; };
  const run = (src, t, end) => { active.add(src); src.onended = () => active.delete(src); src.start(t); src.stop(end); };
  function tone(freq, t, peak, a, d, type = "sine", to) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + a + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * volume), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    o.connect(g); g.connect(ctx.destination); run(o, t, t + a + d + 0.02);
  }
  function whoosh(t, dur, f0, f1, peak, q, pan = [0, 0]) { // noise through a band-pass that sweeps from f0 to f1, swelling then fading, moving between the ears
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner(); s.buffer = noiseBuf();
    f.type = "bandpass"; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * volume), t + dur * 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    p.pan.setValueAtTime(pan[0], t); p.pan.linearRampToValueAtTime(pan[1], t + dur); s.connect(f); f.connect(g); g.connect(p); p.connect(ctx.destination); run(s, t, t + dur + 0.02);
  }
  const ok = () => !!ctx && enabled;
  const extra = {
    // one step of a round map: an airy flick as the arrows draw, then a soft tick as they land, a little higher every step so the round builds up
    mapStep(step) { if (!ok()) return; const t = ctx.currentTime, k = Math.pow(1.12, step); try { whoosh(t, 0.4, 600 * k, 2400 * k, 0.6, 1.6); tone(1050 * k, t + 0.36, 0.12, 0.004, 0.09); } catch {} },
    // the round's first guesses popping onto the map
    mapPop() { if (!ok()) return; try { tone(420, ctx.currentTime, 0.18, 0.006, 0.16, "sine", 640); } catch {} },
    // zooming: out between rounds (a falling swoosh, right to left), in toward the guesses (rising and quieter, left to right)
    mapZoom(out) { if (!ok()) return; const t = ctx.currentTime; try { out ? whoosh(t, 1.05, 2600, 260, 0.6, 0.7, [0.4, -0.4]) : whoosh(t, 1.15, 300, 1800, 0.45, 0.8, [-0.3, 0.3]); } catch {} },
    // the lobby: someone joins (two notes up), leaves (two notes down), readies up (a high tick) or stops being ready (a lower one)
    lobby(kind) { if (!ok()) return; const t = ctx.currentTime; try {
      if (kind === "join") { tone(660, t, 0.16, 0.005, 0.18, "triangle"); tone(990, t + 0.09, 0.14, 0.005, 0.22, "triangle"); }
      else if (kind === "opp") { tone(520, t, 0.13, 0.004, 0.09, "square"); tone(390, t + 0.07, 0.11, 0.004, 0.12, "square"); } // the duel opponent submitted a guess
      else if (kind === "leave") { tone(880, t, 0.13, 0.005, 0.16, "triangle"); tone(590, t + 0.09, 0.12, 0.005, 0.2, "triangle"); }
      else tone(kind === "ready" ? 1320 : 700, t, 0.14, 0.003, 0.08); } catch {} },
  };

  return {
    ...extra,
    get enabled() { return enabled; },
    get volume() { return volume; },
    get ready() { return ui !== null; },
    // Call from a genuine user gesture (pointerdown / keydown). Creates the one shared AudioContext + player the first time
    // (so remounts never make a second one) and resumes the context every time. Never called on page load.
    unlock() {
      if (!AudioContextCtor || !createUISFX) return false;
      if (!ui) {
        try {
          ctx = new AudioContextCtor();
          ui = createUISFX({ pack: PACK, volume, enabled, context: ctx });
        } catch { // no usable audio: close any half-made context, stay silent, and let a later gesture try again
          try { ctx?.close?.()?.catch?.(() => {}); } catch {}
          ui = ctx = null;
          return false;
        }
        loadFiles(ctx).catch(() => {});
      }
      try { ctx.resume?.(); ui.unlock?.(); } catch {}
      return true;
    },
    // Plays an event. Silent (returns null) before the first gesture or while muted, so nothing stale is queued.
    // Returns "file" or "cue" for what actually played.
    play(event, extra) { // extra: uisfx play options, e.g. { playbackRate: 2 } for an octave up
      const e = EVENTS[event];
      if (!e || !ui || !enabled) return null;
      if (e.file && playFile(e.file, e.volume)) return "file";
      if (e.tone) return beep(e.tone, e.volume) ? "tone" : null;
      const o = { ...(e.volume === undefined ? {} : { volume: e.volume }), ...extra };
      return ui.play(e.cue, Object.keys(o).length ? o : undefined) ? "cue" : null; // play() can return null
    },
    setEnabled(on) {
      on = !!on;
      if (!on) { // stop everything first so muting is immediate
        ui?.stopAll();
        for (const s of active) { try { s.stop(); } catch {} }
        active.clear();
      }
      enabled = on; ui?.setEnabled(on); save();
      if (on) this.play("soundOn");
    },
    setVolume(v) { volume = clamp(v); ui?.setVolume(volume); save(); },
    // Final teardown: destroy the player first, then close the context we created.
    async destroy() {
      const u = ui, c = ctx;
      ui = null; ctx = null; files.clear(); active.clear();
      try { await u?.destroy(); } finally { try { await c?.close?.(); } catch {} } // always close the context, even if the player throws
    },
  };
}

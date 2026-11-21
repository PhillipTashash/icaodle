// node --test — game audio (sfx.js): cue mapping, mute persistence, unlock/remount behavior, teardown, SSR safety.
import test from "node:test";
import assert from "node:assert/strict";
import { cueNames, packNames } from "uisfx";
import { createSound, EVENTS, PACK, KEY, DEFAULT_VOLUME } from "../sfx.mjs";

// Fakes: a recording uisfx player, an AudioContext, and a Storage.
function rig({ stored = {}, files = {} } = {}) {
  const log = [], store = { ...stored };
  const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => void (store[k] = v) };
  let players = 0, contexts = 0, lastCtx = null;
  class Ctx {
    constructor() { contexts++; lastCtx = this; this.destination = {}; this.closed = false; }
    resume() { log.push("ctx.resume"); }
    async close() { log.push("ctx.close"); this.closed = true; }
    createBufferSource() { return { connect() {}, start() { log.push("file.start"); }, stop() { log.push("file.stop"); } }; }
    createGain() { return { gain: {}, connect() {} }; }
    async decodeAudioData() { return {}; }
  }
  const createUISFX = (o) => {
    players++; log.push(["create", o.pack, o.volume, o.enabled, o.context === lastCtx]);
    return {
      play: (cue, opts) => (log.push(["cue", cue, opts]), {}), unlock: async () => true, stopAll: () => log.push("stopAll"),
      setEnabled: (v) => log.push(["setEnabled", v]), setVolume: (v) => log.push(["setVolume", v]), destroy: async () => void log.push("destroy"),
    };
  };
  const fetchFile = async (url) => {
    if (url === "/api/sounds") return { ok: true, json: async () => Object.keys(files) };
    const n = url.split("/").pop(); return n in files ? { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } : { ok: false };
  };
  const make = () => createSound({ createUISFX, storage, AudioContextCtor: Ctx, fetchFile });
  return { log, store, make, counts: () => ({ players, contexts }) };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test("SSR safety: importing and creating a sound with no window/AudioContext never throws, and plays nothing", () => {
  assert.equal(typeof globalThis.window, "undefined");
  const s = createSound(); // no createUISFX, no storage, no AudioContext
  assert.equal(s.unlock(), false);
  assert.equal(s.play("correct"), null);
  assert.equal(s.ready, false);
});

test("every event maps to a real uisfx cue, and the pack is real", () => {
  assert.ok(packNames.includes(PACK));
  for (const [event, e] of Object.entries(EVENTS)) assert.ok(cueNames.includes(e.cue), `${event} -> ${e.cue}`);
});

test("semantic mapping: outcomes use outcome cues, navigation uses navigation cues", () => {
  assert.equal(EVENTS.correct.cue, "success");
  assert.equal(EVENTS.wrong.cue, "error");
  assert.equal(EVENTS.lost.cue, "blocked");
  assert.equal(EVENTS.back.cue, "back");
  assert.equal(EVENTS.forward.cue, "forward");
  assert.equal(EVENTS.flap.cue, "typing");
});

test("nothing plays before the first gesture (no stale cues), then plays after unlock()", () => {
  const r = rig(), s = r.make();
  assert.equal(s.play("start"), null);
  assert.deepEqual(r.log, []);
  assert.equal(s.unlock(), true);
  assert.equal(s.play("start"), "cue");
  assert.deepEqual(r.log.at(-1), ["cue", "start", undefined]);
});

test("unlock creates ONE player and ONE context however many gestures or remounts happen", () => {
  const r = rig(), s = r.make();
  s.unlock(); s.unlock(); s.unlock();
  assert.deepEqual(r.counts(), { players: 1, contexts: 1 });
  assert.deepEqual(r.log.find((l) => l[0] === "create"), ["create", PACK, 0.2, true, true]); // shared context is passed in
});

test("user files win over the pack, and the pack covers events without a file", async () => {
  const r = rig({ files: { "correct.wav": 1 } }), s = r.make();
  s.unlock(); await settle();
  assert.equal(s.play("correct"), "file");  // correct.wav exists
  assert.equal(s.play("wrong"), "cue");     // wrong.* missing -> uisfx "error"
  assert.deepEqual(r.log.filter((l) => l[0] === "cue").map((l) => l[1]), ["error"]);
});

test("mute: stops everything first, persists, silences all events, and survives a new session", () => {
  const r = rig(), s = r.make();
  s.unlock();
  r.log.length = 0;
  s.setEnabled(false);
  assert.deepEqual(r.log, ["stopAll", ["setEnabled", false]]); // stopAll BEFORE disabling => immediate
  assert.equal(s.play("correct"), null);
  assert.equal(s.play("wrong"), null);
  assert.deepEqual(JSON.parse(r.store[KEY]), { enabled: false, volume: 0.2 });
  const again = r.make(); again.unlock(); // "reload"
  assert.equal(again.enabled, false);
  assert.equal(again.play("correct"), null);
});

test("unmuting plays a single toggle-on cue; volume is clamped and persisted", () => {
  const r = rig({ stored: { [KEY]: JSON.stringify({ enabled: false, volume: 0.4 }) } }), s = r.make();
  s.unlock();
  assert.equal(s.volume, 0.4);
  r.log.length = 0;
  s.setEnabled(true);
  assert.deepEqual(r.log.filter((l) => l[0] === "cue"), [["cue", "toggle-on", undefined]]);
  s.setVolume(7);
  assert.equal(s.volume, 1);
  assert.equal(JSON.parse(r.store[KEY]).volume, 1);
});

test("the older localStorage.muted flag is honoured", () => {
  const r = rig({ stored: { muted: "1" } }), s = r.make();
  assert.equal(s.enabled, false);
});

test("flap uses the brief typing cue at low volume", () => {
  const r = rig(), s = r.make();
  s.unlock();
  s.play("flap");
  assert.deepEqual(r.log.at(-1), ["cue", "typing", { volume: 0.3 }]);
});

test("teardown destroys the player first, then closes the context, and a remount starts clean", async () => {
  const r = rig(), s = r.make();
  s.unlock(); r.log.length = 0;
  await s.destroy();
  assert.deepEqual(r.log, ["destroy", "ctx.close"]);
  assert.equal(s.ready, false);
  assert.equal(s.play("correct"), null);
  s.unlock(); // remount
  assert.equal(s.ready, true);
});
// Not applicable here: loops (the game has no long-running visible process, so none of the six loop cues are used) and
// keyboard/pointer de-duplication (cues are played from state changes, never from raw input events, so one activation = one cue).

test("first visit defaults to 20% volume, and whatever is set afterwards is what's saved and restored", () => {
  assert.equal(DEFAULT_VOLUME, 0.2);
  const r = rig(), s = r.make();
  assert.equal(s.volume, 0.2);          // nothing saved yet
  s.setVolume(0.55);                    // the slider
  assert.deepEqual(JSON.parse(r.store[KEY]), { enabled: true, volume: 0.55 });
  const again = r.make();               // next visit
  assert.equal(again.volume, 0.55);
});

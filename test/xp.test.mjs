// node --test — XP: points x difficulty, perfect and streak bonuses, one award per day+mode, rank-ups.
import test from "node:test";
import assert from "node:assert/strict";
import { award, fresh, rankIndex, liveStreak } from "../xp.mjs";

test("first game: points x difficulty + perfect bonus + day-1 streak bonus", () => {
  const r = award(fresh(), 100, "medium", 20, 5, 5); // 30 + 10 + 2
  assert.equal(r.gain, 42);
  assert.deepEqual([r.state.xp, r.state.streak, r.state.last], [42, 1, 100]);
});
test("no perfect bonus unless every round was solved", () => assert.equal(award(fresh(), 5, "easy", 14, 4, 5).gain, 16));
test("a second game the same day gets no extra streak bonus", () => {
  const a = award(fresh(), 7, "easy", 10, 3, 5).state, b = award(a, 7, "hard", 10, 3, 5);
  assert.equal(b.gain, 20);
  assert.equal(b.state.streak, 1);
});
test("consecutive days grow the streak (bonus capped at 10); a gap resets it", () => {
  let s = fresh(); for (let d = 1; d <= 7; d++) s = award(s, d, "easy", 0, 0, 5).state;
  assert.equal(s.streak, 7); assert.equal(award(s, 8, "easy", 0, 0, 5).gain, 10);
  assert.equal(award(s, 20, "easy", 0, 0, 5).state.streak, 1);
});
test("the same day + difficulty is only paid once", () => {
  const a = award(fresh(), 3, "easy", 20, 5, 5), b = award(a.state, 3, "easy", 20, 5, 5);
  assert.equal(b.gain, a.gain); assert.equal(b.state.xp, a.state.xp);
});
test("crossing a threshold reports the new rank", () => {
  const s = { ...fresh(), xp: 95 }, r = award(s, 1, "easy", 20, 5, 5);
  assert.equal(r.rankUp, "Cadet"); assert.equal(rankIndex(r.state.xp), 1);
});
test("a streak only shows while alive", () => {
  const s = { xp: 0, streak: 4, last: 10, done: {} };
  assert.equal(liveStreak(s, 11), 4); assert.equal(liveStreak(s, 12), 0);
});

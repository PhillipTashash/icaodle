// node --test — XP: points x difficulty, perfect and streak bonuses, one award per day+mode, rank-ups.
import test from "node:test";
import assert from "node:assert/strict";
import { award, fresh, rankIndex, liveStreak, streakXp, streakTotal } from "../xp.mjs";

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
  const s = { ...fresh(), xp: 130 }, r = award(s, 1, "easy", 20, 5, 5);
  assert.equal(r.rankUp, "Cadet"); assert.equal(rankIndex(r.state.xp), 1);
});
test("a streak only shows while alive", () => {
  const s = { xp: 0, streak: 4, last: 10, done: {} };
  assert.equal(liveStreak(s, 11), 4); assert.equal(liveStreak(s, 12), 0);
});
test("first-guess solves in a row: 2nd = 10 XP, 3rd = 15; any wrong guess, skip or loss resets", () => {
  assert.deepEqual([1, 2, 3, 5].map(streakXp), [0, 10, 15, 25]);
  assert.equal(streakTotal([4, 4, 0, 4, 4]), 10 + 10); // run of 2, a loss, run of 2
  assert.equal(streakTotal([4, 4, 3, 4, 4]), 10 + 10); // solved on the 2nd guess: not a streak round, so it ends the run
  assert.equal(streakTotal([4, 4, 4, 4, 4]), 10 + 15 + 20 + 25);
  assert.equal(streakTotal([3, 3, 3, 3, 3]), 0);
  assert.equal(award(fresh(), 9, "easy", 0, 0, 5, [4, 4]).gain, 10 + 2); // streak XP + day-1 daily bonus
});
test("multiple choice earns half the game XP, but the daily-streak bonus is not halved", () => {
  const typed = award(fresh(), 5, "hard", 20, 5, 5, [4, 4, 4, 4, 4]), picked = award(fresh(), 5, "hard", 20, 5, 5, [4, 4, 4, 4, 4], true);
  assert.equal(typed.gain, 40 + 10 + 70 + 2);          // 120 game XP + 2 daily streak
  assert.equal(picked.gain, (40 + 10 + 70) / 2 + 2);   // 60 + 2
});

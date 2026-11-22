// XP and ranks: pure functions over a saved state {xp, streak, last, done}; the page keeps that state in localStorage (per device).
export const RANKS = [[0, "Passenger"], [150, "Cadet"], [400, "First Officer"], [900, "Captain"], [1800, "Chief Pilot"], [3200, "Air Traffic Legend"]];
export const rankIndex = xp => RANKS.filter(([min]) => xp >= min).length - 1;
const MULT = { easy: 1, medium: 1.5, hard: 2 };
export const fresh = () => ({ xp: 0, streak: 0, last: 0, done: {} });
// Rounds solved in a row: the 2nd in a run is worth 10 XP, the 3rd 15, and so on (5 per round in the run). `scores` = points per round, 0 = missed.
export const streakXp = n => (n >= 2 ? 5 * n : 0);
export const streakTotal = scores => { let n = 0, sum = 0; for (const v of scores) { n = v > 0 ? n + 1 : 0; sum += streakXp(n); } return sum; };
// Award a finished daily game, once per day + difficulty. Asking again just replays the same answer, so reopening a finished game can't double-pay.
// gain = points x difficulty, +10 if every round was solved, + the in-game streak XP, + a daily streak bonus (2 per day in a row, up to 10) on the first game of a day.
export function award(s, day, mode, points, right, rounds, scores = []) {
  const k = day + mode;
  if (k in s.done) { const [gain, rankUp] = s.done[k]; return { state: s, gain, rankUp }; }
  let gain = Math.round(points * MULT[mode]) + (right === rounds ? 10 : 0) + streakTotal(scores), streak = s.streak;
  if (s.last !== day) { streak = s.last === day - 1 ? s.streak + 1 : 1; gain += Math.min(streak, 5) * 2; }
  const xp = s.xp + gain, up = rankIndex(xp) > rankIndex(s.xp) ? RANKS[rankIndex(xp)][1] : "";
  return { state: { xp, streak, last: day, done: { ...s.done, [k]: [gain, up] } }, gain, rankUp: up };
}
// The streak counts only while it is alive: you played today or yesterday.
export const liveStreak = (s, today) => (s.last >= today - 1 ? s.streak : 0);

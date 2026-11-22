// XP and ranks: pure functions over a saved state {xp, streak, last, done}; the page keeps that state in localStorage (per device).
export const RANKS = [[0, "Passenger"], [100, "Cadet"], [300, "First Officer"], [700, "Captain"], [1400, "Chief Pilot"], [2500, "Air Traffic Legend"]];
export const rankIndex = xp => RANKS.filter(([min]) => xp >= min).length - 1;
const MULT = { easy: 1, medium: 1.5, hard: 2 };
export const fresh = () => ({ xp: 0, streak: 0, last: 0, done: {} });
// Award a finished daily game, once per day + difficulty. Asking again just replays the same answer, so reopening a finished game can't double-pay.
// gain = points x difficulty, +10 if every round was solved, + a streak bonus (2 per day in a row, up to 10) on the first game of a day.
export function award(s, day, mode, points, right, rounds) {
  const k = day + mode;
  if (k in s.done) { const [gain, rankUp] = s.done[k]; return { state: s, gain, rankUp }; }
  let gain = Math.round(points * MULT[mode]) + (right === rounds ? 10 : 0), streak = s.streak;
  if (s.last !== day) { streak = s.last === day - 1 ? s.streak + 1 : 1; gain += Math.min(streak, 5) * 2; }
  const xp = s.xp + gain, up = rankIndex(xp) > rankIndex(s.xp) ? RANKS[rankIndex(xp)][1] : "";
  return { state: { xp, streak, last: day, done: { ...s.done, [k]: [gain, up] } }, gain, rankUp: up };
}
// The streak counts only while it is alive: you played today or yesterday.
export const liveStreak = (s, today) => (s.last >= today - 1 ? s.streak : 0);

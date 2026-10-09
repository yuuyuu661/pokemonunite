// Shared, deterministic rules. Team IDs stay stable when display names change.
export const TEAM_IDS = [...'ABCDEFGHIJ'];
export const SEED_ORDER = [1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11];
export const ROUND_NAMES = ['1回戦', '準々決勝', '準決勝', '決勝'];
export function emptyTournament(revision = 0) {
  return { slots: Array(10).fill(null), results: {}, revision };
}
export function validateGames(raw) {
  if (!Array.isArray(raw) || raw.length > 3) throw Error('スコアは最大3試合です');
  const games = []; const wins = [0, 0]; let gap = false;
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== 2) throw Error('両チームのスコアを入力してください');
    const blank = row.map(v => v === null || v === '');
    if (blank.every(Boolean)) { gap = true; continue; }
    if (blank.some(Boolean)) throw Error('両チームのスコアを入力してください');
    if (gap) throw Error('第1試合から順番に入力してください');
    if (wins.includes(2)) throw Error('2勝で決着済みです。以降の試合は空欄にしてください');
    if (row.some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 99999)) throw Error('得点は0〜99999の整数で入力してください');
    if (row[0] === row[1]) throw Error('同点では勝敗を確定できません。決着後のスコアを入力してください');
    wins[row[0] > row[1] ? 0 : 1]++;
    games.push([...row]);
  }
  return { games, wins };
}
export function bracket(tournament) {
  let entrants = SEED_ORDER.map(seed => ({ team: seed <= 10 ? tournament.slots[seed - 1] : null, bye: seed > 10, seed }));
  const rounds = [];
  for (let r = 0; r < 4; r++) {
    const matches = []; const next = [];
    for (let i = 0; i < entrants.length; i += 2) {
      const a = entrants[i], b = entrants[i + 1], id = `r${r+1}m${i/2+1}`;
      const saved = tournament.results[id];
      const valid = a.team && b.team && saved?.teams[0] === a.team && saved?.teams[1] === b.team;
      const { games, wins } = validateGames(valid ? saved.games : []);
      const winner = a.bye ? b.team : b.bye ? a.team : wins[0] === 2 ? a.team : wins[1] === 2 ? b.team : null;
      matches.push({ id, a, b, games, wins, winner, bye: a.bye || b.bye });
      next.push({ team: winner, bye: a.bye && b.bye, seed: null });
    }
    rounds.push(matches); entrants = next;
  }
  return rounds;
}
export function setMatchScore(tournament, matchId, raw) {
  if (tournament.slots.some(t => !t)) throw Error('10チームの抽選を完了してください');
  const next = structuredClone(tournament);
  const match = bracket(next).flat().find(m => m.id === matchId);
  if (!match || match.bye || !match.a.team || !match.b.team) throw Error('対戦チームが未確定です');
  const { games } = validateGames(raw);
  next.results[matchId] = { teams: [match.a.team, match.b.team], games };
  // A changed participant invalidates every dependent result, including the final.
  for (const m of bracket(next).flat()) {
    const saved = next.results[m.id];
    if (saved && (saved.teams[0] !== m.a.team || saved.teams[1] !== m.b.team)) delete next.results[m.id];
  }
  next.revision++;
  return next;
}
export function drawTeam(tournament, seed, randomIndex) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 10 || tournament.slots[seed-1]) throw Error('空いている枠を選んでください');
  const remaining = TEAM_IDS.filter(t => !tournament.slots.includes(t));
  const team = remaining[randomIndex];
  if (!team) throw Error('抽選候補がありません');
  const next = structuredClone(tournament);
  next.slots[seed-1] = team; next.revision++;
  return { tournament: next, team };
}

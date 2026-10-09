import { TEAM_IDS } from './public/tournament-rules.js';
export const ADMIN_PASSWORD = 'yamadayamada';
export function defaultSettings() {
  const names = ['syun','眠','める','氷空','ふぜん','あかり','リウ','rRNA','よしだ','イワーク'];
  return {
    revision: 0,
    teamNames: Object.fromEntries(TEAM_IDS.map((t,i) => [t,names[i]])),
    teamPasswords: Object.fromEntries(TEAM_IDS.map((t,i) => [t,process.env[`LEADER_${t}_PASS`] || (i === 9 ? '1010' : String(i+1).repeat(3))])),
    ranks: ['スーパー','ハイパー','エリート','エキスパート','マスター','レジェンド'].map((name,i) => ({ name, points: [5,5,10,10,15,20][i] }))
  };
}
export function publicSettings(settings) {
  return { revision: settings.revision, teamNames: settings.teamNames, ranks: settings.ranks };
}
export function validateSettings(input, current, players) {
  if (!input || input.revision !== current.revision) throw Error('設定が別の画面で更新されています。管理メニューを開き直してください');
  const next = { revision: current.revision + 1, teamNames: {}, teamPasswords: {}, ranks: [] };
  for (const t of TEAM_IDS) {
    const name = input.teamNames?.[t]?.trim(); const pass = input.teamPasswords?.[t];
    if (typeof name !== 'string' || !name || name.length > 40) throw Error('チーム名は1〜40文字です');
    if (typeof pass !== 'string' || !pass.trim() || pass.length > 100) throw Error('各チームのパスワードは1〜100文字です');
    next.teamNames[t] = name; next.teamPasswords[t] = pass;
  }
  if (new Set(Object.values(next.teamNames)).size !== 10) throw Error('チーム名は重複しないようにしてください');
  if (!Array.isArray(input.ranks) || !input.ranks.length || input.ranks.length > 30) throw Error('ランク帯は1〜30件で設定してください');
  for (const rank of input.ranks) {
    const name = typeof rank.name === 'string' ? rank.name.trim() : '';
    if (!name || name.length > 40 || !Number.isInteger(rank.points) || rank.points < 0 || rank.points > 99999) throw Error('ランク名は1〜40文字、ポイントは0〜99999の整数です');
    if (next.ranks.some(r => r.name === name)) throw Error('ランク名が重複しています');
    next.ranks.push({ name, points: rank.points });
  }
  if (players.some(p => !next.ranks.some(r => r.name === p.rank))) throw Error('登録選手が使用中のランクは削除・改名できません。先に選手のランクを変更してください');
  return next;
}

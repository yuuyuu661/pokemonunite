// server.js — Node.js 20 / Express + Socket.IO (ESM)
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { TEAM_IDS, emptyTournament, drawTeam, setMatchScore } from './public/tournament-rules.js';
import { ADMIN_PASSWORD, defaultSettings, publicSettings, validateSettings } from './settings.js';
import { loadOptions, saveSettings, saveTournament } from './db.js';
import {
  initDB,
  loadPlayers,
  savePlayer,
  deletePlayer,
  clearPlayers,
  loadDraft,
  saveDraft,
  resetDraft
} from './db.js';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

// ====== 環境変数 ======
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 5);
const MAX_TEAM   = Number(process.env.MAX_TEAM   || 5);
const ACTION_PASS = process.env.ACTION_PASS || 'ACTION123';
const REQUIRE_LOCKS = String(process.env.REQUIRE_LOCKS || 'false').toLowerCase() === 'true';


// ====== 状態（メモリ） ======
const rooms = new Map();
function emptyDraft(teams=TEAM_IDS){
  return {
    locks: Object.fromEntries(teams.map(t=>[t,false])),
    picks: Object.fromEntries(teams.map(t=>[t, Array(MAX_ROUNDS).fill('')])),
    teams: Object.fromEntries(teams.map(t=>[t, []])),
    state: { mode: 'idle', cycle: 1, round: 0 } // mode: idle | sequential
  };
}
function getRoom(roomId='default'){
  if(!rooms.has(roomId)){
    rooms.set(roomId, {
      players: [],
      draft: emptyDraft(),
      settings: defaultSettings(),
      tournament: emptyTournament(),
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    });
  }
  return rooms.get(roomId);
}
const uid = ()=> crypto.randomBytes(5).toString('hex');
const now = ()=> new Date().toISOString();
const publicRoom = room => ({ ...room, settings: publicSettings(room.settings) });
const roomLoads = new Map();
const roomQueues = new Map();
async function restoreRoom(roomId) {
  if (!roomLoads.has(roomId)) roomLoads.set(roomId, (async () => {
    const state = getRoom(roomId);
    const [players, saved, options] = await Promise.all([loadPlayers(roomId), loadDraft(roomId), loadOptions(roomId)]);
    state.players = players;
    if (saved) {
      const base = emptyDraft();
      state.draft = {
        locks: { ...base.locks, ...saved.locks }, picks: { ...base.picks, ...saved.picks },
        teams: { ...base.teams, ...saved.teams }, state: saved.state || base.state
      };
    }
    state.settings = options.settings || defaultSettings();
    // Preserve any legacy rank already used by registered players.
    for (const p of players) if (!state.settings.ranks.some(r => r.name === p.rank)) state.settings.ranks.push({ name: p.rank, points: p.points });
    state.tournament = options.tournament || emptyTournament();
  })().catch(error => { roomLoads.delete(roomId); throw error; }));
  return roomLoads.get(roomId);
}

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/images', async (_, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'public', 'images'));
    res.json({ files: files.filter(f => /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f)) });
  } catch { res.json({ files: [] }); }
});
app.get('/healthz', (_,res) => res.json({ ok:true, time:now(), teams:TEAM_IDS, rounds:MAX_ROUNDS, maxTeam:MAX_TEAM, requireLocks:REQUIRE_LOCKS }));
io.on('connection', async socket => {
  const roomId = String(socket.handshake.auth?.room || 'default').slice(0,100);
  socket.data.roomId = roomId;
  try { await restoreRoom(roomId); }
  catch (e) { console.error('[DB restore]', e); socket.emit('action:err', { message:'データを読み込めませんでした。再読み込みしてください' }); return socket.disconnect(); }
  if (!socket.connected) return;
  socket.join(roomId);
  const on = (event, handler) => socket.on(event, (...args) => {
    const job = (roomQueues.get(roomId) || Promise.resolve()).then(() => handler(...args)).catch(error => {
      console.error(`[${event}]`, error.message);
      const ack = args.at(-1);
      if (typeof ack === 'function') ack({ ok:false, error:error.message });
      else socket.emit('action:err', { message:error.message });
    });
    roomQueues.set(roomId, job);
  });
  socket.emit('state:init', { state:publicRoom(getRoom(roomId)), maxRounds:MAX_ROUNDS, teams:TEAM_IDS, maxTeam:MAX_TEAM, requireLocks:REQUIRE_LOCKS });
  on('leader:login', ({ pass, team }) => {
    if (TEAM_IDS.includes(team) && getRoom(roomId).settings.teamPasswords[team] === pass) { socket.data.role = team; socket.emit('leader:ok', { role:team }); }
    else socket.emit('leader:err', { message:'パスワードが違います' });
  });
  const checkActionPass = p => p && p === ACTION_PASS;
  on('admin:login', ({ pass } = {}, ack) => {
    socket.data.admin = pass === ADMIN_PASSWORD;
    if (!socket.data.admin) throw Error('パスワードが違います');
    if (typeof ack === 'function') ack({ ok:true, settings:getRoom(roomId).settings });
  });
  on('admin:logout', () => { socket.data.admin = false; });
  const requireAdmin = () => { if (!socket.data.admin) throw Error('管理メニューで認証してください'); };
  const requireRevision = revision => { if (revision !== getRoom(roomId).tournament.revision) throw Error('表が更新されました。最新の対戦内容を確認して再入力してください'); };
  on('admin:settings', async (input, ack) => {
    requireAdmin();
    const room = getRoom(roomId);
    const next = validateSettings(input, room.settings, room.players);
    await saveSettings(roomId, next);
    const changed = TEAM_IDS.filter(t => next.teamPasswords[t] !== room.settings.teamPasswords[t]);
    room.settings = next;
    room.players.forEach(p => { p.points = next.ranks.find(r => r.name === p.rank).points; });
    for (const client of io.sockets.sockets.values()) {
      if (client.data.roomId === roomId && changed.includes(client.data.role)) { client.data.role = null; client.emit('leader:revoked'); }
    }
    io.to(roomId).emit('settings:updated', publicSettings(next));
    io.to(roomId).emit('players:updated', room.players);
    if (typeof ack === 'function') ack({ ok: true, settings: next });
  });
  on('tournament:draw', async ({ seed, revision }, ack) => {
    requireAdmin(); requireRevision(revision);
    const room = getRoom(roomId);
    const count = TEAM_IDS.filter(t => !room.tournament.slots.includes(t)).length;
    if (!count) throw Error('全チームの抽選が完了しています');
    const result = drawTeam(room.tournament, seed, crypto.randomInt(count));
    await saveTournament(roomId, result.tournament);
    room.tournament = result.tournament;
    io.to(roomId).emit('tournament:updated', room.tournament);
    if (typeof ack === 'function') ack({ ok: true, team: result.team, tournament: room.tournament });
  });
  on('tournament:score', async ({ matchId, games, revision }, ack) => {
    requireAdmin(); requireRevision(revision);
    const room = getRoom(roomId);
    const next = setMatchScore(room.tournament, matchId, games);
    await saveTournament(roomId, next); room.tournament = next;
    io.to(roomId).emit('tournament:updated', next);
    if (typeof ack === 'function') ack({ ok: true });
  });
  on('tournament:reset', async ({ revision }, ack) => {
    requireAdmin(); requireRevision(revision);
    const room = getRoom(roomId), next = emptyTournament(room.tournament.revision + 1);
    await saveTournament(roomId, next); room.tournament = next;
    io.to(roomId).emit('tournament:updated', next);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // 選手登録/編集/削除
  on('player:add', async (payload)=>{  // ★ async
    requireAdmin();
    const room = getRoom(roomId);
    if (!room.settings.ranks.some(r => r.name === payload.rank)) throw Error('ランクを選び直してください');
    const player = {
      id: uid(),
      name: String(payload.name||'').slice(0,50),
      rank: payload.rank,
      points: room.settings.ranks.find(r => r.name === payload.rank)?.points ?? 0,
      avatar: payload.avatar || '',
      pokes: Array.isArray(payload.pokes) ? payload.pokes.slice(0,3) : [],
      comment: String(payload.comment||'').slice(0,300)
    };
    room.players.push(player);
    room.lastUpdated = Date.now();
    try { await savePlayer(roomId, player); } catch(e){ console.error('[DB savePlayer add]', e); }

    io.to(roomId).emit('players:updated', room.players);
  });
  on('player:update', async (payload)=>{ // ★ async
    requireAdmin();
    const room = getRoom(roomId);
    if (!room.settings.ranks.some(r => r.name === payload.rank)) throw Error('ランクを選び直してください');
    const ix = room.players.findIndex(p=>p.id===payload.id);
    if(ix < 0) return;

  const p = room.players[ix];
    p.name = String(payload.name||'').slice(0,50);
    p.rank = payload.rank;
    p.points = room.settings.ranks.find(r => r.name === p.rank)?.points ?? 0;
    p.avatar = payload.avatar || '';
    p.pokes = Array.isArray(payload.pokes) ? payload.pokes.slice(0,3) : [];
    p.comment = String(payload.comment||'').slice(0,300);
    room.lastUpdated = Date.now();

      // ★ DB保存（ここ！）
      try { await savePlayer(roomId, p); } catch(e){ console.error('[DB savePlayer update]', e); }

      io.to(roomId).emit('players:updated', room.players);
      io.to(socket.id).emit('player:updated:ok', { id: payload.id });
    });
  on('player:delOne', async ({ id, actionPass })=>{ // ★ async
    if(!checkActionPass(actionPass)) return socket.emit('action:err', { message: '操作パスワードが違います' });
    const room = getRoom(roomId);
    const d = room.draft;

    room.players = room.players.filter(x=>x.id!==id);
    for(const t of TEAM_IDS){
      d.picks[t] = d.picks[t].map(x=>x===id?'':x);
      d.teams[t] = d.teams[t].filter(x=>x!==id);
    }

    room.lastUpdated = Date.now();

    // ★ DB反映：選手削除 + ドラフト保存（ここ！）
    try { await deletePlayer(roomId, id); } catch(e){ console.error('[DB deletePlayer]', e); }
    try { await saveDraft(roomId, d); } catch(e){ console.error('[DB saveDraft after del]', e); }

    io.to(roomId).emit('state:updated', publicRoom(room));
  });
  on('players:clearAll', async ({ actionPass })=>{
    if(!checkActionPass(actionPass)) return socket.emit('action:err', { message: '操作パスワードが違います' });

    const room = getRoom(roomId);
    room.players = [];
    room.draft = emptyDraft();
    room.lastUpdated = Date.now();

    // ★ DB反映（ここ！）
    try { await clearPlayers(roomId); } catch(e){ console.error('[DB clearPlayers]', e); }
    try { await resetDraft(roomId); } catch(e){ console.error('[DB resetDraft]', e); }

    io.to(roomId).emit('state:updated', publicRoom(room));
  });

  // ドラフト：指名/ロック
  on('draft:pick', async ({ team, round, playerId })=>{
    const room = getRoom(roomId); const d = room.draft; const role = socket.data.role;
    if(!role || team !== role) return;
    if(!Number.isInteger(round) || round<0 || round>=MAX_ROUNDS) return;
    if(d.locks[team]) return;
    const exists = room.players.some(p=>p.id===playerId) || playerId==='';
    if(!exists) return;

    d.picks[team][round] = playerId;
    room.lastUpdated = Date.now();

    // ★ DB保存（ここ！）
    try { await saveDraft(roomId, d); } catch(e){ console.error('[DB saveDraft pick]', e); }

    io.to(roomId).emit('draft:picksUpdated', d.picks);
  });
  on('draft:lock', async ({ team, locked })=>{
    const room = getRoom(roomId); const d = room.draft; const role = socket.data.role;
    if(!role || team !== role) return;

    d.locks[team] = !!locked;
    room.lastUpdated = Date.now();

    // ★ DB保存（ここ！）
    try { await saveDraft(roomId, d); } catch(e){ console.error('[DB saveDraft lock]', e); }

    io.to(roomId).emit('draft:locksUpdated', d.locks);
  });

  // ========= 開示 → 一斉進行 =========
  const rnd100 = ()=> 1 + Math.floor(Math.random()*100);

  // 開示：ロック済みチームの現在ラウンドを全員に見せる
  on('draft:revealLocked', ()=>{
    const room = getRoom(roomId); const d = room.draft;
    if(d.state.mode === 'idle'){ d.state = { mode:'sequential', cycle: d.state.cycle || 1, round: d.state.round || 0 }; }
    const r = d.state.round;
    const entries = [];
    for(const t of TEAM_IDS){
      if(!d.locks[t]) continue;
      const pid = d.picks[t][r] || '';
      if(!pid) continue;
      const p = room.players.find(x=>x.id===pid);
      entries.push({ team:t, playerId:pid, name:p?.name||'(未登録)', points:p?.points??0 });
    }
    io.to(roomId).emit('draft:preview', { round: r+1, cycle: d.state.cycle, entries });
  });

  // 進行：ロック済み分のみ一斉解決（※ここではロックを解除しない）
  on('draft:progress', async ()=>{
    const room = getRoom(roomId); const d = room.draft;
    if(d.state.mode !== 'sequential') d.state = { mode:'sequential', cycle: 1, round: 0 };
    const r = d.state.round;
    const logs = [];

    if(REQUIRE_LOCKS){
      const allLocked = TEAM_IDS.every(t => d.locks[t] === true);
      if(!allLocked){
        return io.to(socket.id).emit('action:err', { message: '全チームのロックが必要です（REQUIRE_LOCKS=true）' });
      }
    }

    const byPlayer = new Map();
    for(const t of TEAM_IDS){
      if(!d.locks[t]) continue; // ロック済みのみ対象
      const pid = d.picks[t][r] || '';
      if(!pid) continue;
      if(!byPlayer.has(pid)) byPlayer.set(pid, []);
      byPlayer.get(pid).push(t);
    }

    if(byPlayer.size===0){
      logs.push(`R${r+1} (Cycle ${d.state.cycle}): 対象なし（ロック済みなし or 指名なし）`);
    }else{
      for(const [pid, teams] of byPlayer.entries()){
        if(TEAM_IDS.some(t=> d.teams[t].includes(pid))) continue;
        const contenders = teams.filter(t => (d.teams[t].length < MAX_TEAM));
        if(contenders.length===0){
          logs.push(`R${r+1}: 全候補チームが定員(${MAX_TEAM})でスキップ`);
          continue;
        }
        if(contenders.length===1){
          const t = contenders[0];
          d.teams[t].push(pid);
          logs.push(`R${r+1}: ${t} が獲得`);
        }else{
          let pool = contenders.slice();
          let roundLog = [];
          while(pool.length>1){
            const rolls = pool.map(t => [t, rnd100()]);
            const max = Math.max(...rolls.map(r=>r[1]));
            const top = rolls.filter(r=>r[1]===max).map(r=>r[0]);
            roundLog.push(rolls.map(([t,v])=>`${t}:${v}`).join(' / '));
            pool = top;
          }
          const winner = pool[0];
          d.teams[winner].push(pid);
          logs.push(`R${r+1}: 競合(${contenders.join(', ')}) → ${roundLog.join(' → ')} → ${winner} が獲得`);
        }
      }
    }

    // ★ ここではロックを解除しない（維持）
    // 次ラウンドへ
    d.state.round += 1;

    // ラウンド完了（= 5番目まで処理）したら、ここで初めてロック解除
    if(d.state.round >= MAX_ROUNDS){
      const allFull = TEAM_IDS.every(t => d.teams[t].length >= MAX_TEAM);
      // 一旦全ロック解除（次サイクルのため）
      for(const t of TEAM_IDS) d.locks[t] = false;

      if(allFull){
        d.state = { mode: 'idle', cycle: d.state.cycle, round: MAX_ROUNDS };
        logs.push(`ドラフト完了（全チーム定員 ${MAX_TEAM}）`);
        await saveDraft(roomId, d);
        io.to(roomId).emit('draft:resolved', { draft: d, logs });
        io.to(roomId).emit('draft:locksUpdated', d.locks);
        io.to(roomId).emit('draft:state', d.state);
        io.to(roomId).emit('state:updated', publicRoom(getRoom(roomId)));
        return;
      }else{
        // 未充足チームがある → 次サイクルへ（指名欄クリア・ロックは解除済み）
        d.state = { mode: 'sequential', cycle: d.state.cycle + 1, round: 0 };
        for(const t of TEAM_IDS){ d.picks[t] = Array(MAX_ROUNDS).fill(''); }
        logs.push(`Cycle ${d.state.cycle} 開始：未充足チームがあるため再指名へ`);
      }
    }
    try { await saveDraft(roomId, d); } catch(e){ console.error('[DB saveDraft progress]', e); }

    // ブロードキャスト
    io.to(roomId).emit('draft:resolved', { draft: d, logs });
    io.to(roomId).emit('draft:picksUpdated', d.picks);
    io.to(roomId).emit('draft:locksUpdated', d.locks);
    io.to(roomId).emit('draft:state', d.state);
    io.to(roomId).emit('state:updated', publicRoom(getRoom(roomId)));
  });

  // 初期化
  on('draft:reset', async ()=>{
    const room = getRoom(roomId);
    room.draft = emptyDraft();
    room.lastUpdated = Date.now();

    // ★ DB反映（ここ！）
    try { await resetDraft(roomId); } catch(e){ console.error('[DB resetDraft event]', e); }

    io.to(roomId).emit('state:updated', publicRoom(room));
    io.to(roomId).emit('draft:state', room.draft.state);
  });


});



const PORT = process.env.PORT || 8080;
await initDB();
server.listen(PORT, ()=> console.log(`[server] listening on :${PORT}`));










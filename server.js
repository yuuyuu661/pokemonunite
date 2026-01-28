// server.js — Node.js 20 / Express + Socket.IO (ESM)
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs/promises';
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
const TEAM_IDS = (process.env.TEAMS || 'A,B,C,D,E,F,G,H,I').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 5);
const MAX_TEAM   = Number(process.env.MAX_TEAM   || 5);
const ACTION_PASS = process.env.ACTION_PASS || 'ACTION123';
const REQUIRE_LOCKS = String(process.env.REQUIRE_LOCKS || 'false').toLowerCase() === 'true';

// チームパス
const defaultPass = ['111','222','333','444','555','666','777','888','999','1010','1111','1212',];
const teamPasses = Object.fromEntries(TEAM_IDS.map((t, i)=>{
  const envKey = `LEADER_${t}_PASS`;
  const fallback = defaultPass[i] || `PASS${t}`;
  return [t, process.env[envKey] || fallback];
}));

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
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    });
  }
  return rooms.get(roomId);
}
const uid = ()=> crypto.randomBytes(5).toString('hex');
const now = ()=> new Date().toISOString();

const pointsByRank = {
  'ビギナー':5,'スーパー':5,'ハイパー':10,'エリート':10,
  'エキスパート':15,'マスター':15,'レジェンド':20
};

// ====== 静的配信 & 画像一覧 ======
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.get('/', (_, res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/images', async (_, res)=>{
  try{
    const dir = path.join(__dirname, 'public', 'images');
    const files = await fs.readdir(dir);
    const allow = new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.svg']);
    const list = files.filter(f=> allow.has(path.extname(f).toLowerCase()));
    res.json({ files: list });
  }catch{ res.json({ files: [] }); }
});
app.get('/healthz', (_,res)=> res.json({
  ok:true, time: now(), teams: TEAM_IDS, rounds: MAX_ROUNDS, maxTeam: MAX_TEAM, requireLocks: REQUIRE_LOCKS
}));

// ====== Socket.IO ======
io.on('connection', async (socket) => { // ★ async を付ける
  const { room: roomQuery } = socket.handshake.auth || {};
  const roomId = (roomQuery && String(roomQuery)) || 'default';
  socket.join(roomId);
  socket.data.roomId = roomId;

  const state = getRoom(roomId);

  // ★ DBから復元（初回接続時）
  try {
    const dbPlayers = await loadPlayers(roomId);
    const dbDraftRow = await loadDraft(roomId);

    if (dbPlayers?.length) state.players = dbPlayers;

    if (dbDraftRow) {
      state.draft = {
        locks: dbDraftRow.locks || Object.fromEntries(TEAM_IDS.map(t=>[t,false])),
        picks: dbDraftRow.picks || Object.fromEntries(TEAM_IDS.map(t=>[t, Array(MAX_ROUNDS).fill('')])),
        teams: dbDraftRow.teams || Object.fromEntries(TEAM_IDS.map(t=>[t, []])),
        state: dbDraftRow.state || { mode:'idle', cycle: 1, round: 0 },
      };
    }
  } catch (e) {
    console.error('[DB restore error]', e);
    // DB不調でもメモリで動くように継続
  }

  socket.emit('state:init', {
    state,
    maxRounds: MAX_ROUNDS,
    teams: TEAM_IDS,
    maxTeam: MAX_TEAM,
    requireLocks: REQUIRE_LOCKS
  });

  // 認証
  socket.on('leader:login', ({ pass })=>{
    const hit = TEAM_IDS.find(t => pass === teamPasses[t]);
    if(hit){ socket.data.role = hit; socket.emit('leader:ok', { role: hit }); }
    else { socket.emit('leader:err', { message: 'パスワードが違います' }); }
  });

  // 操作パス検証
  const checkActionPass = (p)=> p && p === ACTION_PASS;

  // 選手登録/編集/削除
  socket.on('player:add', async (payload)=>{  // ★ async
    if(!checkActionPass(payload?.actionPass)) return socket.emit('action:err', { message: '操作パスワードが違います' });
    const room = getRoom(roomId);
    const player = {
      id: uid(),
      name: String(payload.name||'').slice(0,50),
      rank: payload.rank,
      points: pointsByRank[payload.rank] ?? 0,
      avatar: payload.avatar || '',
      pokes: Array.isArray(payload.pokes) ? payload.pokes.slice(0,3) : [],
      comment: String(payload.comment||'').slice(0,300)
    };
    room.players.push(player);
    room.lastUpdated = Date.now();
    try { await savePlayer(roomId, player); } catch(e){ console.error('[DB savePlayer add]', e); }

    io.to(roomId).emit('players:updated', room.players);
  });
  socket.on('player:update', async (payload)=>{ // ★ async
    if(!checkActionPass(payload?.actionPass)) return socket.emit('action:err', { message: '操作パスワードが違います' });
    const room = getRoom(roomId);
    const ix = room.players.findIndex(p=>p.id===payload.id);
    if(ix < 0) return;

  const p = room.players[ix];
    p.name = String(payload.name||'').slice(0,50);
    p.rank = payload.rank;
    p.points = pointsByRank[p.rank] ?? 0;
    p.avatar = payload.avatar || '';
    p.pokes = Array.isArray(payload.pokes) ? payload.pokes.slice(0,3) : [];
    p.comment = String(payload.comment||'').slice(0,300);
    room.lastUpdated = Date.now();

      // ★ DB保存（ここ！）
      try { await savePlayer(roomId, p); } catch(e){ console.error('[DB savePlayer update]', e); }

      io.to(roomId).emit('players:updated', room.players);
      io.to(socket.id).emit('player:updated:ok', { id: payload.id });
    });
  socket.on('player:delOne', async ({ id, actionPass })=>{ // ★ async
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

    io.to(roomId).emit('state:updated', room);
  });
  socket.on('players:clearAll', async ({ actionPass })=>{
    if(!checkActionPass(actionPass)) return socket.emit('action:err', { message: '操作パスワードが違います' });

    const room = getRoom(roomId);
    room.players = [];
    room.draft = emptyDraft();
    room.lastUpdated = Date.now();

    // ★ DB反映（ここ！）
    try { await clearPlayers(roomId); } catch(e){ console.error('[DB clearPlayers]', e); }
    try { await resetDraft(roomId); } catch(e){ console.error('[DB resetDraft]', e); }

    io.to(roomId).emit('state:updated', room);
  });

  // ドラフト：指名/ロック
  socket.on('draft:pick', async ({ team, round, playerId })=>{
    const room = getRoom(roomId); const d = room.draft; const role = socket.data.role;
    if(!role || team !== role) return;
    if(round<0 || round>=MAX_ROUNDS) return;
    if(d.locks[team]) return;
    const exists = room.players.some(p=>p.id===playerId) || playerId==='';
    if(!exists) return;

    d.picks[team][round] = playerId;
    room.lastUpdated = Date.now();

    // ★ DB保存（ここ！）
    try { await saveDraft(roomId, d); } catch(e){ console.error('[DB saveDraft pick]', e); }

    io.to(roomId).emit('draft:picksUpdated', d.picks);
  });
  socket.on('draft:lock', async ({ team, locked })=>{
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
  socket.on('draft:revealLocked', ()=>{
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
  socket.on('draft:progress', async ()=>{
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
        io.to(roomId).emit('draft:resolved', { draft: d, logs });
        io.to(roomId).emit('draft:locksUpdated', d.locks);
        io.to(roomId).emit('draft:state', d.state);
        io.to(roomId).emit('state:updated', getRoom(roomId));
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
    io.to(roomId).emit('state:updated', getRoom(roomId));
  });

  // 初期化
  socket.on('draft:reset', async ()=>{
    const room = getRoom(roomId);
    room.draft = emptyDraft();
    room.lastUpdated = Date.now();

    // ★ DB反映（ここ！）
    try { await resetDraft(roomId); } catch(e){ console.error('[DB resetDraft event]', e); }

    io.to(roomId).emit('state:updated', room);
    io.to(roomId).emit('draft:state', room.draft.state);
  });

  // バックアップ
  socket.on('backup:export', ({ actionPass })=>{
    if(!checkActionPass(actionPass)) return socket.emit('action:err', { message: '操作パスワードが違います' });
    const room = getRoom(roomId);
    io.to(socket.id).emit('backup:data', { ver:1, players: room.players, draft: room.draft });
  });
  socket.on('backup:import', (data)=>{
    const room = getRoom(roomId);
    if(!data || !Array.isArray(data.players) || !data.draft) return;
    room.players = data.players;
    room.draft = data.draft;
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
    io.to(roomId).emit('draft:state', room.draft.state);
  });
});



const PORT = process.env.PORT || 8080;
await initDB();
server.listen(PORT, ()=> console.log(`[server] listening on :${PORT}`));










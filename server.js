// server.js — Node.js 20 / Express + Socket.IO (ESM)
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs/promises';

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
const ACTION_PASS = process.env.ACTION_PASS || 'ACTION123'; // 登録/編集/削除/全削除/エクスポート

// チームごとのドラフト操作パス（LEADER_A_PASS など）
const defaultPass = ['ABC','DEF','GHI','JKL','MNO','PQR','STU','VWX','YZA'];
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
      players: [], // {id,name,rank,points,avatar,pokes[0..2],comment}
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
  'エキスパート':15,'マスター1200':15,'マスター1400～1600':20
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
  }catch{
    res.json({ files: [] });
  }
});

// health
app.get('/healthz', (_,res)=> res.json({ ok:true, time: now(), teams: TEAM_IDS, rounds: MAX_ROUNDS, maxTeam: MAX_TEAM }));

// ====== Socket.IO ======
io.on('connection', (socket)=>{
  const { room: roomQuery } = socket.handshake.auth || {};
  const roomId = (roomQuery && String(roomQuery)) || 'default';
  socket.join(roomId);
  socket.data.roomId = roomId;

  const state = getRoom(roomId);
  socket.emit('state:init', { state, maxRounds: MAX_ROUNDS, teams: TEAM_IDS, maxTeam: MAX_TEAM });

  // --- 認証：ドラフト操作権 ---
  socket.on('leader:login', ({ pass })=>{
    const hit = TEAM_IDS.find(t => pass === teamPasses[t]);
    if(hit){ socket.data.role = hit; socket.emit('leader:ok', { role: hit }); }
    else { socket.emit('leader:err', { message: 'パスワードが違います' }); }
  });

  // --- 操作パス検証 ---
  const checkActionPass = (p)=> p && p === ACTION_PASS;

  // --- 選手登録 ---
  socket.on('player:add', (payload)=>{
    if(!checkActionPass(payload?.actionPass))
      return socket.emit('action:err', { message: '操作パスワードが違います' });

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
    io.to(roomId).emit('players:updated', room.players);
  });

  // --- 選手編集 ---
  socket.on('player:update', (payload)=>{
    if(!checkActionPass(payload?.actionPass))
      return socket.emit('action:err', { message: '操作パスワードが違います' });

    const room = getRoom(roomId);
    const { id } = payload || {};
    const ix = room.players.findIndex(p=>p.id===id);
    if(ix < 0) return;

    const p = room.players[ix];
    p.name = String(payload.name||'').slice(0,50);
    p.rank = payload.rank;
    p.points = pointsByRank[p.rank] ?? 0;
    p.avatar = payload.avatar || '';
    p.pokes = Array.isArray(payload.pokes) ? payload.pokes.slice(0,3) : [];
    p.comment = String(payload.comment||'').slice(0,300);

    room.lastUpdated = Date.now();
    io.to(roomId).emit('players:updated', room.players);
    io.to(socket.id).emit('player:updated:ok', { id });
  });

  // --- 個別削除 ---
  socket.on('player:delOne', ({ id, actionPass })=>{
    if(!checkActionPass(actionPass))
      return socket.emit('action:err', { message: '操作パスワードが違います' });

    const room = getRoom(roomId);
    const existed = room.players.some(p=>p.id===id);
    room.players = room.players.filter(x=>x.id!==id);

    // draft参照からも除外
    const d = room.draft;
    for(const t of TEAM_IDS){
      d.picks[t] = d.picks[t].map(x=>x===id?'':x);
      d.teams[t] = d.teams[t].filter(x=>x!==id);
    }

    room.lastUpdated = Date.now();
    if(existed) io.to(roomId).emit('state:updated', room);
  });

  // --- 一括削除 ---
  socket.on('players:clearAll', ({ actionPass })=>{
    if(!checkActionPass(actionPass))
      return socket.emit('action:err', { message: '操作パスワードが違います' });

    const room = getRoom(roomId);
    room.players = [];
    room.draft = emptyDraft();
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
  });

  // --- ドラフト：指名 ---
  socket.on('draft:pick', ({ team, round, playerId })=>{
    const room = getRoom(roomId);
    const d = room.draft;
    const role = socket.data.role;
    if(!role) return;
    if(team !== role) return;                 // 他チーム操作不可
    if(round<0 || round>=MAX_ROUNDS) return;
    if(d.locks[team]) return;                 // ロック中は変更不可
    const exists = room.players.some(p=>p.id===playerId) || playerId==='';
    if(!exists) return;

    d.picks[team][round] = playerId;
    room.lastUpdated = Date.now();
    io.to(roomId).emit('draft:picksUpdated', d.picks);
  });

  // --- ドラフト：ロック ---
  socket.on('draft:lock', ({ team, locked })=>{
    const room = getRoom(roomId); const d = room.draft;
    const role = socket.data.role;
    if(!role) return;
    if(team !== role) return;

    d.locks[team] = !!locked;
    room.lastUpdated = Date.now();
    io.to(roomId).emit('draft:locksUpdated', d.locks); // 全員に即反映（可視化）
  });

  // ====== 逐次進行モード ======
  const rnd100 = ()=> 1 + Math.floor(Math.random()*100);

  // 開始
  socket.on('draft:start', ()=>{
    const room = getRoom(roomId); const d = room.draft;
    d.state = { mode: 'sequential', cycle: 1, round: 0 };
    // 「開始時点では各チームがラウンド0の指名→ロック」を行う
    io.to(roomId).emit('draft:state', d.state);
  });

  // 次へ（ラウンド逐次）
  socket.on('draft:next', ()=>{
    const room = getRoom(roomId); const d = room.draft;
    if(d.state.mode !== 'sequential') return;

    const r = d.state.round; // 0-index
    // 進行には全チームロック済みを要求（ロック見える化済）
    const allLocked = TEAM_IDS.every(t => d.locks[t] === true);
    if(!allLocked){
      return io.to(socket.id).emit('action:err', { message: '全チームのロックが必要です' });
    }

    const logs = [];
    // ラウンド r の公開＆解決
    const byPlayer = new Map(); // playerId -> teams[]
    for(const t of TEAM_IDS){
      const pid = d.picks[t][r] || '';
      if(!pid) continue;
      if(!byPlayer.has(pid)) byPlayer.set(pid, []);
      byPlayer.get(pid).push(t);
    }
    if(byPlayer.size===0){
      logs.push(`R${r+1} (Cycle ${d.state.cycle}): 指名なし`);
    }else{
      for(const [pid, teams] of byPlayer.entries()){
        // 既に確保済み or 上限到達チームはスキップ考慮
        const alreadyTaken = TEAM_IDS.some(t=> d.teams[t].includes(pid));
        if(alreadyTaken) continue;

        // 競合解決（d100）。既に満員のチームは候補から除外。
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
          // d100 ロール → 最大値勝ち。同値は勝者同値間で再抽選
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

    // ラウンド処理後：全ロック解除（次ラウンドの指名へ）
    for(const t of TEAM_IDS) d.locks[t] = false;

    // 次ラウンドへ
    d.state.round += 1;

    // ラウンドが一巡したら、全チームの定員チェック
    if(d.state.round >= MAX_ROUNDS){
      const allFull = TEAM_IDS.every(t => d.teams[t].length >= MAX_TEAM);
      if(allFull){
        d.state = { mode: 'idle', cycle: d.state.cycle, round: MAX_ROUNDS };
        logs.push(`ドラフト完了（全チーム定員 ${MAX_TEAM}）`);
        io.to(roomId).emit('draft:resolved', { draft: d, logs });
        io.to(roomId).emit('draft:locksUpdated', d.locks);
        io.to(roomId).emit('draft:state', d.state);
        io.to(roomId).emit('state:updated', getRoom(roomId));
        return;
      }else{
        // 未充足チームがある → 次サイクルへ。各チームは再び1〜MAX_ROUNDSを選択。
        d.state = { mode: 'sequential', cycle: d.state.cycle + 1, round: 0 };
        // 次サイクル用に picks をクリア（未充足チームのみでもよいが、全体をクリアして再指名を促す）
        for(const t of TEAM_IDS){
          d.picks[t] = Array(MAX_ROUNDS).fill('');
        }
        logs.push(`Cycle ${d.state.cycle} 開始：未充足チームがあるため再指名へ`);
      }
    }

    // ブロードキャスト
    io.to(roomId).emit('draft:resolved', { draft: d, logs });
    io.to(roomId).emit('draft:picksUpdated', d.picks);
    io.to(roomId).emit('draft:locksUpdated', d.locks);
    io.to(roomId).emit('draft:state', d.state);
    io.to(roomId).emit('state:updated', getRoom(roomId));
  });

  // --- ドラフト初期化 ---
  socket.on('draft:reset', ()=>{
    const room = getRoom(roomId);
    room.draft = emptyDraft();
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
    io.to(roomId).emit('draft:state', room.draft.state);
  });

  // --- バックアップ ---
  socket.on('backup:export', ({ actionPass })=>{
    if(!checkActionPass(actionPass))
      return socket.emit('action:err', { message: '操作パスワードが違います' });

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
server.listen(PORT, ()=> console.log(`[server] listening on :${PORT}`));

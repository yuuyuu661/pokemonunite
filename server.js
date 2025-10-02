// server.js
// Node 20 / Express + Socket.IO
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();
const __dirname = process.cwd();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

// ====== 設定 ======
const LEADER_A_PASS = process.env.LEADER_A_PASS || 'ABC';
const LEADER_B_PASS = process.env.LEADER_B_PASS || 'DEF';
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 5);

// ルーム毎の状態をメモリで保持
// ※ Railway再起動で消えます。永続化はRedis/DBへ差し替え推奨。
const rooms = new Map();
function getRoom(roomId = 'default') {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: [], // {id, name, rank, points, avatar(dataURL), pokes[3], comment}
      draft: {
        aLocked: false,
        bLocked: false,
        aPicks: Array(MAX_ROUNDS).fill(''),
        bPicks: Array(MAX_ROUNDS).fill(''),
        teamA: [],
        teamB: [],
      },
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function uid() { return crypto.randomBytes(5).toString('hex'); }
function now() { return new Date().toISOString(); }

// 静的配信
app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ヘルスチェック
app.get('/healthz', (_, res) => res.json({ ok: true, time: now() }));

// ====== Socket.IO ======
io.on('connection', (socket) => {
  // クライアントから auth.room を受けてルーム選択（未指定は default）
  const { room: roomQuery } = socket.handshake.auth || {};
  const roomId = (roomQuery && String(roomQuery)) || 'default';
  socket.join(roomId);
  socket.data.roomId = roomId;

  const state = getRoom(roomId);

  // 初期同期
  socket.emit('state:init', { state, maxRounds: MAX_ROUNDS });

  // ====== 認証（ドラフト操作権） ======
  socket.on('leader:login', ({ pass }) => {
    if (pass === LEADER_A_PASS) {
      socket.data.role = 'A';
      socket.emit('leader:ok', { role: 'A' });
    } else if (pass === LEADER_B_PASS) {
      socket.data.role = 'B';
      socket.emit('leader:ok', { role: 'B' });
    } else {
      socket.emit('leader:err', { message: 'パスワードが違います' });
    }
  });

  // ====== 選手登録 ======
  socket.on('player:add', (p) => {
    const room = getRoom(roomId);
    const pointsByRank = {
      'ビギナー': 5, 'スーパー': 5, 'ハイパー': 10, 'エリート': 10,
      'エキスパート': 15, 'マスター1200': 15, 'マスター1400～1600': 20,
    };
    const id = uid();
    const player = {
      id,
      name: (p.name || '').slice(0, 50),
      rank: p.rank,
      points: pointsByRank[p.rank] ?? 0,
      avatar: p.avatar || '',
      pokes: Array.isArray(p.pokes) ? p.pokes.slice(0, 3) : [],
      comment: (p.comment || '').slice(0, 300)
    };
    room.players.push(player);
    room.lastUpdated = Date.now();
    io.to(roomId).emit('players:updated', room.players);
  });

  socket.on('player:del', ({ id }) => {
    const room = getRoom(roomId);
    room.players = room.players.filter(x => x.id !== id);
    // ドラフトの既存参照もクリーン
    const d = room.draft;
    d.aPicks = d.aPicks.map(x => x === id ? '' : x);
    d.bPicks = d.bPicks.map(x => x === id ? '' : x);
    d.teamA = d.teamA.filter(x => x !== id);
    d.teamB = d.teamB.filter(x => x !== id);
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
  });

  // ====== ドラフト操作 ======
  socket.on('draft:pick', ({ side, round, playerId }) => {
    const room = getRoom(roomId);
    const d = room.draft;
    if (side !== 'a' && side !== 'b') return;
    if (round < 0 || round >= MAX_ROUNDS) return;
    const role = socket.data.role; // 'A' or 'B'
    if (!role) return; // 未ログイン
    if ((side === 'a' && role !== 'A') || (side === 'b' && role !== 'B')) return; // 権限違い
    if ((side === 'a' && d.aLocked) || (side === 'b' && d.bLocked)) return; // ロック中

    const exists = room.players.some(p => p.id === playerId) || playerId === '';
    if (!exists) return;
    if (side === 'a') d.aPicks[round] = playerId; else d.bPicks[round] = playerId;
    room.lastUpdated = Date.now();
    io.to(roomId).emit('draft:picksUpdated', { aPicks: d.aPicks, bPicks: d.bPicks });
  });

  socket.on('draft:lock', ({ side, locked }) => {
    const room = getRoom(roomId);
    const d = room.draft;
    const role = socket.data.role;
    if (!role) return;
    if (side === 'a' && role === 'A') d.aLocked = !!locked;
    if (side === 'b' && role === 'B') d.bLocked = !!locked;
    room.lastUpdated = Date.now();
    io.to(roomId).emit('draft:locksUpdated', { aLocked: d.aLocked, bLocked: d.bLocked });
  });

  socket.on('draft:reveal', () => {
    const room = getRoom(roomId);
    const d = room.draft;
    // 両者ロック必須
    if (!(d.aLocked && d.bLocked)) return;

    const logs = [];
    const rnd = () => 1 + Math.floor(Math.random() * 6);

    for (let i = 0; i < MAX_ROUNDS; i++) {
      const pickA = d.aPicks[i];
      const pickB = d.bPicks[i];
      if (!pickA && !pickB) { logs.push(`R${i + 1}: どちらも未選択`); continue; }

      // すでに確保済みはスキップ（実害防止）
      if (pickA && (d.teamA.includes(pickA) || d.teamB.includes(pickA))) { /* skip */ }
      if (pickB && (d.teamA.includes(pickB) || d.teamB.includes(pickB))) { /* skip */ }

      if (pickA && pickB && pickA === pickB) {
        // 競合: ダイス
        let aRoll = rnd();
        let bRoll = rnd();
        if (aRoll === bRoll) {
          logs.push(`R${i + 1}: 競合 → 同値(${aRoll}) → 再抽選`);
          aRoll = rnd(); bRoll = rnd();
        }
        const winner = aRoll >= bRoll ? 'A' : 'B';
        (winner === 'A' ? d.teamA : d.teamB).push(pickA);
        logs.push(`R${i + 1}: 競合 → A:${aRoll} / B:${bRoll} → ${winner} 獲得`);
      } else {
        if (pickA && (!pickB || pickA !== pickB)) {
          if (!d.teamA.includes(pickA) && !d.teamB.includes(pickA)) {
            d.teamA.push(pickA); logs.push(`R${i + 1}: Aが獲得`);
          }
        }
        if (pickB && (!pickA || pickA !== pickB)) {
          if (!d.teamA.includes(pickB) && !d.teamB.includes(pickB)) {
            d.teamB.push(pickB); logs.push(`R${i + 1}: Bが獲得`);
          }
        }
      }
    }

    // 次ラウンドへ備えてロック解除
    d.aLocked = false; d.bLocked = false;
    room.lastUpdated = Date.now();

    io.to(roomId).emit('draft:resolved', { draft: d, logs });
    io.to(roomId).emit('state:updated', room);
  });

  socket.on('draft:reset', () => {
    const room = getRoom(roomId);
    room.draft = {
      aLocked: false, bLocked: false,
      aPicks: Array(MAX_ROUNDS).fill(''),
      bPicks: Array(MAX_ROUNDS).fill(''),
      teamA: [], teamB: []
    };
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
  });

  // バックアップ
  socket.on('backup:export', () => {
    const room = getRoom(roomId);
    socket.emit('backup:data', { ver: 1, players: room.players, draft: room.draft });
  });
  socket.on('backup:import', (data) => {
    const room = getRoom(roomId);
    if (!data || !Array.isArray(data.players) || !data.draft) return;
    room.players = data.players;
    room.draft = data.draft;
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
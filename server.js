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
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

// ====== 環境変数 ======
const TEAM_IDS = (process.env.TEAMS || 'A,B,C,D,E,F').split(',').map(s => s.trim()).filter(Boolean);
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 5);
const ACTION_PASS = process.env.ACTION_PASS || 'ACTION123';

// チームごとのパス（例: LEADER_A_PASS=...）
const teamPasses = Object.fromEntries(TEAM_IDS.map((t, i) => {
  const envKey = `LEADER_${t}_PASS`;
  const fallback = ['ABC','DEF','GHI','JKL','MNO','PQR'][i] || `PASS${t}`;
  return [t, process.env[envKey] || fallback];
}));

// ====== 状態 ======
const rooms = new Map();
function emptyDraft() {
  return {
    locks: Object.fromEntries(TEAM_IDS.map(t => [t, false])),
    picks: Object.fromEntries(TEAM_IDS.map(t => [t, Array(MAX_ROUNDS).fill('')])),
    teams: Object.fromEntries(TEAM_IDS.map(t => [t, []])),
  };
}
function getRoom(roomId = 'default') {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: [],
      draft: emptyDraft(),
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    });
  }
  return rooms.get(roomId);
}
const uid = () => crypto.randomBytes(5).toString('hex');
const now = () => new Date().toISOString();

// ====== 静的ファイルと画像配信 ======
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 画像一覧 API
app.get('/api/images', async (req, res) => {
  try {
    const dir = path.join(__dirname, 'public', 'images');
    const files = await fs.readdir(dir);
    const allow = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
    const list = files.filter(f => allow.has(path.extname(f).toLowerCase()));
    res.json({ files: list });
  } catch {
    res.json({ files: [] });
  }
});

// ヘルスチェック
app.get('/healthz', (_, res) => res.json({ ok: true, time: now(), teams: TEAM_IDS }));

// ====== Socket.IO ======
io.on('connection', (socket) => {
  const { room: roomQuery } = socket.handshake.auth || {};
  const roomId = (roomQuery && String(roomQuery)) || 'default';
  socket.join(roomId);
  socket.data.roomId = roomId;

  const state = getRoom(roomId);
  socket.emit('state:init', { state, maxRounds: MAX_ROUNDS, teams: TEAM_IDS });

  // リーダーログイン
  socket.on('leader:login', ({ pass }) => {
    const hit = TEAM_IDS.find(t => pass === teamPasses[t]);
    if (hit) { socket.data.role = hit; socket.emit('leader:ok', { role: hit }); }
    else { socket.emit('leader:err', { message: 'パスワードが違います' }); }
  });

  // 操作パスチェック
  const checkActionPass = (p) => p && p === ACTION_PASS;

  // 選手登録
  socket.on('player:add', (payload) => {
    if (!checkActionPass(payload?.actionPass))
      return socket.emit('action:err', { message: '操作パスワードが違います' });
    const room = getRoom(roomId);
    const pointsByRank = { 'ビギナー':5,'スーパー':5,'ハイパー':10,'エリート':10,'エキスパート':15,'マスター1200':15,'マスター1400～1600':20 };
    const player = {
      id: uid(),
      name: String(payload.name || '').slice(0, 50),
      rank: payload.rank,
      points: pointsByRank[payload.rank] ?? 0,
      avatar: payload.avatar || '',
      pokes: Array.isArray(payload.pokes) ? payload.pokes.slice(0,3) : [],
      comment: String(payload.comment || '').slice(0, 300)
    };
    room.players.push(player);
    room.lastUpdated = Date.now();
    io.to(roomId).emit('players:updated', room.players);
  });

  // 一括削除
  socket.on('players:clearAll', ({ actionPass }) => {
    if (!checkActionPass(actionPass))
      return socket.emit('action:err', { message: '操作パスワードが違います' });
    const room = getRoom(roomId);
    room.players = [];
    room.draft = emptyDraft();
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
  });

  // 個別削除
  socket.on('player:del', ({ id }) => {
    const room = getRoom(roomId);
    room.players = room.players.filter(x => x.id !== id);
    const d = room.draft;
    for (const t of TEAM_IDS) {
      d.picks[t] = d.picks[t].map(x => x === id ? '' : x);
      d.teams[t] = d.teams[t].filter(x => x !== id);
    }
    room.lastUpdated = Date.now();
    io.to(roomId).emit('state:updated', room);
  });

  // ドラフト処理（省略: 前回キャンバスのロジックと同じ。競合はd6で解決）
  // ...
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));

// db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ==============================
// 初期化
// ==============================
export async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS room_options (
    room TEXT PRIMARY KEY, settings JSONB, tournament JSONB
  )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      room TEXT NOT NULL,
      name TEXT NOT NULL,
      rank TEXT NOT NULL,
      points INTEGER NOT NULL,
      avatar TEXT,
      pokes JSONB,
      comment TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS draft_state (
      room TEXT PRIMARY KEY,
      locks JSONB,
      picks JSONB,
      teams JSONB,
      state JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export async function loadOptions(room) {
  return (await pool.query('SELECT settings, tournament FROM room_options WHERE room=$1', [room])).rows[0] || {};
}
export async function saveTournament(room, tournament) {
  await pool.query(`INSERT INTO room_options (room,tournament) VALUES ($1,$2)
    ON CONFLICT (room) DO UPDATE SET tournament=EXCLUDED.tournament`, [room, JSON.stringify(tournament)]);
}
export async function saveSettings(room, settings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO room_options (room,settings) VALUES ($1,$2)
      ON CONFLICT (room) DO UPDATE SET settings=EXCLUDED.settings`, [room, JSON.stringify(settings)]);
    for (const rank of settings.ranks) await client.query('UPDATE players SET points=$1 WHERE room=$2 AND rank=$3', [rank.points,room,rank.name]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// ==============================
// Players
// ==============================
export async function loadPlayers(room) {
  const res = await pool.query(
    'SELECT * FROM players WHERE room=$1 ORDER BY created_at',
    [room]
  );
  return res.rows;
}

export async function savePlayer(room, p) {
  await pool.query(`
    INSERT INTO players (id, room, name, rank, points, avatar, pokes, comment)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      rank=EXCLUDED.rank,
      points=EXCLUDED.points,
      avatar=EXCLUDED.avatar,
      pokes=EXCLUDED.pokes,
      comment=EXCLUDED.comment
  `, [
    p.id, room, p.name, p.rank, p.points,
    p.avatar || null,
    JSON.stringify(p.pokes || []),
    p.comment || null
  ]);
}

export async function deletePlayer(room, id) {
  await pool.query(
    'DELETE FROM players WHERE room=$1 AND id=$2',
    [room, id]
  );
}

export async function clearPlayers(room) {
  await pool.query(
    'DELETE FROM players WHERE room=$1',
    [room]
  );
}

// ==============================
// Draft
// ==============================
export async function loadDraft(room) {
  const res = await pool.query(
    'SELECT * FROM draft_state WHERE room=$1',
    [room]
  );
  return res.rows[0] || null;
}

export async function saveDraft(room, draft) {
  await pool.query(`
    INSERT INTO draft_state (room, locks, picks, teams, state, updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    ON CONFLICT (room) DO UPDATE SET
      locks=EXCLUDED.locks,
      picks=EXCLUDED.picks,
      teams=EXCLUDED.teams,
      state=EXCLUDED.state,
      updated_at=NOW()
  `, [
    room,
    JSON.stringify(draft.locks),
    JSON.stringify(draft.picks),
    JSON.stringify(draft.teams),
    JSON.stringify(draft.state),
  ]);
}

export async function resetDraft(room) {
  await pool.query(
    'DELETE FROM draft_state WHERE room=$1',
    [room]
  );
}

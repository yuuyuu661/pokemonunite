# db.py
import os
import json
import asyncpg
import asyncio
from dotenv import load_dotenv

load_dotenv()


class Database:
    def __init__(self):
        self.dsn = os.getenv("DATABASE_URL")
        self.conn: asyncpg.Connection | None = None
        self._lock = asyncio.Lock()

    # ============================
    # 接続
    # ============================
    async def connect(self):
        if self.conn is None:
            self.conn = await asyncpg.connect(self.dsn)

    async def _ensure(self):
        if self.conn is None:
            await self.connect()

    # ============================
    # 初期化（テーブル作成）
    # ============================
    async def init_db(self):
        await self._ensure()

        # players（選手情報）
        await self.conn.execute("""
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
        """)

        # draft_state（ドラフト進行状態）
        await self.conn.execute("""
            CREATE TABLE IF NOT EXISTS draft_state (
                room TEXT PRIMARY KEY,
                locks JSONB,
                picks JSONB,
                teams JSONB,
                state JSONB,
                updated_at TIMESTAMP DEFAULT NOW()
            );
        """)

    # ============================
    # Players
    # ============================
    async def load_players(self, room: str) -> list[dict]:
        await self._ensure()
        rows = await self.conn.fetch(
            "SELECT * FROM players WHERE room=$1 ORDER BY created_at",
            room
        )
        return [dict(r) for r in rows]

    async def save_player(self, room: str, player: dict):
        """
        add / update 共通
        """
        await self._ensure()
        async with self._lock:
            await self.conn.execute("""
                INSERT INTO players (id, room, name, rank, points, avatar, pokes, comment)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT (id) DO UPDATE SET
                    name=EXCLUDED.name,
                    rank=EXCLUDED.rank,
                    points=EXCLUDED.points,
                    avatar=EXCLUDED.avatar,
                    pokes=EXCLUDED.pokes,
                    comment=EXCLUDED.comment
            """,
            player["id"],
            room,
            player["name"],
            player["rank"],
            player["points"],
            player.get("avatar"),
            json.dumps(player.get("pokes", [])),
            player.get("comment"),
            )

    async def delete_player(self, room: str, player_id: str):
        await self._ensure()
        async with self._lock:
            await self.conn.execute(
                "DELETE FROM players WHERE room=$1 AND id=$2",
                room, player_id
            )

    async def clear_players(self, room: str):
        await self._ensure()
        async with self._lock:
            await self.conn.execute(
                "DELETE FROM players WHERE room=$1",
                room
            )

    # ============================
    # Draft State
    # ============================
    async def load_draft(self, room: str) -> dict | None:
        await self._ensure()
        row = await self.conn.fetchrow(
            "SELECT * FROM draft_state WHERE room=$1",
            room
        )
        if not row:
            return None
        return {
            "locks": row["locks"] or {},
            "picks": row["picks"] or {},
            "teams": row["teams"] or {},
            "state": row["state"] or {},
        }

    async def save_draft(self, room: str, draft: dict):
        await self._ensure()
        async with self._lock:
            await self.conn.execute("""
                INSERT INTO draft_state (room, locks, picks, teams, state, updated_at)
                VALUES ($1,$2,$3,$4,$5,NOW())
                ON CONFLICT (room) DO UPDATE SET
                    locks=EXCLUDED.locks,
                    picks=EXCLUDED.picks,
                    teams=EXCLUDED.teams,
                    state=EXCLUDED.state,
                    updated_at=NOW()
            """,
            room,
            json.dumps(draft.get("locks", {})),
            json.dumps(draft.get("picks", {})),
            json.dumps(draft.get("teams", {})),
            json.dumps(draft.get("state", {})),
            )

    async def reset_draft(self, room: str):
        await self._ensure()
        async with self._lock:
            await self.conn.execute(
                "DELETE FROM draft_state WHERE room=$1",
                room
            )
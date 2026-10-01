import asyncio
import json
from pathlib import Path
from typing import Any

import aiosqlite


class Database:
    """One app-lifetime SQLite connection; aiosqlite serializes its operations."""

    def __init__(self, path: Path, migrations_dir: Path):
        self.path = path
        self.migrations_dir = migrations_dir
        self.connection: aiosqlite.Connection | None = None
        self.lock = asyncio.Lock()

    async def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = await aiosqlite.connect(str(self.path))
        self.connection.row_factory = aiosqlite.Row
        await self.connection.execute("PRAGMA foreign_keys = ON")
        await self.connection.execute("PRAGMA journal_mode = WAL")
        await self.connection.execute("PRAGMA synchronous = NORMAL")
        await self.connection.execute("PRAGMA busy_timeout = 5000")
        await self.connection.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY, name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        await self.connection.commit()
        await self.migrate()

    async def migrate(self) -> None:
        assert self.connection
        for path in sorted(self.migrations_dir.glob("[0-9][0-9][0-9]_*.sql")):
            version = int(path.name.split("_", 1)[0])
            cursor = await self.connection.execute("SELECT 1 FROM schema_migrations WHERE version=?", (version,))
            if await cursor.fetchone():
                continue
            sql = path.read_text(encoding="utf-8")
            await self.connection.executescript(sql)
            await self.connection.execute("INSERT INTO schema_migrations(version,name) VALUES(?,?)", (version, path.name))
            await self.connection.commit()

    async def close(self) -> None:
        if self.connection:
            await self.connection.close()
            self.connection = None

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        assert self.connection
        async with self.lock:
            cursor = await self.connection.execute(sql, params)
            await self.connection.commit()
            return cursor.rowcount

    async def one(self, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        assert self.connection
        async with self.lock:
            cursor = await self.connection.execute(sql, params)
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def all(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        assert self.connection
        async with self.lock:
            cursor = await self.connection.execute(sql, params)
            return [dict(row) for row in await cursor.fetchall()]

    async def transaction(self, statements: list[tuple[str, tuple[Any, ...]]]) -> None:
        assert self.connection
        async with self.lock:
            try:
                await self.connection.execute("BEGIN IMMEDIATE")
                for sql, params in statements:
                    await self.connection.execute(sql, params)
                await self.connection.commit()
            except Exception:
                await self.connection.rollback()
                raise


def load_json(value: str | None, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback

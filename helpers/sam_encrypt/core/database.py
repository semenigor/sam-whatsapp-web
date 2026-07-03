from __future__ import annotations

import sqlite3
from pathlib import Path

from core.app_paths import db_path


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    key_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    public_key_b64 TEXT NOT NULL,
    source_file TEXT,
    created_utc TEXT NOT NULL,
    updated_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_display_name
ON contacts(display_name);

CREATE INDEX IF NOT EXISTS idx_contacts_key_id
ON contacts(key_id);

CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_utc TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    input_path TEXT,
    output_path TEXT,
    recipient_name TEXT,
    recipient_key_id TEXT,
    file_size INTEGER,
    sha256 TEXT,
    message TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_log_created_utc
ON operation_log(created_utc);

CREATE INDEX IF NOT EXISTS idx_operation_log_operation_type
ON operation_log(operation_type);

CREATE INDEX IF NOT EXISTS idx_operation_log_status
ON operation_log(status);
"""


def get_connection(path: Path | None = None) -> sqlite3.Connection:
    actual_path = path or db_path()
    actual_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(actual_path))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    try:
        with get_connection() as conn:
            conn.executescript(SCHEMA_SQL)
            conn.commit()
    except sqlite3.Error as exc:
        raise RuntimeError(f"Не вдалося ініціалізувати базу: {exc}") from exc

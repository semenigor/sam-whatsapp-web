from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from core.database import get_connection
from core.key_service import PublicKeyInfo, utc_now_iso


@dataclass(frozen=True)
class Contact:
    id: int
    display_name: str
    key_id: str
    fingerprint: str
    algorithm: str
    public_key_b64: str
    source_file: str | None
    created_utc: str
    updated_utc: str


class ContactRepository:
    def list_contacts(self) -> list[Contact]:
        try:
            with get_connection() as conn:
                rows = conn.execute(
                    """
                    SELECT id, display_name, key_id, fingerprint, algorithm,
                           public_key_b64, source_file, created_utc, updated_utc
                    FROM contacts
                    ORDER BY display_name COLLATE NOCASE, key_id
                    """
                ).fetchall()

            return [self._row_to_contact(row) for row in rows]
        except sqlite3.Error as exc:
            raise RuntimeError(f"Не вдалося прочитати контакти: {exc}") from exc

    def get_contact_by_id(self, contact_id: int) -> Contact:
        try:
            with get_connection() as conn:
                row = conn.execute(
                    """
                    SELECT id, display_name, key_id, fingerprint, algorithm,
                           public_key_b64, source_file, created_utc, updated_utc
                    FROM contacts
                    WHERE id = ?
                    """,
                    (contact_id,),
                ).fetchone()

            if row is None:
                raise RuntimeError("Контакт не знайдено.")

            return self._row_to_contact(row)

        except sqlite3.Error as exc:
            raise RuntimeError(f"Не вдалося прочитати контакт: {exc}") from exc

    def upsert_public_key(self, key_info: PublicKeyInfo, source_file: Path | None = None) -> None:
        now = utc_now_iso()
        source = str(source_file) if source_file else None

        try:
            with get_connection() as conn:
                existing = conn.execute(
                    "SELECT id FROM contacts WHERE key_id = ?",
                    (key_info.key_id,),
                ).fetchone()

                if existing:
                    conn.execute(
                        """
                        UPDATE contacts
                        SET display_name = ?,
                            fingerprint = ?,
                            algorithm = ?,
                            public_key_b64 = ?,
                            source_file = ?,
                            updated_utc = ?
                        WHERE key_id = ?
                        """,
                        (
                            key_info.owner_name,
                            key_info.fingerprint,
                            key_info.algorithm,
                            key_info.public_key_b64,
                            source,
                            now,
                            key_info.key_id,
                        ),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO contacts (
                            display_name,
                            key_id,
                            fingerprint,
                            algorithm,
                            public_key_b64,
                            source_file,
                            created_utc,
                            updated_utc
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            key_info.owner_name,
                            key_info.key_id,
                            key_info.fingerprint,
                            key_info.algorithm,
                            key_info.public_key_b64,
                            source,
                            now,
                            now,
                        ),
                    )

                conn.commit()
        except sqlite3.Error as exc:
            raise RuntimeError(f"Не вдалося зберегти контакт: {exc}") from exc

    def delete_contact(self, contact_id: int) -> None:
        try:
            with get_connection() as conn:
                conn.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
                conn.commit()
        except sqlite3.Error as exc:
            raise RuntimeError(f"Не вдалося видалити контакт: {exc}") from exc

    @staticmethod
    def _row_to_contact(row: sqlite3.Row) -> Contact:
        return Contact(
            id=int(row["id"]),
            display_name=str(row["display_name"]),
            key_id=str(row["key_id"]),
            fingerprint=str(row["fingerprint"]),
            algorithm=str(row["algorithm"]),
            public_key_b64=str(row["public_key_b64"]),
            source_file=row["source_file"],
            created_utc=str(row["created_utc"]),
            updated_utc=str(row["updated_utc"]),
        )

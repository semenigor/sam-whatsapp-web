from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from core.database import get_connection
from core.key_service import utc_now_iso


@dataclass(frozen=True)
class OperationLogEntry:
    id: int
    created_utc: str
    operation_type: str
    status: str
    input_path: str | None
    output_path: str | None
    recipient_name: str | None
    recipient_key_id: str | None
    file_size: int | None
    sha256: str | None
    message: str | None


class OperationLogRepository:
    def add_entry(
        self,
        operation_type: str,
        status: str,
        input_path: str | None = None,
        output_path: str | None = None,
        recipient_name: str | None = None,
        recipient_key_id: str | None = None,
        file_size: int | None = None,
        sha256: str | None = None,
        message: str | None = None,
    ) -> None:
        operation_type = operation_type.strip()
        status = status.strip().upper()

        if operation_type not in {"encrypt", "decrypt"}:
            raise ValueError(f"Некоректний operation_type: {operation_type}")

        if status not in {"OK", "ERROR"}:
            raise ValueError(f"Некоректний status: {status}")

        try:
            with get_connection() as conn:
                conn.execute(
                    """
                    INSERT INTO operation_log (
                        created_utc,
                        operation_type,
                        status,
                        input_path,
                        output_path,
                        recipient_name,
                        recipient_key_id,
                        file_size,
                        sha256,
                        message
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        utc_now_iso(),
                        operation_type,
                        status,
                        input_path,
                        output_path,
                        recipient_name,
                        recipient_key_id,
                        file_size,
                        sha256,
                        message,
                    ),
                )
                conn.commit()
        except sqlite3.Error as exc:
            raise RuntimeError(f"Не вдалося записати журнал операцій: {exc}") from exc

    def list_entries(self, limit: int = 500) -> list[OperationLogEntry]:
        try:
            with get_connection() as conn:
                rows = conn.execute(
                    """
                    SELECT id, created_utc, operation_type, status,
                           input_path, output_path, recipient_name, recipient_key_id,
                           file_size, sha256, message
                    FROM operation_log
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()

            return [self._row_to_entry(row) for row in rows]
        except sqlite3.Error as exc:
            raise RuntimeError(f"Не вдалося прочитати журнал операцій: {exc}") from exc

    def clear_entries(self) -> None:
        try:
            with get_connection() as conn:
                conn.execute("DELETE FROM operation_log")
                conn.commit()
        except sqlite3.Error as exc:
            raise RuntimeError(f"Не вдалося очистити журнал операцій: {exc}") from exc

    @staticmethod
    def _row_to_entry(row: sqlite3.Row) -> OperationLogEntry:
        file_size_value = row["file_size"]

        return OperationLogEntry(
            id=int(row["id"]),
            created_utc=str(row["created_utc"]),
            operation_type=str(row["operation_type"]),
            status=str(row["status"]),
            input_path=row["input_path"],
            output_path=row["output_path"],
            recipient_name=row["recipient_name"],
            recipient_key_id=row["recipient_key_id"],
            file_size=int(file_size_value) if file_size_value is not None else None,
            sha256=row["sha256"],
            message=row["message"],
        )

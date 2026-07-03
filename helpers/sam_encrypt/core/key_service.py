from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from nacl.public import PrivateKey

from core.app_paths import (
    exports_dir,
    my_private_key_path,
    my_public_key_path,
    backups_dir,
    project_root,
)


PRIVATE_KEY_FORMAT = "sam-encrypt-private-key"
PUBLIC_KEY_FORMAT = "sam-encrypt-public-key"
KEY_VERSION = 1
ALGORITHM = "curve25519-sealedbox"


@dataclass(frozen=True)
class PublicKeyInfo:
    owner_name: str
    key_id: str
    fingerprint: str
    algorithm: str
    public_key_b64: str
    created_utc: str


@dataclass(frozen=True)
class PrivateKeyInfo:
    owner_name: str
    key_id: str
    fingerprint: str
    algorithm: str
    private_key_b64: str
    public_key_b64: str
    created_utc: str


@dataclass(frozen=True)
class PrivateKeyImportResult:
    info: PrivateKeyInfo
    backup_dir: Path | None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def local_timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def b64encode_bytes(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode_text(value: str) -> bytes:
    try:
        return base64.b64decode(value.encode("ascii"), validate=True)
    except Exception as exc:
        raise RuntimeError("Некоректний base64 у файлі ключа.") from exc


def normalize_filename_part(value: str) -> str:
    cleaned = re.sub(r'[\\\\/:*?"<>|]+', "_", value.strip())
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned or "USER"


def calculate_fingerprint(public_key_bytes: bytes) -> str:
    digest = hashlib.sha256(public_key_bytes).hexdigest().upper()
    return ":".join(digest[i:i + 4] for i in range(0, 32, 4))


def calculate_key_id(public_key_bytes: bytes) -> str:
    digest = hashlib.sha256(public_key_bytes).hexdigest().upper()
    return f"SAM-PUB-{digest[:8]}"


def private_key_exists() -> bool:
    return my_private_key_path().exists()


def public_key_exists() -> bool:
    return my_public_key_path().exists()


def load_json_file(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as fh:
            data = json.load(fh)

        if not isinstance(data, dict):
            raise RuntimeError(f"Файл має містити JSON-обʼєкт: {path}")

        return data

    except FileNotFoundError as exc:
        raise RuntimeError(f"Файл не знайдено: {path}") from exc

    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Некоректний JSON-файл: {path}\n"
            f"Рядок: {exc.lineno}, позиція: {exc.colno}\n"
            f"Причина: {exc.msg}"
        ) from exc

    except OSError as exc:
        raise RuntimeError(f"Не вдалося прочитати файл: {path}. Помилка: {exc}") from exc


def write_json_file(path: Path, data: dict[str, Any], file_mode: int = 0o600) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)

        temp_path = path.with_suffix(path.suffix + ".tmp")

        with temp_path.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

        os.replace(temp_path, path)

        try:
            os.chmod(path, file_mode)
        except OSError:
            pass

    except OSError as exc:
        raise RuntimeError(f"Не вдалося записати файл: {path}. Помилка: {exc}") from exc


def build_public_key_data(
    owner_name: str,
    key_id: str,
    fingerprint: str,
    created_utc: str,
    public_key_b64: str,
) -> dict[str, Any]:
    return {
        "format": PUBLIC_KEY_FORMAT,
        "version": KEY_VERSION,
        "owner_name": owner_name,
        "key_id": key_id,
        "fingerprint": fingerprint,
        "created_utc": created_utc,
        "algorithm": ALGORITHM,
        "public_key_b64": public_key_b64,
    }


def build_private_key_data(
    owner_name: str,
    key_id: str,
    fingerprint: str,
    created_utc: str,
    private_key_b64: str,
    public_key_b64: str,
) -> dict[str, Any]:
    return {
        "format": PRIVATE_KEY_FORMAT,
        "version": KEY_VERSION,
        "owner_name": owner_name,
        "key_id": key_id,
        "fingerprint": fingerprint,
        "created_utc": created_utc,
        "algorithm": ALGORITHM,
        "private_key_b64": private_key_b64,
        "public_key_b64": public_key_b64,
    }


def public_info_from_data(data: dict[str, Any]) -> PublicKeyInfo:
    return PublicKeyInfo(
        owner_name=str(data["owner_name"]),
        key_id=str(data["key_id"]),
        fingerprint=str(data["fingerprint"]),
        algorithm=str(data["algorithm"]),
        public_key_b64=str(data["public_key_b64"]),
        created_utc=str(data["created_utc"]),
    )


def private_info_from_data(data: dict[str, Any]) -> PrivateKeyInfo:
    return PrivateKeyInfo(
        owner_name=str(data["owner_name"]),
        key_id=str(data["key_id"]),
        fingerprint=str(data["fingerprint"]),
        algorithm=str(data["algorithm"]),
        private_key_b64=str(data["private_key_b64"]),
        public_key_b64=str(data["public_key_b64"]),
        created_utc=str(data["created_utc"]),
    )


def generate_my_keypair(owner_name: str, overwrite: bool = False) -> PrivateKeyInfo:
    owner_name = owner_name.strip()

    if not owner_name:
        raise ValueError("Імʼя власника ключа не може бути порожнім.")

    private_path = my_private_key_path()
    public_path = my_public_key_path()

    if private_path.exists() and not overwrite:
        raise RuntimeError("Приватний ключ уже існує. Щоб створити новий — увімкни перезапис.")

    if private_path.exists() or public_path.exists():
        backup_existing_my_keys("before_new_key_generation")

    private_key = PrivateKey.generate()
    private_key_bytes = bytes(private_key)
    public_key_bytes = bytes(private_key.public_key)

    public_key_b64 = b64encode_bytes(public_key_bytes)
    private_key_b64 = b64encode_bytes(private_key_bytes)

    key_id = calculate_key_id(public_key_bytes)
    fingerprint = calculate_fingerprint(public_key_bytes)
    created_utc = utc_now_iso()

    private_data = build_private_key_data(
        owner_name=owner_name,
        key_id=key_id,
        fingerprint=fingerprint,
        created_utc=created_utc,
        private_key_b64=private_key_b64,
        public_key_b64=public_key_b64,
    )

    public_data = build_public_key_data(
        owner_name=owner_name,
        key_id=key_id,
        fingerprint=fingerprint,
        created_utc=created_utc,
        public_key_b64=public_key_b64,
    )

    write_json_file(private_path, private_data, file_mode=0o600)
    write_json_file(public_path, public_data, file_mode=0o644)

    return PrivateKeyInfo(
        owner_name=owner_name,
        key_id=key_id,
        fingerprint=fingerprint,
        algorithm=ALGORITHM,
        private_key_b64=private_key_b64,
        public_key_b64=public_key_b64,
        created_utc=created_utc,
    )


def load_my_private_key_info() -> PrivateKeyInfo:
    data = load_json_file(my_private_key_path())
    validate_private_key_data(data)
    return private_info_from_data(data)


def load_public_key_file(path: Path) -> PublicKeyInfo:
    data = load_json_file(path)
    validate_public_key_data(data)
    return public_info_from_data(data)


def load_my_public_key_info_with_repair() -> PublicKeyInfo:
    public_path = my_public_key_path()

    try:
        return load_public_key_file(public_path)
    except Exception:
        if not my_private_key_path().exists():
            raise

        return restore_public_key_from_private()


def restore_public_key_from_private() -> PublicKeyInfo:
    private_data = load_json_file(my_private_key_path())
    validate_private_key_data(private_data)

    private_info = private_info_from_data(private_data)

    public_data = build_public_key_data(
        owner_name=private_info.owner_name,
        key_id=private_info.key_id,
        fingerprint=private_info.fingerprint,
        created_utc=private_info.created_utc,
        public_key_b64=private_info.public_key_b64,
    )

    write_json_file(my_public_key_path(), public_data, file_mode=0o644)

    return public_info_from_data(public_data)


def backup_existing_my_keys(reason: str) -> Path | None:
    private_path = my_private_key_path()
    public_path = my_public_key_path()

    if not private_path.exists() and not public_path.exists():
        return None

    safe_reason = normalize_filename_part(reason)
    backup_dir = backups_dir() / f"{safe_reason}_{local_timestamp()}"
    backup_dir.mkdir(parents=True, exist_ok=True)

    try:
        if private_path.exists():
            shutil.copy2(private_path, backup_dir / private_path.name)
            try:
                os.chmod(backup_dir / private_path.name, 0o600)
            except OSError:
                pass

        if public_path.exists():
            shutil.copy2(public_path, backup_dir / public_path.name)
            try:
                os.chmod(backup_dir / public_path.name, 0o644)
            except OSError:
                pass

    except OSError as exc:
        raise RuntimeError(f"Не вдалося створити backup поточних ключів: {exc}") from exc

    return backup_dir


def backup_my_private_key(destination_dir: Path | None = None) -> Path:
    if not my_private_key_path().exists():
        raise RuntimeError("Приватний ключ ще не створено.")

    info = load_my_private_key_info()

    safe_name = normalize_filename_part(info.owner_name)
    date_part = datetime.now().strftime("%Y.%m.%d-%H%M")

    out_dir = destination_dir or exports_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    out_path = out_dir / f"PRIVATE_DO_NOT_SEND_sam_private_{safe_name}_{date_part}.samkey"

    try:
        shutil.copy2(my_private_key_path(), out_path)
        try:
            os.chmod(out_path, 0o600)
        except OSError:
            pass
    except OSError as exc:
        raise RuntimeError(f"Не вдалося створити резервну копію приватного ключа: {exc}") from exc

    return out_path


def import_private_key_file(source_path: Path, overwrite: bool = False) -> PrivateKeyImportResult:
    source_path = source_path.expanduser().resolve()

    if not source_path.exists():
        raise RuntimeError(f"Файл приватного ключа не знайдено: {source_path}")

    if not source_path.is_file():
        raise RuntimeError(f"Це не файл приватного ключа: {source_path}")

    source_data = load_json_file(source_path)
    validate_private_key_data(source_data)
    info = private_info_from_data(source_data)

    if my_private_key_path().exists() and not overwrite:
        raise RuntimeError("Локальний приватний ключ уже існує. Потрібне підтвердження перезапису.")

    backup_dir = backup_existing_my_keys("before_private_key_import")

    public_data = build_public_key_data(
        owner_name=info.owner_name,
        key_id=info.key_id,
        fingerprint=info.fingerprint,
        created_utc=info.created_utc,
        public_key_b64=info.public_key_b64,
    )

    write_json_file(my_private_key_path(), source_data, file_mode=0o600)
    write_json_file(my_public_key_path(), public_data, file_mode=0o644)

    return PrivateKeyImportResult(info=info, backup_dir=backup_dir)


def validate_public_key_data(data: dict[str, Any]) -> None:
    required = [
        "format",
        "version",
        "owner_name",
        "key_id",
        "fingerprint",
        "created_utc",
        "algorithm",
        "public_key_b64",
    ]

    for field in required:
        if field not in data:
            raise RuntimeError(f"У файлі публічного ключа відсутнє поле: {field}")

    if data["format"] != PUBLIC_KEY_FORMAT:
        raise RuntimeError("Це не файл публічного ключа SAM Encrypt.")

    if int(data["version"]) != KEY_VERSION:
        raise RuntimeError(f"Непідтримувана версія публічного ключа: {data['version']}")

    if data["algorithm"] != ALGORITHM:
        raise RuntimeError(f"Непідтримуваний алгоритм: {data['algorithm']}")

    public_key_bytes = b64decode_text(str(data["public_key_b64"]))

    if len(public_key_bytes) != 32:
        raise RuntimeError("Некоректна довжина публічного ключа.")

    expected_key_id = calculate_key_id(public_key_bytes)
    expected_fingerprint = calculate_fingerprint(public_key_bytes)

    if data["key_id"] != expected_key_id:
        raise RuntimeError("Key ID не відповідає вмісту публічного ключа.")

    if data["fingerprint"] != expected_fingerprint:
        raise RuntimeError("Fingerprint не відповідає вмісту публічного ключа.")


def validate_private_key_data(data: dict[str, Any]) -> None:
    required = [
        "format",
        "version",
        "owner_name",
        "key_id",
        "fingerprint",
        "created_utc",
        "algorithm",
        "private_key_b64",
        "public_key_b64",
    ]

    for field in required:
        if field not in data:
            raise RuntimeError(f"У файлі приватного ключа відсутнє поле: {field}")

    if data["format"] != PRIVATE_KEY_FORMAT:
        raise RuntimeError("Це не файл приватного ключа SAM Encrypt.")

    if int(data["version"]) != KEY_VERSION:
        raise RuntimeError(f"Непідтримувана версія приватного ключа: {data['version']}")

    if data["algorithm"] != ALGORITHM:
        raise RuntimeError(f"Непідтримуваний алгоритм: {data['algorithm']}")

    private_key_bytes = b64decode_text(str(data["private_key_b64"]))
    public_key_bytes = b64decode_text(str(data["public_key_b64"]))

    if len(private_key_bytes) != 32:
        raise RuntimeError("Некоректна довжина приватного ключа.")

    if len(public_key_bytes) != 32:
        raise RuntimeError("Некоректна довжина публічного ключа.")

    regenerated_public_key = bytes(PrivateKey(private_key_bytes).public_key)

    if regenerated_public_key != public_key_bytes:
        raise RuntimeError("Приватний ключ не відповідає публічному ключу.")

    expected_key_id = calculate_key_id(public_key_bytes)
    expected_fingerprint = calculate_fingerprint(public_key_bytes)

    if data["key_id"] != expected_key_id:
        raise RuntimeError("Key ID не відповідає приватному ключу.")

    if data["fingerprint"] != expected_fingerprint:
        raise RuntimeError("Fingerprint не відповідає приватному ключу.")


def export_my_public_key(destination_dir: Path | None = None) -> Path:
    if not my_private_key_path().exists():
        raise RuntimeError("Приватний ключ ще не створено.")

    info = load_my_public_key_info_with_repair()

    safe_name = normalize_filename_part(info.owner_name)
    date_part = datetime.now().strftime("%Y.%m.%d-%H%M")

    out_dir = destination_dir or exports_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    out_path = out_dir / f"sam_public_{safe_name}_{date_part}.sampub"

    try:
        shutil.copy2(my_public_key_path(), out_path)
        try:
            os.chmod(out_path, 0o644)
        except OSError:
            pass
    except OSError as exc:
        raise RuntimeError(f"Не вдалося експортувати публічний ключ: {exc}") from exc

    return out_path

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from core.app_paths import exports_dir
from core.contact_repository import ContactRepository
from core.key_service import (
    ALGORITHM,
    KEY_VERSION,
    PublicKeyInfo,
    calculate_fingerprint,
    calculate_key_id,
    normalize_filename_part,
    utc_now_iso,
    b64decode_text,
)


GROUP_FORMAT = "sam-encrypt-group"
GROUP_VERSION = 1


@dataclass(frozen=True)
class GroupImportResult:
    group_name: str
    group_id: str
    imported_count: int
    updated_count: int
    total_members: int


@dataclass(frozen=True)
class GroupExportResult:
    output_path: Path
    group_name: str
    group_id: str
    member_count: int


def make_group_id(group_name: str, member_key_ids: list[str]) -> str:
    import hashlib

    source = group_name.strip() + "|" + "|".join(sorted(member_key_ids))
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest().upper()
    return f"SAM-GROUP-{digest[:12]}"


def validate_member(member: dict[str, Any], index: int) -> PublicKeyInfo:
    required = [
        "display_name",
        "key_id",
        "fingerprint",
        "algorithm",
        "public_key_b64",
    ]

    for field in required:
        if field not in member:
            raise RuntimeError(f"Некоректний .samgroup: відсутнє поле members[{index}].{field}")

    if str(member["algorithm"]) != ALGORITHM:
        raise RuntimeError(
            f"Некоректний .samgroup: непідтримуваний algorithm у members[{index}]."
        )

    public_key_bytes = b64decode_text(str(member["public_key_b64"]))

    if len(public_key_bytes) != 32:
        raise RuntimeError(f"Некоректний .samgroup: неправильна довжина ключа members[{index}].")

    expected_key_id = calculate_key_id(public_key_bytes)
    expected_fingerprint = calculate_fingerprint(public_key_bytes)

    if str(member["key_id"]) != expected_key_id:
        raise RuntimeError(f"Некоректний .samgroup: key_id не відповідає ключу members[{index}].")

    if str(member["fingerprint"]) != expected_fingerprint:
        raise RuntimeError(
            f"Некоректний .samgroup: fingerprint не відповідає ключу members[{index}]."
        )

    return PublicKeyInfo(
        owner_name=str(member["display_name"]),
        key_id=str(member["key_id"]),
        fingerprint=str(member["fingerprint"]),
        algorithm=str(member["algorithm"]),
        public_key_b64=str(member["public_key_b64"]),
        created_utc=str(member.get("created_utc") or utc_now_iso()),
    )


def load_group_file(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except FileNotFoundError as exc:
        raise RuntimeError(f"Файл групи не знайдено: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Некоректний JSON у .samgroup: {path}\n"
            f"Рядок: {exc.lineno}, позиція: {exc.colno}\n"
            f"Причина: {exc.msg}"
        ) from exc
    except OSError as exc:
        raise RuntimeError(f"Не вдалося прочитати .samgroup: {path}. Помилка: {exc}") from exc

    if not isinstance(data, dict):
        raise RuntimeError(".samgroup має містити JSON-обʼєкт.")

    if data.get("format") != GROUP_FORMAT:
        raise RuntimeError("Це не файл групи SAM Encrypt.")

    if int(data.get("version", 0)) != GROUP_VERSION:
        raise RuntimeError(f"Непідтримувана версія .samgroup: {data.get('version')}")

    if not str(data.get("group_name", "")).strip():
        raise RuntimeError("Некоректний .samgroup: порожня назва групи.")

    if not str(data.get("group_id", "")).strip():
        raise RuntimeError("Некоректний .samgroup: порожній group_id.")

    members = data.get("members")

    if not isinstance(members, list):
        raise RuntimeError("Некоректний .samgroup: members має бути списком.")

    if not members:
        raise RuntimeError("Некоректний .samgroup: список members порожній.")

    seen: set[str] = set()

    for index, member in enumerate(members):
        if not isinstance(member, dict):
            raise RuntimeError(f"Некоректний .samgroup: members[{index}] не є обʼєктом.")

        info = validate_member(member, index)

        if info.key_id in seen:
            raise RuntimeError(f"Некоректний .samgroup: дубльований key_id {info.key_id}")

        seen.add(info.key_id)

    return data


def export_group_file(group_name: str, destination_dir: Path | None = None) -> GroupExportResult:
    group_name = group_name.strip()

    if not group_name:
        raise ValueError("Назва групи не може бути порожньою.")

    repository = ContactRepository()
    contacts = repository.list_contacts()

    if not contacts:
        raise RuntimeError("Неможливо експортувати групу: список контактів порожній.")

    members = []

    for contact in contacts:
        members.append(
            {
                "display_name": contact.display_name,
                "key_id": contact.key_id,
                "fingerprint": contact.fingerprint,
                "algorithm": contact.algorithm,
                "public_key_b64": contact.public_key_b64,
                "created_utc": contact.created_utc,
            }
        )

    key_ids = [item["key_id"] for item in members]
    group_id = make_group_id(group_name, key_ids)
    now = utc_now_iso()

    data = {
        "format": GROUP_FORMAT,
        "version": GROUP_VERSION,
        "group_name": group_name,
        "group_id": group_id,
        "created_utc": now,
        "updated_utc": now,
        "member_count": len(members),
        "members": members,
    }

    out_dir = destination_dir or exports_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    safe_group_name = normalize_filename_part(group_name)
    date_part = datetime.now().strftime("%Y.%m.%d-%H%M")
    output_path = out_dir / f"sam_group_{safe_group_name}_{date_part}.samgroup"

    try:
        with output_path.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    except OSError as exc:
        raise RuntimeError(f"Не вдалося записати .samgroup: {exc}") from exc

    return GroupExportResult(
        output_path=output_path,
        group_name=group_name,
        group_id=group_id,
        member_count=len(members),
    )


def import_group_file(path: Path) -> GroupImportResult:
    data = load_group_file(path)

    group_name = str(data["group_name"])
    group_id = str(data["group_id"])
    members = data["members"]

    repository = ContactRepository()
    before = {contact.key_id for contact in repository.list_contacts()}

    imported_count = 0
    updated_count = 0

    for index, member in enumerate(members):
        info = validate_member(member, index)
        repository.upsert_public_key(info, source_file=path)

        if info.key_id in before:
            updated_count += 1
        else:
            imported_count += 1

    return GroupImportResult(
        group_name=group_name,
        group_id=group_id,
        imported_count=imported_count,
        updated_count=updated_count,
        total_members=len(members),
    )

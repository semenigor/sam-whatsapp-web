from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from core.app_paths import exports_dir, groups_dir
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
class GroupInfo:
    group_name: str
    group_id: str
    member_count: int
    created_utc: str
    updated_utc: str
    path: Path


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


def export_group_file(group_name: str, destination_dir: Path | None = None, member_key_ids: list[str] | None = None) -> GroupExportResult:
    group_name = group_name.strip()

    if not group_name:
        raise ValueError("Назва групи не може бути порожньою.")

    repository = ContactRepository()
    contacts = repository.list_contacts()

    if member_key_ids:
        wanted = {str(item) for item in member_key_ids}
        contacts = [contact for contact in contacts if contact.key_id in wanted]

        missing = sorted(wanted - {contact.key_id for contact in contacts})
        if missing:
            raise RuntimeError("Не знайдено контакти для group key_id: " + ", ".join(missing))

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


def group_info_from_file(path: Path) -> GroupInfo:
    data = load_group_file(path)

    return GroupInfo(
        group_name=str(data["group_name"]),
        group_id=str(data["group_id"]),
        member_count=int(data.get("member_count") or len(data.get("members") or [])),
        created_utc=str(data.get("created_utc") or ""),
        updated_utc=str(data.get("updated_utc") or ""),
        path=path,
    )


def list_group_files() -> list[GroupInfo]:
    result: list[GroupInfo] = []

    for path in sorted(groups_dir().glob("*.samgroup")):
        try:
            result.append(group_info_from_file(path))
        except Exception:
            continue

    result.sort(key=lambda item: (item.group_name.lower(), item.group_id))
    return result


def delete_group_file(group_id: str) -> int:
    group_id = str(group_id or "").strip()

    if not group_id:
        raise ValueError("group_id не може бути порожнім.")

    removed = 0

    for group in list_group_files():
        if group.group_id != group_id:
            continue

        path = Path(group.path)

        try:
            if path.exists():
                path.unlink()
                removed += 1
        except OSError as exc:
            raise RuntimeError(f"Не вдалося видалити групу {group_id}: {exc}") from exc

    if removed < 1:
        raise RuntimeError(f"Групу не знайдено: {group_id}")

    return removed


def save_group_file_to_local_store(source_path: Path) -> Path:
    data = load_group_file(source_path)

    group_name = str(data["group_name"])
    group_id = str(data["group_id"])

    out_dir = groups_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    safe_group_name = normalize_filename_part(group_name)
    output_path = out_dir / f"sam_group_{safe_group_name}_{group_id}.samgroup"

    source_resolved = source_path.resolve()
    output_resolved = output_path.resolve()

    # При повторному імпорті тієї самої групи не створюємо дубль.
    # Видаляємо всі локальні .samgroup з таким самим group_id, крім цільового файлу
    # і крім source-файлу, якщо користувач імпортує прямо з локального groups dir.
    for candidate in out_dir.glob("*.samgroup"):
        try:
            candidate_resolved = candidate.resolve()
        except OSError:
            continue

        if candidate_resolved == output_resolved or candidate_resolved == source_resolved:
            continue

        try:
            candidate_data = load_group_file(candidate)
        except RuntimeError:
            continue

        if str(candidate_data.get("group_id", "")).strip() == group_id:
            try:
                candidate.unlink()
            except OSError as exc:
                raise RuntimeError(f"Не вдалося видалити дубль групи {candidate}: {exc}") from exc

    try:
        with output_path.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    except OSError as exc:
        raise RuntimeError(f"Не вдалося зберегти локальний .samgroup: {exc}") from exc

    # Якщо імпорт ішов з іншого локального файлу groups dir з тим самим group_id,
    # після успішного запису прибираємо і його.
    if source_resolved != output_resolved and source_path.parent.resolve() == out_dir.resolve():
        try:
            if source_path.exists():
                source_path.unlink()
        except OSError as exc:
            raise RuntimeError(f"Не вдалося видалити старий локальний .samgroup: {exc}") from exc

    return output_path
def create_local_group_file(group_name: str, member_key_ids: list[str]) -> GroupExportResult:
    return export_group_file(
        group_name=group_name,
        destination_dir=groups_dir(),
        member_key_ids=member_key_ids,
    )


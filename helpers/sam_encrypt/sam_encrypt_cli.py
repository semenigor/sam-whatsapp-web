from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.app_paths import exports_dir
from core.contact_repository import Contact, ContactRepository
from core.database import init_db
from core.file_decryptor import decrypt_file_with_my_private_key
from core.file_encryptor import encrypt_file_for_contact, encrypt_file_for_contacts
from core.group_service import create_local_group_file, export_group_file, import_group_file, list_group_files, save_group_file_to_local_store
from core.key_service import (
    export_my_public_key,
    generate_my_keypair,
    load_my_public_key_info_with_repair,
    load_public_key_file,
    private_key_exists,
    public_key_exists,
)


def print_json(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))



def group_to_dict(group) -> dict:
    return {
        "group_name": group.group_name,
        "group_id": group.group_id,
        "member_count": group.member_count,
        "created_utc": group.created_utc,
        "updated_utc": group.updated_utc,
        "path": str(group.path),
    }

def contact_to_dict(contact: Contact) -> dict:
    return {
        "id": contact.id,
        "display_name": contact.display_name,
        "key_id": contact.key_id,
        "fingerprint": contact.fingerprint,
        "algorithm": contact.algorithm,
        "source_file": contact.source_file,
        "created_utc": contact.created_utc,
        "updated_utc": contact.updated_utc,
    }



def key_info_to_dict(info) -> dict | None:
    if info is None:
        return None

    return {
        "owner_name": getattr(info, "owner_name", None),
        "key_id": getattr(info, "key_id", None),
        "fingerprint": getattr(info, "fingerprint", None),
        "algorithm": getattr(info, "algorithm", None),
        "created_utc": getattr(info, "created_utc", None),
        "public_key_b64": getattr(info, "public_key_b64", None),
    }

def public_info_to_contact(info) -> Contact:
    return Contact(
        id=0,
        display_name=info.owner_name,
        key_id=info.key_id,
        fingerprint=info.fingerprint,
        algorithm=info.algorithm,
        public_key_b64=info.public_key_b64,
        source_file=None,
        created_utc=info.created_utc,
        updated_utc=info.created_utc,
    )


def resolve_output_dir(value: str | None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return exports_dir()


def cmd_status(args: argparse.Namespace) -> int:
    init_db()
    contacts = ContactRepository().list_contacts()

    public_info = None
    public_info_error = None

    if public_key_exists():
        try:
            public_info = load_my_public_key_info_with_repair()
        except Exception as exc:
            public_info_error = str(exc)

    print_json(
        {
            "ok": True,
            "private_key_exists": private_key_exists(),
            "public_key_exists": public_key_exists(),
            "my_public_key": key_info_to_dict(public_info),
            "my_public_key_error": public_info_error,
            "contacts_count": len(contacts),
            "exports_dir": str(exports_dir()),
        }
    )
    return 0


def cmd_generate_my_keys(args: argparse.Namespace) -> int:
    init_db()

    info = generate_my_keypair(
        owner_name=str(args.owner_name).strip() or "SAM",
        overwrite=bool(args.overwrite),
    )

    print_json(
        {
            "ok": True,
            "operation": "generate-my-keys",
            "private_key_exists": private_key_exists(),
            "public_key_exists": public_key_exists(),
            "my_key": key_info_to_dict(info),
        }
    )
    return 0


def cmd_export_public(args: argparse.Namespace) -> int:
    init_db()

    output_dir = resolve_output_dir(args.output_dir)
    output_path = export_my_public_key(output_dir)

    print_json(
        {
            "ok": True,
            "operation": "export-public",
            "output_path": str(output_path),
        }
    )
    return 0


def cmd_list_contacts(args: argparse.Namespace) -> int:
    init_db()
    contacts = ContactRepository().list_contacts()

    print_json(
        {
            "ok": True,
            "contacts_count": len(contacts),
            "contacts": [contact_to_dict(contact) for contact in contacts],
        }
    )
    return 0



def cmd_list_groups(args: argparse.Namespace) -> int:
    init_db()
    groups = list_group_files()

    print_json(
        {
            "ok": True,
            "groups_count": len(groups),
            "groups": [group_to_dict(group) for group in groups],
        }
    )
    return 0


def cmd_create_group(args: argparse.Namespace) -> int:
    init_db()

    member_key_ids = [str(item).strip() for item in args.member_key_id or [] if str(item).strip()]

    if not member_key_ids:
        raise RuntimeError("Не вибрано жодного учасника групи.")

    result = create_local_group_file(
        group_name=str(args.name).strip(),
        member_key_ids=member_key_ids,
    )

    print_json(
        {
            "ok": True,
            "operation": "create-group",
            "group_name": result.group_name,
            "group_id": result.group_id,
            "member_count": result.member_count,
            "output_path": str(result.output_path),
        }
    )
    return 0


def cmd_export_group(args: argparse.Namespace) -> int:
    init_db()

    groups = list_group_files()
    matches = [group for group in groups if group.group_id == args.group_id]

    if not matches:
        raise RuntimeError(f"Групу не знайдено: {args.group_id}")

    source = matches[0].path
    output_dir = resolve_output_dir(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    destination = output_dir / source.name
    destination.write_bytes(source.read_bytes())

    print_json(
        {
            "ok": True,
            "operation": "export-group",
            "group_name": matches[0].group_name,
            "group_id": matches[0].group_id,
            "member_count": matches[0].member_count,
            "output_path": str(destination),
        }
    )
    return 0


def cmd_import_public(args: argparse.Namespace) -> int:
    init_db()

    source = Path(args.file).expanduser().resolve()
    info = load_public_key_file(source)

    repo = ContactRepository()
    repo.upsert_public_key(info, source_file=source)

    print_json(
        {
            "ok": True,
            "operation": "import-public",
            "display_name": info.owner_name,
            "key_id": info.key_id,
            "fingerprint": info.fingerprint,
            "source_file": str(source),
        }
    )
    return 0


def cmd_import_group(args: argparse.Namespace) -> int:
    init_db()

    source = Path(args.file).expanduser().resolve()
    local_path = save_group_file_to_local_store(source)
    result = import_group_file(local_path)

    print_json(
        {
            "ok": True,
            "operation": "import-group",
            "group_name": result.group_name,
            "group_id": result.group_id,
            "imported_count": result.imported_count,
            "updated_count": result.updated_count,
            "total_members": result.total_members,
            "source_file": str(source),
            "local_path": str(local_path),
        }
    )
    return 0


def select_recipients(args: argparse.Namespace) -> tuple[list[Contact], bool]:
    repo = ContactRepository()
    contacts = repo.list_contacts()

    if args.group:
        if not contacts:
            raise RuntimeError("Немає контактів для групового шифрування.")
        return contacts, True

    if args.recipient_id is not None:
        return [repo.get_contact_by_id(int(args.recipient_id))], False

    if args.recipient_key_id:
        matches = [c for c in contacts if c.key_id == args.recipient_key_id]
        if not matches:
            raise RuntimeError(f"Контакт з key_id не знайдено: {args.recipient_key_id}")
        return [matches[0]], False

    if args.recipient_name:
        needle = args.recipient_name.strip().lower()
        matches = [c for c in contacts if needle in c.display_name.lower()]

        if not matches:
            raise RuntimeError(f"Контакт за назвою не знайдено: {args.recipient_name}")

        if len(matches) > 1:
            names = "\n".join(f"- {c.display_name} — {c.key_id}" for c in matches)
            raise RuntimeError(f"Знайдено кілька контактів. Уточни key_id:\n{names}")

        return [matches[0]], False

    raise RuntimeError(
        "Не задано отримувача. Використай один із параметрів: "
        "--group, --recipient-id, --recipient-key-id, --recipient-name."
    )


def cmd_encrypt(args: argparse.Namespace) -> int:
    init_db()

    input_path = Path(args.input).expanduser().resolve()
    output_dir = resolve_output_dir(args.output_dir)

    recipients, is_group = select_recipients(args)

    if is_group:
        result = encrypt_file_for_contacts(
            input_path=input_path,
            output_dir=output_dir,
            recipients=recipients,
        )
    else:
        result = encrypt_file_for_contact(
            input_path=input_path,
            output_dir=output_dir,
            recipient=recipients[0],
        )

    print_json(
        {
            "ok": True,
            "operation": "encrypt",
            "output_path": str(result.output_path),
            "original_path": str(result.original_path),
            "original_size": result.original_size,
            "original_sha256": result.original_sha256,
            "recipient_name": result.recipient_name,
            "recipient_key_id": result.recipient_key_id,
            "recipient_count": result.recipient_count,
        }
    )
    return 0


def cmd_encrypt_self(args: argparse.Namespace) -> int:
    init_db()

    input_path = Path(args.input).expanduser().resolve()
    output_dir = resolve_output_dir(args.output_dir)

    info = load_my_public_key_info_with_repair()
    recipient = public_info_to_contact(info)

    result = encrypt_file_for_contact(
        input_path=input_path,
        output_dir=output_dir,
        recipient=recipient,
    )

    print_json(
        {
            "ok": True,
            "operation": "encrypt-self",
            "output_path": str(result.output_path),
            "original_path": str(result.original_path),
            "original_size": result.original_size,
            "original_sha256": result.original_sha256,
            "recipient_name": result.recipient_name,
            "recipient_key_id": result.recipient_key_id,
            "recipient_count": result.recipient_count,
        }
    )
    return 0


def cmd_decrypt(args: argparse.Namespace) -> int:
    init_db()

    input_path = Path(args.input).expanduser().resolve()
    output_dir = resolve_output_dir(args.output_dir)

    result = decrypt_file_with_my_private_key(
        encrypted_path=input_path,
        output_dir=output_dir,
    )

    print_json(
        {
            "ok": True,
            "operation": "decrypt",
            "output_path": str(result.output_path),
            "original_filename": result.original_filename,
            "original_size": result.original_size,
            "original_sha256": result.original_sha256,
        }
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sam_encrypt_cli.py",
        description="CLI helper for SAM Encrypt.",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("status")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("generate-my-keys")
    p.add_argument("--owner-name", required=True)
    p.add_argument("--overwrite", action="store_true")
    p.set_defaults(func=cmd_generate_my_keys)

    p = sub.add_parser("export-public")
    p.add_argument("--output-dir")
    p.set_defaults(func=cmd_export_public)

    p = sub.add_parser("list-contacts")
    p.set_defaults(func=cmd_list_contacts)

    p = sub.add_parser("list-groups")
    p.set_defaults(func=cmd_list_groups)

    p = sub.add_parser("create-group")
    p.add_argument("--name", required=True)
    p.add_argument("--member-key-id", action="append", default=[])
    p.set_defaults(func=cmd_create_group)

    p = sub.add_parser("export-group")
    p.add_argument("--group-id", required=True)
    p.add_argument("--output-dir")
    p.set_defaults(func=cmd_export_group)

    p = sub.add_parser("import-public")
    p.add_argument("--file", required=True)
    p.set_defaults(func=cmd_import_public)

    p = sub.add_parser("import-group")
    p.add_argument("--file", required=True)
    p.set_defaults(func=cmd_import_group)

    p = sub.add_parser("encrypt")
    p.add_argument("--input", required=True)
    p.add_argument("--output-dir")
    p.add_argument("--group", action="store_true")
    p.add_argument("--recipient-id", type=int)
    p.add_argument("--recipient-key-id")
    p.add_argument("--recipient-name")
    p.set_defaults(func=cmd_encrypt)

    p = sub.add_parser("encrypt-self")
    p.add_argument("--input", required=True)
    p.add_argument("--output-dir")
    p.set_defaults(func=cmd_encrypt_self)

    p = sub.add_parser("decrypt")
    p.add_argument("--input", required=True)
    p.add_argument("--output-dir")
    p.set_defaults(func=cmd_decrypt)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        return int(args.func(args))
    except Exception as exc:
        print_json(
            {
                "ok": False,
                "error": str(exc),
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

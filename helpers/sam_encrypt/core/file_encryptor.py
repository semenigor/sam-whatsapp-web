from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Sequence

from core.app_paths import exports_dir
from core.contact_repository import Contact
from core.container_format import VERSION, write_container_header, write_encrypted_chunk
from core.crypto_service import (
    encrypt_aead_xchacha20_poly1305,
    generate_file_key,
    generate_nonce,
    wrap_file_key_for_recipient,
)
from core.key_service import b64encode_bytes, utc_now_iso


DEFAULT_CHUNK_SIZE = 1024 * 1024


ProgressCallback = Callable[[int], None]


@dataclass(frozen=True)
class EncryptionResult:
    output_path: Path
    original_path: Path
    original_size: int
    original_sha256: str
    recipient_name: str
    recipient_key_id: str
    recipient_count: int


def unique_output_path(output_dir: Path, input_path: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)

    # Зовнішня назва не повинна розкривати реальну назву файлу.
    # Реальна назва зберігається тільки всередині encrypted metadata.
    for _ in range(1000):
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        random_part = secrets.token_hex(4).upper()
        candidate = output_dir / f"SAM-{timestamp}-{random_part}.samenc"

        if not candidate.exists():
            return candidate

    raise RuntimeError("Не вдалося створити унікальну назву .samenc файлу.")


def calculate_sha256(path: Path, progress_callback: ProgressCallback | None = None) -> str:
    digest = hashlib.sha256()
    total_size = path.stat().st_size
    processed = 0

    try:
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(DEFAULT_CHUNK_SIZE)
                if not chunk:
                    break

                digest.update(chunk)
                processed += len(chunk)

                if progress_callback and total_size > 0:
                    progress_callback(min(25, int(processed / total_size * 25)))

    except OSError as exc:
        raise RuntimeError(f"Не вдалося прочитати файл для SHA-256: {path}. Помилка: {exc}") from exc

    return digest.hexdigest()


def build_chunk_aad(chunk_index: int) -> bytes:
    return f"SAMENC1|chunk|{chunk_index}".encode("utf-8")


def build_metadata_aad(recipient_key_id: str) -> bytes:
    return f"SAMENC1|metadata|{recipient_key_id}".encode("utf-8")


def build_group_metadata_aad() -> bytes:
    return b"SAMENC1|metadata|recipients-v1"


def _deduplicate_recipients(recipients: Sequence[Contact]) -> list[Contact]:
    result: list[Contact] = []
    seen_key_ids: set[str] = set()

    for recipient in recipients:
        if recipient.key_id in seen_key_ids:
            continue

        seen_key_ids.add(recipient.key_id)
        result.append(recipient)

    return result


def _build_recipient_summary(recipients: Sequence[Contact]) -> tuple[str, str]:
    if len(recipients) == 1:
        return recipients[0].display_name, recipients[0].key_id

    names = [item.display_name for item in recipients[:3]]
    suffix = "" if len(recipients) <= 3 else f" +{len(recipients) - 3}"
    name_summary = f"Група ({len(recipients)}): " + ", ".join(names) + suffix
    key_summary = ",".join(item.key_id for item in recipients)
    return name_summary, key_summary


def encrypt_file_for_contact(
    input_path: Path,
    output_dir: Path | None,
    recipient: Contact,
    progress_callback: ProgressCallback | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> EncryptionResult:
    return encrypt_file_for_contacts(
        input_path=input_path,
        output_dir=output_dir,
        recipients=[recipient],
        progress_callback=progress_callback,
        chunk_size=chunk_size,
        force_single_recipient_format=True,
    )


def encrypt_file_for_contacts(
    input_path: Path,
    output_dir: Path | None,
    recipients: Sequence[Contact],
    progress_callback: ProgressCallback | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    force_single_recipient_format: bool = False,
) -> EncryptionResult:
    input_path = input_path.expanduser().resolve()

    if not input_path.exists():
        raise RuntimeError(f"Файл не знайдено: {input_path}")

    if not input_path.is_file():
        raise RuntimeError(f"Це не файл: {input_path}")

    if chunk_size <= 0:
        raise ValueError("chunk_size має бути більше 0.")

    actual_recipients = _deduplicate_recipients(list(recipients))

    if not actual_recipients:
        raise RuntimeError("Немає отримувачів для шифрування.")

    actual_output_dir = output_dir or exports_dir()
    output_path = unique_output_path(actual_output_dir, input_path)

    original_size = input_path.stat().st_size
    original_sha256 = calculate_sha256(input_path, progress_callback)

    file_key = generate_file_key()
    created_utc = utc_now_iso()

    metadata = {
        "original_filename": input_path.name,
        "original_size": original_size,
        "original_sha256": original_sha256,
        "created_utc": created_utc,
    }

    metadata_nonce = generate_nonce()
    metadata_plaintext = json.dumps(
        metadata,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    use_legacy_single_format = force_single_recipient_format and len(actual_recipients) == 1

    if use_legacy_single_format:
        metadata_aad = build_metadata_aad(actual_recipients[0].key_id)
    else:
        metadata_aad = build_group_metadata_aad()

    encrypted_metadata = encrypt_aead_xchacha20_poly1305(
        key=file_key,
        nonce=metadata_nonce,
        plaintext=metadata_plaintext,
        aad=metadata_aad,
    )

    if use_legacy_single_format:
        recipient = actual_recipients[0]
        header_recipient = {
            "display_name": recipient.display_name,
            "key_id": recipient.key_id,
            "fingerprint": recipient.fingerprint,
            "wrapped_file_key_b64": wrap_file_key_for_recipient(
                file_key=file_key,
                recipient_public_key_b64=recipient.public_key_b64,
            ),
        }

        header = {
            "format": "sam-encrypt-container",
            "version": VERSION,
            "cipher": "xchacha20-poly1305",
            "key_wrap": "sealedbox-curve25519",
            "chunk_size": chunk_size,
            "created_utc": created_utc,
            "recipient": header_recipient,
            "metadata": {
                "nonce_b64": b64encode_bytes(metadata_nonce),
                "ciphertext_b64": b64encode_bytes(encrypted_metadata),
            },
            "payload": {
                "type": "chunked-stream-v1",
            },
        }

    else:
        header_recipients = []

        for recipient in actual_recipients:
            header_recipients.append(
                {
                    "display_name": recipient.display_name,
                    "key_id": recipient.key_id,
                    "fingerprint": recipient.fingerprint,
                    "wrapped_file_key_b64": wrap_file_key_for_recipient(
                        file_key=file_key,
                        recipient_public_key_b64=recipient.public_key_b64,
                    ),
                }
            )

        header = {
            "format": "sam-encrypt-container",
            "version": VERSION,
            "cipher": "xchacha20-poly1305",
            "key_wrap": "sealedbox-curve25519",
            "chunk_size": chunk_size,
            "created_utc": created_utc,
            "recipients": header_recipients,
            "metadata": {
                "nonce_b64": b64encode_bytes(metadata_nonce),
                "ciphertext_b64": b64encode_bytes(encrypted_metadata),
            },
            "payload": {
                "type": "chunked-stream-v1",
            },
        }

    processed = 0
    chunk_index = 0

    try:
        with input_path.open("rb") as in_fh, output_path.open("wb") as out_fh:
            write_container_header(out_fh, header)

            while True:
                chunk = in_fh.read(chunk_size)
                if not chunk:
                    break

                nonce = generate_nonce()
                ciphertext = encrypt_aead_xchacha20_poly1305(
                    key=file_key,
                    nonce=nonce,
                    plaintext=chunk,
                    aad=build_chunk_aad(chunk_index),
                )

                write_encrypted_chunk(
                    fh=out_fh,
                    chunk_index=chunk_index,
                    nonce=nonce,
                    ciphertext=ciphertext,
                )

                processed += len(chunk)
                chunk_index += 1

                if progress_callback:
                    if original_size > 0:
                        progress = 25 + int(processed / original_size * 75)
                        progress_callback(min(100, progress))
                    else:
                        progress_callback(100)

        if progress_callback:
            progress_callback(100)

    except Exception:
        try:
            if output_path.exists():
                output_path.unlink()
        except OSError:
            pass
        raise

    recipient_name, recipient_key_id = _build_recipient_summary(actual_recipients)

    return EncryptionResult(
        output_path=output_path,
        original_path=input_path,
        original_size=original_size,
        original_sha256=original_sha256,
        recipient_name=recipient_name,
        recipient_key_id=recipient_key_id,
        recipient_count=len(actual_recipients),
    )

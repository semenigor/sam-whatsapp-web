from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from core.app_paths import exports_dir
from core.container_format import iter_encrypted_chunks, read_container_header
from core.crypto_service import (
    decrypt_aead_xchacha20_poly1305,
    unwrap_file_key_with_private_key,
)
from core.file_encryptor import build_chunk_aad, build_group_metadata_aad, build_metadata_aad
from core.key_service import b64decode_text, load_my_private_key_info


ProgressCallback = Callable[[int], None]


@dataclass(frozen=True)
class DecryptionResult:
    output_path: Path
    original_filename: str
    original_size: int
    original_sha256: str


@dataclass(frozen=True)
class RecipientMatch:
    key_id: str
    wrapped_file_key_b64: str
    metadata_aad: bytes


def sanitize_original_filename(filename: str) -> str:
    clean_name = Path(filename).name.strip()
    return clean_name or "decrypted_file"


def unique_decrypted_output_path(output_dir: Path, original_filename: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)

    safe_name = sanitize_original_filename(original_filename)
    candidate = output_dir / safe_name

    if not candidate.exists():
        return candidate

    path = Path(safe_name)
    stem = path.stem or "decrypted_file"
    suffix = path.suffix

    counter = 1

    while True:
        candidate = output_dir / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def calculate_sha256(path: Path) -> str:
    digest = hashlib.sha256()

    try:
        with path.open("rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError as exc:
        raise RuntimeError(f"Не вдалося прочитати файл для SHA-256: {path}. Помилка: {exc}") from exc

    return digest.hexdigest()


def validate_required_header_fields(header: dict) -> None:
    required_top = [
        "format",
        "version",
        "cipher",
        "key_wrap",
        "metadata",
        "payload",
    ]

    for field in required_top:
        if field not in header:
            raise RuntimeError(f"Контейнер пошкоджено: відсутнє поле header.{field}")

    if "recipient" not in header and "recipients" not in header:
        raise RuntimeError("Контейнер пошкоджено: немає recipient або recipients.")

    metadata = header["metadata"]

    if not isinstance(metadata, dict):
        raise RuntimeError("Контейнер пошкоджено: header.metadata не є обʼєктом.")

    for field in ["nonce_b64", "ciphertext_b64"]:
        if field not in metadata:
            raise RuntimeError(f"Контейнер пошкоджено: відсутнє поле metadata.{field}")

    if header["cipher"] != "xchacha20-poly1305":
        raise RuntimeError(f"Непідтримуваний cipher: {header['cipher']}")

    if header["key_wrap"] != "sealedbox-curve25519":
        raise RuntimeError(f"Непідтримуваний key_wrap: {header['key_wrap']}")

    if "recipient" in header:
        recipient = header["recipient"]

        if not isinstance(recipient, dict):
            raise RuntimeError("Контейнер пошкоджено: header.recipient не є обʼєктом.")

        for field in ["key_id", "wrapped_file_key_b64"]:
            if field not in recipient:
                raise RuntimeError(f"Контейнер пошкоджено: відсутнє поле recipient.{field}")

    if "recipients" in header:
        recipients = header["recipients"]

        if not isinstance(recipients, list):
            raise RuntimeError("Контейнер пошкоджено: header.recipients не є списком.")

        if not recipients:
            raise RuntimeError("Контейнер пошкоджено: список recipients порожній.")

        for index, recipient in enumerate(recipients):
            if not isinstance(recipient, dict):
                raise RuntimeError(f"Контейнер пошкоджено: recipients[{index}] не є обʼєктом.")

            for field in ["key_id", "wrapped_file_key_b64"]:
                if field not in recipient:
                    raise RuntimeError(
                        f"Контейнер пошкоджено: відсутнє поле recipients[{index}].{field}"
                    )


def find_recipient_match(header: dict, my_key_id: str) -> RecipientMatch:
    if "recipients" in header:
        for recipient in header["recipients"]:
            if str(recipient["key_id"]) == my_key_id:
                return RecipientMatch(
                    key_id=str(recipient["key_id"]),
                    wrapped_file_key_b64=str(recipient["wrapped_file_key_b64"]),
                    metadata_aad=build_group_metadata_aad(),
                )

        available = ", ".join(str(item.get("key_id", "UNKNOWN")) for item in header["recipients"])
        raise RuntimeError(
            "Цей файл зашифровано не для поточного приватного ключа.\n\n"
            f"Поточний Key ID: {my_key_id}\n"
            f"Key ID у файлі: {available}"
        )

    recipient = header["recipient"]
    recipient_key_id = str(recipient["key_id"])

    return RecipientMatch(
        key_id=recipient_key_id,
        wrapped_file_key_b64=str(recipient["wrapped_file_key_b64"]),
        metadata_aad=build_metadata_aad(recipient_key_id),
    )


def decrypt_metadata(header: dict, file_key: bytes, metadata_aad: bytes) -> dict:
    metadata_header = header["metadata"]

    metadata_nonce = b64decode_text(str(metadata_header["nonce_b64"]))
    metadata_ciphertext = b64decode_text(str(metadata_header["ciphertext_b64"]))

    metadata_plaintext = decrypt_aead_xchacha20_poly1305(
        key=file_key,
        nonce=metadata_nonce,
        ciphertext=metadata_ciphertext,
        aad=metadata_aad,
    )

    try:
        metadata = json.loads(metadata_plaintext.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError("Не вдалося прочитати metadata після розшифрування.") from exc

    if not isinstance(metadata, dict):
        raise RuntimeError("Metadata контейнера не є JSON-обʼєктом.")

    for field in ["original_filename", "original_size", "original_sha256"]:
        if field not in metadata:
            raise RuntimeError(f"Metadata пошкоджена: відсутнє поле {field}")

    return metadata


def decrypt_file_with_my_private_key(
    encrypted_path: Path,
    output_dir: Path | None,
    progress_callback: ProgressCallback | None = None,
) -> DecryptionResult:
    encrypted_path = encrypted_path.expanduser().resolve()

    if not encrypted_path.exists():
        raise RuntimeError(f"Файл не знайдено: {encrypted_path}")

    if not encrypted_path.is_file():
        raise RuntimeError(f"Це не файл: {encrypted_path}")

    private_info = load_my_private_key_info()
    actual_output_dir = output_dir or exports_dir()

    encrypted_size = encrypted_path.stat().st_size

    try:
        with encrypted_path.open("rb") as in_fh:
            header = read_container_header(in_fh)
            validate_required_header_fields(header)

            match = find_recipient_match(header, private_info.key_id)

            file_key = unwrap_file_key_with_private_key(
                wrapped_file_key_b64=match.wrapped_file_key_b64,
                private_key_b64=private_info.private_key_b64,
            )

            metadata = decrypt_metadata(header, file_key, match.metadata_aad)

            original_filename = sanitize_original_filename(str(metadata["original_filename"]))
            original_size = int(metadata["original_size"])
            original_sha256 = str(metadata["original_sha256"]).lower()

            output_path = unique_decrypted_output_path(actual_output_dir, original_filename)
            temp_path = output_path.with_name(output_path.name + ".tmp")

            written = 0
            expected_chunk_index = 0

            try:
                with temp_path.open("wb") as out_fh:
                    for chunk_index, nonce, ciphertext in iter_encrypted_chunks(in_fh):
                        if chunk_index != expected_chunk_index:
                            raise RuntimeError(
                                f"Контейнер пошкоджено: неправильний індекс chunk. "
                                f"Очікувався {expected_chunk_index}, отримано {chunk_index}."
                            )

                        plaintext = decrypt_aead_xchacha20_poly1305(
                            key=file_key,
                            nonce=nonce,
                            ciphertext=ciphertext,
                            aad=build_chunk_aad(chunk_index),
                        )

                        out_fh.write(plaintext)
                        written += len(plaintext)
                        expected_chunk_index += 1

                        if progress_callback and encrypted_size > 0:
                            progress = int(in_fh.tell() / encrypted_size * 90)
                            progress_callback(max(0, min(90, progress)))

                if written != original_size:
                    raise RuntimeError(
                        f"Розмір розшифрованого файлу не збігається. "
                        f"Очікувано: {original_size}, отримано: {written}."
                    )

                actual_sha256 = calculate_sha256(temp_path)

                if progress_callback:
                    progress_callback(95)

                if actual_sha256.lower() != original_sha256:
                    raise RuntimeError(
                        "SHA-256 розшифрованого файлу не збігається з metadata. "
                        "Файл пошкоджено або розшифрування некоректне."
                    )

                temp_path.replace(output_path)

                if progress_callback:
                    progress_callback(100)

            except Exception:
                try:
                    if temp_path.exists():
                        temp_path.unlink()
                except OSError:
                    pass
                raise

    except OSError as exc:
        raise RuntimeError(f"Не вдалося прочитати .samenc файл: {encrypted_path}. Помилка: {exc}") from exc

    return DecryptionResult(
        output_path=output_path,
        original_filename=original_filename,
        original_size=original_size,
        original_sha256=original_sha256,
    )

from __future__ import annotations

import json
import struct
from typing import BinaryIO, Iterator


MAGIC = b"SAMENC1\n"
VERSION = 1

CHUNK_HEADER_STRUCT = struct.Struct(">QI")
# Q = chunk_index uint64
# I = ciphertext_length uint32
# після цього:
# nonce 24 bytes
# ciphertext bytes


def make_header_bytes(header: dict) -> bytes:
    try:
        return json.dumps(
            header,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except Exception as exc:
        raise RuntimeError(f"Не вдалося сформувати header .samenc: {exc}") from exc


def write_container_header(fh: BinaryIO, header: dict) -> None:
    header_bytes = make_header_bytes(header)

    if len(header_bytes) > 20 * 1024 * 1024:
        raise RuntimeError("Header .samenc занадто великий.")

    fh.write(MAGIC)
    fh.write(len(header_bytes).to_bytes(4, "big"))
    fh.write(header_bytes)


def read_container_header(fh: BinaryIO) -> dict:
    magic = fh.read(len(MAGIC))

    if magic != MAGIC:
        raise RuntimeError("Це не файл SAM Encrypt або контейнер пошкоджено.")

    header_len_bytes = fh.read(4)

    if len(header_len_bytes) != 4:
        raise RuntimeError("Контейнер пошкоджено: немає довжини header.")

    header_len = int.from_bytes(header_len_bytes, "big")

    if header_len <= 0:
        raise RuntimeError("Контейнер пошкоджено: некоректна довжина header.")

    if header_len > 20 * 1024 * 1024:
        raise RuntimeError("Header .samenc занадто великий.")

    header_bytes = fh.read(header_len)

    if len(header_bytes) != header_len:
        raise RuntimeError("Контейнер пошкоджено: header обрізаний.")

    try:
        header = json.loads(header_bytes.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Контейнер пошкоджено: некоректний JSON header. {exc}") from exc

    if not isinstance(header, dict):
        raise RuntimeError("Контейнер пошкоджено: header не є JSON-обʼєктом.")

    if header.get("format") != "sam-encrypt-container":
        raise RuntimeError("Непідтримуваний формат контейнера.")

    if int(header.get("version", 0)) != VERSION:
        raise RuntimeError(f"Непідтримувана версія контейнера: {header.get('version')}")

    return header


def write_encrypted_chunk(
    fh: BinaryIO,
    chunk_index: int,
    nonce: bytes,
    ciphertext: bytes,
) -> None:
    if chunk_index < 0:
        raise ValueError("chunk_index не може бути відʼємним.")

    if len(nonce) != 24:
        raise ValueError("Некоректна довжина nonce для chunk.")

    if len(ciphertext) > 0xFFFFFFFF:
        raise ValueError("Chunk ciphertext занадто великий.")

    fh.write(CHUNK_HEADER_STRUCT.pack(chunk_index, len(ciphertext)))
    fh.write(nonce)
    fh.write(ciphertext)


def iter_encrypted_chunks(fh: BinaryIO) -> Iterator[tuple[int, bytes, bytes]]:
    while True:
        chunk_header = fh.read(CHUNK_HEADER_STRUCT.size)

        if chunk_header == b"":
            break

        if len(chunk_header) != CHUNK_HEADER_STRUCT.size:
            raise RuntimeError("Контейнер пошкоджено: обрізаний header chunk.")

        chunk_index, ciphertext_len = CHUNK_HEADER_STRUCT.unpack(chunk_header)

        nonce = fh.read(24)

        if len(nonce) != 24:
            raise RuntimeError("Контейнер пошкоджено: обрізаний nonce chunk.")

        ciphertext = fh.read(ciphertext_len)

        if len(ciphertext) != ciphertext_len:
            raise RuntimeError("Контейнер пошкоджено: обрізаний ciphertext chunk.")

        yield chunk_index, nonce, ciphertext

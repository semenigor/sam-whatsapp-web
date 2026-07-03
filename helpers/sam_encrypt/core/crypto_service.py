from __future__ import annotations

import os

from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_decrypt,
    crypto_aead_xchacha20poly1305_ietf_encrypt,
)
from nacl.exceptions import CryptoError
from nacl.public import PrivateKey, PublicKey, SealedBox

from core.key_service import b64decode_text, b64encode_bytes


FILE_KEY_SIZE = 32
XCHACHA20_POLY1305_KEY_SIZE = 32
XCHACHA20_POLY1305_NONCE_SIZE = 24


def generate_file_key() -> bytes:
    return os.urandom(FILE_KEY_SIZE)


def generate_nonce() -> bytes:
    return os.urandom(XCHACHA20_POLY1305_NONCE_SIZE)


def wrap_file_key_for_recipient(file_key: bytes, recipient_public_key_b64: str) -> str:
    if len(file_key) != FILE_KEY_SIZE:
        raise ValueError("Некоректна довжина file_key.")

    public_key_bytes = b64decode_text(recipient_public_key_b64)

    if len(public_key_bytes) != 32:
        raise ValueError("Некоректна довжина публічного ключа отримувача.")

    public_key = PublicKey(public_key_bytes)
    sealed_box = SealedBox(public_key)
    wrapped = sealed_box.encrypt(file_key)

    return b64encode_bytes(bytes(wrapped))


def unwrap_file_key_with_private_key(
    wrapped_file_key_b64: str,
    private_key_b64: str,
) -> bytes:
    private_key_bytes = b64decode_text(private_key_b64)

    if len(private_key_bytes) != 32:
        raise ValueError("Некоректна довжина приватного ключа.")

    wrapped_file_key = b64decode_text(wrapped_file_key_b64)

    try:
        private_key = PrivateKey(private_key_bytes)
        sealed_box = SealedBox(private_key)
        file_key = sealed_box.decrypt(wrapped_file_key)
    except CryptoError as exc:
        raise RuntimeError(
            "Не вдалося розшифрувати ключ файлу. "
            "Файл зашифровано не для цього приватного ключа або контейнер пошкоджено."
        ) from exc

    if len(file_key) != FILE_KEY_SIZE:
        raise RuntimeError("Розшифрований file_key має некоректну довжину.")

    return bytes(file_key)


def encrypt_aead_xchacha20_poly1305(
    key: bytes,
    nonce: bytes,
    plaintext: bytes,
    aad: bytes,
) -> bytes:
    if len(key) != XCHACHA20_POLY1305_KEY_SIZE:
        raise ValueError("Некоректна довжина ключа XChaCha20-Poly1305.")

    if len(nonce) != XCHACHA20_POLY1305_NONCE_SIZE:
        raise ValueError("Некоректна довжина nonce XChaCha20-Poly1305.")

    return crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        aad,
        nonce,
        key,
    )


def decrypt_aead_xchacha20_poly1305(
    key: bytes,
    nonce: bytes,
    ciphertext: bytes,
    aad: bytes,
) -> bytes:
    if len(key) != XCHACHA20_POLY1305_KEY_SIZE:
        raise ValueError("Некоректна довжина ключа XChaCha20-Poly1305.")

    if len(nonce) != XCHACHA20_POLY1305_NONCE_SIZE:
        raise ValueError("Некоректна довжина nonce XChaCha20-Poly1305.")

    try:
        return crypto_aead_xchacha20poly1305_ietf_decrypt(
            ciphertext,
            aad,
            nonce,
            key,
        )
    except CryptoError as exc:
        raise RuntimeError(
            "Не вдалося розшифрувати дані. "
            "Файл пошкоджено, змінено або використано неправильний ключ."
        ) from exc

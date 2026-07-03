from __future__ import annotations

import os
import platform
import sys
from pathlib import Path


APP_NAME = "SAM Encrypt"
SAM_ENCRYPT_HOME_ENV = "SAM_ENCRYPT_HOME"


def is_frozen_app() -> bool:
    return bool(getattr(sys, "frozen", False))


def source_project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def platform_runtime_root() -> Path:
    system = platform.system().lower()

    if system == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME

    if system == "windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / APP_NAME
        return Path.home() / "AppData" / "Roaming" / APP_NAME

    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return Path(xdg_data_home) / APP_NAME

    return Path.home() / ".local" / "share" / APP_NAME


def env_runtime_root() -> Path | None:
    value = os.environ.get(SAM_ENCRYPT_HOME_ENV, "").strip()

    if not value:
        return None

    path = Path(value).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def runtime_root() -> Path:
    env_root = env_runtime_root()

    if env_root is not None:
        return env_root

    if is_frozen_app():
        path = platform_runtime_root()
        path.mkdir(parents=True, exist_ok=True)
        return path

    return source_project_root()


def project_root() -> Path:
    return runtime_root()


def data_dir() -> Path:
    path = runtime_root() / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def db_path() -> Path:
    return data_dir() / "contacts.db"


def keys_dir() -> Path:
    path = runtime_root() / "keys"
    path.mkdir(parents=True, exist_ok=True)
    return path


def private_keys_dir() -> Path:
    path = keys_dir() / "private"
    path.mkdir(parents=True, exist_ok=True)
    return path


def public_keys_dir() -> Path:
    path = keys_dir() / "public"
    path.mkdir(parents=True, exist_ok=True)
    return path


def exports_dir() -> Path:
    path = runtime_root() / "exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def backups_dir() -> Path:
    path = runtime_root() / "backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


def my_private_key_path() -> Path:
    return private_keys_dir() / "my_private.samkey"


def my_public_key_path() -> Path:
    return public_keys_dir() / "my_public.sampub"

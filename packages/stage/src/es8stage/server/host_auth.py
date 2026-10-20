"""Mot de passe de la page de l'hôte (docs/stage-host.md) : elle peut éteindre le Pi ou effacer un set.

Tant qu'aucun mot de passe n'est choisi, tout est ouvert et la page propose d'en choisir un.
Le mot de passe est gardé haché (PBKDF2) ; la session est un cookie signé (HMAC) qui
survit aux redémarrages du service.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

COOKIE = "es8host"
SESSION_S = 30 * 24 * 3600
_ROUNDS = 200_000


class HostAuth:
    def __init__(self, file: Path):
        self.file = file
        self._data = self._read()

    def _read(self) -> dict:
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) and data.get("hash") else {}
        except (OSError, ValueError):
            return {}

    @property
    def is_set(self) -> bool:
        return bool(self._data)

    def _hash(self, password: str, salt: str) -> str:
        return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), _ROUNDS).hex()

    def check(self, password: str) -> bool:
        return self.is_set and hmac.compare_digest(self._hash(password, self._data["salt"]), self._data["hash"])

    def set_password(self, password: str) -> None:
        """Nouveau mot de passe ; les sessions ouvertes sont fermées (nouveau secret)."""
        if len(password) < 4:
            raise ValueError("The password needs 4 characters at least.")
        salt = secrets.token_hex(16)
        self._data = {"salt": salt, "hash": self._hash(password, salt), "secret": secrets.token_hex(32)}
        self.file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self._data, f)
        tmp.replace(self.file)

    def _sign(self, expires: int) -> str:
        return hmac.new(bytes.fromhex(self._data["secret"]), str(expires).encode(), hashlib.sha256).hexdigest()

    def token(self) -> str:
        expires = int(time.time()) + SESSION_S
        return f"{expires}.{self._sign(expires)}"

    def valid(self, token: str | None) -> bool:
        if not self.is_set:
            return True  # pas encore de mot de passe : ouvert
        try:
            expires, sig = (token or "").split(".", 1)
            return int(expires) > time.time() and hmac.compare_digest(sig, self._sign(int(expires)))
        except ValueError:
            return False

    @staticmethod
    def from_cookie(header: str | None) -> str | None:
        for part in (header or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE:
                return value
        return None

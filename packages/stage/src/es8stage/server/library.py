"""Bibliothèque de sets de `es8stage serve` (docs/stage-host.md) : projets, shows et sauvegardes de l'ES-8.

Un dossier par sorte sous `~/.local/share/es8stage/library/` ; un fichier par élément, nommé par
l'utilisateur. Le show joué est une copie dans `show.json` (celui que lit l'hôte de scène) ; son
nom dans la bibliothèque est noté dans `playing.json`.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

KINDS = {
    "projects": (".es8project.json", "es8ctl.project/1"),
    "shows": (".show.json", "es8ctl.show/1"),
    "backups": (".syx", None),
}
HISTORY_KEEP = 100  # versions gardées par set
HISTORY_GAP_S = 300  # deux versions gardées sont espacées d'au moins 5 min (le Designer enregistre à chaque frappe)
_VERSION = re.compile(r"^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d(?:-\d+)?$")
_NAME = re.compile(r"^[^/\\:*?\"<>|\x00-\x1f.][^/\\:*?\"<>|\x00-\x1f]{0,79}$")


class LibraryError(ValueError):
    """Demande refusée : le message est pour l'utilisateur ; `code` est le statut HTTP."""

    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


class Library:
    def __init__(self, root: Path, show_file: Path):
        self.root, self.show_file = root, show_file
        self.playing_file = root / "playing.json"

    # ---------------------------------------------------------------- noms
    def path(self, kind: str, name: str) -> Path:
        """Chemin d'un élément ; le nom est celui affiché, sans l'extension de sa sorte."""
        if kind not in KINDS:
            raise LibraryError(f"Unknown library section {kind!r}.", 404)
        name = name.strip()
        if not _NAME.match(name) or name.endswith((".", " ")):
            raise LibraryError(f"Invalid name {name!r}: no slash, no leading dot, 80 characters at most.")
        return self.root / kind / (name + KINDS[kind][0])

    def _check(self, kind: str, data: bytes) -> None:
        schema = KINDS[kind][1]
        if schema is None:
            if not (data[:1] == b"\xf0" and data[-1:] == b"\xf7"):
                raise LibraryError("Not a SysEx dump (.syx).")
            return
        try:
            doc = json.loads(data)
        except ValueError:
            raise LibraryError("Not JSON.") from None
        if not isinstance(doc, dict) or doc.get("schema") != schema:
            raise LibraryError(f"Not an {schema} document.")

    @staticmethod
    def etag(data: bytes) -> str:
        """Empreinte d'un élément : un écran qui enregistre dit sur quelle version il a travaillé."""
        return hashlib.sha256(data).hexdigest()[:16]

    # ---------------------------------------------------------------- historique des sets
    # Chaque enregistrement d'un set garde la version qu'il remplace : history/<set>/<date>.es8project.json.
    def _history_dir(self, name: str) -> Path:
        self.path("projects", name)  # même règle de nom
        return self.root / "history" / name.strip()

    def history(self, name: str) -> list[dict]:
        folder = self._history_dir(name)
        ext = KINDS["projects"][0]
        items = [{"id": p.name[: -len(ext)], "modified": p.stat().st_mtime, "size": p.stat().st_size}
                 for p in folder.glob("*" + ext)] if folder.is_dir() else []
        return sorted(items, key=lambda i: i["id"], reverse=True)

    def history_read(self, name: str, version: str) -> bytes:
        if not _VERSION.match(version):
            raise LibraryError(f"No version {version!r}.", 404)
        p = self._history_dir(name) / (version + KINDS["projects"][0])
        if not p.is_file():
            raise LibraryError(f"No version {version!r} of {name!r}.", 404)
        return p.read_bytes()

    def _keep_version(self, name: str, old: Path) -> None:
        folder = self._history_dir(name)
        folder.mkdir(parents=True, exist_ok=True)
        ext = KINDS["projects"][0]
        newest = max((p.stat().st_mtime for p in folder.glob("*" + ext)), default=None)
        if newest is not None and old.stat().st_mtime - newest < HISTORY_GAP_S:
            return
        stamp = datetime.fromtimestamp(old.stat().st_mtime).strftime("%Y-%m-%d %H.%M.%S")
        target, n = folder / (stamp + ext), 2
        while target.exists():
            target, n = folder / f"{stamp}-{n}{ext}", n + 1
        shutil.copy2(old, target)
        for extra in sorted(folder.glob("*" + ext), key=lambda p: p.name, reverse=True)[HISTORY_KEEP:]:
            extra.unlink()

    # ---------------------------------------------------------------- lecture
    def playing(self) -> str | None:
        try:
            name = json.loads(self.playing_file.read_text(encoding="utf-8")).get("show")
        except (OSError, ValueError, AttributeError):
            return None
        return name if isinstance(name, str) and self.path("shows", name).is_file() else None

    def listing(self) -> dict:
        out: dict = {"playing": self.playing()}
        for kind, (ext, _) in KINDS.items():
            items = []
            folder = self.root / kind
            for p in folder.glob("*" + ext) if folder.is_dir() else []:
                st = p.stat()
                items.append({"name": p.name[: -len(ext)], "modified": st.st_mtime, "size": st.st_size})
            out[kind] = sorted(items, key=lambda i: i["name"].lower())
        return out

    def read(self, kind: str, name: str) -> bytes:
        p = self.path(kind, name)
        if not p.is_file():
            raise LibraryError(f"No {name!r} in {kind}.", 404)
        return p.read_bytes()

    # ---------------------------------------------------------------- écriture
    def write(self, kind: str, name: str, data: bytes, replace: bool = True, base: str | None = None) -> None:
        """`base` : l'empreinte de la version que l'écran avait ouverte ; une autre version entre-temps est refusée."""
        p = self.path(kind, name)
        self._check(kind, data)
        if not replace and p.exists():
            raise LibraryError(f"{name!r} already exists in {kind}.", 409)
        if base is not None and p.is_file() and self.etag(p.read_bytes()) != base:
            raise LibraryError(f"{name!r} was changed on another screen since you opened it.", 412)
        if kind == "projects" and p.is_file() and p.read_bytes() != data:
            self._keep_version(name, p)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)
        if kind == "shows" and self.playing() == name:
            self._install(p)  # le show joué a changé : l'hôte le recharge

    def delete(self, kind: str, name: str) -> None:
        p = self.path(kind, name)
        if not p.is_file():
            raise LibraryError(f"No {name!r} in {kind}.", 404)
        if kind == "shows" and self.playing() == name:
            raise LibraryError("This show is the one being played: play another one first.", 409)
        p.unlink()

    def rename(self, kind: str, name: str, to: str) -> None:
        src, dst = self.path(kind, name), self.path(kind, to)
        if not src.is_file():
            raise LibraryError(f"No {name!r} in {kind}.", 404)
        if dst.exists():
            raise LibraryError(f"{to!r} already exists in {kind}.", 409)
        playing = kind == "shows" and self.playing() == name
        src.rename(dst)
        if kind == "projects" and self._history_dir(name).is_dir() and not self._history_dir(to).exists():
            self._history_dir(name).rename(self._history_dir(to))
        if playing:
            self._set_playing(to)

    def duplicate(self, kind: str, name: str, to: str | None = None) -> str:
        src = self.path(kind, name)
        if not src.is_file():
            raise LibraryError(f"No {name!r} in {kind}.", 404)
        to = to or self.free_name(kind, f"{name} copy")
        dst = self.path(kind, to)
        if dst.exists():
            raise LibraryError(f"{to!r} already exists in {kind}.", 409)
        shutil.copyfile(src, dst)
        return to

    def free_name(self, kind: str, base: str) -> str:
        name, n = base, 2
        while self.path(kind, name).exists():
            name, n = f"{base} {n}", n + 1
        return name

    # ---------------------------------------------------------------- show joué
    def play(self, name: str) -> None:
        p = self.path("shows", name)
        if not p.is_file():
            raise LibraryError(f"No {name!r} in shows.", 404)
        self._install(p)
        self._set_playing(name)

    def _install(self, p: Path) -> None:
        self.show_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.show_file.with_suffix(".tmp")
        shutil.copyfile(p, tmp)
        tmp.replace(self.show_file)

    def _set_playing(self, name: str | None) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.playing_file.write_text(json.dumps({"show": name}), encoding="utf-8")

    def show_posted(self) -> None:
        """Un show arrive par POST /stage/show.json (hors bibliothèque) : plus aucun show de la liste n'est joué."""
        if self.playing_file.exists():
            self._set_playing(None)

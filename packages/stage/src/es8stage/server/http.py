"""Serveur HTTP de ES8 Stage (docs/stage-host.md) : les applis, la bibliothèque, l'hôte de scène.

- Applis : `web/` de ce dépôt (designer, companion, host, stage-shared) et, par-dessus, celles
  de l'éditeur (`es8ctl` : control, shared) ; `/` mène à la Companion, la façade.
- Moteur du navigateur : `/stage-shared/engine.zip` = es8core + es8stage (sans le serveur),
  refait dès qu'une source change.
- Show courant : `GET|POST /stage/show.json` ; bibliothèque : `/library/…` ;
  hôte de scène (`--stage`) : `/stage/state`, `/stage/events`, `/stage/act`, pont MIDI
  `/stage/midi` et `/stage/midi/events` ; page de l'hôte : `/host/api/…`.
"""

from __future__ import annotations

import functools
import http.server
import io
import json
import os
import posixpath
import shutil
import socket
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .host_auth import COOKIE, SESSION_S, HostAuth
from .library import Library, LibraryError

SHOW_PATH = "/stage/show.json"
ZIP_PATH = "/stage-shared/engine.zip"
MAX_BODY = 4 * 1024 * 1024
SHOW_SCHEMA = "es8ctl.show/1"


def data_dir() -> Path:
    """Données du serveur : show courant, position, bibliothèque, mot de passe (persistent, sur le Pi aussi)."""
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "es8stage"


def web_roots() -> list[Path]:
    """Dossiers servis, dans l'ordre : les applis de ce dépôt, puis celles de l'éditeur (es8ctl)."""
    from es8ctl.cli import _web_roots

    here = Path(__file__).resolve().parent.parent  # paquet installé (es8stage/web), puis dépôt
    ours = next((b / "web" for b in (here, here.parents[3]) if (b / "web" / "stage-shared").is_dir()), None)
    if ours is None:
        raise FileNotFoundError("ES8 Stage web apps not found (web/stage-shared).")
    return [ours, _web_roots()["web"]]


def _engine_sources() -> list[tuple[Path, Path]]:
    """(fichier, chemin dans l'archive) des modules Python du navigateur."""
    import es8core

    import es8stage

    out = []
    for pkg in (es8core, es8stage):
        root = Path(pkg.__file__).resolve().parent
        for p in sorted(root.rglob("*.py")):
            rel = p.relative_to(root)
            if "__pycache__" in p.parts or (pkg is es8stage and rel.parts[0] in ("server", "cli.py")):
                continue  # le serveur et la CLI ne tournent pas dans le navigateur
            out.append((p, Path(root.name) / rel))
    return out


def engine_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, name in _engine_sources():
            archive.write(path, name)
    return buffer.getvalue()


def lan_address() -> str:
    """Adresse de cette machine sur le réseau local (une socket UDP « connectée » n'envoie rien)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
        except OSError:
            return socket.gethostname()


def system_info(where: Path) -> dict:
    """Ce que la page de l'hôte montre du système (Linux du Pi ; ailleurs, ce qui est disponible)."""
    info: dict = {"hostname": socket.gethostname()}
    try:
        info["uptime_s"] = float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        pass
    try:
        info["temp_c"] = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
    except (OSError, ValueError):
        pass
    try:
        info["load"] = os.getloadavg()[0]
    except OSError:
        pass
    try:
        du = shutil.disk_usage(where if where.exists() else Path.home())
        info["disk_free"], info["disk_total"] = du.free, du.total
    except OSError:
        pass
    return info


def _later(cmd: list[str], delay: float = 0.7) -> None:
    """Lance une commande système un peu après la réponse HTTP (redémarrer le service coupe la connexion)."""
    threading.Timer(delay, lambda: subprocess.run(cmd, check=False, capture_output=True)).start()


def make_server(port: int, lan: bool = False, host=None, data: Path | None = None, service: str = "es8-stage"):
    """Serveur prêt à `serve_forever()`. `host` : StageServer (hôte de scène) ou None."""
    data = data or data_dir()
    show_file = data / "show.json"
    library = Library(data / "library", show_file)
    auth = HostAuth(data / "host-auth.json")
    roots = web_roots()
    engine = {"key": None, "zip": b""}

    def archive() -> bytes:
        sources = _engine_sources()
        key = (len(sources), max((p.stat().st_mtime_ns for p, _ in sources), default=0))
        if key != engine["key"]:
            engine.update(key=key, zip=engine_zip())
        return engine["zip"]

    class Handler(http.server.SimpleHTTPRequestHandler):
        # ------------------------------------------------------------ outils
        def _reply(self, code: int, body: bytes = b"", kind: str = "application/json"):
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _error(self, code: int, message: str):
            return self._reply(code, json.dumps({"error": message}).encode())

        def _raw(self):
            size = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(size) if 0 < size <= MAX_BODY else None

        def _body(self):
            raw = self._raw()
            try:
                return json.loads(raw) if raw is not None else None
            except ValueError:
                return None

        def _authed(self) -> bool:
            return auth.valid(HostAuth.from_cookie(self.headers.get("Cookie")))

        # ------------------------------------------------------------ flux (Server-Sent Events)
        def _stream_start(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

        def _events(self):
            """L'état de scène à chaque changement (et toutes les 15 s, pour garder le lien)."""
            self._stream_start()
            try:
                while True:
                    snap = host.snapshot()
                    self.wfile.write(f"data: {json.dumps(snap)}\n\n".encode())
                    self.wfile.flush()
                    host.wait(snap["version"])
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        def _midi_events(self):
            """Ce que l'ES-8 répond, pour un éditeur branché sur le pont MIDI."""
            self._stream_start()
            seen = host.midi_seq  # seulement ce qui arrive à partir de maintenant
            try:
                self.wfile.write(b": bridge open\n\n")
                self.wfile.flush()
                while True:
                    items = host.bridge_wait(seen)
                    for n, msg in items:
                        self.wfile.write(f"data: {json.dumps(msg)}\n\n".encode())
                        seen = n
                    if not items:
                        self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        # ------------------------------------------------------------ bibliothèque
        def _library(self, method: str):
            """/library/ : la liste ; /library/<sorte>/<nom> : lire, écrire (PUT), supprimer, POST {op}."""
            parts = urlsplit(self.path)
            segs = [unquote(x) for x in parts.path.split("/")[2:] if x]
            query = parse_qs(parts.query, keep_blank_values=True)
            try:
                if not segs and method == "GET":
                    return self._reply(200, json.dumps(library.listing()).encode())
                if len(segs) != 2:
                    raise LibraryError("Expected /library/<section>/<name>.", 404)
                kind, name = segs
                if method == "GET":
                    data = library.read(kind, name)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream" if kind == "backups" else "application/json")
                    if "download" in query:
                        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''"
                                         + quote(library.path(kind, name).name))
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return None
                if method == "PUT":
                    data = self._raw()
                    if data is None:
                        raise LibraryError("Empty or too large.", 413)
                    library.write(kind, name, data, replace="new" not in query)
                elif method == "DELETE":
                    if not self._authed():
                        raise LibraryError("Deleting needs the host password: log in on the host page (/host/).", 401)
                    library.delete(kind, name)
                else:
                    cmd = self._body() or {}
                    op = cmd.get("op")
                    if op == "rename":
                        library.rename(kind, name, str(cmd.get("to", "")))
                    elif op == "duplicate":
                        return self._reply(200, json.dumps({"name": library.duplicate(kind, name, cmd.get("to"))}).encode())
                    elif op == "play" and kind == "shows":
                        library.play(name)
                        if host is not None:
                            host.show_updated()
                    else:
                        raise LibraryError(f"Unknown operation {op!r}.")
                return self._reply(204)
            except LibraryError as exc:
                return self._error(exc.code, str(exc))

        # ------------------------------------------------------------ page de l'hôte
        def _login(self):
            self.send_response(204)
            self.send_header("Set-Cookie", f"{COOKIE}={auth.token()}; Path=/; Max-Age={SESSION_S}; HttpOnly; SameSite=Strict")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _host(self, method: str):
            """État, mot de passe, système, sauvegarde et restauration de l'ES-8."""
            route = self.path.split("?")[0][len("/host/api/"):]
            if method == "GET" and route == "status":
                status = {"auth": {"set": auth.is_set, "ok": self._authed()}, "stage": host is not None,
                          "system": system_info(data)}
                if host is not None:
                    snap = host.snapshot()
                    show = snap["show"] or {}
                    status.update(midi=snap["midi"], edit=snap["edit"], job=snap["job"], version=snap["version"],
                                  ble=host.ble_address, pos=snap["pos"],
                                  show=[sl["name"] for sl in show.get("setlists", [])] or None)
                return self._reply(200, json.dumps(status).encode())
            if method != "POST":
                return self._reply(404)
            body = self._body() or {}
            if route == "login":
                if not auth.check(str(body.get("password", ""))):
                    time.sleep(1)  # pas de devinettes en rafale
                    return self._error(401, "Wrong password.")
                return self._login()
            if route == "logout":
                self.send_response(204)
                self.send_header("Set-Cookie", f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
                self.send_header("Content-Length", "0")
                return self.end_headers()
            if not self._authed():
                return self._error(401, "Log in first.")
            if route == "password":
                try:
                    auth.set_password(str(body.get("password", "")))
                except ValueError as exc:
                    return self._error(400, str(exc))
                return self._login()
            if host is None:
                return self._error(400, "Only on a stage host (es8stage serve --stage).")
            err = None
            if route == "edit":
                host.set_edit(bool(body.get("on")))
            elif route == "reconnect":
                host.reconnect()
            elif route == "backup":
                err = host.backup(library, (str(body["name"]).strip() or None) if body.get("name") else None)
            elif route == "restore":
                try:
                    err = host.restore(library, str(body.get("name", "")))
                except LibraryError as exc:
                    err = str(exc)
            elif route in ("restart", "reboot", "poweroff"):
                cmd = {"restart": ["systemctl", "restart", service], "reboot": ["systemctl", "reboot"],
                       "poweroff": ["systemctl", "poweroff"]}[route]
                _later(["sudo", "-n", *cmd])
            else:
                return self._reply(404)
            return self._error(409, err) if err else self._reply(204)

        # ------------------------------------------------------------ verbes
        def do_PUT(self):  # noqa: N802
            return self._library("PUT") if self.path.startswith("/library/") else self._reply(404)

        def do_DELETE(self):  # noqa: N802
            return self._library("DELETE") if self.path.startswith("/library/") else self._reply(404)

        def do_POST(self):  # noqa: N802
            route = self.path.split("?")[0]
            if route.startswith("/library/"):
                return self._library("POST")
            if route.startswith("/host/api/"):
                return self._host("POST")
            if route == "/stage/midi" and host is not None:  # pont MIDI des éditeurs
                body = self._body()
                messages = body.get("messages") if isinstance(body, dict) else None
                if not isinstance(messages, list) or not all(isinstance(m, list) for m in messages):
                    return self._reply(400)
                err = host.bridge_send(messages)
                if err:
                    return self._error(423 if "locked" in err else 503, err)
                return self._reply(204)
            if route == "/stage/act" and host is not None:
                cmd = self._body()
                if not isinstance(cmd, dict):
                    return self._reply(400)
                host.handle(cmd)
                return self._reply(204)
            if route != SHOW_PATH:
                return self._reply(404)
            # Show courant (Companion « Load a show ») : hors bibliothèque.
            doc = self._body()
            if not isinstance(doc, dict) or doc.get("schema") != SHOW_SCHEMA:
                return self._error(400, f"Not an {SHOW_SCHEMA} document.")
            show_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = show_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(doc), encoding="utf-8")
            tmp.replace(show_file)
            library.show_posted()
            if host is not None:
                host.show_updated()
            return self._reply(204)

        def do_GET(self):  # noqa: N802 (API http.server)
            route = self.path.split("?")[0]
            if route == "/":
                self.send_response(302)
                self.send_header("Location", "/companion/")
                self.send_header("Content-Length", "0")
                return self.end_headers()
            if route.startswith("/library/"):
                return self._library("GET")
            if route.startswith("/host/api/"):
                return self._host("GET")
            if route == "/stage/state":
                return self._reply(200, json.dumps(host.snapshot()).encode()) if host else self._reply(404)
            if route == "/stage/events" and host is not None:
                return self._events()
            if route == "/stage/midi/events" and host is not None:
                return self._midi_events()
            if route == SHOW_PATH:
                return self._reply(200, show_file.read_bytes()) if show_file.is_file() else self._reply(404)
            if route == ZIP_PATH:
                return self._reply(200, archive(), "application/zip")
            if route in ("/control/", "/control/index.html"):  # ES8 Control passe par l'hôte de scène
                page = Path(self.translate_path("/control/index.html")).read_text(encoding="utf-8")
                tag = '<script type="module" src="app.js"></script>'
                page = page.replace(tag, '<script type="module" src="../stage-shared/control.js"></script>\n  ' + tag, 1)
                return self._reply(200, page.encode(), "text/html; charset=utf-8")
            return super().do_GET()

        def translate_path(self, path):
            # normpath depuis la racine : un « .. » ne peut pas sortir des dossiers servis
            clean = posixpath.normpath("/" + unquote(path.split("?")[0])).lstrip("/")
            first = clean.split("/")[0]
            for base in roots:
                if first and (base / first).is_dir():
                    return str(base / clean)
            return str(roots[0] / "__missing__")

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, *args):
            pass

    handler = functools.partial(Handler, directory=str(roots[0]))
    server = http.server.ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", port), handler)
    server.daemon_threads = True  # les flux d'événements ne retiennent pas l'arrêt
    return server

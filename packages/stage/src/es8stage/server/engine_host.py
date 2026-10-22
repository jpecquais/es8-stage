"""Moteur des éditeurs sur l'hôte de scène (docs/stage-host.md, « Moteur sur l'hôte ») : le pont Python
d'ES8 Designer et d'ES8 Control (`es8stage.webapp`) tourne ici, et la page n'en est que l'écran.

Charger Python dans le navigateur (Pyodide) coûte des dizaines de Mo et demande internet : un iPad
ancien plante, et le Wi-Fi du Pi n'a pas internet. Ici :

- une boucle asyncio à elle, dans un fil : les appels de la page y passent l'un après l'autre,
  comme dans le navigateur ;
- l'ES-8 est celui de l'hôte : les envois passent par le pont MIDI (mêmes règles : écrire demande
  le mode édition), le SysEx reçu arrive par `push` ;
- un seul état pour toutes les pages (le Pi fait foi), gardé sur disque après chaque lecture.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
from datetime import datetime
from pathlib import Path

# Fonctions qui parlent à l'ES-8 (coroutines) ; celles qui prennent un rapport d'avancement en dernier.
DEVICE = {"read_device", "read_some", "read_names", "write_pending", "select_on_device"}
PROGRESS = {"read_device", "read_some", "read_names", "write_pending"}


class EngineError(Exception):
    def __init__(self, message: str, code: int = 500):
        super().__init__(message)
        self.code = code


def _decode(arg):
    return base64.b64decode(arg["$bytes"]) if isinstance(arg, dict) and "$bytes" in arg else arg


def _encode(result):
    if isinstance(result, (bytes, bytearray)):
        return {"$bytes": base64.b64encode(bytes(result)).decode()}
    return result


class EngineHost:
    def __init__(self, server, cache_file: Path):
        self.server, self.cache_file = server, cache_file
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True, name="stage-engine").start()
        self.running: str | None = None  # échange en cours avec l'ES-8
        self.progress: list = []
        self.synced = False  # noms et réglages lus sur l'ES-8 depuis le démarrage
        self._gate = threading.Lock()
        self.module, self.core = self._run(self._setup()).result()

    async def _setup(self):
        from es8core import webapp as core

        from es8stage import webapp

        core.set_sender(self._send)
        self.server.engine_in = lambda data: self.loop.call_soon_threadsafe(core.push, data)
        if self.cache_file.is_file():
            try:
                saved = json.loads(self.cache_file.read_text(encoding="utf-8"))
                core.load_cached(base64.b64decode(saved["data"]), saved["date"])
            except (ValueError, KeyError, OSError):
                pass  # cache abîmé : on relira l'ES-8
        return webapp, core

    def _run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def _send(self, raw) -> None:
        err = self.server.bridge_send([list(raw)])
        if err:
            raise RuntimeError(err)

    def call(self, fn: str, args: list):
        """Appel d'une fonction du pont ; rend son résultat (texte JSON, ou octets en base64)."""
        if fn == "engine_status":
            return json.dumps({"synced": self.synced, "running": self.running})
        func = getattr(self.module, fn, None) if not fn.startswith("_") else None
        if not callable(func):
            raise EngineError(f"Unknown engine function {fn!r}.", 400)
        args = [_decode(a) for a in args]
        if fn not in DEVICE:
            return _encode(self._run(self._plain(func, args)).result(timeout=60))
        if self.server.busy():
            raise EngineError(f"The stage host is busy ({self.server.job['kind']} of the ES-8): try again when it is done.", 409)
        if not self._gate.acquire(blocking=False):
            raise EngineError(f"Already talking to the ES-8 ({self.running}).", 409)
        try:
            self.running, self.progress = fn, []
            if fn in PROGRESS:
                args.append(lambda *p: setattr(self, "progress", list(p)))
            result = self._run(func(*args)).result()
            if fn == "read_names":
                self.synced = json.loads(result).get("names", 0) >= 800
            if fn != "select_on_device":
                self._run(self._save()).result()
            return result
        finally:
            self.running = None
            self._gate.release()

    @staticmethod
    async def _plain(func, args):
        return func(*args)

    async def _save(self) -> None:
        """Dernière lecture de l'ES-8 gardée sur disque : affichée (marquée ancienne) après un redémarrage."""
        core = self.core
        if not core.state["frames"] or core.state["source"] == "file":
            return
        data = {"date": datetime.now().astimezone().isoformat(timespec="seconds"),
                "data": base64.b64encode(core.syx_bytes()).decode()}
        tmp = self.cache_file.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data), encoding="utf-8")
            tmp.replace(self.cache_file)
        except OSError:
            pass

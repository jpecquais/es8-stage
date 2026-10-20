"""Moteur de scène de `es8ctl web --stage` (docs/stage-host.md) : MIDI, état, événements pour les écrans.

- La logique est `es8core.stage.Stage` ; ici, seulement les entrées/sorties.
- MIDI : mido + python-rtmidi. Le port est cherché par un morceau de son nom (« WIDI ») et
  rouvert tout seul s'il disparaît ; avec une adresse Bluetooth, on relance la connexion.
- Écrans : l'état est poussé en Server-Sent Events (`/stage/events`), les gestes arrivent en
  POST (`/stage/act`). Rien d'autre que la bibliothèque standard côté réseau.
"""

from __future__ import annotations

import asyncio
import json
import queue
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from es8core.stage import Stage, check_show


class StageServer:
    def __init__(self, show_file: Path, midi_match: str = "WIDI", ble_address: str | None = None, log=print):
        self.show_file, self.midi_match, self.ble_address, self.log = show_file, midi_match, ble_address, log
        self.state_file = show_file.with_name("stage.json")
        self.lock = threading.RLock()
        self.cond = threading.Condition()
        self.version = 0
        self.port_name: str | None = None
        self._in = self._out = None
        self._show_mtime = None
        # Pont MIDI des éditeurs (Designer, Control) : ce que l'ES-8 répond, numéroté, pour les flux /stage/midi/events.
        self.midi_log: list[tuple[int, list[int]]] = []
        self.midi_seq = 0
        self.midi_cond = threading.Condition()
        self.edit = False  # mode édition : la scène est en pause, les éditeurs peuvent écrire sur l'ES-8
        self._taps: list[queue.Queue] = []  # SysEx reçu, pour les travaux de l'hôte (sauvegarde, restauration)
        self.job: dict | None = None  # travail en cours ou dernier fini : {kind, phase, n, total, done, error, result}
        self.stage = Stage(send=self._send, changed=self._changed)
        self._load_show(restore=True)

    # ---------------------------------------------------------------- show et persistance
    def _load_show(self, restore: bool = False) -> None:
        if not self.show_file.is_file():
            return
        try:
            show = json.loads(self.show_file.read_text(encoding="utf-8"))
        except ValueError:
            return
        if check_show(show):
            return
        self._show_mtime = self.show_file.stat().st_mtime_ns
        saved = {}
        if restore and self.state_file.is_file():
            try:
                saved = json.loads(self.state_file.read_text(encoding="utf-8"))
            except ValueError:
                saved = {}
        same = saved.get("exported") == show.get("exported")
        with self.lock:
            self.stage.backup = bool(saved.get("backup")) if same else False
            self.stage.load(show, saved.get("pos") if same else None)  # reprise sans rien envoyer

    def show_updated(self) -> None:
        """Le fichier show vient d'être remplacé (POST /stage/show.json) : le recharger."""
        self._load_show()

    def _save(self) -> None:
        st = self.stage
        if not st.show:
            return
        data = {"exported": st.show.get("exported"), "pos": st.pos, "backup": st.backup}
        tmp = self.state_file.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data), encoding="utf-8")
            tmp.replace(self.state_file)
        except OSError:
            pass  # système en lecture seule : on joue quand même

    def _changed(self) -> None:
        self._save()
        with self.cond:
            self.version += 1
            self.cond.notify_all()

    # ---------------------------------------------------------------- MIDI
    def _send(self, data) -> bool:
        out = self._out
        if out is None:
            return False
        import mido

        try:
            out.send(mido.Message.from_bytes(list(data)))
            return True
        except (OSError, ValueError) as exc:
            self.log(f"MIDI send failed: {exc}")
            return False

    def _on_midi(self, msg) -> None:
        if msg.type in ("clock", "active_sensing"):
            return
        data = msg.bytes()
        if msg.type == "sysex":
            for tap in list(self._taps):
                tap.put(bytes(data))
        with self.midi_cond:  # tout part aussi vers les éditeurs branchés sur le pont
            self.midi_seq += 1
            self.midi_log.append((self.midi_seq, data))
            del self.midi_log[:-2000]
            self.midi_cond.notify_all()
        if msg.type == "sysex" or self.edit:
            return  # réponses aux éditeurs ; en mode édition, la scène ne réagit plus aux switches
        with self.lock:
            self.stage.midi_in(data)

    # ---------------------------------------------------------------- pont MIDI des éditeurs
    # Hors mode édition, seuls les messages sans risque passent : lectures (RQ1), mode éditeur (7F50),
    # affichage et sélection de patch (7F03, 7F01). Une écriture (DT1 ailleurs) demande le mode édition.
    _SAFE_DT1 = {(0x7F, 0x50), (0x7F, 0x03), (0x7F, 0x01)}

    def _allowed(self, data: list[int]) -> bool:
        if self.edit or not data or data[0] != 0xF0:
            return True
        if len(data) > 9 and data[1] == 0x41 and data[7] == 0x12:  # DT1 Roland : adresse en 8–9
            return (data[8], data[9]) in self._SAFE_DT1
        return True

    def bridge_send(self, messages: list[list[int]]) -> str | None:
        """Envoie des messages d'un éditeur à l'ES-8 ; rend une erreur ou None."""
        if self._out is None:
            return "The ES-8 is not connected to the stage host."
        if self.busy():
            return f"The stage host is busy ({self.job['kind']} of the ES-8): try again when it is done."
        if not all(self._allowed(m) for m in messages):
            return "Writing to the ES-8 is locked while the stage plays: turn Edit mode on (it pauses ES8 Companion)."
        for m in messages:
            if not self._send(m):
                return "MIDI send failed."
        return None

    def bridge_wait(self, after: int, timeout: float = 15.0) -> list[tuple[int, list[int]]]:
        """Messages reçus de l'ES-8 après le numéro `after` (attend jusqu'à `timeout`)."""
        with self.midi_cond:
            self.midi_cond.wait_for(lambda: self.midi_seq > after, timeout=timeout)
            return [(n, d) for n, d in self.midi_log if n > after]

    def set_edit(self, on: bool) -> None:
        if not on and self.busy() and self.job["kind"] == "restore":
            return  # une restauration écrit encore : la scène reste en pause
        self.edit = bool(on)
        with self.lock:
            self.stage.traffic.update({"in": "host", "action": "Edit mode on" if on else "Edit mode off"})
        self._changed()

    def reconnect(self) -> None:
        """Bouton de la page de l'hôte : ferme le port et relance aussitôt la liaison (Bluetooth compris)."""
        self._close()
        self._last_ble = 0.0
        if self.ble_address:
            try:
                subprocess.run(["bluetoothctl", "disconnect", self.ble_address], capture_output=True, timeout=10, check=False)
            except (subprocess.TimeoutExpired, OSError):
                pass
        self._changed()

    # ---------------------------------------------------------------- sauvegarde et restauration de l'ES-8
    def busy(self) -> bool:
        return bool(self.job and not self.job.get("done"))

    def _start_job(self, kind: str, work) -> str | None:
        if self._out is None:
            return "The ES-8 is not connected to the stage host."
        if self.busy():
            return f"Already busy: {self.job['kind']}."
        self.job = {"kind": kind, "phase": "start", "n": 0, "total": 0, "done": False, "error": None, "result": None}
        self._changed()

        def run():
            tap: queue.Queue = queue.Queue()
            self._taps.append(tap)
            try:
                self.job["result"] = asyncio.run(work(_BridgeTransport(self, tap)))
            except Exception as exc:  # noqa: BLE001 — rapporté à la page
                self.job["error"] = str(exc) or repr(exc)
            finally:
                self._taps.remove(tap)
                self.job["done"] = True
                self._changed()

        threading.Thread(target=run, daemon=True, name=f"stage-{kind}").start()
        return None

    def _progress(self, phase: str):
        last = [0.0]

        def report(n: int, total: int) -> None:
            self.job.update(phase=phase, n=n, total=total)
            if time.monotonic() - last[0] > 0.5 or n == total:
                last[0] = time.monotonic()
                self._changed()
        return report

    async def _read_all(self, transport, phase: str = "read"):
        from es8core.codec import PATCH_COUNT
        from es8core.request import patch_page
        from es8core.session import read_pages_async

        pages = list(range(8)) + [patch_page(i) for i in range(PATCH_COUNT)]
        frames, missing = await read_pages_async(transport, pages, on_progress=self._progress(phase))
        if missing:
            raise RuntimeError(f"{len(missing)} page(s) of the ES-8 could not be read; nothing was saved.")
        return frames

    def backup(self, library, name: str | None = None) -> str | None:
        """Lit tout l'ES-8 (≈ 800 pages) et range le dump dans la bibliothèque. Lecture seule : permis en jouant."""
        from es8core.request import frames_to_syx

        async def work(transport):
            frames = await self._read_all(transport)
            target = name or library.free_name("backups", f"ES-8 {datetime.now().strftime('%Y-%m-%d %H.%M')}")
            library.write("backups", target, frames_to_syx(frames))
            return {"name": target}

        return self._start_job("backup", work)

    def restore(self, library, name: str) -> str | None:
        """Remet l'ES-8 dans l'état d'une sauvegarde : relit l'ES-8 (gardé en sauvegarde « Before restore »),
        écrit seulement les pages qui diffèrent, puis les relit pour les vérifier. Demande le mode édition."""
        from es8core.apply import DEFAULT_INTERVAL_S, DEFAULT_PAGE_GAP_S, pending_pages
        from es8core.codec import PATCH_FRAMES
        from es8core.codec.roland import split_frames
        from es8core.request import frames_to_syx
        from es8core.session import write_confirmed_async

        if not self.edit:
            return "Restoring writes to the ES-8: turn Edit mode on first (it pauses ES8 Companion)."
        dump = list(split_frames(library.read("backups", name)))

        async def work(transport):
            device = await self._read_all(transport, "read")
            before = library.free_name("backups", f"Before restore {datetime.now().strftime('%Y-%m-%d %H.%M')}")
            library.write("backups", before, frames_to_syx(device))
            todo = [f for page in pending_pages(dump, device) for f in page]
            if not todo:
                return {"pages": 0, "confirmed": True, "before": before}

            def report(phase, n, total):
                self._progress(phase)(n, total)

            r = await write_confirmed_async(transport, todo, DEFAULT_INTERVAL_S, DEFAULT_PAGE_GAP_S, on_progress=report)
            return {"pages": len(todo) // PATCH_FRAMES, "confirmed": r["confirmed"], "before": before}

        return self._start_job("restore", work)

    def _ble_reconnect(self) -> None:
        """Relance la liaison Bluetooth : un court balayage (BlueZ doit revoir l'appareil), puis la connexion."""
        for cmd in (["bluetoothctl", "--timeout", "6", "scan", "on"], ["bluetoothctl", "connect", self.ble_address]):
            try:
                subprocess.run(cmd, capture_output=True, timeout=20, check=False)
            except (subprocess.TimeoutExpired, OSError) as exc:
                self.log(f"Bluetooth: {exc}")

    def midi_loop(self) -> None:
        """Ouvre le port quand il apparaît, le referme s'il disparaît ; relance le Bluetooth au besoin.
        Ne s'arrête jamais : une erreur est notée et la boucle repart."""
        while True:
            try:
                self._midi_round()
            except Exception as exc:  # noqa: BLE001 — sur scène, la boucle ne doit jamais mourir
                self.log(f"MIDI loop: {exc!r}")
            time.sleep(2)

    _last_ble = 0.0

    def _midi_round(self) -> None:
        import mido

        names = [n for n in mido.get_input_names() if self.midi_match.lower() in n.lower()]
        outs = [n for n in mido.get_output_names() if self.midi_match.lower() in n.lower()]
        if self._in is None and names and outs:
            try:
                self._in = mido.open_input(names[0], callback=self._on_midi)
                self._out = mido.open_output(outs[0])
                self.port_name = outs[0]
                self.log(f"MIDI: {outs[0]}")
                self._changed()
            except OSError as exc:
                self.log(f"MIDI open failed: {exc}")
                self._close()
        elif self._in is not None and not names:
            self.log("MIDI: port gone")
            self._close()
            self._changed()
        if self._in is None and self.ble_address and time.monotonic() - self._last_ble > 10:
            self._last_ble = time.monotonic()
            self._ble_reconnect()
        if self.show_file.is_file() and self.show_file.stat().st_mtime_ns != self._show_mtime:
            self._load_show()

    def _close(self) -> None:
        for p in (self._in, self._out):
            try:
                if p is not None:
                    p.close()
            except OSError:
                pass
        self._in = self._out = None
        self.port_name = None

    # ---------------------------------------------------------------- écrans
    def snapshot(self) -> dict:
        with self.lock:
            snap = self.stage.snapshot()
        snap["midi"] = {"connected": self._out is not None, "port": self.port_name, "match": self.midi_match}
        snap["edit"] = self.edit
        snap["job"] = self.job
        snap["version"] = self.version
        return snap

    def handle(self, cmd: dict) -> None:
        """Geste d'un écran : {type: act, action} | {type: press, key, down} | {type: goto, setlist, step}."""
        kind = cmd.get("type")
        if kind == "edit":
            return self.set_edit(bool(cmd.get("on")))
        if self.edit and kind in ("act", "press", "goto", "resend"):
            return  # mode édition : la scène est en pause
        with self.lock:
            if kind == "act":
                self.stage.act(str(cmd.get("action")), "screen")
            elif kind == "press":
                self.stage.press(str(cmd.get("key")), bool(cmd.get("down")), "screen")
            elif kind == "goto":
                self.stage.goto(int(cmd.get("setlist", 0)), int(cmd.get("step", 0)))
            elif kind == "resend":
                self.stage.send_step()
                self.stage.traffic.update({"in": "screen", "action": "Resend"})
                self._changed()
            elif kind == "channel":
                self.stage.channel = int(cmd.get("channel", 0))
                self._changed()

    def wait(self, seen: int, timeout: float = 15.0) -> int:
        """Attend un changement après la version `seen` (ou le délai) ; rend la version courante."""
        with self.cond:
            self.cond.wait_for(lambda: self.version != seen, timeout=timeout)
            return self.version

    def start(self) -> None:
        threading.Thread(target=self.midi_loop, daemon=True, name="stage-midi").start()


class _BridgeTransport:
    """Transport de `es8core.session` sur le port de l'hôte : envoi direct, réception du SysEx reçu."""

    def __init__(self, server: StageServer, tap: queue.Queue):
        self.server, self.tap = server, tap

    def send(self, raw: bytes) -> None:
        if not self.server._send(list(raw)):
            raise RuntimeError("The ES-8 is not connected to the stage host.")

    async def receive(self, timeout_s: float) -> bytes | None:
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                return self.tap.get_nowait()
            except queue.Empty:
                pass
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(0.002)

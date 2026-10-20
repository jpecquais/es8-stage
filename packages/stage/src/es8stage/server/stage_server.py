"""Moteur de scène de `es8ctl web --stage` (docs/stage-host.md) : MIDI, état, événements pour les écrans.

- La logique est `es8core.stage.Stage` ; ici, seulement les entrées/sorties.
- MIDI : mido + python-rtmidi. Le port est cherché par un morceau de son nom (« WIDI ») et
  rouvert tout seul s'il disparaît ; avec une adresse Bluetooth, on relance la connexion.
- Écrans : l'état est poussé en Server-Sent Events (`/stage/events`), les gestes arrivent en
  POST (`/stage/act`). Rien d'autre que la bibliothèque standard côté réseau.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
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
        if msg.type in ("clock", "active_sensing", "sysex"):
            return
        with self.lock:
            self.stage.midi_in(msg.bytes())

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
        snap["version"] = self.version
        return snap

    def handle(self, cmd: dict) -> None:
        """Geste d'un écran : {type: act, action} | {type: press, key, down} | {type: goto, setlist, step}."""
        kind = cmd.get("type")
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

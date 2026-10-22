"""Moteur de scène de `es8stage serve --stage` (docs/stage-host.md) : MIDI, état, événements pour les écrans.

- La logique est `es8stage.stage.Stage` ; ici, seulement les entrées/sorties.
- MIDI : mido + python-rtmidi. Le port est cherché par un morceau de son nom (« WIDI ») et
  rouvert tout seul s'il disparaît ; avec une adresse Bluetooth, on relance la connexion.
- Écrans : l'état est poussé en Server-Sent Events (`/stage/events`), les gestes arrivent en
  POST (`/stage/act`). Rien d'autre que la bibliothèque standard côté réseau.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import queue
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from es8stage.stage import Stage, check_show, is_playable

# Mode édition oublié : il se coupe seul après ce temps sans message d'un éditeur vers l'ES-8.
EDIT_IDLE_S = 600


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
        self._edit_touched = 0.0  # dernier signe de vie d'un éditeur en mode édition
        # Vérification de la setlist sur l'ES-8 (pc_map lue par SysEx) : None, ou {exported, ok, setlists, …}.
        self.checked: dict | None = None
        self._want_check = True
        self._taps: list[queue.Queue] = []  # SysEx reçu, pour les travaux de l'hôte (sauvegarde, restauration)
        self.job: dict | None = None  # travail en cours ou dernier fini : {kind, phase, n, total, done, error, result}
        self.stage = Stage(send=self._send, changed=self._changed)
        self.playing_name = lambda: None  # nom du set joué dans la bibliothèque (posé par le serveur HTTP)
        self.engine_in = None  # SysEx reçu, pour le moteur des éditeurs (engine_host.py)
        self._engine = None
        self._engine_lock = threading.Lock()
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
        self._want_check = True

    def show_updated(self) -> None:
        """Le fichier show vient d'être remplacé (POST /stage/show.json) : le recharger."""
        self._load_show()

    def project_saved(self, show: dict, install) -> str:
        """Le set joué vient d'être enregistré (docs/unified-app.md) ; `show` est recalculé de ce projet.

        Si l'ES-8 n'a rien à changer (mêmes tables de PC, même canal), le show est joué tout de suite, à
        la même place : `install()` l'écrit, rien n'est envoyé. Sinon la scène garde l'ancien jusqu'à
        l'envoi à l'ES-8. Rend "playing", "unchanged" ou "send".
        """
        bare = lambda s: {k: v for k, v in s.items() if k != "exported"}  # noqa: E731
        favs = lambda s, i: [f["label"] for f in s.get("favorites") or []][i:i + 1]  # noqa: E731
        with self.lock:
            st, cur = self.stage, self.stage.show
            if cur is None or check_show(show) or self._check_key(show) != self._check_key(cur) \
                    or (show.get("es8") or {}).get("rx_channel") != (cur.get("es8") or {}).get("rx_channel"):
                return "send"
            if bare(show) == bare(cur):
                return "unchanged"
            pos, backup, fav = st.pos, st.backup, st.favorite
            install()
            self._show_mtime = self.show_file.stat().st_mtime_ns
            st.backup = backup
            st.load(show, pos)  # mêmes setlists, mêmes pas : la place reste juste
            if fav is not None and favs(show, fav) == favs(cur, fav):
                st.favorite = fav  # l'ES-8 joue toujours ce favori
                st.changed()
        return "playing"

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

    def library_changed(self) -> None:
        """Le set joué a changé de nom dans la bibliothèque : les écrans le reçoivent."""
        self._changed()

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
            if self.engine_in is not None:
                self.engine_in(bytes(data))
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
        if self.edit:
            self._edit_touched = time.monotonic()
        for m in messages:
            if not self._send(m):
                return "MIDI send failed."
        return None

    def bridge_wait(self, after: int, timeout: float = 15.0) -> list[tuple[int, list[int]]]:
        """Messages reçus de l'ES-8 après le numéro `after` (attend jusqu'à `timeout`)."""
        with self.midi_cond:
            self.midi_cond.wait_for(lambda: self.midi_seq > after, timeout=timeout)
            return [(n, d) for n, d in self.midi_log if n > after]

    def set_edit(self, on: bool, reason: str = "") -> None:
        if not on and self.busy() and self.job["kind"] == "restore":
            return  # une restauration écrit encore : la scène reste en pause
        was, self.edit = self.edit, bool(on)
        self._edit_touched = time.monotonic()
        if was and not self.edit:
            self._want_check = True  # l'ES-8 a pu être écrit : on revérifie la setlist
        with self.lock:
            self.stage.traffic.update({"in": "host", "action": reason or ("Edit mode on" if on else "Edit mode off")})
        self._changed()

    def _edit_idle(self) -> None:
        """Un mode édition oublié laisserait les switches sans effet pendant le concert : il se coupe seul."""
        if self.edit and not self.busy() and time.monotonic() - self._edit_touched > EDIT_IDLE_S:
            self.set_edit(False, "Edit mode off (unused for 10 min)")

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

    # ---------------------------------------------------------------- moteur des éditeurs
    def engine(self):
        """Le pont Python d'ES8 Designer et d'ES8 Control, chargé au premier appel d'une page."""
        with self._engine_lock:
            if self._engine is None:
                from .engine_host import EngineHost

                self._engine = EngineHost(self, self.show_file.with_name("engine-cache.json"))
            return self._engine

    def _engine_running(self) -> str | None:
        return self._engine.running if self._engine is not None else None

    # ---------------------------------------------------------------- sauvegarde et restauration de l'ES-8
    def busy(self) -> bool:
        return bool(self.job and not self.job.get("done"))

    def _start_job(self, kind: str, work) -> str | None:
        if self._out is None:
            return "The ES-8 is not connected to the stage host."
        if self.busy():
            return f"Already busy: {self.job['kind']}."
        if self._engine_running():
            return "An editor is talking to the ES-8: try again when it is done."
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

    def check(self) -> str | None:
        """Lit la pc_map de l'ES-8 (8 pages système, quelques secondes) et la compare au show joué :
        chaque setlist jouable doit avoir son empreinte, et l'ES-8 écouter le canal du show. Lecture seule."""
        from es8core.codec import split_dump
        from es8core.session import read_pages_async
        from es8core.system import decode_system

        show = self.stage.show
        if not show:
            return "No show to check."
        self._want_check = False

        async def work(transport):
            frames, missing = await read_pages_async(transport, list(range(8)))
            system = split_dump(list(frames.values())).system
            if missing or system is None:
                raise RuntimeError("The ES-8 settings could not be read.")
            values = decode_system(system)
            setlists = []
            for sl in show["setlists"]:
                if not is_playable(sl) or not sl.get("pc_map"):
                    continue
                entries = values[f"pc_map_bank{sl['midi_bank']}_pc"]
                digest = "sha256:" + hashlib.sha256(bytes(b for e in entries for b in e.to_bytes(2, "big"))).hexdigest()
                setlists.append({"name": sl["name"], "midi_bank": sl["midi_bank"], "ok": digest == sl["pc_map"]})
            channel = values["midi_setting_rx_ch"] + 1
            ok = all(s["ok"] for s in setlists) and channel == self.stage.es8_channel()
            self.checked = {"key": self._check_key(show), "ok": ok, "setlists": setlists,
                            "channel": channel, "show_channel": self.stage.es8_channel(), "at": time.time()}
            return self.checked

        return self._start_job("check", work)

    def _check_key(self, show: dict | None) -> str:
        """Ce que la vérification compare : l'empreinte de chaque setlist et le canal de l'ES-8."""
        return json.dumps([[sl.get("midi_bank"), sl.get("pc_map")] for sl in (show or {}).get("setlists", [])]
                          + [self.stage.es8_channel()])

    def _auto_check(self) -> None:
        """Après un branchement, un nouveau show ou la fin du mode édition : on revérifie, sans gêner personne."""
        if (self._want_check and self._out is not None and self.stage.show and not self.edit and not self.busy()
                and not self._engine_running()):
            self.check()

    ble_seen: bool | None = None  # l'adaptateur s'annonce-t-il ? (None : pas encore cherché)

    def _ble_reconnect(self) -> None:
        """Relance la liaison Bluetooth : un court balayage, puis la connexion si l'adaptateur s'annonce.
        Un adaptateur BLE MIDI ne parle qu'à un appareil : s'il ne s'annonce pas, un autre (un Mac, un
        téléphone) le tient sans doute ; les écrans le disent, et on réessaie sans attendre la connexion."""
        try:
            scan = subprocess.run(["bluetoothctl", "--timeout", "6", "scan", "on"], capture_output=True, text=True,
                                  timeout=20, check=False).stdout
        except (subprocess.TimeoutExpired, OSError) as exc:
            self.log(f"Bluetooth: {exc}")
            return
        seen = self.ble_address.upper() in scan.upper()
        if seen != self.ble_seen:
            self.ble_seen = seen
            self.log(f"Bluetooth: {self.ble_address} {'advertising' if seen else 'not advertising (held by another device?)'}")
            self._changed()
        if not seen:
            return
        try:
            subprocess.run(["bluetoothctl", "connect", self.ble_address], capture_output=True, timeout=20, check=False)
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
                self._want_check = True
                if self.ble_address:
                    self.ble_seen = True
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
            with self.lock:  # project_saved l'installe peut-être en ce moment, sous le même verrou
                if self.show_file.stat().st_mtime_ns != self._show_mtime:
                    self._load_show()
        self._edit_idle()
        self._auto_check()

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
        snap["midi"] = {"connected": self._out is not None, "port": self.port_name, "match": self.midi_match,
                        "ble": self.ble_address, "ble_seen": self.ble_seen}
        snap["edit"] = self.edit
        snap["playing"] = self.playing_name()
        snap["job"] = self.job
        show = snap.get("show")
        if self.busy() and self.job["kind"] == "check":
            snap["check"] = {"state": "checking"}
        elif self.checked and self.checked["key"] == self._check_key(show):
            snap["check"] = {"state": "ok" if self.checked["ok"] else "mismatch", **self.checked}
        elif self.job and self.job["kind"] == "check" and self.job.get("error"):
            snap["check"] = {"state": "error", "error": self.job["error"]}
        else:
            snap["check"] = {"state": "unknown"}
        snap["version"] = self.version
        return snap

    def handle(self, cmd: dict) -> None:
        """Geste d'un écran : {type: act, action} | {type: press, key, down} | {type: goto, setlist, step}."""
        kind = cmd.get("type")
        if kind == "edit":
            return self.set_edit(bool(cmd.get("on")))
        if kind == "check":
            return self.check()
        if self.edit and kind in ("act", "press", "goto", "resend", "favorite"):
            return  # mode édition : la scène est en pause
        with self.lock:
            if kind == "act":
                self.stage.act(str(cmd.get("action")), "screen")
            elif kind == "press":
                self.stage.press(str(cmd.get("key")), bool(cmd.get("down")), "screen")
            elif kind == "goto":
                self.stage.goto(int(cmd.get("setlist", 0)), int(cmd.get("step", 0)))
            elif kind == "favorite":
                self.stage.play_favorite(int(cmd.get("index", -1)))
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

    def stop(self) -> None:
        """Arrêt du service (redémarrage, extinction du Pi) : on lâche le Bluetooth proprement.
        Coupé brutalement (BlueZ qui s'arrête éteint la radio), le WIDI ne s'annonçait plus jusqu'à ce
        qu'on le rallume (vérifié le 2026-10-21) ; une déconnexion propre le laisse se réannoncer."""
        self._close()
        if self.ble_address:
            try:
                subprocess.run(["bluetoothctl", "disconnect", self.ble_address], capture_output=True, timeout=5, check=False)
            except (subprocess.TimeoutExpired, OSError):
                pass

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

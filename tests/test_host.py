"""Page de l'hôte : mot de passe ; sauvegarde et restauration de l'ES-8 par le port de l'hôte (faux ES-8)."""

import time
from pathlib import Path

import pytest

from es8core.apply import plan_changes
from es8core.codec import BULK_LAST_COUNTER, parse_es8_bulk_frame, split_frames
from es8core.codec.roland import checksum
from es8stage.server.host_auth import HostAuth
from es8stage.server.library import Library
from es8stage.server.stage_server import StageServer

FIXTURE = Path(__file__).parent / "fixtures" / "es8_bulk_session2_name_A.syx"


def test_password_session_and_cookie(tmp_path):
    a = HostAuth(tmp_path / "auth.json")
    assert not a.is_set and a.valid(None)  # pas de mot de passe : ouvert
    with pytest.raises(ValueError):
        a.set_password("abc")
    a.set_password("secret1")
    assert (tmp_path / "auth.json").stat().st_mode & 0o777 == 0o600
    assert a.check("secret1") and not a.check("nope") and not a.valid(None)
    tok = a.token()
    assert HostAuth(tmp_path / "auth.json").valid(tok)  # survit à un redémarrage
    assert not a.valid(tok[:-1] + ("0" if tok[-1] != "0" else "1"))
    assert HostAuth.from_cookie(f"x=1; es8host={tok}") == tok
    a.set_password("secret2")
    assert not a.valid(tok)  # changer de mot de passe ferme les sessions


class Msg:
    type = "sysex"

    def __init__(self, data):
        self.data = data

    def bytes(self):
        return list(self.data)


class FakeES8:
    """Répond aux lectures (RQ1) et applique les écritures (DT1) ; appelle le récepteur de l'hôte."""

    def __init__(self, server):
        self.server = server
        self.mem = {parse_es8_bulk_frame(f).counter: f for f in split_frames(FIXTURE.read_bytes())}
        for c in set(range(BULK_LAST_COUNTER + 1)) - self.mem.keys():  # le dump du panneau en perd un : complété
            body = [c >> 7, c & 0x7F, *self.mem[c - 2][10:-2]]
            self.mem[c] = bytes([*self.mem[c - 2][:8], *body, checksum(body), 0xF7])
        self.writes = 0

    def __call__(self, data) -> bool:
        raw = bytes(data)
        if len(raw) == 155 and raw[7] == 0x12:
            self.writes += 1
            self.mem[raw[8] * 128 + raw[9]] = raw
        elif len(raw) > 11 and raw[7] == 0x11:
            first = raw[8] * 128 + raw[9]
            last = first + raw[10] * 128 + raw[11]
            if first <= 15:
                first, last = 0, (last - 1 if last <= 15 else last)
            for c in range(first, last + 1):
                if c in self.mem:
                    self.server._on_midi(Msg(self.mem[c]))
        return True


def wait_job(server, timeout=60):
    end = time.monotonic() + timeout
    while server.busy() and time.monotonic() < end:
        time.sleep(0.05)
    assert server.job["done"], server.job
    assert not server.job["error"], server.job["error"]
    return server.job["result"]


@pytest.fixture
def host(tmp_path, monkeypatch):
    import es8core.apply as apply_mod

    monkeypatch.setattr(apply_mod, "DEFAULT_PAGE_GAP_S", 0.05)
    monkeypatch.setattr(apply_mod, "DEFAULT_INTERVAL_S", 0.05)
    server = StageServer(tmp_path / "show.json", log=lambda m: None)
    es8 = FakeES8(server)
    server._send, server._out = es8, object()
    return server, es8, Library(tmp_path / "library", tmp_path / "show.json")


def test_backup_reads_the_whole_es8(host):
    server, es8, lib = host
    assert server.backup(lib) is None
    r = wait_job(server)
    assert lib.read("backups", r["name"]) == b"".join(es8.mem[c] for c in sorted(es8.mem))
    assert es8.writes == 0


def test_restore_needs_edit_mode_and_writes_only_what_differs(host):
    server, es8, lib = host
    server.backup(lib, "Good")
    wait_job(server)
    plan = plan_changes([es8.mem[c] for c in sorted(es8.mem)], {"patches": {"0-1": {"master_bpm": 151}}})
    for f in plan.frames:  # quelqu'un a changé le patch 0-1 sur l'ES-8
        es8.mem[parse_es8_bulk_frame(f).counter] = f
    assert "Edit mode" in server.restore(lib, "Good")
    server.set_edit(True)
    assert server.restore(lib, "Good") is None
    server.set_edit(False)  # refusé tant que la restauration écrit
    assert server.edit
    r = wait_job(server)
    assert r["pages"] == 1 and r["confirmed"] and es8.writes == 2
    assert b"".join(es8.mem[c] for c in sorted(es8.mem)) == lib.read("backups", "Good")
    assert lib.read("backups", r["before"]) != lib.read("backups", "Good")  # l'état d'avant est gardé


def _show_for(es8, bank_entries=None, channel=None):
    """Le show de démo, avec l'empreinte de la pc_map (banque 0) du faux ES-8, ou d'autres entrées."""
    import hashlib
    import json

    from es8core.codec import split_dump
    from es8core.system import decode_system

    values = decode_system(split_dump([es8.mem[c] for c in sorted(es8.mem)]).system)
    entries = bank_entries or values["pc_map_bank0_pc"]
    show = json.loads((Path(__file__).parent / "fixtures" / "demo-show.json").read_text())
    show["setlists"] = show["setlists"][:1]
    show["setlists"][0]["pc_map"] = "sha256:" + hashlib.sha256(bytes(b for e in entries for b in e.to_bytes(2, "big"))).hexdigest()
    show["es8"] = {"rx_channel": channel or values["midi_setting_rx_ch"] + 1}
    return show


def test_check_compares_the_setlist_with_the_es8(host):
    server, es8, _ = host
    server.stage.load(_show_for(es8))
    assert server.check() is None
    assert wait_job(server)["ok"] and server.snapshot()["check"]["state"] == "ok"
    assert es8.writes == 0  # lecture seule
    server.stage.load(_show_for(es8, bank_entries=[5] * 128))
    assert server.snapshot()["check"]["state"] == "unknown"  # autre show : rien de vérifié
    server.check()
    wait_job(server)
    snap = server.snapshot()["check"]
    assert snap["state"] == "mismatch" and snap["setlists"][0]["ok"] is False
    server.stage.load(_show_for(es8, channel=16 if es8.mem else 1))
    server.check()
    assert wait_job(server)["ok"] is False  # l'ES-8 n'écoute pas le canal du show


def test_auto_check_and_forgotten_edit_mode(host, monkeypatch):
    import es8stage.server.stage_server as mod

    server, es8, _ = host
    server.stage.load(_show_for(es8))
    server.set_edit(True)
    server._auto_check()
    assert server.job is None  # pas pendant que les éditeurs écrivent
    monkeypatch.setattr(mod, "EDIT_IDLE_S", 0)
    server._edit_idle()
    assert not server.edit and "unused" in server.stage.traffic["action"]
    server._auto_check()  # le mode édition fini : on revérifie
    assert server.job["kind"] == "check" and wait_job(server)["ok"]
    server._auto_check()
    assert server.job["done"]  # une seule fois


def test_bluetooth_adapter_held_elsewhere_is_reported(tmp_path, monkeypatch):
    import subprocess

    calls = []
    scan = {"out": "[CHG] Device 11:22:33:44:55:66 RSSI: -70\n"}

    def run(cmd, **kw):
        calls.append(cmd[1] if cmd[1] != "--timeout" else "scan")
        return subprocess.CompletedProcess(cmd, 0, stdout=scan["out"] if "scan" in cmd else "")

    monkeypatch.setattr(subprocess, "run", run)
    server = StageServer(tmp_path / "show.json", ble_address="20:98:66:65:ea:44", log=lambda m: None)
    server._ble_reconnect()
    assert calls == ["scan"] and server.snapshot()["midi"]["ble_seen"] is False  # pas de connexion inutile
    scan["out"] += "[CHG] Device 20:98:66:65:EA:44 RSSI: -60\n"
    server._ble_reconnect()
    assert calls == ["scan", "scan", "connect"] and server.ble_seen is True


def test_stop_lets_go_of_the_bluetooth_adapter(tmp_path, monkeypatch):
    import subprocess

    calls = []
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: calls.append(cmd))
    StageServer(tmp_path / "show.json", ble_address="20:98:66:65:EA:44", log=lambda m: None).stop()
    assert calls == [["bluetoothctl", "disconnect", "20:98:66:65:EA:44"]]

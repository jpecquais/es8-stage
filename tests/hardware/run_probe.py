"""Sends PCs / Bank Selects to the ES-8 and records what its MIDI OUT emits for each step (JSON on stdout).

Probe rigs: each snapshot sends CC100 = its id on channel 15 (A1..A4 = 11..14, B1..B3 = 21..23),
plus PC 10 (rig A) / PC 20 (rig B) on channel 15.
Usage: uv run python run_probe.py <label>
"""

import json
import sys
import threading
import time

import mido

PORT = "WIDI Jack Bluetooth"
WAIT = 1.5
received: list = []
lock = threading.Lock()


def listen(port):
    for msg in port:
        if msg.type in ("sysex", "clock", "active_sensing"):
            continue
        with lock:
            received.append(msg)


def pc(n, ch=0):
    return mido.Message("program_change", channel=ch, program=n)


def cc(c, v, ch=0):
    return mido.Message("control_change", channel=ch, control=c, value=v)


def short(m):
    d = {"t": m.type, "ch": m.channel + 1}
    if m.type == "program_change":
        d["pc"] = m.program
    elif m.type == "control_change":
        d["cc"], d["v"] = m.control, m.value
    elif m.type in ("note_on", "note_off"):
        d["note"], d["vel"] = m.note, m.velocity
    return d


STEPS = [
    ("PC0", [pc(0)], "11"), ("PC1", [pc(1)], "12"), ("PC2", [pc(2)], "11"), ("PC3", [pc(3)], "21"),
    ("PC4", [pc(4)], "13"), ("PC5", [pc(5)], "22"), ("PC6 beyond", [pc(6)], "22"), ("PC127 beyond", [pc(127)], "22"),
    ("PC1 again", [pc(1)], "12"), ("PC1 repeat same", [pc(1)], "12 (same patch resent)"),
    ("CC0=1 PC0", [cc(0, 1), pc(0)], "23 if CC0 selects MIDI bank 1, else 11"),
    ("CC0=1 PC1", [cc(0, 1), pc(1)], "14 if CC0 works, else 12"),
    ("CC0=0 PC3", [cc(0, 0), pc(3)], "21"),
    ("CC32=1 PC0", [cc(0, 0), cc(32, 1), pc(0)], "23 if CC32 selects MIDI bank 1, else 11"),
    ("CC32=0 PC2", [cc(32, 0), pc(2)], "11"),
    ("PC0 on ch2", [pc(0, ch=1)], "nothing (not the rx channel)"),
]

with mido.open_input(PORT) as inp, mido.open_output(PORT) as out:
    threading.Thread(target=listen, args=(inp,), daemon=True).start()
    time.sleep(0.5)
    with lock:
        received.clear()
    results = []
    for label, msgs, expect in STEPS:
        for m in msgs:
            out.send(m)
            time.sleep(0.03)
        time.sleep(WAIT)
        with lock:
            got = [short(m) for m in received]
            received.clear()
        ids = [g["v"] for g in got if g.get("cc") == 100 and g["ch"] == 15]
        results.append({"step": label, "expect": expect, "ids": ids, "got": got})
    print(json.dumps({"label": sys.argv[1] if len(sys.argv) > 1 else "", "results": results}, indent=1))

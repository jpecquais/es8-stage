"""Appuis simulés (sortie de l'ES-8 en Thru) : CC du switch (canal 4) envoyé à l'ES-8, recopié en Thru vers la Companion.
On relève ce que la Companion renvoie et ce qu'elle affiche (état écrit par companion_firefox.py).

    uv run python tests/hardware/press_switches.py <state.json>

Séquence et canaux : ceux du projet PULSE de test (switches canal 4, CC 80 + rang)."""
import json, sys, time, mido
PORT = "WIDI Jack Bluetooth"; STATE = sys.argv[1]
seq = [("NUM6 (OD)", 85), ("NUM7 (Big Muff)", 86), ("NUM7 again", 86), ("NUM8 (Dist)", 87), ("NUM1 (Macro1)", 80), ("NUM6 (OD)", 85), ("BANK_U (next)", 91)]
with mido.open_output(PORT) as out, mido.open_input(PORT) as inp:
    time.sleep(0.5); list(inp.iter_pending())
    for name, cc in seq:
        out.send(mido.Message("control_change", channel=3, control=cc, value=127)); time.sleep(0.12)
        out.send(mido.Message("control_change", channel=3, control=cc, value=0))
        t = time.monotonic() + 1.2; got = []
        while time.monotonic() < t:
            for m in inp.iter_pending():
                if m.type == "control_change" and m.channel == 3: continue  # écho de nos propres appuis
                if m.type in ("clock", "active_sensing", "sysex"): continue
                got.append(f"ch{m.channel+1} " + (f"CC{m.control}={m.value}" if m.type == "control_change" else f"PC{m.program}"))
            time.sleep(0.01)
        view = json.loads(open(STATE).read())
        print(f"{name:18} → out {got}   lit {view.get('lit')}   now {view.get('now')!r}", flush=True)

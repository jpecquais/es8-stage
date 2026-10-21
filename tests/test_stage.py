"""Hôte de scène : la logique Python (es8core.stage) est celle de web/companion/show.js, cas par cas."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from es8stage import stage as P

COMPANION = Path(__file__).parents[1] / "web" / "companion"
DEMO = json.loads((COMPANION / "demo-show.json").read_text(encoding="utf-8"))


def demo_with_group():
    """Le show de démo, avec un sélecteur à crans (NUM5/NUM6) dans un groupe avec Drive (NUM1)."""
    g = json.loads(json.dumps(DEMO))
    sws = g["rigs"]["crunch"]["surface"]["switches"]
    step = {"role": "param", "mode": "toggle", "param": "daw.amp", "channel": 1, "cc": 22, "off": 8, "exact": True, "group": "drive"}
    sws["NUM5"] = {"label": "OD", **step, "on": 24}
    sws["NUM6"] = {"label": "Muff", **step, "on": 40}
    sws["NUM1"]["group"] = "drive"
    return g


def scenario(show):
    """Opérations à jouer des deux côtés : (nom, arguments)."""
    ops = []
    for k, sl in enumerate(show["setlists"]):
        for i in range(len(sl["steps"])):
            pos = {"setlist": k, "step": i}
            for a in ("next", "prev", "next_song", "prev_song", "song_start", "bogus"):
                ops.append(["move", pos, a])
            ops.append(["startStates", pos])
            for b in (False, True):
                ops.append(["played", sl["steps"][i], i, b])
    ops += [["switchFromMidi", d] for d in ([0xBF, 80, 127], [0xBF, 80, 0], [0xBF, 91, 127], [0xBE, 80, 127], [0xBF, 99, 1], [0xC0, 1])]
    ops += [["validPosition", p] for p in ({"setlist": 0, "step": 3}, {"setlist": 9, "step": 0}, {"setlist": 0, "step": 99}, None)]
    return ops


def presses(show):
    """Une suite d'appuis enchaînés sur un pas (l'état passe de l'un à l'autre)."""
    return [["NUM1", True], ["NUM1", False], ["NUM5", True], ["NUM6", True], ["NUM6", True], ["NUM1", True],
            ["NUM4", True], ["NUM4", False], ["BANK_U", True], ["NUM3", True], ["NUM8", True], ["XX", True]]


JS = """
import * as S from %s;
const [show, ops, seq, pos] = %s;
const out = ops.map(([op, ...a]) => {
  if (op === "move") return S.move(show, a[0], a[1]);
  if (op === "startStates") return S.startStates(show, a[0]);
  if (op === "played") return S.played(a[0], a[1], a[2]);
  if (op === "switchFromMidi") return S.switchFromMidi(show, a[0]);
  if (op === "validPosition") return S.validPosition(show, a[0]);
});
let states = S.startStates(show, pos);
const chain = seq.map(([key, down]) => {
  const r = S.pressSwitch(show, pos, key, down, states);
  if (r && r.states) states = r.states;
  return r && (r.action ? { action: r.action, label: r.label } : { states: r.states, messages: r.messages, on: r.on, label: r.label });
});
console.log(JSON.stringify({ out, chain, lit: Object.fromEntries(Object.entries(show.rigs.crunch.surface.switches).map(([k, sw]) => [k, S.switchIsOn(sw, states)])) }));
"""


def python_side(show, ops, seq, pos):
    out = []
    for op, *a in ops:
        out.append({"move": lambda: P.move(show, a[0], a[1]), "startStates": lambda: P.start_states(show, a[0]),
                    "played": lambda: P.played(a[0], a[1], a[2]), "switchFromMidi": lambda: P.switch_from_midi(show, a[0]),
                    "validPosition": lambda: P.valid_position(show, a[0])}[op]())
    states = P.start_states(show, pos)
    chain = []
    for key, down in seq:
        r = P.press_switch(show, pos, key, down, states)
        if r and "states" in r:
            states = r["states"]
        chain.append(r)
    lit = {k: P.switch_is_on(sw, states) for k, sw in show["rigs"]["crunch"]["surface"]["switches"].items()}
    return {"out": out, "chain": chain, "lit": lit}


@pytest.mark.skipif(shutil.which("node") is None, reason="Node absent")
@pytest.mark.parametrize("show", [DEMO, demo_with_group()], ids=["demo", "group"])
def test_python_logic_is_the_companion_logic(show):
    ops, seq, pos = scenario(show), presses(show), {"setlist": 0, "step": 3}
    script = JS % (json.dumps((COMPANION / "show.js").as_uri()), json.dumps([show, ops, seq, pos]))
    js = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True).stdout)
    py = json.loads(json.dumps(python_side(show, ops, seq, pos)))
    assert py["out"] == js["out"]
    assert py["chain"] == js["chain"]
    assert py["lit"] == js["lit"]
    assert len(ops) > 100


def test_stage_engine_moves_presses_and_sends():
    sent, changes = [], []
    st = P.Stage(send=sent.append, changed=lambda: changes.append(1))
    st.load(DEMO)
    assert st.pos == {"setlist": 0, "step": 0} and not sent  # charger n'envoie rien
    assert st.act("next") == [[0xB0, 0, 0], [0xC0, 1]] and st.pos["step"] == 1
    st.goto(0, 3)
    assert st.states["daw.drive"] == 127  # Chorus : drive on au départ
    assert st.midi_in([0xBF, 80, 127]) == [[0xB0, 18, 0]] and st.states["daw.drive"] == 0  # NUM1 : drive off
    assert st.midi_in([0xBF, 80, 0]) == []  # relâchement d'une bascule
    assert st.midi_in([0xBF, 91, 127]) == [[0xB0, 0, 0], [0xC0, 4]]  # BANK_U : pas suivant
    assert st.states["daw.drive"] == 0 and st.move["dir"] == "next"
    assert st.act("backup") == [[0xB0, 0, 0], [0xC0, 127]] and st.backup  # le secours du pas 4
    assert st.midi_in([0xC0, 5]) == []  # un PC reçu (écho) n'est pas un geste
    snap = st.snapshot()
    assert snap["pos"] == {"setlist": 0, "step": 4} and snap["channel"] == 1 and changes

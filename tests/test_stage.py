"""Hôte de scène : la logique de jeu (es8stage.stage), seule à jouer le show depuis que la Companion n'est plus qu'un écran."""

import json
from pathlib import Path

from es8stage import stage as P

DEMO = json.loads((Path(__file__).parent / "fixtures" / "demo-show.json").read_text(encoding="utf-8"))


def demo_with_group():
    """Le show de démo, avec un sélecteur à crans (NUM5/NUM6) dans un groupe avec Drive (NUM1)."""
    g = json.loads(json.dumps(DEMO))
    sws = g["rigs"]["crunch"]["surface"]["switches"]
    step = {"role": "param", "mode": "toggle", "param": "daw.amp", "channel": 1, "cc": 22, "off": 8, "exact": True, "group": "drive"}
    sws["NUM5"] = {"label": "OD", **step, "on": 24}
    sws["NUM6"] = {"label": "Muff", **step, "on": 40}
    sws["NUM1"]["group"] = "drive"
    return g


def test_moves_and_steps():
    at = lambda step: {"setlist": 0, "step": step}  # noqa: E731
    assert P.check_show(DEMO) == [] and len(P.check_show({"schema": "x", "setlists": []})) >= 2
    assert P.start_position(DEMO) == at(0) and P.valid_position(DEMO, at(7)) == at(7)
    assert P.valid_position(DEMO, {"setlist": 1, "step": 0}) == {"setlist": 1, "step": 0}  # banque MIDI 1 : jouable
    assert P.valid_position(DEMO, {"setlist": 0, "step": 99}) == at(0) and P.valid_position(DEMO, None) == at(0)
    assert P.move(DEMO, at(5), "next") == at(6) and P.move(DEMO, at(5), "prev") == at(4)
    assert P.move(DEMO, at(12), "next") is None and P.move(DEMO, at(0), "prev") is None  # rien à envoyer aux bouts
    assert P.move(DEMO, at(5), "next_song") == at(8) and P.move(DEMO, at(5), "prev_song") == at(0)
    assert P.move(DEMO, at(1), "prev_song") is None and P.move(DEMO, at(11), "next_song") is None
    assert P.move(DEMO, at(5), "song_start") == at(2) and P.move(DEMO, at(2), "song_start") is None
    assert P.move(DEMO, at(5), "bogus") is None
    assert P.step_messages(1, 0, 5) == [[0xB0, 0, 0], [0xC0, 5]] and P.step_messages(16, 6, 127) == [[0xBF, 0, 6], [0xCF, 127]]
    step = DEMO["setlists"][0]["steps"][5]
    assert P.played(step, 5, False) == {"pc": 5, "label": "12-2", "snapshot": "Chorus", "backup": False}
    assert P.played(step, 5, True) == {"pc": 126, "label": "40-2", "snapshot": "Lead", "rig": "GP50 backup", "backup": True}
    assert P.played(DEMO["setlists"][0]["steps"][0], 0, True)["backup"] is False  # pas sans secours : le son normal


def test_switches_groups_and_steps_of_a_selector():
    pos = {"setlist": 0, "step": 3}  # White Night / Chorus : drive on au départ
    st = P.start_states(DEMO, pos)
    assert st == {"daw.drive": 127, "daw.delay": 127, "reverb.freeze": 0}
    assert P.switch_from_midi(DEMO, [0xBF, 80, 127]) == {"key": "NUM1", "press": True}
    assert P.switch_from_midi(DEMO, [0xBE, 80, 127]) is None and P.switch_from_midi(DEMO, [0xBF, 99, 1]) is None
    assert P.switch_from_midi(DEMO, [0xC0, 1]) is None
    r1 = P.press_switch(DEMO, pos, "NUM1", True, st)
    r2 = P.press_switch(DEMO, pos, "NUM1", True, r1["states"])
    assert (r1["messages"], r1["on"], r2["messages"], r2["on"]) == ([[0xB0, 18, 0]], False, [[0xB0, 18, 127]], True)
    assert P.press_switch(DEMO, pos, "NUM1", False, r2["states"]) is None  # une bascule ignore le relâchement
    f1 = P.press_switch(DEMO, pos, "NUM4", True, st)
    assert [f1["messages"], P.press_switch(DEMO, pos, "NUM4", False, f1["states"])["messages"]] == [[[0xB1, 21, 127]], [[0xB1, 21, 0]]]
    assert P.press_switch(DEMO, pos, "BANK_U", True, st) == {"action": "next", "label": "Next"}
    assert P.press_switch(DEMO, pos, "NUM5", True, st) is None  # boucle : l'ES-8 s'en charge
    g = demo_with_group()
    sws = g["rigs"]["crunch"]["surface"]["switches"]
    st = P.start_states(g, pos)
    od = P.press_switch(g, pos, "NUM5", True, st)
    muff = P.press_switch(g, pos, "NUM6", True, od["states"])
    back = P.press_switch(g, pos, "NUM6", True, muff["states"])
    lit = lambda states: [k for k in ("NUM1", "NUM5", "NUM6") if P.switch_is_on(sws[k], states)]  # noqa: E731
    assert (od["messages"], lit(od["states"])) == ([[0xB0, 22, 24], [0xB0, 18, 0]], ["NUM5"])  # OD choisi, Drive coupé
    assert (muff["messages"], lit(muff["states"])) == ([[0xB0, 22, 40]], ["NUM6"])  # un autre cran
    assert (back["messages"], lit(back["states"])) == ([[0xB0, 22, 8]], [])  # réappuyer : retour au off (Clean)


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

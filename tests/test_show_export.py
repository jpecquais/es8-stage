"""Projet → show de ES8 Companion (`es8ctl.show/1`) : mêmes pas que la pc_map, préréglage d'entrée."""

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from test_rig_model import FIXTURE, PEDALBOARD, project_doc, write_project

from es8core.diff import load_dump
from es8core.model import ModelError, compile_project, export_show, load_project, project_from_doc

SHOW_JS = Path(__file__).parents[1] / "web" / "companion" / "show.js"


def companion_doc():
    doc = project_doc()
    doc["pedalboard"]["devices"]["companion"] = {
        "name": "Companion", "midi": {"channel": 16, "companion": True, "params": {"next": {"cc": 80}, "prev": {"cc": 81}}},
    }
    doc["surfaces"]["lead"]["switches"].update({
        "CTL_IN_1": {"label": "Next", "role": "param", "param": "companion.next", "mode": "momentary"},
        "CTL_IN_2": {"label": "Prev", "role": "param", "param": "companion.prev", "mode": "momentary"},
    })
    return doc


def test_show_from_setup_matches_the_pc_map(tmp_path):
    project = load_project(write_project(tmp_path))
    show = export_show(project, exported="2026-10-19T12:00:00Z")
    assert show["schema"] == "es8ctl.show/1" and show["exported"] == "2026-10-19T12:00:00Z"
    (sl,) = show["setlists"]
    assert sl["id"] == "november" and sl["name"] == "November" and sl["midi_bank"] == 1
    assert sl["songs"] == [
        {"name": "Ambient", "rig": "ambient", "first_step": 0, "steps": 1},
        {"name": "Crunch Lead", "rig": "crunch", "first_step": 1, "steps": 4},
    ]
    assert [(s["snapshot"], s["label"]) for s in sl["steps"]] == [
        ("Pad", "11-1"), ("Intro", "12-1"), ("Chorus", "12-2"), ("Intro", "12-1"), ("Chorus", "12-2"),
    ]
    # Le pas i du show est l'entrée i de la pc_map compilée, empreinte comprise.
    entries = compile_project(project, load_dump(FIXTURE)).system_wanted["pc_map_bank1_pc"]
    assert [s["patch"] for s in sl["steps"]] == entries[:5]
    assert sl["pc_map"] == "sha256:" + hashlib.sha256(b"".join(e.to_bytes(2, "big") for e in entries)).hexdigest()
    crunch = show["rigs"]["crunch"]
    assert crunch["patches"] == ["12-1", "12-2"] and crunch["snapshots"] == ["Intro", "Chorus"]
    assert crunch["chain"] == [{"loop": "L2", "device": "Overdrive"}, {"loop": "L5", "device": "Fuzz"},
                               {"loop": "L7", "device": "Chorus"}]
    assert crunch["programs"][0] == {"device": "DAW", "program": "crunch", "pc": 12}
    assert crunch["surface"]["switches"]["NUM1"] == {
        "label": "drive", "role": "param", "mode": "toggle", "target": "DAW · drive",
        "param": "daw.drive", "channel": 1, "cc": 18, "on": 127, "off": 0,
    }
    # État de départ des paramètres de la surface : Intro drive off, Chorus drive on.
    assert crunch["states"]["Intro"]["daw.drive"] == 0 and crunch["states"]["Chorus"]["daw.drive"] == 127
    assert crunch["surface"]["switches"]["NUM5"] == {"label": "Overdrive", "role": "loop", "target": "L2"}
    assert crunch["surface"]["switches"]["NUM8"] == {"label": "Tap", "role": "tap"}
    assert "surface" not in show["rigs"]["ambient"] and "input_preset" not in show


def test_song_names_from_tracks_and_inline_songs():
    doc = project_doc()
    doc["tracks"] = {"a": {"schema": "es8ctl.track/1", "name": "Song A", "rig": "crunch", "sequence": ["Chorus"]}}
    doc["setlists"]["nov"]["songs"] = [{"track": "a"}, {"name": "Encore", "rig": "crunch", "sequence": ["Intro"]},
                                       {"rig": "crunch", "sequence": ["Intro"]}]
    sl = export_show(project_from_doc(doc))["setlists"][0]
    assert [s["name"] for s in sl["songs"]] == ["Song A", "Encore", "Crunch Lead"]
    assert sl["id"] == "nov" and [s["first_step"] for s in sl["songs"]] == [0, 1, 2]


def test_companion_device_gives_the_input_preset():
    show = export_show(project_from_doc(companion_doc()))
    assert show["input_preset"] == {
        "source": "surface Lead",
        "bindings": [{"action": "next", "type": "cc", "channel": 16, "number": 80},
                     {"action": "prev", "type": "cc", "channel": 16, "number": 81}],
    }


def test_companion_params_must_be_actions():
    doc = companion_doc()
    doc["pedalboard"]["devices"]["companion"]["midi"]["params"]["jump"] = {"cc": 82}
    with pytest.raises(ModelError, match="companion device's parameters are its actions"):
        project_from_doc(doc)
    assert PEDALBOARD["devices"].get("companion") is None  # la fixture partagée n'est pas touchée


def test_cli_rig_show(tmp_path):
    from typer.testing import CliRunner

    from es8ctl.cli import app

    out = tmp_path / "show.json"
    result = CliRunner().invoke(app, ["rig", "show", str(write_project(tmp_path)), "-o", str(out)])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"show": str(out), "setlists": ["November"], "steps": 5}
    assert json.loads(out.read_text())["schema"] == "es8ctl.show/1"
    rig = tmp_path / "rigs" / "crunch.json"
    assert CliRunner().invoke(app, ["rig", "show", str(rig)]).exit_code == 2


@pytest.mark.skipif(shutil.which("node") is None, reason="Node absent")
def test_exported_show_is_accepted_by_the_companion():
    show = export_show(project_from_doc(companion_doc()))
    script = f"""
import * as S from {json.dumps(SHOW_JS.as_uri())};
const show = {json.dumps(show)};
console.log(JSON.stringify({{ problems: S.checkShow(show), now: S.view(show, S.startPosition(show)).step.snapshot,
  next: S.actionFor(S.presetBindings(show), S.eventFromMidi([0xbf, 80, 127])) }}));
"""
    r = json.loads(subprocess.run(["node", "--input-type=module", "-e", script],
                                  capture_output=True, text=True, check=True).stdout)
    assert r == {"problems": [], "now": "Intro", "next": "next"}


def test_web_show_export():
    from es8core import webapp

    show = json.loads(webapp.show_export(json.dumps(companion_doc())))["show"]
    assert show["setlists"][0]["name"] == "Nov" and show["input_preset"]["bindings"][0]["number"] == 80
    bad = companion_doc()
    bad["setlists"]["nov"]["songs"] = [{"rig": "crunch", "sequence": ["Bridge"]}]
    assert "no snapshot 'Bridge'" in json.loads(webapp.show_export(json.dumps(bad)))["problems"][0]
    bad["setlists"] = {}
    assert json.loads(webapp.show_export(json.dumps(bad)))["error"] == "This project has no setlist."


def test_companion_switches_are_plain_buttons(tmp_path):
    from es8core.model import compile_rig
    from es8core.model.compile import _CTL_SLOT
    from es8core.model.schema import companion_settings

    doc = project_doc()
    doc["surfaces"]["lead"]["switches"].update({
        "BANK_U": {"role": "companion", "action": "next"},
        "BANK_D": {"role": "companion", "action": "prev"},
        "MUTE": {"role": "companion", "action": "backup"},
    })
    doc["companion"] = {"channel": 15}
    project = project_from_doc(doc)
    assert project.companion == {"channel": 15, "first_cc": 80, "es8_channel": 1}
    show = export_show(project)
    # Un CC par switch (80 + rang : NUM1 = 80, NUM4 = 83, MUTE = 89, BANK_D = 90, BANK_U = 91).
    assert show["controls"] == {"channel": 15, "switches": {"NUM1": 80, "NUM4": 83, "MUTE": 89, "BANK_D": 90, "BANK_U": 91}}
    assert show["rigs"]["crunch"]["surface"]["switches"]["BANK_U"] == {"label": "Next", "role": "companion", "target": "next"}
    assert "input_preset" not in show
    rig = project.rig_ids["crunch"]
    first = compile_rig(rig.pedalboard, rig.surface, rig.doc, load_dump(FIXTURE), project.companion).changes["patches"]["12-1"]
    # Assigns dans l'ordre de la surface : BANK_U, BANK_D, MUTE.
    assert first["assign_target_cc_no"][2:5] == [91, 90, 89] and first["assign_target_cc_ch"][2:5] == [14, 14, 14]
    assert [first["ctl_func"][_CTL_SLOT[k]] for k in ("BANK_U", "BANK_D", "MUTE")] == [0, 0, 0]  # OFF
    # Le canal de la Companion ne peut être celui d'un appareil.
    doc["companion"] = {"channel": 2}
    with pytest.raises(ModelError, match="channel 2 is used by 'Reverb pedal'"):
        project_from_doc(doc)
    assert companion_settings(None, PEDALBOARD) == {"channel": 16, "first_cc": 80, "es8_channel": 1}
    # Le DAW écoute le canal de l'ES-8 (1) : en Thru il recevrait les PC de la setlist.
    warnings = compile_project(project, load_dump(FIXTURE)).warnings
    assert any("DAW listens on channel 1, the ES-8's channel" in w for w in warnings)
    doc["companion"] = {"channel": 15, "es8_channel": 14}
    p2 = project_from_doc(doc)
    assert export_show(p2)["es8"]["rx_channel"] == 14
    assert compile_project(p2, load_dump(FIXTURE)).system_wanted["midi_setting_rx_ch"] == 13
    assert not any("ES-8's channel" in w for w in compile_project(p2, load_dump(FIXTURE)).warnings)


def test_rig_aliases_name_the_switches_in_the_show():
    doc = project_doc()
    doc["rigs"]["crunch"]["aliases"] = {"daw.drive": "Big Muff"}
    sw = export_show(project_from_doc(doc))["rigs"]["crunch"]["surface"]["switches"]["NUM1"]
    assert sw["label"] == "Big Muff" and sw["role"] == "param" and sw["cc"] == 18
    doc["rigs"]["crunch"]["aliases"] = {"daw.nope": "x"}
    with pytest.raises(ModelError, match="aliases: 'daw.nope'"):
        project_from_doc(doc)


def test_switch_groups_and_selector_steps_reach_the_show():
    doc = project_doc()
    doc["surfaces"]["lead"]["switches"].update({
        "NUM2": {"label": "OD", "role": "param", "param": "daw.verb", "value": 24, "group": "drive"},
        "NUM3": {"label": "Muff", "role": "param", "param": "daw.verb", "value": 40, "group": "drive"},
    })
    sws = export_show(project_from_doc(doc))["rigs"]["crunch"]["surface"]["switches"]
    assert sws["NUM2"]["on"] == 24 and sws["NUM2"]["exact"] is True and sws["NUM2"]["group"] == "drive"
    assert sws["NUM3"]["off"] == 10  # le off du paramètre (verb : off 10)
    doc["surfaces"]["lead"]["switches"]["NUM2"]["value"] = 200
    with pytest.raises(ModelError, match="NUM2.value: expected 0-127"):
        project_from_doc(doc)

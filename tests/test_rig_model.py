"""Modèle pedalboard → rig → snapshot : validation et compilation, sur fixture réelle."""

import json
from pathlib import Path

import pytest

from es8core.apply import plan_changes
from es8core.codec import split_frames, unpack_page
from es8core.diff import load_dump
from es8core.model import ModelError, chain_notation, compile_project, compile_rig, load_project
from es8core.patch import decode_patch
from es8core.routing import render
from es8core.system import decode_system

FIXTURE = Path(__file__).parent / "fixtures" / "es8_bulk_session2_name_A.syx"

PEDALBOARD = {
    "schema": "es8ctl.pedalboard/2",
    "devices": {
        "comp": {"name": "Comp", "loops": ["L1"]},
        "od": {"name": "Overdrive", "loops": ["L2"]},
        "fuzz": {"name": "Fuzz", "loops": ["L5"]},
        "chorus": {"name": "Chorus", "loops": ["L7"]},
        "delay": {"name": "Delay", "loops": ["L8"]},
        "daw": {
            "name": "DAW",
            "midi": {"channel": 1, "program_change": "pc", "programs": {"crunch": {"pc": 12}},
                     "params": {"drive": {"cc": 18}, "delay": {"cc": 19}, "verb": {"cc": 20, "off": 10, "on": 100}}},
        },
        "reverb": {
            "name": "Reverb pedal",
            "midi": {"channel": 2, "program_change": "bank_msb_pc", "programs": {"hall": {"pc": 5, "bank_msb": 1}},
                     "params": {"freeze": {"cc": 21}}},
        },
    },
}
SURFACE = {
    "schema": "es8ctl.surface/1",
    "name": "Lead",
    "switches": {
        "NUM1": {"role": "param", "param": "daw.drive", "mode": "toggle"},
        "NUM4": {"role": "param", "param": "reverb.freeze", "mode": "momentary"},
        "NUM5": {"role": "loop", "loop": "L2"},
        "NUM8": {"role": "tap"},
    },
}
RIG = {
    "schema": "es8ctl.rig/1",
    "name": "Crunch Lead",
    "short": "Crunch",
    "bank": 12,
    "chain": ["L2", "L5", "L7"],
    "programs": {"daw": "crunch", "reverb": "hall"},
    "snapshots": [
        {"name": "Intro", "loops": ["L5"], "params": {"daw.delay": "on"}},
        {"name": "Chorus", "loops": ["L2", "L5"], "params": {"daw.drive": "on", "daw.delay": "on", "daw.verb": 64}},
    ],
}


@pytest.fixture(scope="module")
def dump():
    return load_dump(FIXTURE)


def patch(dump, index):
    return decode_patch(unpack_page(dump.patches[index]))


def write_after(tmp_path, changes):
    """Dump attendu après écriture des changements (même chemin que `apply`)."""
    plan = plan_changes(list(split_frames(FIXTURE.read_bytes())), changes)
    after = tmp_path / "after.syx"
    after.write_bytes(plan.expected)
    return load_dump(after)


def test_chain_notation():
    # Liste entrée → sortie ; la notation va de la sortie vers l'entrée, V au bout côté entrée.
    assert chain_notation(["L2", "L5", "L7"]) == "75286431V"
    assert chain_notation(["V", 1, "l3"]) == "31V876542"
    assert chain_notation("V8746(3//5)21") == "V8746(3//5)21"


def test_chain_notation_keeps_v_where_listed():
    assert chain_notation(["LV", "L1", "L2"]) == "21V876543"


def test_compile_rig_fields(dump):
    result = compile_rig(PEDALBOARD, SURFACE, RIG, dump)
    first, second = result.changes["patches"]["12-1"], result.changes["patches"]["12-2"]
    assert first["name"] == "Crunch Intro    "
    assert second["loop_sw"] == [0, 1, 0, 0, 1, 0, 0, 0, 0]
    assert first["loop_chain"] == "75286431V"
    # Slots (valeur + 1, 0 = OFF) : daw = PC 12, CC drive (18) et delay (19), puis CC verb (20) ;
    # reverb = bank MSB 1, PC 5, sans CC (freeze n'est piloté par aucun snapshot).
    assert first["midi_tx_ch"] == [1, 1, 2, 0, 0, 0, 0, 0]
    assert first["midi_pc"] == [13, 0, 6, 0, 0, 0, 0, 0]
    assert first["midi_pc_bank_msb"] == [0, 0, 2, 0, 0, 0, 0, 0]
    assert first["midi_ctl1_cc"][:3] == [19, 21, 0] and first["midi_ctl2_cc"][:3] == [20, 0, 0]
    # Intro : drive off, verb off (= 10), delay on.
    assert first["midi_ctl1_cc_val"][:2] == [0, 10] and first["midi_ctl2_cc_val"][0] == 127
    # Chorus : drive on, verb 64, delay on.
    assert second["midi_ctl1_cc_val"][:2] == [127, 64] and second["midi_ctl2_cc_val"][0] == 127
    # Surface : assigns 1-2, NUM8 en tap, NUM5 sur L2 en mode manuel.
    assert first["assign_sw"][:3] == [1, 1, 0]
    assert first["assign_source"][:2] == [8, 11]  # NUM1, NUM4
    assert first["assign_mode"][:2] == [1, 0]
    assert first["assign_target"][:2] == [22, 22]
    assert first["assign_target_cc_ch"][:2] == [0, 1]
    assert first["assign_target_cc_no"][:2] == [18, 21]
    assert first["ctl_func"][11] == 21
    assert result.changes["system"] == {"manual_number5": 2}
    assert len(result.changes["patches"]) == 2


def test_compile_rig_warnings(dump):
    warnings = compile_rig(PEDALBOARD, SURFACE, RIG, dump).warnings
    assert "Crunch Lead: L1 (Comp) is wired but not in the chain: it stays off." in warnings
    assert any("6 patch(es) of bank 12" in w for w in warnings)


def test_compile_then_recompile_is_in_sync(dump, tmp_path):
    """Divergence : après écriture, recompiler ne produit plus rien."""
    result = compile_rig(PEDALBOARD, SURFACE, RIG, dump)
    after = write_after(tmp_path, result.changes)
    again = compile_rig(PEDALBOARD, SURFACE, RIG, after)
    assert again.changes == {"patches": {}}
    assert render(patch(after, 96)["loop_position"]) == "75286431V"
    assert decode_system(after.system)["manual_number5"] == 2


def test_without_surface_switches_are_untouched(dump):
    result = compile_rig(PEDALBOARD, None, RIG, dump)
    fields = result.changes["patches"]["12-1"]
    assert not {"ctl_func", "assign_sw"} & set(fields)
    assert "system" not in result.changes
    assert "ctl_func" not in result.owns["patches"]["12-1"]


@pytest.mark.parametrize(
    "edit, message",
    [
        (lambda r: r.update(bank=100), "bank"),
        (lambda r: r["snapshots"][0].update(patch_name="Seventeen chars!!"), "16 characters at most"),
        (lambda r: r["snapshots"][0].update(patch_name="Écho"), "plain ASCII"),
        (lambda r: r["snapshots"][0].update(loops=["L3"]), "not wired"),
        (lambda r: r["snapshots"][0].update(loops=["L8"]), "not in the rig's chain"),
        (lambda r: r["snapshots"][0].update(params={"daw.nope": "on"}), "daw.nope"),
        (lambda r: r["snapshots"][0].update(params={"daw.drive": 200}), "0-127"),
        (lambda r: r.update(programs={"daw": "nope"}), "unknown program"),
        (lambda r: r.update(snapshots=[{"name": str(i)} for i in range(9)]), "8 at most"),
        (lambda r: r["snapshots"].append({"name": "Intro"}), "used twice"),
    ],
)
def test_rig_is_refused(dump, edit, message):
    rig = json.loads(json.dumps(RIG))
    edit(rig)
    with pytest.raises(ModelError, match=message):
        compile_rig(PEDALBOARD, SURFACE, rig, dump)


def test_too_many_midi_slots(dump):
    pedalboard = json.loads(json.dumps(PEDALBOARD))
    pedalboard["devices"]["daw"]["midi"]["params"] = {f"p{i}": {"cc": i} for i in range(16)}
    rig = {**RIG, "snapshots": [{"name": "All", "params": {f"daw.p{i}": "on" for i in range(16)}}]}
    with pytest.raises(ModelError, match="MIDI slots"):
        compile_rig(pedalboard, None, rig, dump)


def test_surface_is_refused():
    from es8core.model.schema import check_pedalboard, check_surface

    bad = {"schema": "es8ctl.surface/1", "switches": {
        "NUM9": {"role": "tap"},
        "MUTE": {"role": "loop", "loop": "L2"},
        "NUM2": {"role": "loop", "loop": "L3"},
        "NUM3": {"role": "es8", "function": "FLY"},
    }}
    with pytest.raises(ModelError) as exc:
        check_surface(bad, check_pedalboard(PEDALBOARD))
    assert len(exc.value.problems) == 4


# ---------------------------------------------------------------- projet et setlist


def write_project(root: Path, setlist_songs=None, second_surface=None):
    (root / "rigs").mkdir()
    (root / "surfaces").mkdir()
    (root / "setlists").mkdir()
    (root / "pedalboard.json").write_text(json.dumps(PEDALBOARD))
    (root / "surfaces" / "lead.json").write_text(json.dumps(SURFACE))
    rig = {**RIG, "pedalboard": "../pedalboard.json", "surface": "../surfaces/lead.json"}
    (root / "rigs" / "crunch.json").write_text(json.dumps(rig))
    ambient = {
        "schema": "es8ctl.rig/1", "name": "Ambient", "bank": 11, "chain": ["L7", "L8"],
        "snapshots": [{"name": "Pad", "loops": ["L7", "L8"]}],
    }
    if second_surface:
        (root / "surfaces" / "other.json").write_text(json.dumps(second_surface))
        ambient["surface"] = "../surfaces/other.json"
    (root / "rigs" / "ambient.json").write_text(json.dumps({**ambient, "pedalboard": "../pedalboard.json"}))
    setlist = {"schema": "es8ctl.setlist/1", "name": "November", "songs": setlist_songs or [
        {"rig": "../rigs/ambient.json", "sequence": ["Pad"]},
        {"rig": "../rigs/crunch.json", "sequence": ["Intro", "Chorus", "Intro", "Chorus"]},
    ]}
    (root / "setlists" / "november.json").write_text(json.dumps(setlist))
    setup = {
        "schema": "es8ctl.setup/1", "pedalboard": "pedalboard.json",
        "rigs": {"12": "rigs/crunch.json", "11": "rigs/ambient.json"},
        "setlists": {"1": "setlists/november.json"},
    }
    (root / "setup.json").write_text(json.dumps(setup))
    return root / "setup.json"


def test_project_compiles_rigs_and_setlist(dump, tmp_path):
    project = load_project(write_project(tmp_path))
    result = compile_project(project, dump)
    assert set(result.changes["patches"]) == {"11-1", "12-1", "12-2"}
    entries = result.changes["system"]["pc_map_bank1_pc"]
    # Pad (88), Intro (96), Chorus (97), Intro, Chorus, puis le dernier pas répété.
    assert entries[:6] == [88, 96, 97, 96, 97, 97]
    assert len(entries) == 128 and set(entries[5:]) == {97}
    assert result.changes["system"]["manual_number5"] == 2
    assert "pc_map_bank1_pc" in result.owns["system"]


def test_project_written_is_in_sync(dump, tmp_path):
    project = load_project(write_project(tmp_path))
    after = write_after(tmp_path, compile_project(project, dump).changes)
    assert compile_project(project, after).changes == {"patches": {}}


def test_setlist_refuses_unknown_snapshot_and_unplaced_rig(dump, tmp_path):
    (tmp_path / "loose.json").write_text(json.dumps({**RIG, "bank": 3}))
    project = load_project(write_project(tmp_path, setlist_songs=[
        {"rig": "../rigs/crunch.json", "sequence": ["Bridge"]},
        {"rig": "../loose.json", "sequence": ["Intro"]},
    ]))
    with pytest.raises(ModelError) as exc:
        compile_project(project, dump)
    assert len(exc.value.problems) == 2


def test_two_surfaces_cannot_share_a_manual_number(dump, tmp_path):
    other = {"schema": "es8ctl.surface/1", "switches": {"NUM5": {"role": "loop", "loop": "L7"}}}
    project = load_project(write_project(tmp_path, second_surface=other))
    with pytest.raises(ModelError, match="manual_number5"):
        compile_project(project, dump)


def test_setup_bank_must_match_rig(tmp_path):
    setup = write_project(tmp_path)
    doc = json.loads(setup.read_text())
    doc["rigs"] = {"13": "rigs/crunch.json"}
    setup.write_text(json.dumps(doc))
    with pytest.raises(ModelError, match="declares bank 12"):
        load_project(setup)


# ---------------------------------------------------------------- CLI


def test_cli_rig_compile_then_status(tmp_path):
    from typer.testing import CliRunner

    from es8ctl.cli import app

    runner = CliRunner()
    setup = write_project(tmp_path)
    changes = tmp_path / "changes.json"
    result = runner.invoke(app, ["rig", "compile", str(setup), "-b", str(FIXTURE), "-o", str(changes)])
    assert result.exit_code == 0, result.output
    assert set(json.loads(changes.read_text())["patches"]) == {"11-1", "12-1", "12-2"}

    drifted = runner.invoke(app, ["rig", "status", str(setup), "-b", str(FIXTURE)])
    assert drifted.exit_code == 1 and json.loads(drifted.stdout)["in_sync"] is False

    after = tmp_path / "after.syx"
    after.write_bytes(plan_changes(list(split_frames(FIXTURE.read_bytes())),
                                   json.loads(changes.read_text())).expected)
    synced = runner.invoke(app, ["rig", "status", str(setup), "-b", str(after)])
    assert synced.exit_code == 0 and json.loads(synced.stdout)["in_sync"] is True

    single = runner.invoke(app, ["rig", "compile", str(tmp_path / "rigs" / "crunch.json"), "-b", str(FIXTURE)])
    assert single.exit_code == 0, single.output


def test_cli_rig_compile_reports_problems(tmp_path):
    from typer.testing import CliRunner

    from es8ctl.cli import app

    setup = write_project(tmp_path, setlist_songs=[{"rig": "../rigs/crunch.json", "sequence": ["Bridge"]}])
    result = CliRunner().invoke(app, ["rig", "compile", str(setup), "-b", str(FIXTURE)])
    assert result.exit_code == 2
    assert "Bridge" in json.loads(result.stdout)["error"]


# ---------------------------------------------------------------- pont web (ES8 Designer)


def project_doc():
    rig = {**json.loads(json.dumps(RIG)), "surface": "lead"}
    return json.loads(json.dumps({
        "schema": "es8ctl.project/1", "pedalboard": PEDALBOARD, "surfaces": {"lead": SURFACE}, "rigs": {"crunch": rig},
        "setlists": {"nov": {"schema": "es8ctl.setlist/1", "name": "Nov", "midi_bank": 1,
                             "songs": [{"rig": "crunch", "sequence": ["Intro", "Chorus", "Intro"]}]}},
    }))


def test_web_rig_preview_and_stage():
    from es8core import webapp

    webapp.load_syx(FIXTURE.read_bytes())
    webapp.discard()
    doc = json.dumps(project_doc())
    preview = json.loads(webapp.rig_preview(doc))
    assert set(preview["patches"]) == {"12-1", "12-2"} and preview["system"] == ["manual_number5", "pc_map_bank1_pc"]
    assert not preview["in_sync"] and not preview["staged"]
    summary = json.loads(webapp.rig_stage(doc))
    assert summary["patches"] == ["12-1", "12-2"] and summary["system"]
    assert json.loads(webapp.rig_preview(doc))["staged"] is True
    webapp.discard()


def test_web_rig_preview_reports_problems_and_missing_reads():
    from es8core import webapp

    webapp.load_syx(FIXTURE.read_bytes())
    bad = project_doc()
    bad["rigs"]["crunch"]["snapshots"][0]["loops"] = ["L3"]
    result = json.loads(webapp.rig_preview(json.dumps(bad)))
    assert result["where"] == "rig 'crunch'" and "not wired" in result["problems"][0]
    far = project_doc()
    far["rigs"]["crunch"]["bank"] = 99  # 99-8 est incomplet dans la fixture
    far["rigs"]["crunch"]["snapshots"] = [{"name": str(i)} for i in range(8)]
    far["setlists"] = {}
    assert json.loads(webapp.rig_preview(json.dumps(far)))["missing"] == ["99-8"]


def test_cli_accepts_a_project_document(tmp_path):
    from typer.testing import CliRunner

    from es8ctl.cli import app

    path = tmp_path / "project.json"
    path.write_text(json.dumps(project_doc()))
    result = CliRunner().invoke(app, ["rig", "compile", str(path), "-b", str(FIXTURE)])
    assert result.exit_code == 0, result.output
    assert set(json.loads(result.stdout)["patches"]) == {"12-1", "12-2"}


# ---------------------------------------------------------------- morceaux (tracks)


def test_setlist_of_tracks_in_a_project_document(dump):
    from es8core.model import project_from_doc

    doc = project_doc()
    doc["tracks"] = {
        "song-a": {"schema": "es8ctl.track/1", "name": "Song A", "rig": "crunch", "sequence": ["Intro", "Chorus", "Intro"]},
        "song-b": {"schema": "es8ctl.track/1", "name": "Song B", "rig": "crunch", "sequence": ["Chorus"]},
    }
    doc["setlists"]["nov"]["songs"] = [{"track": "song-b"}, {"track": "song-a"}, {"track": "song-b"}]
    entries = compile_project(project_from_doc(doc), dump).changes["system"]["pc_map_bank1_pc"]
    assert entries[:6] == [97, 96, 97, 96, 97, 97]


def test_track_problems_name_the_track(dump):
    from es8core.model import project_from_doc

    doc = project_doc()
    doc["tracks"] = {"t": {"schema": "es8ctl.track/1", "name": "Song A", "rig": "crunch", "sequence": ["Solo"]},
                     "empty": {"schema": "es8ctl.track/1", "name": "Draft", "rig": "crunch", "sequence": []}}
    doc["setlists"]["nov"]["songs"] = [{"track": "t"}, {"track": "empty"}, {"track": "gone"}]
    with pytest.raises(ModelError) as exc:
        compile_project(project_from_doc(doc), dump)
    assert exc.value.problems == [
        "track 'Song A': rig 'Crunch Lead' has no snapshot 'Solo'.",
        "track 'Draft': no step in its running order.",
        "songs[2]: unknown track 'gone'.",
    ]


def test_setlist_of_track_files_on_disk(dump, tmp_path):
    setup = write_project(tmp_path)
    (tmp_path / "tracks").mkdir()
    (tmp_path / "tracks" / "song.json").write_text(json.dumps(
        {"schema": "es8ctl.track/1", "name": "Song", "rig": "../rigs/crunch.json", "sequence": ["Chorus", "Intro"]}))
    setlist = tmp_path / "setlists" / "november.json"
    doc = json.loads(setlist.read_text())
    doc["songs"] = [{"track": "../tracks/song.json"}, {"rig": "../rigs/ambient.json", "sequence": ["Pad"]}]
    setlist.write_text(json.dumps(doc))
    entries = compile_project(load_project(setup), dump).changes["system"]["pc_map_bank1_pc"]
    assert entries[:4] == [97, 96, 88, 88]



# ---------------------------------------------------------------- pedalboard : appareils


def test_pedalboard_v2_view():
    from es8core.model.schema import check_pedalboard

    view = check_pedalboard(PEDALBOARD)
    assert view["loops"]["L2"] == {"name": "Overdrive", "device": "od"}
    assert set(view["devices"]) == {"daw", "reverb"} and view["devices"]["daw"]["channel"] == 1


def test_a_device_can_sit_in_a_loop_and_receive_midi(dump):
    pedalboard = json.loads(json.dumps(PEDALBOARD))
    pedalboard["devices"]["daw"]["loops"] = ["L3"]  # carte son en insert : une boucle et du MIDI
    rig = {**json.loads(json.dumps(RIG)), "chain": ["L2", "L3", "L5"]}
    rig["snapshots"][0]["loops"] = ["L3"]
    first = compile_rig(pedalboard, SURFACE, rig, dump).changes["patches"]["12-1"]
    assert first["loop_sw"][2] == 1 and first["midi_tx_ch"][0] == 1


def test_pedalboard_v2_refuses_a_loop_used_twice():
    from es8core.model.schema import check_pedalboard

    bad = json.loads(json.dumps(PEDALBOARD))
    bad["devices"]["fuzz"]["loops"] = ["L2"]
    with pytest.raises(ModelError, match="already used by 'Overdrive'"):
        check_pedalboard(bad)


def test_pedalboard_v1_still_accepted(dump):
    v1 = {
        "schema": "es8ctl.pedalboard/1",
        "loops": {"L2": {"name": "Overdrive"}, "L5": {"name": "Fuzz"}, "L7": {"name": "Chorus"}},
        "devices": {"daw": {"name": "DAW", "channel": 1, "programs": {"crunch": {"pc": 12}}, "params": {"drive": {"cc": 18}}}},
    }
    rig = {**json.loads(json.dumps(RIG)), "programs": {"daw": "crunch"},
           "snapshots": [{"name": "Intro", "loops": ["L5"], "params": {"daw.drive": "on"}}]}
    first = compile_rig(v1, None, rig, dump).changes["patches"]["12-1"]
    assert first["midi_pc"][0] == 13 and first["midi_ctl1_cc"][0] == 19


# ---------------------------------------------------------------- rigs v2 : N snapshots, patchs consécutifs

RIG_V2 = {
    "schema": "es8ctl.rig/2",
    "name": "Pulse",
    "short": "PULSE",
    "start": "12-5",
    "chain": ["L2", "L5", "L7"],
    "programs": {"daw": "crunch", "reverb": 7},
    "snapshots": [{"name": f"S{i}", "loops": ["L5"]} for i in range(10)],
}


def test_rig_v2_spans_banks_from_its_start(dump):
    changes = compile_rig(PEDALBOARD, None, RIG_V2, dump).changes["patches"]
    assert sorted(changes, key=lambda label: [int(p) for p in label.split("-")])[0] == "12-5"
    assert changes["12-5"]["name"] == "PULSE S0        " and changes["13-6"]["name"] == "PULSE S9        "
    assert len(changes) == 10
    # PC par alias (daw : crunch = 12) et par numéro (reverb : 7, sans bank MSB).
    assert changes["12-5"]["midi_pc"][:2] == [13, 8]
    assert changes["12-5"].get("midi_pc_bank_msb", [0, 0])[:2] == [0, 0]


def test_snapshot_overrides_the_rig_programs(dump):
    rig = json.loads(json.dumps(RIG_V2))
    rig["snapshots"][1]["programs"] = {"daw": 40}
    rig["snapshots"][2]["programs"] = {"reverb": None, "daw": {"pc": 3}}
    changes = compile_rig(PEDALBOARD, None, rig, dump).changes["patches"]
    assert changes["12-5"]["midi_pc"][:2] == [13, 8]
    assert changes["12-6"]["midi_pc"][:2] == [41, 8]
    assert changes["12-7"]["midi_tx_ch"][:2] == [1, 0] and changes["12-7"]["midi_pc"][:1] == [4]


@pytest.mark.parametrize(
    "edit, message",
    [
        (lambda r: r.update(start="100-1"), "is not a patch"),
        (lambda r: r.update(start=795), "past the last patch"),
        (lambda r: r.update(programs={"daw": 128}), "invalid program"),
        (lambda r: r["snapshots"][0].update(programs={"comp": 3}), "unknown device"),
        (lambda r: r.pop("start"), "first patch"),
    ],
)
def test_rig_v2_is_refused(dump, edit, message):
    rig = json.loads(json.dumps(RIG_V2))
    edit(rig)
    with pytest.raises(ModelError, match=message):
        compile_rig(PEDALBOARD, None, rig, dump)


def test_rigs_cannot_share_patches():
    from es8core.model import project_from_doc

    doc = project_doc()
    doc["rigs"]["pulse"] = {**json.loads(json.dumps(RIG_V2)), "start": "11-8"}  # 11-8 … 13-1 : chevauche 12-1, 12-2
    with pytest.raises(ModelError, match=r"patches 12-1…12-2 are already used by rig 'Crunch Lead'"):
        project_from_doc(doc)
    doc["rigs"]["pulse"]["start"] = "12-3"
    assert sorted(project_from_doc(doc).rigs) == [96, 98]


def test_setlist_steps_use_the_v2_patches(dump):
    from es8core.model import project_from_doc

    doc = project_doc()
    doc["rigs"]["pulse"] = json.loads(json.dumps(RIG_V2))
    doc["setlists"]["nov"]["songs"] = [{"rig": "pulse", "sequence": ["S0", "S9", "S0"]}]
    entries = compile_project(project_from_doc(doc), dump).system_wanted["pc_map_bank1_pc"]
    assert entries[:4] == [100, 109, 100, 100]


def test_rig_devices_limit_what_it_uses(dump):
    rig = {**json.loads(json.dumps(RIG_V2)), "devices": ["od", "fuzz", "chorus", "daw", "reverb"]}
    warnings = compile_rig(PEDALBOARD, None, rig, dump).warnings
    # Comp et Delay ne servent pas à ce rig : pas d'avertissement « wired but not in the chain ».
    assert not any("Comp" in w or "Delay" in w for w in warnings)
    rig["devices"].remove("reverb")
    with pytest.raises(ModelError, match="device 'reverb' is not used by this rig"):
        compile_rig(PEDALBOARD, None, rig, dump)
    rig["programs"].pop("reverb")
    rig["devices"].remove("fuzz")
    with pytest.raises(ModelError, match=r"chain: L5: device 'fuzz' is not used"):
        compile_rig(PEDALBOARD, None, rig, dump)
    rig["devices"].append("nope")
    with pytest.raises(ModelError, match="unknown device 'nope'"):
        compile_rig(PEDALBOARD, None, rig, dump)


# ---------------------------------------------------------------- secours

BACKUP = {"schema": "es8ctl.rig/2", "name": "Backup", "short": "BK", "start": "40-1",
          "chain": ["L8"], "snapshots": [{"name": "Clean"}, {"name": "Lead"}]}


def backup_doc():
    doc = project_doc()
    doc["rigs"]["backup"] = json.loads(json.dumps(BACKUP))
    doc["rigs"]["crunch"]["backup"] = "backup"
    doc["rigs"]["crunch"]["snapshots"][1]["backup"] = "Lead"  # Chorus → Lead ; Intro → Clean (premier)
    return doc


def test_backup_patches_sit_at_the_top_of_the_pc_map(dump):
    from es8core.model import export_show, project_from_doc

    project = project_from_doc(backup_doc())
    entries = compile_project(project, dump).system_wanted["pc_map_bank1_pc"]
    # Pas : Intro, Chorus, Intro (96, 97, 96) ; secours : Clean (320) en PC 127, Lead (321) en PC 126.
    assert entries[:4] == [96, 97, 96, 96] and entries[125:] == [96, 321, 320]
    steps = export_show(project)["setlists"][0]["steps"]
    assert steps[0]["backup"] == {"rig": "Backup", "snapshot": "Clean", "pc": 127, "label": "40-1"}
    assert steps[1]["backup"] == {"rig": "Backup", "snapshot": "Lead", "pc": 126, "label": "40-2"}


@pytest.mark.parametrize(
    "edit, message",
    [
        (lambda d: d["rigs"]["crunch"].update(backup="nope"), "unknown rig 'nope'"),
        (lambda d: d["rigs"]["crunch"].update(backup="crunch"), "its own backup"),
        (lambda d: d["rigs"]["crunch"]["snapshots"][1].update(backup="Solo"), "no snapshot 'Solo'"),
        (lambda d: d["rigs"]["crunch"].pop("backup"), "the rig has no backup rig"),
    ],
)
def test_backup_is_refused(edit, message):
    from es8core.model import project_from_doc

    doc = backup_doc()
    edit(doc)
    with pytest.raises(ModelError, match=message):
        project_from_doc(doc)


# ---------------------------------------------------------------- noms de patch raccourcis


@pytest.mark.parametrize(
    "short, name, expected",
    [
        ("Crunch", "Chorus", "Crunch Chorus"),
        ("PULSE", "A Great Day For Freedom - Intro", "PULSE GDF Intro"),
        ("PULSE", "A Great Day For Freedom", "PULSE GD Freedom"),
        ("PULSE", "Shine On You Crazy Diamond Part 2", "PULSE SYCD Prt 2"),
        ("PULSE", "Sorrow Outro", "PULSE Srrw Outro"),
        ("Écho", "Première partie élégante", "Echo PP elegante"),
    ],
)
def test_abbreviate(short, name, expected):
    from es8core.model.abbrev import abbreviate

    assert abbreviate(short, name) == expected


def test_long_snapshot_names_are_shortened_in_the_patch(dump):
    rig = json.loads(json.dumps(RIG_V2))
    rig["snapshots"][0]["name"] = "A Great Day For Freedom - Intro"
    rig["snapshots"][1]["name"] = "A Great Day For Freedom - Intro (2)"
    rig["snapshots"][2]["patch_name"] = "Mine"
    result = compile_rig(PEDALBOARD, None, rig, dump)
    names = [result.changes["patches"][label]["name"].rstrip() for label in ("12-5", "12-6", "12-7", "12-8")]
    assert names == ["PULSE GDF Intro", "PULSE GDF Intr 2", "Mine", "PULSE S3"]
    assert "Pulse: patch 12-5 is named 'PULSE GDF Intro' (shortened from 'A Great Day For Freedom - Intro')." in result.warnings

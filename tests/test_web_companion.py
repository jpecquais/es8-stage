"""Logique de ES8 Companion (web/companion/show.js) sur le show de démo, exécutée sous Node."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

COMPANION = Path(__file__).parents[1] / "web" / "companion"

SCRIPT = """
import * as S from %s;
const show = %s;
const at = (step) => ({ setlist: 0, step });
const v = S.view(show, at(5));
const debounce = S.makeDebounce(120);
const cc80 = S.eventFromMidi([0xbe, 80, 127]);
let b = S.presetBindings(show);
b = S.learn(b, "next_song", cc80);
console.log(JSON.stringify({
  problems: S.checkShow(show),
  broken: S.checkShow({ schema: "x", setlists: [] }).length,
  start: S.startPosition(show),
  kept: S.validPosition(show, at(7)),
  reset: S.validPosition(show, { setlist: 1, step: 0 }),
  view: { song: v.song.name, pos: v.posInSong, now: v.step.snapshot, prev: v.prev.snapshot, next: v.next.snapshot,
          strip: v.strip.map((s) => s.state), nextSong: v.nextSong.name, newSong: v.nextIsNewSong },
  bank: { n: v.bank.bank, current: v.bank.patches.filter((p) => p.current).map((p) => p.label),
          names: v.bank.patches.map((p) => p.snapshot) },
  programs: v.programs.map((p) => p.pc),
  played: [S.played(v.step, 5, false), S.played(v.step, 5, true), S.played(S.view(show, at(0)).step, 0, true)],
  group: (() => {
    // Sélecteur : NUM5 / NUM6 sont deux crans (24, 40) d'un même paramètre « amp » (off = 8), dans le groupe
    // « drive » avec NUM1 (drive, un autre paramètre). Pas 3 : drive on.
    const g = JSON.parse(JSON.stringify(show));
    const sws = g.rigs.crunch.surface.switches;
    const step = (on) => ({ role: "param", mode: "toggle", param: "daw.amp", channel: 1, cc: 22, on, off: 8, exact: true, group: "drive" });
    sws.NUM5 = { label: "OD", ...step(24) }; sws.NUM6 = { label: "Muff", ...step(40) }; sws.NUM1.group = "drive";
    const pos = at(3), st = S.startStates(g, pos);
    const od = S.pressSwitch(g, pos, "NUM5", true, st);
    const muff = S.pressSwitch(g, pos, "NUM6", true, od.states);
    const back = S.pressSwitch(g, pos, "NUM6", true, muff.states);
    const lit = (states) => ["NUM1", "NUM5", "NUM6"].filter((k) => S.switchIsOn(sws[k], states));
    return { od: [od.messages, lit(od.states)], muff: [muff.messages, lit(muff.states)], back: [back.messages, lit(back.states)] };
  })(),
  sw: (() => {
    // Pas 3 (White Night / Chorus) : drive on au départ. NUM1 (CC80 ch16) bascule drive, BANK_U avance, NUM4 est momentané.
    const pos = at(3), st = S.startStates(show, pos);
    const press = (cc, v) => S.switchFromMidi(show, [0xbf, cc, v]);
    const n1 = press(80, 127), r1 = S.pressSwitch(show, pos, n1.key, true, st);
    const r2 = S.pressSwitch(show, pos, "NUM1", true, r1.states);
    const rel = S.pressSwitch(show, pos, "NUM1", false, r2.states);
    const f1 = S.pressSwitch(show, pos, "NUM4", true, st), f0 = S.pressSwitch(show, pos, "NUM4", false, f1.states);
    return { start: st, n1, first: [r1.message, r1.on], second: [r2.message, r2.on], release: rel,
             next: S.pressSwitch(show, pos, "BANK_U", true, st), freeze: [f1.message, f0.message],
             other: S.switchFromMidi(show, [0xbe, 80, 127]), unknown: press(99, 127), loop: S.pressSwitch(show, pos, "NUM5", true, st) };
  })(),
  boundary: S.view(show, at(7)).nextIsNewSong,
  next: S.move(show, at(5), "next"), prev: S.move(show, at(5), "prev"),
  atEnd: S.move(show, at(12), "next"), atStart: S.move(show, at(0), "prev"),
  nextSong: S.move(show, at(5), "next_song"), prevSong: S.move(show, at(5), "prev_song"),
  firstPrevSong: S.move(show, at(1), "prev_song"), lastNextSong: S.move(show, at(11), "next_song"),
  songStart: S.move(show, at(5), "song_start"), songStartNoop: S.move(show, at(2), "song_start"),
  goSong: S.goToSong(show, 0, 2),
  pc: S.stepMessages(1, 0, 5), pc16: S.stepMessages(16, 6, 127),
  cc80, release: S.eventFromMidi([0xbe, 80, 0]), noteOn: S.eventFromMidi([0x90, 60, 100]),
  noteOff: S.eventFromMidi([0x80, 60, 0]), pcIn: S.eventFromMidi([0xc0, 5]), clock: S.eventFromMidi([0xf8]),
  presetNext: S.actionFor(S.presetBindings(show), cc80),
  releaseAction: S.actionFor(S.presetBindings(show), S.eventFromMidi([0xbe, 80, 0])),
  key: S.actionFor(S.presetBindings(show), S.eventFromKey("PageDown")),
  relearned: S.actionFor(b, cc80), relearnedCount: b.filter((x) => x.type === "cc" && x.number === 80).length,
  cleared: S.clearAction(b, "prev").some((x) => x.action === "prev"),
  noPreset: S.presetBindings(null).length,
  describe: [S.describeBinding({ type: "cc", channel: 16, number: 80 }), S.describeBinding({ type: "key", key: "ArrowRight" })],
  debounce: [debounce(cc80, 0), debounce(cc80, 50), debounce(cc80, 200), debounce(S.eventFromMidi([0xbe, 81, 127]), 210)],
}));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="Node absent")
def test_companion_logic():
    show = (COMPANION / "demo-show.json").read_text(encoding="utf-8")
    script = SCRIPT % (json.dumps((COMPANION / "show.js").as_uri()), show)
    r = json.loads(subprocess.run(["node", "--input-type=module", "-e", script],
                                  capture_output=True, text=True, check=True).stdout)
    assert r["problems"] == [] and r["broken"] >= 2
    assert r["start"] == {"setlist": 0, "step": 0} and r["kept"] == {"setlist": 0, "step": 7}
    assert r["reset"] == {"setlist": 1, "step": 0}  # banque MIDI 1 : jouable (Bank Select CC0)
    assert r["view"] == {"song": "White Night", "pos": 3, "now": "Chorus", "prev": "Verse", "next": "Bridge",
                         "strip": ["done", "done", "done", "current", "next", "later"],
                         "nextSong": "Homecoming", "newSong": False}
    assert r["boundary"] is True
    assert r["next"]["step"] == 6 and r["prev"]["step"] == 4
    assert r["atEnd"] is None and r["atStart"] is None  # rien à envoyer aux bouts
    assert r["nextSong"]["step"] == 8 and r["prevSong"]["step"] == 0
    assert r["firstPrevSong"] is None and r["lastNextSong"] is None
    assert r["songStart"]["step"] == 2 and r["songStartNoop"] is None
    assert r["goSong"] == {"setlist": 0, "step": 8}
    assert r["pc"] == [0xB0, 0, 0, 0xC0, 5] and r["pc16"] == [0xBF, 0, 6, 0xCF, 127]
    assert r["cc80"] == {"type": "cc", "channel": 15, "number": 80, "press": True}
    assert r["release"]["press"] is False and r["noteOn"]["press"] is True and r["noteOff"]["press"] is False
    assert r["pcIn"] is None and r["clock"] is None  # les PC reçus ne sont jamais des entrées
    assert r["presetNext"] == "next" and r["releaseAction"] is None and r["key"] == "next"
    assert r["relearned"] == "next_song" and r["relearnedCount"] == 1
    assert r["cleared"] is False and r["noPreset"] == 4
    assert r["describe"] == ["CC 80 · ch 16", "Key →"]
    assert r["debounce"] == [True, False, True, True]
    assert r["bank"] == {"n": 12, "current": ["12-2"], "names": ["Verse", "Chorus", "Bridge", "Solo", None, None, None, None]}
    assert r["programs"] == [12, 5]
    normal, backup, none = r["played"]
    assert normal == {"pc": 5, "label": "12-2", "snapshot": "Chorus", "backup": False}
    assert backup == {"pc": 126, "label": "40-2", "snapshot": "Lead", "rig": "GP50 backup", "backup": True}
    assert none["pc"] == 0 and none["backup"] is False  # pas sans secours : le son normal
    sw = r["sw"]
    assert sw["start"] == {"daw.drive": 127, "daw.delay": 127, "reverb.freeze": 0}
    assert sw["n1"] == {"key": "NUM1", "press": True}
    assert sw["first"] == [[0xB0, 18, 0], False] and sw["second"] == [[0xB0, 18, 127], True]  # drive était on : off, puis on
    assert sw["release"] is None  # une bascule ignore le relâchement
    assert sw["next"] == {"action": "next", "label": "Next"}
    assert sw["freeze"] == [[0xB1, 21, 127], [0xB1, 21, 0]]  # momentané : on à l'appui, off au relâchement
    assert sw["other"] is None and sw["unknown"] is None and sw["loop"] is None
    g = r["group"]
    assert g["od"] == [[[0xB0, 22, 24], [0xB0, 18, 0]], ["NUM5"]]  # OD choisi, Drive (même groupe) coupé
    assert g["muff"] == [[[0xB0, 22, 40]], ["NUM6"]]  # un autre cran : OD s'éteint de lui-même
    assert g["back"] == [[[0xB0, 22, 8]], []]  # réappuyer sur le cran actif : retour au off (Clean)

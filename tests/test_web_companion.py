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
const cc80 = S.eventFromMidi([0xbf, 80, 127]);
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
  boundary: S.view(show, at(7)).nextIsNewSong,
  next: S.move(show, at(5), "next"), prev: S.move(show, at(5), "prev"),
  atEnd: S.move(show, at(12), "next"), atStart: S.move(show, at(0), "prev"),
  nextSong: S.move(show, at(5), "next_song"), prevSong: S.move(show, at(5), "prev_song"),
  firstPrevSong: S.move(show, at(1), "prev_song"), lastNextSong: S.move(show, at(11), "next_song"),
  songStart: S.move(show, at(5), "song_start"), songStartNoop: S.move(show, at(2), "song_start"),
  goSong: S.goToSong(show, 0, 2),
  pc: S.programChange(1, 5), pc16: S.programChange(16, 127),
  cc80, release: S.eventFromMidi([0xbf, 80, 0]), noteOn: S.eventFromMidi([0x90, 60, 100]),
  noteOff: S.eventFromMidi([0x80, 60, 0]), pcIn: S.eventFromMidi([0xc0, 5]), clock: S.eventFromMidi([0xf8]),
  presetNext: S.actionFor(S.presetBindings(show), cc80),
  releaseAction: S.actionFor(S.presetBindings(show), S.eventFromMidi([0xbf, 80, 0])),
  key: S.actionFor(S.presetBindings(show), S.eventFromKey("PageDown")),
  relearned: S.actionFor(b, cc80), relearnedCount: b.filter((x) => x.type === "cc" && x.number === 80).length,
  cleared: S.clearAction(b, "prev").some((x) => x.action === "prev"),
  noPreset: S.presetBindings(null).length,
  describe: [S.describeBinding({ type: "cc", channel: 16, number: 80 }), S.describeBinding({ type: "key", key: "ArrowRight" })],
  debounce: [debounce(cc80, 0), debounce(cc80, 50), debounce(cc80, 200), debounce(S.eventFromMidi([0xbf, 81, 127]), 210)],
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
    assert r["reset"] == {"setlist": 0, "step": 0}  # banque MIDI 1 : pas jouable sans Bank Select
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
    assert r["pc"] == [0xC0, 5] and r["pc16"] == [0xCF, 127]
    assert r["cc80"] == {"type": "cc", "channel": 16, "number": 80, "press": True}
    assert r["release"]["press"] is False and r["noteOn"]["press"] is True and r["noteOff"]["press"] is False
    assert r["pcIn"] is None and r["clock"] is None  # les PC reçus ne sont jamais des entrées
    assert r["presetNext"] == "next" and r["releaseAction"] is None and r["key"] == "next"
    assert r["relearned"] == "next_song" and r["relearnedCount"] == 1
    assert r["cleared"] is False and r["noPreset"] == 4
    assert r["describe"] == ["CC 80 · ch 16", "Key →"]
    assert r["debounce"] == [True, False, True, True]

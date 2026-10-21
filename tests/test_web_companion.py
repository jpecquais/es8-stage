"""ES8 Companion, écran de l'hôte de scène : ce qu'elle affiche d'un show et les touches du clavier
(web/companion/show.js, sous Node). Le jeu lui-même est testé dans test_stage.py."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

COMPANION = Path(__file__).parents[1] / "web" / "companion"
DEMO = Path(__file__).parent / "fixtures" / "demo-show.json"

SCRIPT = """
import * as S from %s;
const show = %s;
const at = (step) => ({ setlist: 0, step });
const v = S.view(show, at(5));
let k = S.learn(S.DEFAULT_KEY_BINDINGS, "next_song", S.eventFromKey("ArrowRight"));
console.log(JSON.stringify({
  view: { song: v.song.name, pos: v.posInSong, now: v.step.snapshot, prev: v.prev.snapshot, next: v.next.snapshot,
          strip: v.strip.map((s) => s.state), nextSong: v.nextSong.name, newSong: v.nextIsNewSong },
  boundary: S.view(show, at(7)).nextIsNewSong,
  bank: { n: v.bank.bank, current: v.bank.patches.filter((p) => p.current).map((p) => p.label),
          names: v.bank.patches.map((p) => p.snapshot) },
  programs: v.programs.map((p) => p.pc),
  played: [S.played(v.step, 5, false), S.played(v.step, 5, true)],
  goSong: S.goToSong(show, 0, 2),
  playable: show.setlists.map(S.isPlayable),
  lit: Object.entries(show.rigs.crunch.surface.switches).filter(([, sw]) => S.switchIsOn(sw, { "daw.drive": 127 })).map(([k]) => k),
  key: S.actionFor(S.DEFAULT_KEY_BINDINGS, S.eventFromKey("PageDown")),
  release: S.actionFor(S.DEFAULT_KEY_BINDINGS, { type: "key", key: "PageDown", press: false }),
  relearned: S.actionFor(k, S.eventFromKey("ArrowRight")), relearnedCount: k.filter((b) => b.key === "ArrowRight").length,
  cleared: S.clearAction(k, "prev").some((b) => b.action === "prev"),
  describe: [S.describeBinding({ type: "key", key: "ArrowRight" }), S.describeBinding({ type: "key", key: "b" })],
}));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="Node absent")
def test_companion_display_and_keys():
    script = SCRIPT % (json.dumps((COMPANION / "show.js").as_uri()), DEMO.read_text(encoding="utf-8"))
    r = json.loads(subprocess.run(["node", "--input-type=module", "-e", script],
                                  capture_output=True, text=True, check=True).stdout)
    assert r["view"] == {"song": "White Night", "pos": 3, "now": "Chorus", "prev": "Verse", "next": "Bridge",
                         "strip": ["done", "done", "done", "current", "next", "later"],
                         "nextSong": "Homecoming", "newSong": False}
    assert r["boundary"] is True
    assert r["bank"] == {"n": 12, "current": ["12-2"], "names": ["Verse", "Chorus", "Bridge", "Solo", None, None, None, None]}
    assert r["programs"] == [12, 5]
    assert r["played"][0]["pc"] == 5 and r["played"][1] == {"pc": 126, "label": "40-2", "snapshot": "Lead", "rig": "GP50 backup", "backup": True}
    assert r["goSong"] == {"setlist": 0, "step": 8}
    assert r["playable"][0] is True
    assert r["lit"] == ["NUM1"]
    assert r["key"] == "next" and r["release"] is None
    assert r["relearned"] == "next_song" and r["relearnedCount"] == 1 and r["cleared"] is False
    assert r["describe"] == ["Key →", "Key b"]

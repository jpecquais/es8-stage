"""ES8 Stage, l'appli unifiée (web/app/) dans un vrai navigateur : jouer, éditer, enregistrer, envoyer à l'ES-8.

Firefox sans écran, piloté par Selenium, contre un hôte de scène local et le faux ES-8 de test_host.py.
Sauté sans Selenium ni Firefox ; pour le lancer : `uv run --with selenium pytest tests/test_web_app.py`.
"""

import json
import shutil
import threading
import time
from pathlib import Path

import pytest

webdriver = pytest.importorskip("selenium.webdriver")
pytestmark = pytest.mark.skipif(shutil.which("firefox") is None and not Path("/Applications/Firefox.app").exists(),
                                reason="Firefox absent")

E = "document.getElementById('edit').shadowRoot"
P = "document.getElementById('play').shadowRoot"


@pytest.fixture
def app(tmp_path, monkeypatch):
    from test_host import FakeES8
    from test_rig_model import project_doc

    import es8core.apply as apply_mod
    from es8stage.model import export_show, project_from_doc
    from es8stage.server.http import make_server
    from es8stage.server.library import Library
    from es8stage.server.stage_server import StageServer

    monkeypatch.setattr(apply_mod, "DEFAULT_PAGE_GAP_S", 0.05)
    monkeypatch.setattr(apply_mod, "DEFAULT_INTERVAL_S", 0.05)
    doc = project_doc()
    doc["name"] = "Gig"
    lib = Library(tmp_path / "library", tmp_path / "show.json")
    lib.write("projects", "Gig", json.dumps(doc).encode())
    lib.write("shows", "Gig", json.dumps(export_show(project_from_doc(doc))).encode())
    lib.play("Gig")
    host = StageServer(tmp_path / "show.json", log=lambda m: None)
    host._send, host._out = FakeES8(host), object()
    host.stage.send = lambda m: True
    srv = make_server(0, data=tmp_path, host=host)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    opts = webdriver.FirefoxOptions()
    opts.add_argument("-headless")
    d = webdriver.Firefox(options=opts)
    d.set_window_size(1180, 820)
    d.base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield d, host, lib
    d.quit()
    srv.shutdown()
    srv.server_close()


def until(fn, timeout=20.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = fn()
        if value:
            return value
        time.sleep(0.2)
    raise AssertionError("timed out")


def alert(d):
    try:
        return d.switch_to.alert
    except Exception:  # noqa: BLE001 — pas encore là
        return None


def js(d, script, *args):
    return d.execute_script(script, *args)


def test_edit_what_plays_then_done_and_send(app):
    d, host, lib = app
    d.get(d.base + "/")
    until(lambda: js(d, f"return {P}?.querySelector('.home-row')"))
    js(d, f"{P}.querySelector('.home-row').click()")  # la setlist
    until(lambda: js(d, f"return {P}.querySelector('.bar-title')"))  # sur scène
    js(d, f"{P}.querySelector('.edit-btn').click()")
    # ✎ ouvre le son joué
    until(lambda: js(d, f"return {E}?.querySelector('.row[aria-current=true]')"))
    assert "Intro" in js(d, f"return {E}.querySelector('section.col:nth-of-type(2) .bar h1').textContent")
    # La touche espace dans un champ n'avance pas la scène
    pos = dict(host.stage.pos)
    js(d, f"{E}.querySelector('input.text.big').focus()")
    js(d, "window.dispatchEvent(new KeyboardEvent('keydown', {key: ' '}))")
    assert host.stage.pos == pos
    # Un favori, puis Done : enregistré, joué tout de suite (l'ES-8 n'a rien à changer)
    js(d, f"[...{E}.querySelectorAll('.switch')][0].click()")
    js(d, f"{E}.querySelector('.tool.done').click()")
    until(lambda: (host.stage.show.get("favorites") or [{}])[0].get("name") == "Intro")
    assert js(d, "return document.getElementById('edit').hidden") is True
    assert "plays it now" in until(lambda: js(d, "return document.querySelector('.shell-toast').textContent"))
    # Envoyer à l'ES-8 : tout diffère du dump de test ; le job écrit, vérifie, puis plus rien ne diffère
    js(d, f"{P}.querySelector('.edit-btn').click()")
    until(lambda: js(d, f"return {E}.querySelector('.sendbox .send')"))
    js(d, f"{E}.querySelector('.sendbox .send').click()")
    until(lambda: alert(d)).accept()
    until(lambda: host.job and host.job["done"], 60)
    assert not host.job["error"] and host.job["result"]["written"] > 0 and not host.edit
    until(lambda: "matches" in js(d, f"return {E}.querySelector('.side-foot').textContent"))


def test_a_save_over_a_version_changed_elsewhere_asks_first(app):
    d, host, lib = app
    d.get(d.base + "/app/#edit")
    until(lambda: js(d, f"return {E}?.querySelector('.nav')"))
    doc = json.loads(lib.read("projects", "Gig"))
    doc["setlists"]["nov"]["name"] = "Changed elsewhere"
    lib.write("projects", "Gig", json.dumps(doc).encode())
    js(d, f"{E}.querySelectorAll('.nav')[4].click()")
    js(d, f"[...{E}.querySelectorAll('section.col .row.link')].pop().click()")
    js(d, f"const i={E}.querySelector('input.text.big'); i.value='Mine'; i.dispatchEvent(new Event('input', {{bubbles: true}}))")
    js(d, f"{E}.querySelector('.save').click()")
    until(lambda: alert(d)).dismiss()  # garder l'autre version…
    until(lambda: alert(d)).accept()  # … et la charger
    until(lambda: js(d, f"return {E}.querySelector('input.text.big')?.value") == "Changed elsewhere")
    assert json.loads(lib.read("projects", "Gig"))["setlists"]["nov"]["name"] == "Changed elsewhere"


def test_song_info_undo_and_favorites_from_the_stage(app):
    """Tempo et notes d'un morceau sur scène ; annuler pas à pas ; un favori joué depuis la scène, et le retour."""
    d, host, lib = app
    doc = json.loads(lib.read("projects", "Gig"))
    doc["favorites"] = [{"rig": "crunch", "sound": "Chorus"}]
    lib.write("projects", "Gig", json.dumps(doc).encode())
    d.get(d.base + "/app/#edit")
    until(lambda: js(d, f"return {E}?.querySelector('.nav')"))
    js(d, f"{E}.querySelectorAll('.nav')[3].click()")  # Songs
    js(d, f"{E}.querySelector('section.col.list .row.link').click()")
    js(d, f"[...{E}.querySelectorAll('section.col:nth-of-type(2) .switch')].pop().click()")  # tempo 120
    time.sleep(1.1)  # un pas d'annulation à part
    js(d, f"const t={E}.querySelector('textarea.notes'); t.value='Wait for drums'; t.dispatchEvent(new Event('input', {{bubbles: true}}))")
    js(d, f"{E}.querySelector('[aria-label=Undo]').click()")
    assert js(d, f"return {E}.querySelector('textarea.notes').value") == ""
    js(d, f"{E}.querySelector('[aria-label=Redo]').click()")
    assert js(d, f"return {E}.querySelector('textarea.notes').value") == "Wait for drums"
    js(d, f"{E}.querySelector('.tool.done').click()")
    until(lambda: host.stage.show["setlists"][0]["songs"][0].get("notes") == "Wait for drums")
    song = host.stage.show["setlists"][0]["songs"][0]
    assert song["tempo"] == 120 and (host.stage.show.get("favorites") or [{}])[0].get("name") == "Chorus"
    # Sur scène : le tempo, les notes ; un favori depuis la feuille ★, puis retour à la setlist
    js(d, f"{P}.querySelector('.home-row').click()")
    until(lambda: js(d, f"return {P}.querySelector('.song-info')"))
    assert "120" in js(d, f"return {P}.querySelector('.song-info').textContent")
    assert js(d, f"return {P}.querySelector('.song-notes').textContent") == "Wait for drums"
    js(d, f"{P}.querySelector('.fav-btn').click()")
    js(d, f"{P}.querySelector('.sheet-favs .fav').click()")
    until(lambda: host.stage.favorite == 0)
    until(lambda: "Favorite" in js(d, f"return {P}.querySelector('.card.now').textContent"))
    js(d, f"{P}.querySelector('.card.now').click()")
    until(lambda: host.stage.favorite is None)

"""Serveur HTTP de es8stage : applis des deux dépôts, moteur du navigateur, bibliothèque, sûreté des chemins."""

import http.client
import io
import json
import threading
import zipfile
from pathlib import Path

import pytest

from es8stage.server.http import make_server

SHOW = {"schema": "es8ctl.show/1", "exported": "1", "setlists": []}


@pytest.fixture
def server(tmp_path):
    srv = make_server(0, data=tmp_path)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv
    srv.shutdown()
    srv.server_close()


def request(srv, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    conn.request(method, path, body=data, headers=headers or {})
    res = conn.getresponse()
    return res.status, res.read(), res


def test_serves_both_repositories_apps(server):
    for path in ("/app/", "/designer/", "/companion/", "/host/", "/stage-shared/bridge.js", "/control/", "/shared/engine.js"):
        assert request(server, "GET", path)[0] == 200, path
    status, _, res = request(server, "GET", "/")
    assert status == 302 and res.getheader("Location") == "/app/"
    page = request(server, "GET", "/control/")[1].decode()
    assert page.index("stage-shared/control.js") < page.index('src="app.js"')  # le pont avant l'appli


def test_engine_zip_has_both_engines_but_not_the_server(server):
    names = zipfile.ZipFile(io.BytesIO(request(server, "GET", "/stage-shared/engine.zip")[1])).namelist()
    assert "es8core/webapp.py" in names and "es8stage/webapp.py" in names and "es8stage/model/compile.py" in names
    assert not any(n.startswith("es8stage/server/") or n == "es8stage/cli.py" for n in names)


def test_never_serves_outside_its_folders(server):
    for path in ("/control/../../../../../../../../etc/hosts", "/../../../../../etc/hosts",
                 "/designer/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/hosts"):
        status, body, _ = request(server, "GET", path)
        assert status == 404 and b"localhost" not in body, path


def test_library_and_current_show(server):
    assert request(server, "PUT", "/library/shows/Sat", SHOW)[0] == 204
    assert request(server, "POST", "/library/shows/Sat", {"op": "play"})[0] == 204
    assert json.loads(request(server, "GET", "/library/")[1])["playing"] == "Sat"
    assert json.loads(request(server, "GET", "/stage/show.json")[1]) == SHOW
    # Pas de mot de passe : supprimer est permis ; avec un mot de passe, il faut la session.
    assert request(server, "POST", "/host/api/password", {"password": "secret"})[0] == 204
    assert request(server, "DELETE", "/library/shows/Sat")[0] == 401
    status, _, res = request(server, "POST", "/host/api/login", {"password": "secret"})
    cookie = res.getheader("Set-Cookie").split(";")[0]
    assert status == 204
    assert request(server, "DELETE", "/library/shows/Sat", headers={"Cookie": cookie})[0] == 409  # joué
    assert request(server, "POST", "/stage/show.json", {"schema": "nope"})[0] == 400


def test_stage_state_names_the_set_played(tmp_path):
    """Les écrans (Companion, Designer) savent quel set de la bibliothèque la scène joue : le Designer l'ouvre."""
    from es8stage.server.stage_server import StageServer

    host = StageServer(tmp_path / "show.json", log=lambda m: None)
    srv = make_server(0, data=tmp_path, host=host)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        show = json.loads((Path(__file__).parent / "fixtures" / "demo-show.json").read_text())
        assert json.loads(request(srv, "GET", "/stage/state")[1])["playing"] is None
        assert request(srv, "PUT", "/library/shows/PULSE", show)[0] == 204
        assert request(srv, "POST", "/library/shows/PULSE", {"op": "play"})[0] == 204
        assert json.loads(request(srv, "GET", "/stage/state")[1])["playing"] == "PULSE"
        version = host.version
        assert request(srv, "POST", "/library/shows/PULSE", {"op": "rename", "to": "PULSE live"})[0] == 204
        assert host.version > version  # les écrans reçoivent le nouveau nom
        assert json.loads(request(srv, "GET", "/stage/state")[1])["playing"] == "PULSE live"
    finally:
        srv.shutdown()
        srv.server_close()


def test_saving_the_set_played_updates_the_stage_when_the_es8_has_nothing_to_change(tmp_path):
    """Une seule appli (docs/unified-app.md) : enregistrer le set joué le donne à la scène, à la même place,
    tant que l'ES-8 n'a rien à changer ; un nouvel ordre attend l'envoi à l'ES-8."""
    from test_rig_model import project_doc

    from es8stage.model import export_show, project_from_doc
    from es8stage.server.stage_server import StageServer

    host = StageServer(tmp_path / "show.json", log=lambda m: None)
    srv = make_server(0, data=tmp_path, host=host)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        doc = project_doc()
        status, body, _ = request(srv, "PUT", "/library/projects/PULSE", doc)
        assert status == 200 and "stage" not in json.loads(body)  # pas joué : rien d'autre
        request(srv, "PUT", "/library/shows/PULSE", export_show(project_from_doc(doc)))
        request(srv, "POST", "/library/shows/PULSE", {"op": "play"})
        host.stage.act("next")
        assert host.stage.pos["step"] == 1

        def save(d):
            status, body, _ = request(srv, "PUT", "/library/projects/PULSE", d)
            assert status == 200
            return json.loads(body)["stage"]

        assert save(doc) == "unchanged"
        doc["setlists"]["nov"]["name"] = "November"
        doc["favorites"] = [{"rig": "crunch", "sound": "Chorus"}]
        assert save(doc) == "playing"
        snap = json.loads(request(srv, "GET", "/stage/state")[1])
        assert snap["show"]["setlists"][0]["name"] == "November" and snap["show"]["favorites"][0]["name"] == "Chorus"
        assert snap["pos"]["step"] == 1  # la scène n'a pas bougé
        host._midi_round()  # le fichier a changé, mais c'est déjà le show joué
        assert host.stage.pos["step"] == 1
        doc["setlists"]["nov"]["songs"][0]["sequence"] = ["Chorus", "Intro"]  # d'autres PC : l'ES-8 doit changer
        assert save(doc) == "send"
        assert host.stage.show["setlists"][0]["steps"][0]["snapshot"] == "Intro"
        doc["rigs"]["crunch"]["snapshots"] = []
        assert save(doc) == "invalid"
    finally:
        srv.shutdown()
        srv.server_close()

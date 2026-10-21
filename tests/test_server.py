"""Serveur HTTP de es8stage : applis des deux dépôts, moteur du navigateur, bibliothèque, sûreté des chemins."""

import http.client
import io
import json
import threading
import zipfile

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
    for path in ("/designer/", "/companion/", "/host/", "/stage-shared/bridge.js", "/control/", "/shared/engine.js"):
        assert request(server, "GET", path)[0] == 200, path
    status, _, res = request(server, "GET", "/")
    assert status == 302 and res.getheader("Location") == "/host/"
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

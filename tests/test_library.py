"""Bibliothèque de sets (es8ctl web) : projets, shows, sauvegardes ; le show joué."""

import json

import pytest

from es8stage.server.library import Library, LibraryError

PROJECT = json.dumps({"schema": "es8ctl.project/1", "name": "PULSE"}).encode()
SHOW = json.dumps({"schema": "es8ctl.show/1", "exported": "1", "setlists": []}).encode()


@pytest.fixture
def lib(tmp_path):
    return Library(tmp_path / "library", tmp_path / "show.json")


def test_write_list_read_delete(lib):
    lib.write("projects", "PULSE", PROJECT)
    lib.write("backups", "Before gig", b"\xf0\x41\xf7")
    ls = lib.listing()
    assert [i["name"] for i in ls["projects"]] == ["PULSE"] and ls["backups"][0]["size"] == 3
    assert ls["playing"] is None and ls["shows"] == []
    assert lib.read("projects", "PULSE") == PROJECT
    lib.delete("projects", "PULSE")
    assert lib.listing()["projects"] == []


def test_refuses_wrong_documents_and_names(lib):
    with pytest.raises(LibraryError):
        lib.write("projects", "x", SHOW)  # un show n'est pas un projet
    with pytest.raises(LibraryError):
        lib.write("backups", "x", b"not sysex")
    for bad in ("../evil", "a/b", ".hidden", "", "x" * 81):
        with pytest.raises(LibraryError):
            lib.write("projects", bad, PROJECT)
    with pytest.raises(LibraryError) as e:
        lib.read("nope", "x")
    assert e.value.code == 404
    lib.write("projects", "A", PROJECT)
    with pytest.raises(LibraryError) as e:
        lib.write("projects", "A", PROJECT, replace=False)
    assert e.value.code == 409


def test_rename_and_duplicate(lib):
    lib.write("projects", "A", PROJECT)
    assert lib.duplicate("projects", "A") == "A copy"
    assert lib.duplicate("projects", "A") == "A copy 2"
    lib.rename("projects", "A copy", "B")
    assert [i["name"] for i in lib.listing()["projects"]] == ["A", "A copy 2", "B"]
    with pytest.raises(LibraryError):
        lib.rename("projects", "B", "A")


def test_play_follows_the_played_show(lib):
    lib.write("shows", "Saturday", SHOW)
    lib.play("Saturday")
    assert lib.show_file.read_bytes() == SHOW and lib.playing() == "Saturday"
    with pytest.raises(LibraryError):
        lib.delete("shows", "Saturday")  # joué : on ne le supprime pas
    lib.rename("shows", "Saturday", "Sunday")
    assert lib.playing() == "Sunday"
    newer = SHOW.replace(b'"1"', b'"2"')
    lib.write("shows", "Sunday", newer)
    assert lib.show_file.read_bytes() == newer  # le show joué est remplacé aussi
    lib.show_posted()
    assert lib.playing() is None


def test_versions_of_a_set_and_saves_from_two_screens(tmp_path, monkeypatch):
    """Chaque enregistrement garde la version remplacée (espacées de 5 min) ; un écran qui enregistre sur une
    version que quelqu'un d'autre a changée entre-temps est refusé au lieu d'écraser son travail."""
    import json
    import os

    import es8stage.server.library as L

    lib = L.Library(tmp_path / "library", tmp_path / "show.json")
    doc = lambda n: json.dumps({"schema": "es8ctl.project/1", "n": n}).encode()  # noqa: E731
    lib.write("projects", "Set", doc(1))
    p = lib.path("projects", "Set")
    os.utime(p, (1_000_000, 1_000_000))
    v1 = L.Library.etag(doc(1))
    lib.write("projects", "Set", doc(2), base=v1)
    assert [json.loads(lib.history_read("Set", h["id"]))["n"] for h in lib.history("Set")] == [1]
    with pytest.raises(L.LibraryError) as exc:
        lib.write("projects", "Set", doc(3), base=v1)  # l'autre écran avait ouvert la version 1
    assert exc.value.code == 412
    os.utime(p, (1_000_000 + 100, 1_000_000 + 100))
    lib.write("projects", "Set", doc(3))  # la version 2 n'a vécu que 100 s après la 1 gardée : pas gardée
    assert len(lib.history("Set")) == 1
    os.utime(p, (1_000_000 + 400, 1_000_000 + 400))
    lib.write("projects", "Set", doc(4), base=L.Library.etag(doc(3)))
    assert [json.loads(lib.history_read("Set", h["id"]))["n"] for h in lib.history("Set")] == [3, 1]
    lib.rename("projects", "Set", "Gig")
    assert len(lib.history("Gig")) == 2 and lib.history("Set") == []
    with pytest.raises(L.LibraryError):
        lib.history_read("Gig", "../../show")

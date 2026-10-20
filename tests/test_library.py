"""Bibliothèque de sets (es8ctl web) : projets, shows, sauvegardes ; le show joué."""

import json

import pytest

from es8ctl.library import Library, LibraryError

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

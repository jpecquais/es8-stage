"""La Companion côté hôte de scène (Pi) : la même logique que `web/companion/show.js`.

Spéc : `docs/stage-host.md`. Pur, sans MIDI ni réseau : le service
(`es8stage serve --stage`) s'en sert pour tenir la position et l'état des
switches, et décider quoi envoyer. Les deux implémentations sont vérifiées
sur les mêmes cas (`tests/test_stage.py`) pour ne pas diverger.

Position : {"setlist": k, "step": i} ; le pas i se joue en envoyant le PC i
(précédé de Bank Select CC0 = banque MIDI de la setlist). Un favori (`show.favorites`) se joue
hors setlist : son patch est rappelé directement (commande de sélection de l'ES-8) ; la position
dans la setlist ne bouge pas et le prochain pas joué l'efface.
"""

from __future__ import annotations

SCHEMA = "es8ctl.show/1"
MIDI_BANKS = 7
NAV_ACTIONS = ("next", "prev", "next_song", "prev_song", "song_start")


def check_show(doc) -> list[str]:
    """Vérification légère d'un show (comme `checkShow`) : vide = utilisable."""
    if not isinstance(doc, dict):
        return ["Not a JSON object."]
    problems = []
    if doc.get("schema") != SCHEMA:
        problems.append(f'"schema" must be "{SCHEMA}".')
    setlists = doc.get("setlists")
    if not isinstance(setlists, list) or not setlists:
        problems.append('"setlists": expected at least one setlist.')
        setlists = []
    rigs = doc.get("rigs") or {}
    for k, sl in enumerate(setlists):
        if not isinstance(sl.get("songs"), list) or not sl.get("steps"):
            problems.append(f'setlists[{k}]: expected "songs" and at least one step.')
            continue
        for s, sg in enumerate(sl["songs"]):
            if sg.get("rig") not in rigs:
                problems.append(f"setlists[{k}].songs[{s}]: unknown rig {sg.get('rig')!r}.")
    return problems


def is_playable(setlist: dict) -> bool:
    bank = setlist.get("midi_bank")
    return isinstance(bank, int) and 0 <= bank < MIDI_BANKS


def start_position(show: dict) -> dict:
    k = next((i for i, sl in enumerate(show["setlists"]) if is_playable(sl)), 0)
    return {"setlist": k, "step": 0}


def valid_position(show: dict, pos) -> dict:
    try:
        sl = show["setlists"][pos["setlist"]]
        if is_playable(sl) and 0 <= pos["step"] < len(sl["steps"]):
            return {"setlist": pos["setlist"], "step": pos["step"]}
    except (TypeError, KeyError, IndexError):
        pass
    return start_position(show)


def follow_position(old: dict | None, pos, new: dict) -> dict:
    """La place dans `new` qui correspond à `pos` dans `old` : même setlist (banque MIDI), même morceau (nom),
    même pas dans le morceau ; sinon le début de la setlist, ou du show."""
    try:
        sl = old["setlists"][pos["setlist"]]
        step = sl["steps"][pos["step"]]
        song = sl["songs"][step["song"]]
        within = pos["step"] - song["first_step"]
    except (TypeError, KeyError, IndexError):
        return start_position(new)
    for k, s in enumerate(new["setlists"]):
        if s["midi_bank"] != sl["midi_bank"]:
            continue
        for so in s["songs"]:
            if so["name"] == song["name"]:
                return valid_position(new, {"setlist": k, "step": so["first_step"] + min(within, so["steps"] - 1)})
        return valid_position(new, {"setlist": k, "step": 0})
    return start_position(new)


def _parts(show: dict, pos: dict):
    sl = show["setlists"][pos["setlist"]]
    step = sl["steps"][pos["step"]]
    song = sl["songs"][step["song"]]
    return sl, step, song, show["rigs"][song["rig"]]


def move(show: dict, pos: dict, action: str) -> dict | None:
    """Position après une action de navigation, ou None aux bouts de la setlist (comme `move`)."""
    sl, step, _, _ = _parts(show, pos)
    songs, i = sl["songs"], step["song"]
    if action == "next":
        target = pos["step"] + 1
    elif action == "prev":
        target = pos["step"] - 1
    elif action == "next_song":
        target = songs[i + 1]["first_step"] if i + 1 < len(songs) else -1
    elif action == "prev_song":
        target = songs[i - 1]["first_step"] if i > 0 else -1
    elif action == "song_start":
        target = songs[i]["first_step"]
    else:
        return None
    if target < 0 or target >= len(sl["steps"]) or target == pos["step"]:
        return None
    return {"setlist": pos["setlist"], "step": target}


def played(step: dict, index: int, backup: bool) -> dict:
    """Ce que joue un pas : son PC, ou celui de son secours en mode backup (s'il en a un)."""
    if backup and step.get("backup"):
        b = step["backup"]
        return {"pc": b["pc"], "label": b["label"], "snapshot": b["snapshot"], "rig": b["rig"], "backup": True}
    return {"pc": index, "label": step["label"], "snapshot": step["snapshot"], "backup": False}


def step_messages(channel: int, midi_bank: int, pc: int) -> list[list[int]]:
    """Bank Select CC0 = banque MIDI, puis PC, sur le canal de l'ES-8 (1–16)."""
    ch = (channel - 1) & 0x0F
    return [[0xB0 | ch, 0, midi_bank & 0x7F], [0xC0 | ch, pc & 0x7F]]


def switch_from_midi(show: dict, data) -> dict | None:
    """Message MIDI → {key, press} si c'est le CC d'un switch de l'ES-8 (`controls`)."""
    c = show.get("controls") if show else None
    if not c or not data or len(data) < 3 or data[0] & 0xF0 != 0xB0 or (data[0] & 0x0F) + 1 != c["channel"]:
        return None
    key = next((k for k, cc in c["switches"].items() if cc == data[1]), None)
    return {"key": key, "press": data[2] > 0} if key else None


def start_states(show: dict, pos: dict) -> dict:
    """État des paramètres de la surface à l'arrivée sur un pas : celui que le patch a envoyé."""
    _, step, _, rig = _parts(show, pos)
    return dict((rig.get("states") or {}).get(step["snapshot"]) or {})


def switch_is_on(sw: dict, states: dict) -> bool:
    if sw.get("role") != "param":
        return False
    v = states.get(sw["param"], sw["off"])
    return v == sw["on"] if sw.get("exact") else v != sw["off"]


def _cc(sw: dict, value: int) -> list[int]:
    return [0xB0 | ((sw["channel"] - 1) & 0x0F), sw["cc"] & 0x7F, value & 0x7F]


def press_switch(show: dict, pos: dict, key: str, press: bool, states: dict) -> dict | None:
    """Appui ou relâchement d'un switch (comme `pressSwitch`) :
    {action} ; {states, messages, on, label} pour un paramètre (bascule, momentané, groupe, cran) ; ou None."""
    _, _, _, rig = _parts(show, pos)
    every = (rig.get("surface") or {}).get("switches") or {}
    sw = every.get(key)
    if not sw:
        return None
    if sw["role"] == "companion":
        return {"action": sw["target"], "label": sw["label"]} if press else None
    if sw["role"] != "param":
        return None
    if sw.get("mode") == "momentary":
        value = sw["on"] if press else sw["off"]
    elif not press:
        return None
    else:
        value = sw["off"] if switch_is_on(sw, states) else sw["on"]
    nxt = {**states, sw["param"]: value}
    messages = [_cc(sw, value)]
    on = value != sw["off"]
    if on and sw.get("group"):
        for k, o in every.items():
            if (k == key or o.get("role") != "param" or o.get("group") != sw["group"]
                    or o["param"] == sw["param"] or not switch_is_on(o, nxt)):
                continue
            nxt[o["param"]] = o["off"]
            messages.append(_cc(o, o["off"]))
    return {"states": nxt, "messages": messages, "on": on, "label": sw["label"]}


class Stage:
    """L'état de scène et ses règles ; `send(bytes)` envoie un message MIDI, `changed()` prévient les écrans.

    Les méthodes rendent la liste des messages envoyés (utile aux tests).
    """

    def __init__(self, send=lambda data: None, changed=lambda: None):
        self.send, self.changed = send, changed
        self.show: dict | None = None
        self.pos: dict | None = None
        self.states: dict = {}
        self.backup = False
        self.traffic = {"in": "", "action": "", "out": ""}
        self.move = {"n": 0, "dir": ""}
        self.channel = 0  # 0 = celui du show
        self.sent_ok = True
        self.favorite: int | None = None  # favori joué (indice dans show.favorites), sinon la setlist

    # ---------------------------------------------------------------- show et position
    def load(self, show: dict, pos=None) -> None:
        self.show = show
        self.favorite = None
        self.pos = valid_position(show, pos)
        self.states = start_states(show, self.pos)
        self.changed()

    def es8_channel(self) -> int:
        return self.channel or ((self.show or {}).get("es8") or {}).get("rx_channel") or 1

    def _emit(self, messages) -> list[list[int]]:
        """Envoie ; `send` peut rendre False (pas de sortie MIDI) : le trafic affiché le dit."""
        self.sent_ok = all([self.send(m) is not False for m in messages])
        return messages

    def send_step(self) -> list[list[int]]:
        self.favorite = None
        sl = self.show["setlists"][self.pos["setlist"]]
        play = played(sl["steps"][self.pos["step"]], self.pos["step"], self.backup)
        sent = self._emit(step_messages(self.es8_channel(), sl["midi_bank"], play["pc"]))
        bank = f"bank {sl['midi_bank']} · " if sl["midi_bank"] else ""
        self.traffic["out"] = (f"{bank}PC {play['pc']}{' · backup' if play['backup'] else ''}" if self.sent_ok
                               else "not sent: ES-8 not connected")
        return sent

    def _arrive(self, pos: dict, direction: str) -> list[list[int]]:
        self.pos = pos
        self.states = start_states(self.show, pos)
        self.move = {"n": self.move["n"] + 1, "dir": direction}
        return self.send_step()

    # ---------------------------------------------------------------- gestes
    def act(self, action: str, source: str = "screen") -> list[list[int]]:
        if not self.show:
            return []
        if action == "backup":
            self.backup = not self.backup
            self.traffic.update({"in": source, "action": "Backup on" if self.backup else "Backup off"})
            sent = self.send_step()
            self.changed()
            return sent
        p = move(self.show, self.pos, action)
        self.traffic.update({"in": source, "action": action.replace("_", " ").capitalize() + ("" if p else " · end")})
        if not p:
            self.move = {"n": self.move["n"] + 1, "dir": "end"}
            self.changed()
            return []
        sent = self._arrive(p, action)
        self.changed()
        return sent

    def goto(self, setlist: int, step: int) -> list[list[int]]:
        if not self.show:
            return []
        pos = valid_position(self.show, {"setlist": setlist, "step": step})
        self.traffic.update({"in": "screen", "action": f"Step {pos['step'] + 1}"})
        sent = self._arrive(pos, "jump")
        self.changed()
        return sent

    def play_favorite(self, index: int) -> list[list[int]]:
        """Rappelle le patch d'un favori (mode éditeur, sélection, fin du mode éditeur)."""
        favorites = (self.show or {}).get("favorites") or []
        if not 0 <= index < len(favorites):
            return []
        from es8core.live import select

        fav = favorites[index]
        sent = self._emit([list(m) for m in select(fav["label"]).messages])
        self.favorite = index
        self.traffic = {"in": "screen", "action": f"Favorite · {fav['name']}",
                        "out": f"patch {fav['label']}" if self.sent_ok else "not sent: ES-8 not connected"}
        self.changed()
        return sent

    def press(self, key: str, down: bool, source: str | None = None) -> list[list[int]]:
        if not self.show:
            return []
        r = press_switch(self.show, self.pos, key, down, self.states)
        if not r:
            return []
        if "action" in r:
            return self.act(r["action"], source or key)
        self.states = r["states"]
        sent = self._emit(r["messages"])
        m = r["messages"][0]
        more = f" (+{len(r['messages']) - 1} off)" if len(r["messages"]) > 1 else ""
        self.traffic = {"in": source or key, "action": f"{r['label']} {'on' if r['on'] else 'off'}",
                        "out": f"ch {(m[0] & 0x0F) + 1} · CC{m[1]} = {m[2]}{more}" if self.sent_ok
                        else "not sent: ES-8 not connected"}
        self.changed()
        return sent

    def midi_in(self, data) -> list[list[int]]:
        """Message reçu de l'ES-8 : un CC de switch devient un appui ; le reste est ignoré (échos, PC)."""
        sw = switch_from_midi(self.show, list(data))
        return self.press(sw["key"], sw["press"]) if sw else []

    def snapshot(self) -> dict:
        """Ce que les écrans affichent."""
        return {"show": self.show, "pos": self.pos, "states": self.states, "backup": self.backup,
                "traffic": self.traffic, "move": self.move, "channel": self.es8_channel(), "favorite": self.favorite}

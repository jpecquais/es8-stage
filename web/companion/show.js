// ES8 Companion — logique pure (sans DOM ni MIDI), testée sous Node.
// Spéc : docs/companion.md. Le show (`es8ctl.show/1`) est calculé par la
// lib Python ; ici on ne fait que le parcourir : la position est
// { setlist, step }, et le pas i se joue en envoyant le PC i.

export const SCHEMA = "es8ctl.show/1";

export const ACTIONS = [
  { id: "next", label: "Next" },
  { id: "prev", label: "Previous" },
  { id: "next_song", label: "Next song" },
  { id: "prev_song", label: "Previous song" },
  { id: "song_start", label: "Song start" },
  { id: "backup", label: "Backup on / off" },
];
export const actionLabel = (id) => (ACTIONS.find((a) => a.id === id) || { label: id }).label;

// La pc_map a 7 banques MIDI (une setlist chacune), choisies par Bank Select CC0
// (vérifié sur l'ES-8 le 2026-10-19 ; CC32 est ignoré).
export const MIDI_BANKS = 7;

// ---------------------------------------------------------------- le show

/** Vérification légère d'un show chargé : liste des problèmes (vide = utilisable). */
export function checkShow(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") return ["Not a JSON object."];
  if (doc.schema !== SCHEMA) problems.push(`"schema" must be "${SCHEMA}".`);
  if (!Array.isArray(doc.setlists) || !doc.setlists.length) problems.push('"setlists": expected at least one setlist.');
  const rigs = doc.rigs || {};
  (doc.setlists || []).forEach((sl, k) => {
    const at = `setlists[${k}]`;
    if (!Array.isArray(sl.songs) || !Array.isArray(sl.steps) || !sl.steps.length) {
      problems.push(`${at}: expected "songs" and at least one step.`);
      return;
    }
    if (sl.steps.length > 128) problems.push(`${at}: ${sl.steps.length} steps, 128 at most.`);
    sl.steps.forEach((st, i) => {
      if (!sl.songs[st.song]) problems.push(`${at}.steps[${i}]: unknown song ${st.song}.`);
    });
    sl.songs.forEach((sg, s) => {
      if (!rigs[sg.rig]) problems.push(`${at}.songs[${s}]: unknown rig ${JSON.stringify(sg.rig)}.`);
    });
  });
  return problems;
}

export const isPlayable = (setlist) => Number.isInteger(setlist.midi_bank) && setlist.midi_bank >= 0 && setlist.midi_bank < MIDI_BANKS;

/** Première setlist jouable, à son premier pas. */
export function startPosition(show) {
  const k = show.setlists.findIndex(isPlayable);
  return { setlist: Math.max(0, k), step: 0 };
}

/** Position encore valable pour ce show, sinon le départ. */
export function validPosition(show, pos) {
  const sl = pos && show.setlists[pos.setlist];
  if (sl && isPlayable(sl) && Number.isInteger(pos.step) && pos.step >= 0 && pos.step < sl.steps.length) return pos;
  return startPosition(show);
}

/** Tout ce que l'écran affiche pour une position. */
export function view(show, pos) {
  const sl = show.setlists[pos.setlist];
  const step = sl.steps[pos.step];
  const song = sl.songs[step.song];
  const posInSong = pos.step - song.first_step;
  const at = (i) => (i >= 0 && i < sl.steps.length ? { index: i, ...sl.steps[i] } : null);
  const prev = at(pos.step - 1);
  const next = at(pos.step + 1);
  const nextSong = sl.songs[step.song + 1] || null;
  return {
    setlist: sl,
    step: { index: pos.step, ...step },
    song,
    songIndex: step.song,
    posInSong,
    rig: show.rigs[song.rig],
    strip: sl.steps.slice(song.first_step, song.first_step + song.steps).map((st, j) => ({
      index: song.first_step + j,
      snapshot: st.snapshot,
      state: j < posInSong ? "done" : j === posInSong ? "current" : j === posInSong + 1 ? "next" : "later",
    })),
    prev,
    next,
    nextIsNewSong: !!next && next.song !== step.song,
    nextSong,
    programs: (show.rigs[song.rig].snapshot_programs || {})[step.snapshot] || show.rigs[song.rig].programs || [],
    bank: bankPatches(show, step.patch),
  };
}

/** Les 8 patchs de la banque d'un patch (NUM1–8 en mode patch) : libellé et snapshot connu du show. */
export function bankPatches(show, patch) {
  const bank = Math.floor(patch / 8);
  const names = {};
  Object.values(show.rigs).forEach((rig) => (rig.patches || []).forEach((l, i) => { names[l] = rig.snapshots[i]; }));
  return {
    bank,
    patches: Array.from({ length: 8 }, (_, k) => {
      const label = `${bank}-${k + 1}`;
      return { label, snapshot: names[label] || null, current: bank * 8 + k === patch };
    }),
  };
}

/** Position après une action, ou null s'il n'y a rien à faire (bout de la setlist). */
export function move(show, pos, action) {
  const sl = show.setlists[pos.setlist];
  const songIndex = sl.steps[pos.step].song;
  let step;
  if (action === "next") step = pos.step + 1;
  else if (action === "prev") step = pos.step - 1;
  else if (action === "next_song") step = sl.songs[songIndex + 1] ? sl.songs[songIndex + 1].first_step : -1;
  else if (action === "prev_song") step = songIndex > 0 ? sl.songs[songIndex - 1].first_step : -1;
  else if (action === "song_start") step = sl.songs[songIndex].first_step;
  else return null;
  if (step < 0 || step >= sl.steps.length || step === pos.step) return null;
  return { setlist: pos.setlist, step };
}

/** Aller au premier pas d'un morceau, ou à un pas donné. */
export const goToSong = (show, setlist, song) => ({ setlist, step: show.setlists[setlist].songs[song].first_step });

// ---------------------------------------------------------------- MIDI

/**
 * Messages qui rappellent un pas, sur le canal de réception de l'ES-8 (1–16) :
 * Bank Select CC0 = banque MIDI de la setlist, puis PC = pas. Le CC0 part à
 * chaque fois : un autre contrôleur a pu changer de banque entre-temps.
 */
/** Ce que joue un pas : son PC et son patch, ou ceux de son secours en mode backup (s'il en a un). */
export function played(step, index, backup) {
  if (backup && step.backup) return { pc: step.backup.pc, label: step.backup.label, snapshot: step.backup.snapshot, rig: step.backup.rig, backup: true };
  return { pc: index, label: step.label, snapshot: step.snapshot, backup: false };
}

// ---------------------------------------------------------------- switches de l'ES-8 (docs/companion.md, v2)
// Chaque switch envoie un CC fixe (show.controls) ; la Companion lit son rôle dans le rig du pas en cours,
// tient l'état des paramètres et envoie leurs CC aux machines.

/** Message MIDI → {key, press} si c'est le CC d'un switch de l'ES-8, sinon null. */
export function switchFromMidi(show, data) {
  const c = show && show.controls;
  if (!c || !data || data.length < 3 || (data[0] & 0xf0) !== 0xb0 || (data[0] & 0x0f) + 1 !== c.channel) return null;
  const key = Object.keys(c.switches).find((k) => c.switches[k] === data[1]);
  return key ? { key, press: data[2] > 0 } : null;
}

/** État des paramètres de la surface à l'arrivée sur un pas : celui que le patch a envoyé. */
export function startStates(show, pos) {
  const v = view(show, pos);
  return { ...((v.rig.states || {})[v.step.snapshot] || {}) };
}

/**
 * Le paramètre d'un switch est-il allumé dans `states` ? Un cran (`exact`, plusieurs switches sur un
 * même paramètre) l'est quand le paramètre vaut exactement sa valeur ; sinon, dès qu'il n'est pas à off.
 */
export function switchIsOn(sw, states) {
  if (sw.role !== "param") return false;
  const v = states[sw.param] ?? sw.off;
  return sw.exact ? v === sw.on : v !== sw.off;
}

const ccMessage = (sw, value) => [0xb0 | ((sw.channel - 1) & 0x0f), sw.cc & 0x7f, value & 0x7f];

/**
 * Appui (ou relâchement) d'un switch → ce qu'il faut faire, ou null :
 * {action} pour une action de navigation ; {states, messages, on} pour un paramètre.
 * - momentané : on à l'appui, off au relâchement ;
 * - bascule : allumé → off, éteint → sa valeur on (pour un cran : choisir ce cran) ;
 * - groupe : allumer un switch éteint les autres switches allumés du même groupe (sur d'autres
 *   paramètres ; sur le même paramètre, choisir un cran suffit à éteindre les autres).
 */
export function pressSwitch(show, pos, key, press, states) {
  const rig = view(show, pos).rig;
  const all = (rig.surface && rig.surface.switches) || {};
  const sw = all[key];
  if (!sw) return null;
  if (sw.role === "companion") return press ? { action: sw.target, label: sw.label } : null;
  if (sw.role !== "param") return null;
  let value;
  if (sw.mode === "momentary") value = press ? sw.on : sw.off;
  else if (!press) return null;
  else value = switchIsOn(sw, states) ? sw.off : sw.on;
  const next = { ...states, [sw.param]: value };
  const messages = [ccMessage(sw, value)];
  const on = value !== sw.off;
  if (on && sw.group) {
    Object.entries(all).forEach(([k, o]) => {
      if (k === key || o.role !== "param" || o.group !== sw.group || o.param === sw.param || !switchIsOn(o, next)) return;
      next[o.param] = o.off;
      messages.push(ccMessage(o, o.off));
    });
  }
  return { states: next, messages, message: messages[0], on, label: sw.label };
}

export const stepMessages = (channel, midiBank, step) => {
  const ch = (channel - 1) & 0x0f;
  return [0xb0 | ch, 0, midiBank & 0x7f, 0xc0 | ch, step & 0x7f];
};

/**
 * Message MIDI reçu → événement d'entrée, ou null s'il n'en est pas un.
 * Les PC ne sont jamais des entrées : ce sont ceux que la Companion envoie
 * (écho d'un ES-8 en Thru). Horloge, active sensing et SysEx sont ignorés.
 */
export function eventFromMidi(data) {
  if (!data || data.length < 3) return null;
  const kind = data[0] & 0xf0;
  const channel = (data[0] & 0x0f) + 1;
  if (kind === 0xb0) return { type: "cc", channel, number: data[1], press: data[2] > 0 };
  if (kind === 0x90) return { type: "note", channel, number: data[1], press: data[2] > 0 };
  if (kind === 0x80) return { type: "note", channel, number: data[1], press: false };
  return null;
}

export const eventFromKey = (key) => ({ type: "key", key, press: true });

export const sameMessage = (a, b) =>
  a.type === b.type && (a.type === "key" ? a.key === b.key : a.channel === b.channel && a.number === b.number);

/** Action liée à un événement, seulement à l'appui. */
export function actionFor(bindings, event) {
  if (!event || !event.press) return null;
  const hit = bindings.find((b) => sameMessage(b, event));
  return hit ? hit.action : null;
}

/** Apprentissage : le message rejoint l'action et quitte toute autre action. */
export function learn(bindings, action, event) {
  const message = event.type === "key"
    ? { type: "key", key: event.key }
    : { type: event.type, channel: event.channel, number: event.number };
  return [...bindings.filter((b) => !sameMessage(b, message)), { action, ...message }];
}

export const clearAction = (bindings, action) => bindings.filter((b) => b.action !== action);

export function describeBinding(b) {
  if (b.type === "key") return `Key ${KEY_NAMES[b.key] || b.key}`;
  return `${b.type === "cc" ? "CC" : "Note"} ${b.number} · ch ${b.channel}`;
}
const KEY_NAMES = { ArrowRight: "→", ArrowLeft: "←", ArrowUp: "↑", ArrowDown: "↓", PageDown: "Page Down", PageUp: "Page Up", " ": "Space" };

// Pédales tourne-page : elles envoient le plus souvent ces touches.
export const DEFAULT_KEY_BINDINGS = [
  { action: "next", type: "key", key: "ArrowRight" },
  { action: "next", type: "key", key: "PageDown" },
  { action: "prev", type: "key", key: "ArrowLeft" },
  { action: "prev", type: "key", key: "PageUp" },
];

/** Table de départ : le préréglage du show (s'il y en a un) et les touches usuelles. */
export function presetBindings(show) {
  const preset = ((show && show.input_preset && show.input_preset.bindings) || [])
    .filter((b) => ACTIONS.some((a) => a.id === b.action) && (b.type === "cc" || b.type === "note"))
    .map((b) => ({ action: b.action, type: b.type, channel: b.channel, number: b.number }));
  return [...preset, ...DEFAULT_KEY_BINDINGS];
}

/** Anti-rebond : un même message reçu deux fois en moins de `ms` ne compte qu'une fois. */
export function makeDebounce(ms = 120) {
  let last = null;
  return (event, now) => {
    if (last && sameMessage(last.event, event) && now - last.at < ms) return false;
    last = { event, at: now };
    return true;
  };
}

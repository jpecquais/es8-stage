// ES8 Companion — ce que l'écran affiche d'un show (sans DOM), testé sous Node. Spéc : docs/companion.md.
// Le jeu (déplacements, switches, messages MIDI) est tenu par l'hôte de scène, en Python
// (`es8stage.stage`) : ici, seulement la lecture du show pour l'affichage, et les touches du clavier
// (pédales tourne-page) qui deviennent des actions envoyées à l'hôte.

export const SCHEMA = "es8ctl.show/1";

export const ACTIONS = [
  { id: "next", label: "Next" },
  { id: "prev", label: "Previous" },
  { id: "next_song", label: "Next song" },
  { id: "prev_song", label: "Previous song" },
  { id: "song_start", label: "Song start" },
  { id: "backup", label: "Backup on / off" },
];

// La pc_map a 7 banques MIDI (une setlist chacune), choisies par Bank Select CC0.
export const MIDI_BANKS = 7;

// ---------------------------------------------------------------- le show

export const isPlayable = (setlist) => Number.isInteger(setlist.midi_bank) && setlist.midi_bank >= 0 && setlist.midi_bank < MIDI_BANKS;

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

/** Aller au premier pas d'un morceau, ou à un pas donné. */
export const goToSong = (show, setlist, song) => ({ setlist, step: show.setlists[setlist].songs[song].first_step });

/** Ce que joue un pas : son PC et son patch, ou ceux de son secours en mode backup (s'il en a un). */
export function played(step, index, backup) {
  if (backup && step.backup) return { pc: step.backup.pc, label: step.backup.label, snapshot: step.backup.snapshot, rig: step.backup.rig, backup: true };
  return { pc: index, label: step.label, snapshot: step.snapshot, backup: false };
}

// ---------------------------------------------------------------- switches de l'ES-8 (docs/companion.md, v2)

/**
 * Le paramètre d'un switch est-il allumé dans `states` ? Un cran (`exact`, plusieurs switches sur un
 * même paramètre) l'est quand le paramètre vaut exactement sa valeur ; sinon, dès qu'il n'est pas à off.
 */
export function switchIsOn(sw, states) {
  if (sw.role !== "param") return false;
  const v = states[sw.param] ?? sw.off;
  return sw.exact ? v === sw.on : v !== sw.off;
}

// ---------------------------------------------------------------- clavier (pédales tourne-page)

export const eventFromKey = (key) => ({ type: "key", key, press: true });

export const sameMessage = (a, b) => a.type === b.type && a.key === b.key;

/** Action liée à un événement, seulement à l'appui. */
export function actionFor(bindings, event) {
  if (!event || !event.press) return null;
  const hit = bindings.find((b) => sameMessage(b, event));
  return hit ? hit.action : null;
}

/** Apprentissage : le message rejoint l'action et quitte toute autre action. */
export function learn(bindings, action, event) {
  const message = { type: "key", key: event.key };
  return [...bindings.filter((b) => !sameMessage(b, message)), { action, ...message }];
}

export const clearAction = (bindings, action) => bindings.filter((b) => b.action !== action);

export const describeBinding = (b) => `Key ${KEY_NAMES[b.key] || b.key}`;
const KEY_NAMES = { ArrowRight: "→", ArrowLeft: "←", ArrowUp: "↑", ArrowDown: "↓", PageDown: "Page Down", PageUp: "Page Up", " ": "Space" };

// Pédales tourne-page : elles envoient le plus souvent ces touches.
export const DEFAULT_KEY_BINDINGS = [
  { action: "next", type: "key", key: "ArrowRight" },
  { action: "next", type: "key", key: "PageDown" },
  { action: "prev", type: "key", key: "ArrowLeft" },
  { action: "prev", type: "key", key: "PageUp" },
];

// ES8 Designer — édition par intention (Preact + htm, sans compilation). Textes en anglais.
// On décrit le pedalboard, des surfaces, des rigs (N snapshots sur des patchs consécutifs) et
// des setlists ; le moteur Python compile le tout (es8core.model) contre l'état
// lu de l'ES-8. Le projet vit dans ce navigateur et s'exporte en un fichier
// `es8ctl.project/1`, que `es8ctl rig compile` accepte aussi. Rien n'est
// envoyé à l'ES-8 avant « Write ».

import { html, render, useState, useEffect, useRef, useMemo } from "../shared/vendor/preact-htm.module.js";
import * as E from "../shared/engine.js";

const { store, call, mutate, toast } = E;

const PROJECT_KEY = "es8designer.project";
const UI_KEY = "es8designer.ui";
const LOOPS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "LV"];
const NUMS = ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8"];
const BOARD = [["MEM_M", "MUTE", "BANK_D", "BANK_U", "NUM7", "NUM8"], ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6"]];
const JACKS = ["CTL_IN_1", "CTL_IN_2", "CTL_IN_3", "CTL_IN_4"];
const SWITCH_NAME = { MEM_M: "MEM/MAN", BANK_D: "BANK ▼", BANK_U: "BANK ▲", CTL_IN_1: "CTL IN 1", CTL_IN_2: "CTL IN 2", CTL_IN_3: "CTL IN 3", CTL_IN_4: "CTL IN 4" };
const CTL_FUNCTIONS = ["OFF", "MEM_M", "MUTE", "BANK_D", "BANK_U", "MEM_U", "MEM_D", "NUM_1", "NUM_2", "NUM_3", "NUM_4",
  "NUM_5", "NUM_6", "NUM_7", "NUM_8", "CTL_1", "CTL_2", "CTL_3", "CTL_4", "CTL_5", "CTL_6", "BPM"];
const PC_MODES = [["none", "No program change"], ["pc", "PC"], ["bank_msb_pc", "Bank MSB + PC"], ["bank_lsb_pc", "Bank LSB + PC"], ["bank_msb_lsb_pc", "Bank MSB + LSB + PC"]];
const NAME_LEN = 16;
// Actions de ES8 Companion (docs/companion.md) : rôle `companion` d'un switch. Chacune envoie son CC sur le
// canal de la Companion (réglage du projet `companion`, 16 et CC 80… par défaut).
// Switches MIDI et Companion : chacun envoie un CC fixe (premier CC + rang du switch) à ES8 Companion,
// qui tient la logique (docs/companion.md, « Les switches de l'ES-8 »).
const SWITCH_ORDER = ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8", "MEM_M", "MUTE", "BANK_D", "BANK_U", "CTL_IN_1", "CTL_IN_2", "CTL_IN_3", "CTL_IN_4"];
const COMPANION_DEFAULT = { channel: 16, first_cc: 80, es8_channel: 1 };
const companionOf = (doc) => ({ channel: (doc.companion || {}).channel || COMPANION_DEFAULT.channel,
  first_cc: (doc.companion || {}).first_cc ?? COMPANION_DEFAULT.first_cc,
  es8_channel: (doc.companion || {}).es8_channel || COMPANION_DEFAULT.es8_channel });
const switchCC = (c, key) => c.first_cc + SWITCH_ORDER.indexOf(key);
const COMPANION_ACTIONS = [["next", "Next step"], ["prev", "Previous step"], ["next_song", "Next song"], ["prev_song", "Previous song"], ["song_start", "Song start"], ["backup", "Backup on / off"]];
const PATCHES = 800;
const MAX_ASSIGNS = 12;

const swName = (key) => SWITCH_NAME[key] || key;
const patchAt = (n) => `${Math.floor(n / 8)}-${(n % 8) + 1}`;
const parseLabel = (text) => {
  const m = /^\s*(\d{1,2})\s*-\s*([1-8])\s*$/.exec(String(text));
  return m ? Number(m[1]) * 8 + Number(m[2]) - 1 : null;
};
// Rig v2 : premier patch `start` (numéro ou « 12-5 ») ; v1 : `bank`.
const rigStart = (rig) => (rig.schema === "es8ctl.rig/1" ? rig.bank * 8 : typeof rig.start === "string" ? parseLabel(rig.start) ?? 0 : rig.start ?? 0);
const patchOf = (rig, i) => patchAt(rigStart(rig) + i);
const rigRange = (rig) => (rig.snapshots.length > 1 ? `${patchOf(rig, 0)} … ${patchOf(rig, rig.snapshots.length - 1)}` : patchOf(rig, 0));
/** Premier patch libre où tiennent `size` patchs, hors du rig `except`. */
function freeStart(doc, size, except) {
  const used = new Set();
  Object.entries(doc.rigs || {}).forEach(([id, r]) => {
    if (id === except) return;
    for (let i = 0; i < r.snapshots.length; i++) used.add(rigStart(r) + i);
  });
  for (let n = 0; n + size <= PATCHES; n++) {
    let fits = true;
    for (let i = 0; i < size && fits; i++) fits = !used.has(n + i);
    if (fits) return n;
  }
  return null;
}
/** Rigs dont les patchs recouvrent ceux du rig `rid`. */
function overlaps(doc, rid) {
  const rig = doc.rigs[rid];
  const a = rigStart(rig), b = a + rig.snapshots.length;
  return Object.entries(doc.rigs).filter(([id, r]) => id !== rid && rigStart(r) < b && a < rigStart(r) + r.snapshots.length).map(([, r]) => r);
}
const loopNumber = (l) => (l === "LV" ? "V" : l.slice(1));
const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
const slug = (text, taken) => {
  const base = (text || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
};
/** Noms écrits dans les patchs d'un rig (16 caractères, raccourcis par le moteur au besoin) : [[nom, auto], …]. */
let engineWarned = false;
const patchNames = (rig) => {
  try { return call("patch_names", JSON.stringify(rig)); } catch {
    // Moteur d'une version antérieure (serveur lancé avant la mise à jour) : le dire plutôt que d'afficher un nom faux.
    if (!engineWarned) { engineWarned = true; setTimeout(() => toast("The ES8 engine in this page is out of date: reload the page (restart es8ctl web if it persists).", "error")); }
    return [];
  }
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ================================================================= projet

const EXAMPLE = {
  schema: "es8ctl.project/1",
  name: "My project",
  pedalboard: {
    schema: "es8ctl.pedalboard/2",
    devices: {
      volume: { name: "Volume pedal", loops: ["LV"] },
      comp: { name: "Compressor", loops: ["L1"] },
      od: { name: "Overdrive", loops: ["L2"] },
      fuzz: { name: "Fuzz", loops: ["L3"] },
      chorus: { name: "Chorus", loops: ["L4"] },
      delay: { name: "Delay pedal", loops: ["L5"] },
      daw: {
        name: "DAW", loops: ["L6"],
        midi: {
          channel: 1, program_change: "pc",
          programs: { clean: { name: "Clean", pc: 3 }, crunch: { name: "Crunch Lead", pc: 12 }, ambient: { name: "Ambient", pc: 20 } },
          params: { drive: { name: "Drive", cc: 18 }, delay: { name: "Delay", cc: 19 }, reverb: { name: "Reverb", cc: 20 } },
        },
      },
      reverb: {
        name: "Reverb pedal", loops: ["L7"],
        midi: { channel: 2, program_change: "pc", programs: { hall: { name: "Hall", pc: 5 }, plate: { name: "Plate", pc: 6 } },
          params: { freeze: { name: "Freeze", cc: 21 } } },
      },
    },
  },
  surfaces: {
    lead: {
      schema: "es8ctl.surface/1", name: "Lead 4 + 4",
      switches: {
        NUM1: { label: "Drive", role: "param", param: "daw.drive", mode: "toggle" },
        NUM2: { label: "Delay", role: "param", param: "daw.delay", mode: "toggle" },
        NUM4: { label: "Freeze", role: "param", param: "reverb.freeze", mode: "momentary" },
        NUM5: { label: "Overdrive", role: "loop", loop: "L2" },
        NUM6: { label: "Fuzz", role: "loop", loop: "L3" },
        NUM8: { label: "Tap", role: "tap" },
      },
    },
  },
  rigs: {
    crunch: {
      schema: "es8ctl.rig/2", name: "Crunch Lead", short: "Crunch", start: "12-1", surface: "lead",
      chain: ["LV", "L1", "L2", "L6", "L5", "L7"],
      programs: { daw: "crunch", reverb: "hall" },
      snapshots: [
        { name: "Verse", loops: ["LV", "L1", "L6", "L7"], params: { "daw.reverb": "on" } },
        { name: "Chorus", loops: ["LV", "L1", "L2", "L6", "L7"], params: { "daw.drive": "on", "daw.reverb": "on" } },
        { name: "Bridge", loops: ["LV", "L5", "L6", "L7"], params: { "daw.delay": "on", "daw.reverb": 90 } },
      ],
    },
  },
  tracks: {
    "first-song": {
      schema: "es8ctl.track/1", name: "First song", rig: "crunch",
      sequence: ["Verse", "Chorus", "Verse", "Chorus", "Bridge", "Chorus"],
    },
    "slow-one": { schema: "es8ctl.track/1", name: "The slow one", rig: "crunch", sequence: ["Verse", "Bridge", "Verse"] },
  },
  setlists: {
    set: {
      schema: "es8ctl.setlist/1", name: "Saturday set", midi_bank: 0,
      songs: [{ track: "first-song" }, { track: "slow-one" }, { track: "first-song" }],
    },
  },
};

const clone = (x) => JSON.parse(JSON.stringify(x));

// Show pour ES8 Companion : téléchargé, et déposé pour la Companion ouverte dans ce navigateur (même origine).
const COMPANION_INBOX = "es8companion/incoming";
function exportShow(doc) {
  const r = call("show_export", JSON.stringify(doc));
  if (r.error) { toast(`No show: ${(r.problems || [r.error]).join(" ")}`, "error"); return; }
  E.download(JSON.stringify(r.show, null, 2), `${slug(doc.name, [])}.show.json`, "application/json");
  try { localStorage.setItem(COMPANION_INBOX, JSON.stringify(r.show)); } catch { /* stockage plein : le fichier suffit */ }
  // Le serveur (es8ctl web, le Pi) le garde comme show courant : toutes les Companion ouvertes le prennent.
  fetch("../stage/show.json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.show) })
    .then((res) => toast(res.ok ? "Show exported and sent to the server: every open ES8 Companion takes it." : "Show exported (file)."))
    .catch(() => toast("Show exported. ES8 Companion in this browser opens it by itself."));
}

/** Les morceaux écrits dans une setlist ({rig, sequence}) deviennent des tracks ; les rigs v1 (une banque) passent en v2. */
function migrate(doc) {
  // Ancien réglage : un CC par action. Le CC dépend maintenant du switch.
  if (doc.companion && doc.companion.cc) doc.companion = { channel: doc.companion.channel || 16, first_cc: 80 };
  // Ancien format : la Companion déclarée comme un appareil MIDI `companion` → rôle `companion` des switches.
  // Un appareil MIDI nommé « … Companion » (déclaré à la main) est converti de la même façon.
  const actionOf = (pid, p) => {
    if (COMPANION_ACTIONS.some(([x]) => x === pid)) return pid;
    const n = `${(p && p.name) || pid}`.toLowerCase();
    if (n.includes("song") && n.includes("next")) return "next_song";
    if (n.includes("song") && n.includes("prev")) return "prev_song";
    if (n.includes("start")) return "song_start";
    if (n.includes("backup")) return "backup";
    if (n.includes("next")) return "next";
    if (n.includes("prev")) return "prev";
    return null;
  };
  Object.entries((doc.pedalboard || {}).devices || {}).forEach(([did, dev]) => {
    if (!dev.midi || !(dev.midi.companion || (/companion/i.test(dev.name || "") && !(dev.loops || []).length))) return;
    const params = dev.midi.params || {};
    const cc = {};
    Object.entries(params).forEach(([pid, p]) => { const a = actionOf(pid, p); if (a && cc[a] === undefined) cc[a] = p.cc; });
    doc.companion = { channel: dev.midi.channel, first_cc: COMPANION_DEFAULT.first_cc };
    Object.values(doc.surfaces || {}).forEach((sf) => Object.entries(sf.switches || {}).forEach(([key, sw]) => {
      if (sw.role !== "param" || !sw.param || sw.param.split(".")[0] !== did) return;
      const action = actionOf(sw.param.split(".")[1], params[sw.param.split(".")[1]]);
      if (action) sf.switches[key] = { ...(sw.label ? { label: sw.label } : {}), role: "companion", action };
      else delete sf.switches[key];
    }));
    Object.values(doc.rigs || {}).forEach((r) => r.snapshots.forEach((sn) => {
      Object.keys(sn.params || {}).forEach((ref) => { if (ref.split(".")[0] === did) delete sn.params[ref]; });
      if (sn.programs) delete sn.programs[did];
    }));
    Object.values(doc.rigs || {}).forEach((r) => { if (r.programs) delete r.programs[did]; });
    Object.values(doc.rigs || {}).forEach((r) => { if (r.devices) r.devices = r.devices.filter((x) => x !== did); });
    delete doc.pedalboard.devices[did];
  });
  Object.values(doc.rigs || {}).forEach((r) => {
    if (r.schema !== "es8ctl.rig/1") return;
    r.schema = "es8ctl.rig/2";
    r.start = `${r.bank}-1`;
    delete r.bank;
  });
  doc.pedalboard = pedalboardV2(doc.pedalboard);
  if (doc.pedalboard) delete doc.pedalboard.name; // plus utilisé : le nom du projet suffit
  doc.tracks = doc.tracks || {};
  Object.values(doc.setlists || {}).forEach((sl) => {
    sl.songs = (sl.songs || []).map((song) => {
      if (song.track) return song;
      const rig = (doc.rigs || {})[song.rig];
      const id = slug(rig ? rig.name : "track", Object.keys(doc.tracks));
      doc.tracks[id] = { schema: "es8ctl.track/1", name: rig ? rig.name : id, rig: song.rig, sequence: song.sequence || [] };
      return { track: id };
    });
  });
  return doc;
}

function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECT_KEY) || "null");
    if (saved && saved.schema === "es8ctl.project/1") return migrate(saved);
  } catch { /* stockage indisponible : exemple */ }
  return clone(EXAMPLE);
}

const projectListeners = new Set();
const project = {
  doc: loadProject(),
  /** Modifie une copie du projet : `edit(doc)` la change sur place. */
  update(edit) {
    const next = clone(this.doc);
    edit(next);
    this.replace(next);
  },
  replace(doc) {
    this.doc = doc;
    try { localStorage.setItem(PROJECT_KEY, JSON.stringify(doc)); } catch { /* confort seulement */ }
    projectListeners.forEach((fn) => fn(doc));
  },
};

function useStore() {
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(setState), []);
  return state;
}

function useProject() {
  const [doc, setDoc] = useState(project.doc);
  useEffect(() => { projectListeners.add(setDoc); return () => projectListeners.delete(setDoc); }, []);
  return doc;
}

function loadUI() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || "{}"); } catch { return {}; }
}
function saveUI(ui) {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* rien */ }
}

/** Pedalboard v2 (appareils) → vue par boucle et par appareil MIDI, comme le moteur Python. */
function pbView(pb) {
  if (!pb || pb.schema !== "es8ctl.pedalboard/2") return pb || { loops: {}, devices: {} };
  const view = { loops: {}, devices: {} };
  Object.entries(pb.devices || {}).forEach(([id, d]) => {
    (d.loops || []).forEach((l) => { if (!view.loops[l]) view.loops[l] = { name: d.name, device: id }; });
    if (d.midi) view.devices[id] = { name: d.name, ...d.midi };
  });
  return view;
}
const pbOf = (doc) => pbView(doc.pedalboard);

/** Pedalboard v1 (boucles et appareils MIDI séparés) → v2 (des appareils). */
function pedalboardV2(pb) {
  if (!pb || pb.schema === "es8ctl.pedalboard/2") return pb;
  const devices = {};
  Object.entries(pb.devices || {}).forEach(([id, d]) => {
    const { name, ...midi } = d;
    devices[id] = { name, loops: [], midi };
  });
  Object.entries(pb.loops || {}).forEach(([l, loop]) => {
    if (!loop) return;
    if (loop.device && devices[loop.device]) devices[loop.device].loops.push(l);
    else devices[slug(loop.name, Object.keys(devices))] = { name: loop.name, loops: [l] };
  });
  return { schema: "es8ctl.pedalboard/2", devices };
}

const allParams = (pb) => Object.entries(pb.devices || {}).flatMap(([did, d]) =>
  Object.entries(d.params || {}).map(([pid, p]) => ({ ref: `${did}.${pid}`, dev: d, did, param: p, pid })));
const wiredLoops = (pb) => LOOPS.filter((l) => pb.loops && pb.loops[l]);
const loopTitle = (pb, l) => (pb.loops && pb.loops[l] ? pb.loops[l].name : "not wired");
/** Le rig se sert-il de cet appareil ? `devices` absent = tous. */
const usesDevice = (rig, pb, did) => !rig.devices || rig.devices.includes(did);
const loopDevice = (pb, l) => (pb.loops && pb.loops[l] ? pb.loops[l].device : null);
const sortedRigs = (doc) => Object.entries(doc.rigs || {}).sort((a, b) => rigStart(a[1]) - rigStart(b[1]));

/** État d'un rig d'après la compilation : bad | missing | diff | sync. */
function rigState(preview, rid, rig) {
  if (!preview) return "";
  if (preview.error) return preview.where === `rig '${rid}'` || (preview.where || "").includes(`'${rid}'`) ? "bad" : "";
  const labels = rig.snapshots.map((_, i) => patchOf(rig, i));
  if (preview.missing) return labels.some((l) => preview.missing.includes(l)) ? "missing" : "";
  return labels.some((l) => preview.patches[l]) ? "diff" : "sync";
}

// ================================================================= application

function App() {
  const s = useStore();
  const doc = useProject();
  const [ui, setUI] = useState(() => ({ tab: "intro", rig: null, track: null, surface: null, setlist: null, ...loadUI() }));
  const go = (patch) => setUI((u) => { const next = { ...u, ...patch }; saveUI(next); return next; });
  const preview = usePreview(s, doc);

  if (!s.ready) {
    return html`<div class="splash">
      <span class="logo">ES8 Designer</span>
      ${s.bootError ? html`<p class="error">The engine could not load: ${s.bootError}</p>`
        : html`<p>Loading the Python engine…</p><div class="spinner"></div>`}
    </div>`;
  }
  const tabs = { intro: IntroTab, pedalboard: PedalboardTab, surfaces: SurfacesTab, rigs: RigsTab, tracks: TracksTab, setlists: SetlistsTab };
  const Tab = tabs[ui.tab] || IntroTab;
  return html`
    <div class="app">
      <${TopBar} s=${s} ui=${ui} go=${go} doc=${doc} />
      <${Tab} s=${s} doc=${doc} ui=${ui} go=${go} preview=${preview} />
      ${s.toast ? html`<div class="toast ${s.toast.kind}" role="status">
        <span>${s.toast.text}</span><button class="x" onClick=${() => store.set({ toast: null })} aria-label="Dismiss">×</button>
      </div>` : null}
    </div>`;
}

/** Compile le projet contre l'ES-8 à chaque changement (projet, lecture, écriture). */
function usePreview(s, doc) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!s.ready) return undefined;
    const timer = setTimeout(() => {
      try { setPreview(call("rig_preview", JSON.stringify(doc))); } catch (err) { setPreview({ error: String(err), problems: [String(err)] }); }
    }, 200);
    return () => clearTimeout(timer);
  }, [s.ready, doc, s.grid, s.summary]);
  return preview;
}

// ================================================================= barre du haut

function TopBar({ s, ui, go, doc }) {
  const tabs = [["intro", "Start"], ["pedalboard", "Pedalboard"], ["surfaces", "Surfaces"], ["rigs", "Rigs"], ["tracks", "Tracks"], ["setlists", "Setlists"]];
  return html`
    <header class="top">
      <span class="logo">ES8 Designer</span>
      <nav class="tabs" role="tablist">
        ${tabs.map(([id, label]) => html`
          <button role="tab" aria-selected=${ui.tab === id} onClick=${() => go({ tab: id })}>${label}</button>`)}
      </nav>
      <span class="grow"></span>
      ${s.busy ? html`<span class="busy"><span>${s.busy.label}</span>
        <progress max=${s.busy.total || 1} value=${s.busy.n}></progress></span>` : null}
      ${s.midi === "ok" && !s.synced && !s.busy ? html`<button class="btn primary" onClick=${E.connect}>Connect to the ES-8</button>` : null}
      <${Menu} s=${s} doc=${doc} />
    </header>`;
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return [open, setOpen, ref];
}

function Menu({ s, doc }) {
  const [open, setOpen, ref] = usePopover();
  const device = E.hasDevice();
  let state = "", text = "No MIDI port";
  if (s.midi === "unsupported") text = "Web MIDI unavailable";
  else if (s.midi === "insecure") text = "No MIDI on this address";
  else if (s.midi === "denied") text = "MIDI access denied";
  else if (device) { state = s.synced ? "on" : ""; text = E.portName(s.out); }
  const source = s.fileName ? s.fileName : s.synced ? "connected" : s.grid && s.grid.source === "cache" ? "last read" : "";
  const importProject = async (file) => {
    try {
      const next = JSON.parse(await file.text());
      if (next.schema !== "es8ctl.project/1") throw new Error("not an ES8 Designer project (es8ctl.project/1)");
      project.replace(migrate(next));
      toast(`${file.name} opened.`, "ok", 3000);
    } catch (err) { toast(`Cannot open this project: ${err.message || err}`, "error"); }
  };
  return html`
    <div class="menu" ref=${ref}>
      <button class="pill ${state}" onClick=${() => setOpen(!open)} aria-expanded=${open}>
        <span class="dot"></span><span>${text}</span>${source ? html`<span class="src">· ${source}</span>` : null}
      </button>
      ${open ? html`<div class="pop">
        ${s.stageHost ? html`<div class="stage-host">
          <b>Stage host</b> <span class="muted small">MIDI goes through the stage host${s.stageHost.connected ? "" : " (ES-8 not connected)"}.</span>
          <label class="check"><input type="checkbox" checked=${s.stageHost.edit} onChange=${(e) => E.setEditMode(e.target.checked)} />
            Edit mode: pause ES8 Companion and allow writing to the ES-8</label>
        </div>` : null}
        ${s.midi === "ok" ? html`
          <label>Output to the ES-8
            <select value=${s.out} onChange=${(e) => E.choosePorts(e.target.value, s.in)}>
              ${s.outputs.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
            </select></label>
          <label>Input from the ES-8
            <select value=${s.in} onChange=${(e) => E.choosePorts(s.out, e.target.value)}>
              ${s.inputs.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
            </select></label>
          <div class="row">
            <button class="btn primary" disabled=${!device || s.busy} onClick=${() => { setOpen(false); E.connect(); }}>Connect</button>
            <button class="btn" disabled=${s.busy} onClick=${() => { setOpen(false); E.findES8(); }}>Find my ES-8</button>
          </div>`
        : html`<p class="muted small">${s.midi === "unsupported"
            ? "This browser has no Web MIDI: use Chrome, Edge or Opera. You can still design and compile against a .syx file."
            : "Allow MIDI access (with SysEx) in the site settings, then reload the page."}</p>`}
        <label class="btn" title="Compile against a file instead of the ES-8">Open a .syx dump<input type="file" accept=".syx" hidden
          onChange=${(e) => { e.target.files[0] && E.openFile(e.target.files[0]); e.target.value = ""; setOpen(false); }} /></label>
        <div class="sep row">
          <b class="grow">Project</b>
          <button class="btn small" onClick=${() => E.download(JSON.stringify(doc, null, 2), `${slug(doc.name, [])}.es8project.json`, "application/json")}
            title="One file for es8ctl rig compile, or to open on another computer">Export</button>
          <button class="btn small" onClick=${() => exportShow(doc)}
            title="The setlists as a show file for ES8 Companion, the stage app">Show</button>
          <label class="btn small">Open<input type="file" accept=".json" hidden
            onChange=${(e) => { e.target.files[0] && importProject(e.target.files[0]); e.target.value = ""; setOpen(false); }} /></label>
        </div>
        <label>Project name<input value=${doc.name || ""} onInput=${(e) => project.update((d) => { d.name = e.target.value; })} /></label>
        <div class="row">
          <button class="link" onClick=${() => { if (confirm("Replace the project with the example?")) project.replace(clone(EXAMPLE)); }}>Load the example</button>
          <button class="link danger" onClick=${() => {
            if (confirm("Start an empty project? The current one is lost unless exported.")) {
              project.replace({ schema: "es8ctl.project/1", name: "New project",
                pedalboard: { schema: "es8ctl.pedalboard/2", devices: {} }, surfaces: {}, rigs: {}, tracks: {}, setlists: {} });
            }
          }}>Start empty</button>
        </div>
        <p class="muted small sep">The project is kept in this browser. Classic patch editing: <a href="../control/">ES8 Control</a>.
          Free software under the AGPL-3.0 · <a href="https://github.com/jpecquais/es8" target="_blank" rel="noopener">source</a></p>
      </div>` : null}
    </div>`;
}

// ================================================================= colonne de droite : vers l'ES-8

const FIELD_GROUPS = [
  [/^name$/, "name"], [/^loop_(sw|chain)$/, "loops & chain"], [/^midi_/, "MIDI messages"],
  [/^assign_/, "switch assigns"], [/^ctl_func$/, "switch functions"], [/^manual_number/, "manual-mode loops"], [/^pc_map/, "setlist"],
];
const describeFields = (fields) => [...new Set(fields.map((f) => (FIELD_GROUPS.find(([re]) => re.test(f)) || [null, f])[1]))].join(", ");

function Tray({ s, preview, title }) {
  const pending = s.summary || { frames: 0 };
  if (!preview) return html`<aside class="tray"><header><h3>To the ES-8</h3></header><div class="scroll muted">Compiling…</div></aside>`;
  let badge, body;
  if (preview.error) {
    badge = html`<span class="badge bad">Cannot compile</span>`;
    body = html`<p class="small muted">${preview.where || "Project"}:</p>
      <ul class="notes bad">${(preview.problems || [preview.error]).map((p) => html`<li>${p}</li>`)}</ul>`;
  } else if (preview.missing) {
    const device = E.hasDevice();
    badge = html`<span class="badge">ES-8 not read yet</span>`;
    body = html`
      <p class="small">To compare the project with your ES-8, these must be read first:</p>
      <p class="mono">${preview.missing.join(" ")}</p>
      <button class="btn primary" disabled=${!device || s.busy}
        onClick=${() => E.readSome(preview.missing, plural(preview.missing.length, "page"))}>Read them from the ES-8</button>
      ${!device ? html`<p class="small muted">Connect the ES-8, or open a .syx dump from the menu at the top right.</p>` : null}`;
  } else {
    const labels = Object.keys(preview.patches);
    const what = [labels.length ? `${labels.length} ${labels.length === 1 ? "patch" : "patches"}` : "", preview.system.length ? "system" : ""]
      .filter(Boolean).join(" + ");
    badge = preview.in_sync ? html`<span class="badge sync">The ES-8 matches the project</span>`
      : preview.staged ? html`<span class="badge diff">Ready to write: ${what}</span>`
      : html`<span class="badge diff">To update: ${what}</span>`;
    body = html`
      ${labels.length || preview.system.length ? html`<div class="diff-list">
        ${labels.map((l) => html`<div><span class="lbl">${l}</span><span>${describeFields(preview.patches[l])}</span></div>`)}
        ${preview.system.length ? html`<div><span class="lbl">system</span><span>${describeFields(preview.system)}</span></div>` : null}
      </div>` : html`<p class="small muted">Every patch, switch and setlist entry the project owns is already on the ES-8.</p>`}
      ${preview.warnings.length ? html`<div><h3>Notes</h3><ul class="notes warn">${preview.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : null}`;
  }
  const canStage = preview && !preview.error && !preview.missing && !preview.in_sync && !preview.staged;
  return html`
    <aside class="tray">
      <header><h3>${title || "To the ES-8"}</h3>${badge}</header>
      <div class="scroll">${body}</div>
      <footer>
        ${canStage ? html`<button class="btn primary" onClick=${() => mutate("rig_stage", JSON.stringify(project.doc))}>Prepare the write</button>` : null}
        ${pending.frames ? html`
          <button class="btn write" disabled=${!E.hasDevice() || s.busy} onClick=${E.writePending}>
            Write to the ES-8 · ${plural(pending.frames / 2, "page")} · ≈ ${pending.estimated_s} s</button>
          <button class="link" onClick=${() => mutate("discard")}>Discard</button>` : null}
        <p class="small muted">${pending.frames ? "Written pages are read back and resent until verified; a backup is kept in this browser."
          : "Nothing is sent to the ES-8 before you write."}</p>
      </footer>
    </aside>`;
}

// ================================================================= liste de gauche (générique)

function SideList({ items, current, onPick, onAdd, addLabel, empty }) {
  return html`
    <nav class="side">
      <div class="list">
        ${items.length ? items.map((it) => html`
          <button class="item" aria-current=${it.id === current} onClick=${() => onPick(it.id)}>
            <span class="bank">${it.badge}</span>
            <span class="nm">${it.name}<span class="sub">${it.sub}</span></span>
            <span class="state ${it.state || ""}" title=${it.stateTitle || ""}></span>
          </button>`) : html`<p class="muted small" style="padding: 0 14px">${empty}</p>`}
      </div>
      <div class="foot"><button class="btn" onClick=${onAdd}>${addLabel}</button></div>
    </nav>`;
}

// ================================================================= introduction

function IntroTab({ doc, go }) {
  const pb = pbOf(doc);
  const rigs = sortedRigs(doc);
  const tracks = Object.values(doc.tracks || {});
  const setlists = Object.values(doc.setlists || {});
  const loops = wiredLoops(pb).length;
  const firstTrack = tracks.find((t) => (doc.rigs || {})[t.rig] && t.sequence.length);
  const layers = [
    {
      tab: "pedalboard", name: "Pedalboard", what: "Every device plugged into the ES-8 — pedals, a DAW, an amp, a multi-effect — and how: in a loop, through MIDI, or both.",
      es8: "Nothing: it is your description, used by everything else.",
      status: `${plural(Object.keys(doc.pedalboard.devices || {}).length, "device")} · ${plural(loops, "loop")} used`,
    },
    {
      tab: "surfaces", name: "Surface", what: "What each footswitch does in manual mode: toggle a MIDI parameter, switch a loop, tap the tempo. Several rigs can share one.",
      es8: "Switch functions and assigns of the rig's patches.",
      status: plural(Object.keys(doc.surfaces || {}).length, "surface"),
    },
    {
      tab: "rigs", name: "Rig", what: "A sound setup shared by many songs: the loops in the chain, the program each MIDI device loads, and as many snapshots as you need — the sounds you switch between.",
      es8: "Patches in a row, one per snapshot. A snapshot can load other programs than the rig's.",
      status: plural(rigs.length, "rig"),
    },
    {
      tab: "tracks", name: "Track", what: "A song: the order in which you play the rig's snapshots, repeats included — Verse, Chorus, Verse, Chorus, Bridge…",
      es8: "Nothing stored by itself: a repeat never duplicates a patch.",
      status: plural(tracks.length, "track"),
    },
    {
      tab: "setlists", name: "Setlist", what: "The songs of a gig, in order. A pedal sending “next” / “previous” program changes walks through the whole gig.",
      es8: "The program-change map: PC n recalls step n.",
      status: plural(setlists.length, "setlist"),
    },
  ];
  return html`
    <div class="body one">
      <main class="center intro">
        <section class="hero">
          <h1>Describe what you play. ES8 Designer sets up the ES-8.</h1>
          <p>The ES-8 stores 800 patches full of switches, numbers and MIDI slots. Here you describe your music instead —
            your pedals, your sounds, your songs — and the app works out every setting, shows you what will change,
            and writes it.</p>
        </section>

        <section class="layers" aria-label="The five layers">
          ${layers.map((layer, i) => html`
            ${i ? html`<span class="layer-arrow" aria-hidden="true">→</span>` : null}
            <article class="layer">
              <span class="step-n">${i + 1}</span>
              <h2>${layer.name}</h2>
              <p>${layer.what}</p>
              <p class="on-es8"><b>On the ES-8</b>${layer.es8}</p>
              <footer>
                <span class="muted small">${layer.status}</span>
                <button class="btn small" onClick=${() => go({ tab: layer.tab })}>Open</button>
              </footer>
            </article>`)}
        </section>

        ${firstTrack ? html`<section class="example">
          <h3>For example</h3>
          <p>The track <b>${firstTrack.name}</b> plays the rig <b>${doc.rigs[firstTrack.rig].name}</b> (patches ${rigRange(doc.rigs[firstTrack.rig])}):</p>
          <div class="flow">${firstTrack.sequence.map((name, k) => {
            const rig = doc.rigs[firstTrack.rig];
            const i = rig.snapshots.findIndex((sn) => sn.name === name);
            return html`${k ? html`<span class="arrow">→</span>` : null}<span class="flow-step"><b>${name}</b><span class="mono">${i >= 0 ? patchOf(rig, i) : "?"}</span></span>`;
          })}</div>
          <p class="muted small">${`${plural(firstTrack.sequence.length, "step")}, but only ${new Set(firstTrack.sequence).size} ${new Set(firstTrack.sequence).size === 1 ? "patch" : "patches"} on the ES-8.`}</p>
        </section>` : null}

        <section class="how">
          <h3>How it works</h3>
          <ol>
            <li><b>Describe</b>, from left to right: pedalboard, surfaces, rigs, tracks, setlists.</li>
            <li><b>Compare.</b> The column on the right compiles your project against the ES-8 at every change: what differs, what is refused and why.</li>
            <li><b>Write.</b> Only the pages that differ are sent, then read back and resent until verified. A backup is kept in this browser.</li>
          </ol>
          <p class="muted small">Your project lives in this browser: export it from the menu at the top right (one file, also read by
            <code>es8ctl rig compile</code>). Patch-by-patch editing stays in <a href="../control/">ES8 Control</a>.</p>
          <div><button class="btn primary" onClick=${() => go({ tab: "pedalboard" })}>Start with the pedalboard →</button></div>
        </section>
      </main>
    </div>`;
}

// ================================================================= rigs

const STATE_TITLE = { sync: "On the ES-8", diff: "Differs from the ES-8", bad: "Cannot compile", missing: "Not read from the ES-8 yet" };

function RigsTab({ s, doc, ui, go, preview }) {
  const rigs = sortedRigs(doc);
  const rid = doc.rigs && doc.rigs[ui.rig] ? ui.rig : (rigs[0] || [null])[0];
  const addRig = () => {
    const start = freeStart(doc, 1);
    if (start === null) { toast("Every patch of the ES-8 is used by a rig.", "warn"); return; }
    const id = slug("rig", Object.keys(doc.rigs || {}));
    project.update((d) => {
      d.rigs = d.rigs || {};
      d.rigs[id] = { schema: "es8ctl.rig/2", name: "New rig", short: "New", start: patchAt(start), surface: Object.keys(d.surfaces || {})[0] || null,
        chain: wiredLoops(pbOf(d)).slice(0, 3), programs: {}, snapshots: [{ name: "A", loops: [], params: {} }] };
    });
    go({ rig: id });
  };
  return html`
    <div class="body">
      <${SideList} current=${rid} onPick=${(id) => go({ rig: id })} onAdd=${addRig} addLabel="+ New rig"
        empty="No rig yet. A rig is a loop chain, the programs loaded on each MIDI device, and its snapshots: one patch each, in a row."
        items=${rigs.map(([id, r]) => {
          const st = rigState(preview, id, r);
          return { id, badge: patchOf(r, 0), name: r.name, sub: `${plural(r.snapshots.length, "snapshot")} · ${rigRange(r)}`, state: st, stateTitle: STATE_TITLE[st] };
        })} />
      <main class="center">
        ${rid ? html`<${RigEditor} key=${rid} s=${s} doc=${doc} rid=${rid} go=${go} />`
          : html`<div class="empty-state"><h2>Design your first rig</h2>
              <p>Describe what you want to hear, not which bits to set: the loops in the chain, the program each MIDI device loads,
                and the snapshots you switch between. ES8 Designer writes the patches for you.</p>
              <button class="btn primary" onClick=${addRig}>+ New rig</button></div>`}
      </main>
      <${Tray} s=${s} preview=${preview} />
    </div>`;
}

function RigEditor({ s, doc, rid, go }) {
  const rig = doc.rigs[rid];
  const pb = pbOf(doc);
  const edit = (fn) => project.update((d) => fn(d.rigs[rid], d));
  const short = rig.short ?? rig.name;
  const shortened = patchNames(rig).filter(([, auto]) => auto).length;
  const clash = overlaps(doc, rid);
  const moveToFree = () => {
    const n = freeStart(doc, rig.snapshots.length, rid);
    if (n === null) { toast(`No room for ${plural(rig.snapshots.length, "patch")} in a row.`, "warn"); return; }
    edit((r) => { r.start = patchAt(n); });
  };
  const remove = () => {
    const tracks = Object.values(doc.tracks || {}).filter((t) => t.rig === rid);
    if (!confirm(`Delete the rig "${rig.name}"${tracks.length ? ` and its ${plural(tracks.length, "track")}` : ""}? The ES-8 is not changed.`)) return;
    project.update((d) => {
      delete d.rigs[rid];
      Object.values(d.rigs).forEach((r) => {
        if (r.backup !== rid) return;
        delete r.backup;
        r.snapshots.forEach((sn) => { delete sn.backup; });
      });
      const gone = Object.keys(d.tracks || {}).filter((tid) => d.tracks[tid].rig === rid);
      gone.forEach((tid) => { delete d.tracks[tid]; });
      Object.values(d.setlists || {}).forEach((sl) => { sl.songs = sl.songs.filter((song) => !gone.includes(song.track)); });
    });
    go({ rig: null });
  };
  return html`
    <div class="head">
      <label class="field">Rig<input class="title" value=${rig.name} onInput=${(e) => edit((r) => { r.name = e.target.value; })} /></label>
      <label class="field">Short name (patch names: ${"<short> <snapshot>"})
        <span class="row"><input value=${short} size="10" onInput=${(e) => edit((r) => { r.short = e.target.value; })} />
          ${shortened ? html`<span class="muted small" title="Their ES-8 patch name is shortened to 16 characters; edit it under each snapshot">${plural(shortened, "name")} shortened</span>` : null}</span></label>
      <label class="field">First patch
        <span class="row"><input class="mono" size="5" value=${typeof rig.start === "number" ? patchAt(rig.start) : rig.start}
          onChange=${(e) => { const n = parseLabel(e.target.value); if (n === null) toast("A patch is bank-number, 0-1 … 99-8.", "warn"); else edit((r) => { r.start = patchAt(n); }); }} />
          <span class="muted small">${rigRange(rig)}</span></span>
        ${clash.length ? html`<span class="error small">overlaps ${clash.map((r) => r.name).join(", ")}
          <button class="link" onClick=${moveToFree}>Move to free patches</button></span>` : null}
        ${rigStart(rig) + rig.snapshots.length > PATCHES ? html`<span class="error small">goes past 99-8</span>` : null}</label>
      <label class="field">Surface
        <select value=${rig.surface || ""} onChange=${(e) => edit((r) => { r.surface = e.target.value || null; })}>
          <option value="">— leave switches as they are —</option>
          ${Object.entries(doc.surfaces || {}).map(([id, sf]) => html`<option value=${id}>${sf.name}</option>`)}
        </select></label>
      <label class="field" title="ES8 Companion's Backup button switches each snapshot to a snapshot of this rig">Backup rig
        <select value=${rig.backup || ""} onChange=${(e) => edit((r) => {
          if (e.target.value) r.backup = e.target.value; else delete r.backup;
          r.snapshots.forEach((sn) => { delete sn.backup; });
        })}>
          <option value="">— none —</option>
          ${sortedRigs(doc).filter(([id]) => id !== rid).map(([id, r]) => html`<option value=${id}>${r.name}</option>`)}
        </select></label>
      <span class="grow"></span>
      <button class="link danger" onClick=${remove}>Delete rig</button>
    </div>
    <${DevicesEditor} rig=${rig} doc=${doc} pb=${pb} edit=${edit} />
    <${ChainEditor} rig=${rig} pb=${pb} edit=${edit} />
    <${ProgramsEditor} rig=${rig} pb=${pb} edit=${edit} />
    <${SnapshotMatrix} s=${s} rig=${rig} rid=${rid} pb=${pb} edit=${edit} short=${short} />`;
}

function DevicesEditor({ rig, doc, pb, edit }) {
  const devices = Object.entries((doc.pedalboard || {}).devices || {});
  if (!devices.length) return null;
  const toggle = (did) => edit((r) => {
    const all = devices.map(([id]) => id);
    const used = r.devices || all;
    const loops = LOOPS.filter((l) => loopDevice(pb, l) === did);
    if (used.includes(did)) {
      r.devices = used.filter((id) => id !== did);
      if (Array.isArray(r.chain)) r.chain = r.chain.filter((l) => !loops.includes(l));
      if (r.programs) delete r.programs[did];
      r.snapshots.forEach((sn) => {
        sn.loops = (sn.loops || []).filter((l) => !loops.includes(l));
        if (sn.programs) { delete sn.programs[did]; if (!Object.keys(sn.programs).length) delete sn.programs; }
        if (sn.params) Object.keys(sn.params).forEach((ref) => { if (ref.split(".")[0] === did) delete sn.params[ref]; });
      });
    } else {
      r.devices = all.filter((id) => used.includes(id) || id === did);
      if (Array.isArray(r.chain)) loops.forEach((l) => { if (!r.chain.includes(l)) r.chain.push(l); });
    }
    if (r.devices.length === all.length) delete r.devices;
  });
  return html`
    <section class="section">
      <header><h3>Devices</h3><p>The pedals and devices this rig uses. Only these appear below.</p></header>
      <div class="spare">${devices.map(([did, d]) => {
        const on = usesDevice(rig, pb, did);
        const what = [...(d.loops || []), d.midi ? `MIDI ch ${d.midi.channel}` : null].filter(Boolean).join(" · ");
        return html`<button class="chip ${on ? "solid" : ""}" aria-pressed=${on} onClick=${() => toggle(did)}
          title=${on ? "Used: click to leave it out of this rig" : "Not used: click to add it"}>${d.name}<span class="muted small"> ${what}</span></button>`;
      })}</div>
    </section>`;
}

function ChainEditor({ rig, pb, edit }) {
  if (typeof rig.chain === "string") {
    return html`<section class="section"><header><h3>Signal chain</h3><p>Screen notation (output → input), parallel blocks allowed.</p></header>
      <input class="mono" value=${rig.chain} onInput=${(e) => edit((r) => { r.chain = e.target.value; })} />
      <button class="link" onClick=${() => edit((r) => { r.chain = []; })}>Back to a simple chain</button></section>`;
  }
  const chain = rig.chain || [];
  const spare = wiredLoops(pb).filter((l) => !chain.includes(l) && usesDevice(rig, pb, loopDevice(pb, l)));
  const move = (i, d) => edit((r) => { const [x] = r.chain.splice(i, 1); r.chain.splice(i + d, 0, x); });
  return html`
    <section class="section">
      <header><h3>Signal chain</h3><p>From the guitar to the amp. Loops left out stay off.</p></header>
      <div class="chain">
        <span class="jack">INPUT</span>
        ${chain.map((l, i) => html`
          <span class="arrow">→</span>
          <span class="loop"><b>${loopNumber(l) === "V" ? "V" : l}</b><span>${loopTitle(pb, l)}</span>
            <span class="ctl">
              <button disabled=${i === 0} onClick=${() => move(i, -1)} aria-label="Earlier">◀</button>
              <button disabled=${i === chain.length - 1} onClick=${() => move(i, 1)} aria-label="Later">▶</button>
              <button onClick=${() => edit((r) => {
                r.chain.splice(i, 1);
                r.snapshots.forEach((sn) => { sn.loops = (sn.loops || []).filter((x) => x !== l); });
              })} aria-label="Remove">×</button>
            </span></span>`)}
        <span class="arrow">→</span><span class="jack">OUTPUT</span>
      </div>
      ${spare.length ? html`<div class="spare">Add:
        ${spare.map((l) => html`<button class="chip" onClick=${() => edit((r) => { r.chain.push(l); })}>${l} · ${loopTitle(pb, l)}</button>`)}
      </div>` : null}
      ${!wiredLoops(pb).length ? html`<p class="hint">No loop is wired yet: name your pedals in the Pedalboard tab.</p>` : null}
    </section>`;
}

/** Programme (alias, numéro ou {pc, bank_*}) → {pc, bank_msb?, bank_lsb?} ; null si absent. */
function resolveProgram(dev, value) {
  if (typeof value === "string") return (dev.programs || {})[value] || null;
  if (typeof value === "number") return { pc: value };
  return value && typeof value === "object" ? value : null;
}
function programText(dev, value) {
  if (value === undefined) return "—";
  if (value === null) return "no PC";
  const p = resolveProgram(dev, value);
  if (!p) return `${value}?`;
  const alias = typeof value === "string" ? (dev.programs[value].name || value)
    : (Object.values(dev.programs || {}).find((a) => a.pc === p.pc && a.bank_msb === p.bank_msb && a.bank_lsb === p.bank_lsb) || {}).name;
  return `${alias ? `${alias} · ` : ""}PC ${p.pc}${p.bank_msb != null ? ` · MSB ${p.bank_msb}` : ""}${p.bank_lsb != null ? ` · LSB ${p.bank_lsb}` : ""}`;
}

/**
 * Choix d'un programme : un alias du pedalboard, ou directement un numéro (avec bank MSB/LSB si
 * l'appareil les demande). `inherited` (snapshot) : la valeur vide reprend celle du rig, « no PC » la coupe.
 */
function ProgramPicker({ dev, value, onChange, inherited }) {
  const mode = dev.program_change || "pc";
  const numeric = typeof value === "number" || (value && typeof value === "object");
  const p = numeric ? resolveProgram(dev, value) : null;
  const sel = value === undefined ? "" : value === null ? "none" : numeric ? "number" : `a:${value}`;
  const pick = (v) => {
    if (v === "") onChange(undefined);
    else if (v === "none") onChange(null);
    else if (v === "number") onChange(p ? value : 0);
    else onChange(v.slice(2));
  };
  const setPart = (part, n) => {
    const next = { pc: p ? p.pc : 0, ...(p || {}), [part]: Math.max(0, Math.min(127, Number(n) || 0)) };
    onChange(next.bank_msb == null && next.bank_lsb == null ? next.pc : next);
  };
  return html`<span class="prog-pick">
    <select value=${sel} onChange=${(e) => pick(e.target.value)}>
      <option value="">${inherited !== undefined ? `Rig: ${programText(dev, inherited)}` : "— no program change —"}</option>
      ${inherited !== undefined ? html`<option value="none">No program change</option>` : null}
      ${Object.entries(dev.programs || {}).map(([pid, pp]) => html`<option value=${`a:${pid}`}>${pp.name || pid} (PC ${pp.pc})</option>`)}
      <option value="number">PC number…</option>
    </select>
    ${numeric ? html`
      <label class="num">PC<input type="number" min="0" max="127" value=${p.pc} onInput=${(e) => setPart("pc", e.target.value)} /></label>
      ${mode.includes("msb") ? html`<label class="num">MSB<input type="number" min="0" max="127" value=${p.bank_msb ?? 0} onInput=${(e) => setPart("bank_msb", e.target.value)} /></label>` : null}
      ${mode.includes("lsb") ? html`<label class="num">LSB<input type="number" min="0" max="127" value=${p.bank_lsb ?? 0} onInput=${(e) => setPart("bank_lsb", e.target.value)} /></label>` : null}` : null}
  </span>`;
}

function ProgramsEditor({ rig, pb, edit }) {
  const devices = Object.entries(pb.devices || {}).filter(([did, d]) => d.program_change !== "none" && usesDevice(rig, pb, did));
  if (!devices.length) return null;
  return html`
    <section class="section">
      <header><h3>Programs</h3><p>Sent with every snapshot, so recalling one from another rig always loads the right sound.
        A snapshot can load another one (Snapshots, below).</p></header>
      <div class="programs">
        ${devices.map(([did, d]) => html`<div class="prog">
          <span class="dev">${d.name}</span>
          <${ProgramPicker} dev=${d} value=${(rig.programs || {})[did]} onChange=${(v) => edit((r) => {
            r.programs = r.programs || {};
            if (v === undefined) delete r.programs[did]; else r.programs[did] = v;
          })} />
          <span class="meta">ch ${d.channel}</span>
        </div>`)}
      </div>
    </section>`;
}

function SnapshotMatrix({ s, rig, rid, pb, edit, short }) {
  const chain = typeof rig.chain === "string" ? wiredLoops(pb) : rig.chain || [];
  const params = allParams(pb).filter((p) => usesDevice(rig, pb, p.did));
  const [editing, setEditing] = useState(null); // "i:ref" en saisie numérique
  const toggleLoop = (i, l) => edit((r) => {
    const sn = r.snapshots[i];
    sn.loops = sn.loops || [];
    sn.loops = sn.loops.includes(l) ? sn.loops.filter((x) => x !== l) : [...sn.loops, l];
  });
  /** Une boucle dans tous les snapshots, ou dans aucun si elle y est déjà partout. */
  const toggleLoopAll = (l) => edit((r) => {
    const all = r.snapshots.every((sn) => (sn.loops || []).includes(l));
    r.snapshots.forEach((sn) => {
      sn.loops = (sn.loops || []).filter((x) => x !== l);
      if (!all) sn.loops.push(l);
    });
  });
  const setAlias = (ref, name) => edit((r) => {
    r.aliases = r.aliases || {};
    if (name.trim()) r.aliases[ref] = name; else delete r.aliases[ref];
    if (!Object.keys(r.aliases).length) delete r.aliases;
  });
  // Le switch de la surface du rig qui pilote chaque paramètre (affiché à côté de l'alias).
  const surface = (project.doc.surfaces || {})[rig.surface] || { switches: {} };
  const switchOf = (ref) => Object.entries(surface.switches || {}).find(([, sw]) => sw.role === "param" && sw.param === ref);
  const setParam = (i, ref, value) => edit((r) => {
    const sn = r.snapshots[i];
    sn.params = sn.params || {};
    if (value === "off" || value === undefined) delete sn.params[ref]; else sn.params[ref] = value;
  });
  const rename = (i, name) => project.update((d) => {
    const r = d.rigs[rid];
    const old = r.snapshots[i].name;
    r.snapshots[i].name = name;
    Object.values(d.tracks || {}).forEach((t) => {
      if (t.rig === rid) t.sequence = t.sequence.map((n) => (n === old ? name : n));
    });
    Object.values(d.rigs).forEach((o) => {
      if (o.backup === rid) o.snapshots.forEach((sn) => { if (sn.backup === old) sn.backup = name; });
    });
  });
  const removeSnap = (i) => project.update((d) => {
    const r = d.rigs[rid];
    const [gone] = r.snapshots.splice(i, 1);
    Object.values(d.tracks || {}).forEach((t) => {
      if (t.rig === rid) t.sequence = t.sequence.filter((n) => n !== gone.name);
    });
    Object.values(d.rigs).forEach((o) => {
      if (o.backup === rid) o.snapshots.forEach((sn) => { if (sn.backup === gone.name) delete sn.backup; });
    });
  });
  const setProgram = (i, did, value) => edit((r) => {
    const sn = r.snapshots[i];
    sn.programs = sn.programs || {};
    if (value === undefined) delete sn.programs[did]; else sn.programs[did] = value;
    if (!Object.keys(sn.programs).length) delete sn.programs;
  });
  const backupRig = rig.backup ? (project.doc.rigs || {})[rig.backup] : null;
  const setBackup = (i, name) => edit((r) => { if (name) r.snapshots[i].backup = name; else delete r.snapshots[i].backup; });
  const pcDevices = Object.entries(pb.devices || {}).filter(([did, d]) => d.program_change !== "none" && usesDevice(rig, pb, did));
  const addSnap = () => edit((r) => {
    const last = r.snapshots[r.snapshots.length - 1] || { loops: [], params: {} };
    const names = r.snapshots.map((sn) => sn.name);
    let n = r.snapshots.length + 1;
    while (names.includes(`Snap ${n}`)) n++;
    r.snapshots.push({ name: `Snap ${n}`, loops: [...(last.loops || [])], params: { ...(last.params || {}) } });
  });
  const cols = rig.snapshots.length;
  const names = patchNames(rig);
  return html`
    <section class="section">
      <header><h3>Snapshots</h3>
        <button class="btn small" onClick=${addSnap} title="The table scrolls sideways when the snapshots don't fit">+ Snapshot (${cols})</button>
        <p>One patch each, in a row from ${patchOf(rig, 0)}. Double-click a MIDI cell to send a value instead of on/off.</p></header>
      <div class="matrix-wrap">
        <table class="matrix">
          <thead><tr>
            <th class="rowh"></th>
            ${rig.snapshots.map((sn, i) => {
              const [pname, auto] = names[i] || [`${short} ${sn.name}`.trim(), false];
              const at = patchOf(rig, i);
              return html`<th><div class="snap-h">
                <span class="num">${at}
                  <button class="link" title="Recall this patch on the ES-8" disabled=${!E.hasDevice() || s.busy} onClick=${() => E.play(at)}>▶</button>
                  ${cols > 1 ? html`<button class="x" title="Remove this snapshot" onClick=${() => removeSnap(i)}>×</button>` : null}</span>
                <input value=${sn.name} title=${sn.name} onInput=${(e) => rename(i, e.target.value)} aria-label="Snapshot name" />
                <input class="lcd lcd-input ${sn.patch_name ? "own" : auto ? "auto" : ""}" maxlength=${NAME_LEN} spellcheck="false"
                  value=${sn.patch_name || ""} placeholder=${pname} aria-label="Patch name on the ES-8"
                  title=${sn.patch_name ? "Your patch name. Empty it to get the automatic one." : auto ? "Shortened automatically to 16 characters: type to change it" : "Patch name on the ES-8: type to change it"}
                  onInput=${(e) => edit((r) => {
                    const v = e.target.value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
                    if (v.trim()) r.snapshots[i].patch_name = v; else delete r.snapshots[i].patch_name;
                  })} />
                <span class="count">${sn.patch_name ? "yours" : auto ? "auto · shortened" : ""}</span>
              </div></th>`;
            })}
            <th class="add-snap"><button onClick=${addSnap} title="Add a snapshot">+</button></th>
          </tr></thead>
          <tbody>
            ${backupRig ? html`<tr class="group"><td colspan=${cols + 2}><span class="group-label">Backup · ${backupRig.name}</span></td></tr>
              <tr><td class="rowh"><b>⇄</b>Backup snapshot</td>
              ${rig.snapshots.map((sn, i) => html`<td class="prog-cell ${sn.backup ? "own" : ""}">
                <select value=${sn.backup || ""} onChange=${(e) => setBackup(i, e.target.value)}>
                  <option value="">${`First: ${backupRig.snapshots[0].name}`}</option>
                  ${backupRig.snapshots.map((b, k) => html`<option value=${b.name}>${b.name} · ${patchOf(backupRig, k)}</option>`)}
                </select></td>`)}<td></td></tr>` : null}
            ${pcDevices.length ? html`<tr class="group"><td colspan=${cols + 2}><span class="group-label">Programs</span></td></tr>` : null}
            ${pcDevices.map(([did, d]) => html`<tr>
              <td class="rowh rp"><b>PC</b>${d.name}</td>
              ${rig.snapshots.map((sn, i) => {
                const own = (sn.programs || {})[did];
                return html`<td class="prog-cell ${own !== undefined ? "own" : ""}"><${ProgramPicker} dev=${d} value=${own}
                  inherited=${(rig.programs || {})[did] ?? null} onChange=${(v) => setProgram(i, did, v)} /></td>`;
              })}<td></td></tr>`)}
            ${chain.length ? html`<tr class="group"><td colspan=${cols + 2}><span class="group-label">Loops</span></td></tr>` : null}
            ${chain.map((l) => {
              const all = rig.snapshots.every((sn) => (sn.loops || []).includes(l));
              return html`<tr>
              <td class="rowh rl"><b>${l}</b>${loopTitle(pb, l)}
                <button class="all-btn" aria-pressed=${all} onClick=${() => toggleLoopAll(l)}
                  title=${all ? "Turn this loop off in every snapshot" : "Turn this loop on in every snapshot"}>${all ? "none" : "all"}</button></td>
              ${rig.snapshots.map((sn, i) => {
                const on = (sn.loops || []).includes(l);
                return html`<td><button class="cell cl ${on ? "on" : ""}" aria-pressed=${on} onClick=${() => toggleLoop(i, l)}>${on ? "ON" : ""}</button></td>`;
              })}<td></td></tr>`;
            })}
            ${Object.entries(pb.devices || {}).map(([did, d]) => {
              const rows = params.filter((p) => p.did === did);
              if (!rows.length) return null;
              return html`
                <tr class="group"><td colspan=${cols + 2}><span class="group-label">${d.name} · ch ${d.channel}</span></td></tr>
                ${rows.map((p) => {
                  const sw = switchOf(p.ref);
                  const generic = p.param.name || p.pid;
                  return html`<tr>
                  <td class="rowh rp"><span class="alias-row"><b>CC${p.param.cc}</b>
                    <input class="alias" value=${(rig.aliases || {})[p.ref] || ""} placeholder=${generic}
                      title="This rig's name for the parameter (shown by ES8 Companion on the switch)" aria-label=${`Name of ${generic} in this rig`}
                      onInput=${(e) => setAlias(p.ref, e.target.value)} /></span>
                    <span class="alias-of">${(rig.aliases || {})[p.ref] ? generic : ""}${sw ? `${(rig.aliases || {})[p.ref] ? " · " : ""}${swName(sw[0])}` : ""}</span></td>
                  ${rig.snapshots.map((sn, i) => {
                    const v = (sn.params || {})[p.ref];
                    const key = `${i}:${p.ref}`;
                    if (editing === key) {
                      return html`<td><input class="cell-input" type="number" min="0" max="127" autoFocus
                        value=${typeof v === "number" ? v : v === "on" ? (p.param.on ?? 127) : (p.param.off ?? 0)}
                        onBlur=${() => setEditing(null)} onKeyDown=${(e) => e.key === "Enter" && e.target.blur()}
                        onChange=${(e) => setParam(i, p.ref, Math.max(0, Math.min(127, Number(e.target.value) || 0)))} /></td>`;
                    }
                    const cls = v === "on" ? "on" : typeof v === "number" ? "val" : "";
                    return html`<td><button class="cell cp ${cls}" aria-pressed=${Boolean(v)}
                      title="Click: on/off · double-click: value"
                      onClick=${() => setParam(i, p.ref, v ? "off" : "on")}
                      onDblClick=${() => setEditing(key)}>${v === "on" ? "ON" : typeof v === "number" ? v : ""}</button></td>`;
                  })}<td></td></tr>`;
                })}`;
            })}
          </tbody>
        </table>
      </div>
      ${!params.length ? html`<p class="hint">No MIDI parameter yet: add devices and their CCs in the Pedalboard tab.</p>` : null}
    </section>`;
}

// ================================================================= liste réordonnable

/**
 * Liste qu'on réordonne en glissant la poignée ⋮⋮ (ou avec ▲ ▼ au clavier).
 * Seule la poignée démarre le glisser : les champs de la ligne restent utilisables.
 */
function Sortable({ items, onMove, row, keyOf }) {
  const [armed, setArmed] = useState(null);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null); // { i, after }
  const reset = () => { setArmed(null); setDrag(null); setOver(null); };
  const drop = () => {
    if (drag !== null && over) {
      let to = over.i + (over.after ? 1 : 0);
      if (to > drag) to -= 1;
      if (to !== drag) onMove(drag, to);
    }
    reset();
  };
  return html`<ol class="sortable">
    ${items.map((item, i) => {
      const mark = over && over.i === i && drag !== null && drag !== i ? (over.after ? "drop-after" : "drop-before") : "";
      return html`<li key=${keyOf ? keyOf(item, i) : i} class="srow ${drag === i ? "dragging" : ""} ${mark}"
        draggable=${armed === i}
        onDragStart=${(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
        onDragOver=${(e) => {
          if (drag === null) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          if (!over || over.i !== i || over.after !== after) setOver({ i, after });
        }}
        onDrop=${(e) => { e.preventDefault(); drop(); }}
        onDragEnd=${reset}>
        <span class="grip" title="Drag to reorder" onPointerDown=${() => setArmed(i)} onPointerUp=${() => drag === null && setArmed(null)}>⋮⋮</span>
        <span class="idx">${i + 1}</span>
        ${row(item, i)}
        <span class="moves">
          <button class="x" disabled=${i === 0} onClick=${() => onMove(i, i - 1)} aria-label="Move up">▲</button>
          <button class="x" disabled=${i === items.length - 1} onClick=${() => onMove(i, i + 1)} aria-label="Move down">▼</button>
        </span>
      </li>`;
    })}
  </ol>`;
}

const moved = (list, from, to) => { const next = [...list]; const [x] = next.splice(from, 1); next.splice(to, 0, x); return next; };

// ================================================================= tracks (morceaux)

const sortedTracks = (doc) => Object.entries(doc.tracks || {}).sort((a, b) => a[1].name.localeCompare(b[1].name));

function TracksTab({ s, doc, ui, go, preview }) {
  const tracks = sortedTracks(doc);
  const tid = doc.tracks && doc.tracks[ui.track] ? ui.track : (tracks[0] || [null])[0];
  const rigs = sortedRigs(doc);
  const add = () => {
    if (!rigs.length) { toast("Create a rig first: a track plays the snapshots of one rig.", "warn"); return; }
    const id = slug("track", Object.keys(doc.tracks || {}));
    const [rid, rig] = rigs[0];
    project.update((d) => {
      d.tracks = d.tracks || {};
      d.tracks[id] = { schema: "es8ctl.track/1", name: "New track", rig: rid, sequence: rig.snapshots.slice(0, 1).map((sn) => sn.name) };
    });
    go({ track: id });
  };
  return html`
    <div class="body">
      <${SideList} current=${tid} onPick=${(id) => go({ track: id })} onAdd=${add} addLabel="+ New track"
        empty="A track is a song: one rig, and the snapshots in the order you play them."
        items=${tracks.map(([id, t]) => {
          const rig = (doc.rigs || {})[t.rig];
          return { id, badge: rig ? patchOf(rig, 0) : "?", name: t.name,
            sub: `${rig ? rig.name : "no rig"} · ${plural(t.sequence.length, "step")}` };
        })} />
      <main class="center">
        ${tid ? html`<${TrackEditor} key=${tid} s=${s} doc=${doc} tid=${tid} go=${go} />`
          : html`<div class="empty-state"><h2>No track yet</h2>
            <p>Write the running order of each song once — Verse, Chorus, Verse, Chorus, Bridge, Chorus — then chain the songs in a setlist.
              Repeats cost nothing: no patch is duplicated.</p>
            <button class="btn primary" onClick=${add}>+ New track</button></div>`}
      </main>
      <${Tray} s=${s} preview=${preview} />
    </div>`;
}

function TrackEditor({ s, doc, tid, go }) {
  const t = doc.tracks[tid];
  const rig = (doc.rigs || {})[t.rig];
  const edit = (fn) => project.update((d) => fn(d.tracks[tid], d));
  const names = rig ? rig.snapshots.map((sn) => sn.name) : [];
  const pnames = rig ? patchNames(rig) : [];
  const setlists = Object.values(doc.setlists || {}).filter((sl) => sl.songs.some((song) => song.track === tid));
  const nextName = () => {
    if (!names.length) return null;
    const last = t.sequence[t.sequence.length - 1];
    return names[(names.indexOf(last) + 1) % names.length];
  };
  const remove = () => {
    if (!confirm(`Delete the track "${t.name}"${setlists.length ? ` (used in ${plural(setlists.length, "setlist")})` : ""}?`)) return;
    project.update((d) => {
      delete d.tracks[tid];
      Object.values(d.setlists || {}).forEach((sl) => { sl.songs = sl.songs.filter((song) => song.track !== tid); });
    });
    go({ track: null });
  };
  return html`
    <div class="head">
      <label class="field">Track<input class="title" value=${t.name} onInput=${(e) => edit((x) => { x.name = e.target.value; })} /></label>
      <label class="field">Rig
        <select value=${t.rig} onChange=${(e) => edit((x) => { x.rig = e.target.value; })}>
          ${!rig ? html`<option value=${t.rig}>— missing rig —</option>` : null}
          ${sortedRigs(doc).map(([id, r]) => html`<option value=${id}>${r.name} · ${rigRange(r)}</option>`)}
        </select></label>
      ${rig ? html`<button class="link" onClick=${() => go({ tab: "rigs", rig: t.rig })}>Edit the rig</button>` : null}
      <span class="grow"></span>
      <span class="muted small">${setlists.length ? `In ${setlists.map((sl) => sl.name).join(", ")}` : "In no setlist"}</span>
      <button class="link danger" onClick=${remove}>Delete track</button>
    </div>
    <section class="section">
      <header><h3>Running order</h3><p>One line per section, in the order you play them. Drag ⋮⋮ to reorder.</p></header>
      ${t.sequence.length ? html`<${Sortable} items=${t.sequence}
        onMove=${(from, to) => edit((x) => { x.sequence = moved(x.sequence, from, to); })}
        row=${(name, i) => {
          const k = names.indexOf(name);
          return html`
            <select class="grow" value=${name} onChange=${(e) => edit((x) => { x.sequence[i] = e.target.value; })} aria-label="Snapshot">
              ${k < 0 ? html`<option value=${name}>${name} — not in this rig</option>` : null}
              ${names.map((n) => html`<option value=${n}>${n}</option>`)}
            </select>
            <span class="mono ${k < 0 ? "error" : "muted"}">${k < 0 ? "missing" : patchOf(rig, k)}</span>
            ${k >= 0 ? html`<span class="lcd small-lcd">${((pnames[k] || [""])[0]).padEnd(NAME_LEN)}</span>` : html`<span></span>`}
            <span class="row-actions">
              <button class="x" title="Duplicate" onClick=${() => edit((x) => { x.sequence.splice(i + 1, 0, name); })}>⧉</button>
              <button class="x" title="Remove" onClick=${() => edit((x) => { x.sequence.splice(i, 1); })}>×</button>
              ${E.hasDevice() && k >= 0 ? html`<button class="x" title="Recall on the ES-8" disabled=${s.busy}
                onClick=${() => E.play(patchOf(rig, k))}>▶</button>` : null}
            </span>`;
        }} />` : html`<p class="hint">No step yet.</p>`}
      <div class="row">
        <button class="btn" disabled=${!names.length} onClick=${() => edit((x) => { x.sequence.push(nextName()); })}>+ Add a step</button>
        ${!rig ? html`<span class="error small">Pick a rig for this track.</span>` : null}
      </div>
    </section>`;
}

// ================================================================= setlists

function trackSteps(doc, song) {
  const t = song.track ? (doc.tracks || {})[song.track] : song;
  if (!t) return { track: null, rig: null, steps: [] };
  const rig = (doc.rigs || {})[t.rig];
  return {
    track: t, rig,
    steps: (t.sequence || []).map((name) => {
      const i = rig ? rig.snapshots.findIndex((sn) => sn.name === name) : -1;
      return { name, label: rig && i >= 0 ? patchOf(rig, i) : "?" };
    }),
  };
}

const stepCount = (doc, setlist) => setlist.songs.reduce((n, song) => n + trackSteps(doc, song).steps.length, 0);

function SetlistsTab({ s, doc, ui, go, preview }) {
  const lists = Object.entries(doc.setlists || {}).sort((a, b) => a[1].midi_bank - b[1].midi_bank);
  const lid = doc.setlists && doc.setlists[ui.setlist] ? ui.setlist : (lists[0] || [null])[0];
  const add = () => {
    const used = lists.map(([, l]) => l.midi_bank);
    const bank = [0, 1, 2, 3, 4, 5, 6].find((b) => !used.includes(b));
    if (bank === undefined) { toast("The ES-8 holds 7 setlists (MIDI banks 0–6).", "warn"); return; }
    const id = slug("setlist", Object.keys(doc.setlists || {}));
    project.update((d) => {
      d.setlists = d.setlists || {};
      d.setlists[id] = { schema: "es8ctl.setlist/1", name: "New setlist", midi_bank: bank, songs: [] };
    });
    go({ setlist: id });
  };
  return html`
    <div class="body">
      <${SideList} current=${lid} onPick=${(id) => go({ setlist: id })} onAdd=${add} addLabel="+ New setlist"
        empty="A setlist chains tracks in the order of the gig."
        items=${lists.map(([id, l]) => ({ id, badge: `B${l.midi_bank}`, name: l.name,
          sub: `${plural(l.songs.length, "track")} · ${plural(stepCount(doc, l), "step")}` }))} />
      <main class="center">
        ${lid ? html`<${SetlistEditor} key=${lid} doc=${doc} lid=${lid} go=${go} />`
          : html`<div class="empty-state"><h2>No setlist yet</h2>
            <p>Chain your tracks in the order of the gig. Every step becomes one program change: a pedal sending PC +1 / −1
              (or any MIDI controller) walks through the whole gig.</p>
            <button class="btn primary" onClick=${add}>+ New setlist</button></div>`}
      </main>
      <${Tray} s=${s} preview=${preview} />
    </div>`;
}

function SetlistEditor({ doc, lid, go }) {
  const sl = doc.setlists[lid];
  const edit = (fn) => project.update((d) => fn(d.setlists[lid], d));
  const tracks = sortedTracks(doc);
  const used = Object.entries(doc.setlists).filter(([id]) => id !== lid).map(([, l]) => l.midi_bank);
  const parts = sl.songs.map((song) => trackSteps(doc, song));
  let pc = 0;
  const ranges = parts.map((part) => { const from = pc; pc += part.steps.length; return [from, pc - 1]; });
  const total = pc;
  return html`
    <div class="head">
      <label class="field">Setlist<input class="title" value=${sl.name} onInput=${(e) => edit((l) => { l.name = e.target.value; })} /></label>
      <label class="field">MIDI bank
        <select value=${sl.midi_bank} onChange=${(e) => edit((l) => { l.midi_bank = Number(e.target.value); })}>
          ${[0, 1, 2, 3, 4, 5, 6].map((b) => html`<option value=${b} disabled=${used.includes(b)}>${b}${b === 0 ? " (no Bank Select needed)" : ""}</option>`)}
        </select></label>
      <span class="grow"></span>
      <span class="count ${total > 128 ? "over" : ""}">${total}/128 steps</span>
      <button class="link danger" onClick=${() => {
        if (confirm(`Delete the setlist "${sl.name}"? Its tracks are kept.`)) { project.update((d) => { delete d.setlists[lid]; }); go({ setlist: null }); }
      }}>Delete setlist</button>
    </div>
    ${sl.midi_bank ? html`<p class="hint">MIDI bank ${sl.midi_bank} is chosen with Bank Select (CC0 = ${sl.midi_bank}) before the program changes: not yet verified on the ES-8.</p>` : null}
    <section class="section">
      <header><h3>Tracks</h3><p>In the order of the gig. Drag ⋮⋮ to reorder; a track can come back later in the set.</p></header>
      ${sl.songs.length ? html`<${Sortable} items=${sl.songs}
        onMove=${(from, to) => edit((l) => { l.songs = moved(l.songs, from, to); })}
        row=${(song, i) => {
          const part = parts[i];
          const [a, b] = ranges[i];
          return html`
            <span class="track-cell">
              <b>${part.track ? part.track.name : "missing track"}</b>
              <span class="muted small">${part.rig ? part.rig.name : "no rig"} · ${part.steps.map((st) => st.name).join(" → ") || "no step"}</span>
            </span>
            <span class="mono muted">${part.steps.length ? (a === b ? `PC ${a}` : `PC ${a}–${b}`) : "—"}</span>
            <span class="row-actions">
              ${part.track && song.track ? html`<button class="link" onClick=${() => go({ tab: "tracks", track: song.track })}>edit</button>` : null}
              <button class="x" title="Remove from the setlist" onClick=${() => edit((l) => { l.songs.splice(i, 1); })}>×</button>
            </span>`;
        }} />` : html`<p class="hint">No track in this setlist yet.</p>`}
      <div class="row">
        ${tracks.length ? html`<select value="" onChange=${(e) => {
          const id = e.target.value;
          e.target.value = "";
          if (id) edit((l) => { l.songs.push({ track: id }); });
        }}>
          <option value="">+ Add a track…</option>
          ${tracks.map(([id, t]) => html`<option value=${id}>${t.name}</option>`)}
        </select>` : null}
        <button class="link" onClick=${() => go({ tab: "tracks" })}>${tracks.length ? "Manage tracks" : "Create a track first"}</button>
      </div>
    </section>
    <section class="section">
      <header><h3>Program changes</h3><p>PC n recalls step n. After the last step, extra “next” presses stay on it.</p></header>
      ${total ? html`<table class="steps"><tbody>
        ${parts.flatMap((part, i) => part.steps.map((st, k) => html`<tr class=${k === 0 && i ? "song-start" : ""}>
          <td class="pc">PC ${ranges[i][0] + k}</td><td class="pl">${st.label}</td>
          <td>${k === 0 ? html`<b>${part.track ? part.track.name : "?"}</b> · ` : null}${st.name}</td></tr>`))}
      </tbody></table>` : html`<p class="hint">Add tracks to see the program changes.</p>`}
    </section>`;
}

// ================================================================= surfaces

function SurfacesTab({ s, doc, ui, go, preview }) {
  const surfaces = Object.entries(doc.surfaces || {});
  const sid = doc.surfaces && doc.surfaces[ui.surface] ? ui.surface : (surfaces[0] || [null])[0];
  const add = () => {
    const id = slug("surface", Object.keys(doc.surfaces || {}));
    project.update((d) => { d.surfaces = d.surfaces || {}; d.surfaces[id] = { schema: "es8ctl.surface/1", name: "New surface", switches: {} }; });
    go({ surface: id });
  };
  const usedBy = (id) => Object.values(doc.rigs || {}).filter((r) => r.surface === id);
  return html`
    <div class="body">
      <${SideList} current=${sid} onPick=${(id) => go({ surface: id })} onAdd=${add} addLabel="+ New surface"
        empty="A surface gives each footswitch a role in manual mode. Several rigs can share it."
        items=${surfaces.map(([id, sf]) => ({ id, badge: "⌗", name: sf.name, sub: `${plural(usedBy(id).length, "rig")}` }))} />
      <main class="center">
        ${sid ? html`<${SurfaceEditor} key=${sid} doc=${doc} sid=${sid} go=${go} usedBy=${usedBy(sid)} />`
          : html`<div class="empty-state"><h2>No surface yet</h2>
            <p>Decide once what each switch does in manual mode — toggle a MIDI parameter, switch a loop, tap the tempo — and reuse it across rigs.</p>
            <button class="btn primary" onClick=${add}>+ New surface</button></div>`}
      </main>
      <${Tray} s=${s} preview=${preview} />
    </div>`;
}

function roleText(sw, pb) {
  if (!sw) return "";
  if (sw.label) return sw.label;
  if (sw.role === "param") { const p = allParams(pb).find((x) => x.ref === sw.param); return p ? p.param.name || p.pid : sw.param; }
  if (sw.role === "loop") return `${sw.loop} ${loopTitle(pb, sw.loop)}`;
  if (sw.role === "tap") return "Tap";
  if (sw.role === "es8") return sw.function;
  if (sw.role === "companion") return (COMPANION_ACTIONS.find(([a]) => a === sw.action) || [, sw.action])[1];
  return "";
}

function SurfaceEditor({ doc, sid, go, usedBy }) {
  const sf = doc.surfaces[sid];
  const pb = pbOf(doc);
  const [sel, setSel] = useState("NUM1");
  const edit = (fn) => project.update((d) => fn(d.surfaces[sid], d));
  const switches = sf.switches || {};
  const assigns = Object.values(switches).filter((sw) => sw.role === "param" || sw.role === "companion").length;
  const SwitchBtn = ({ k, jack }) => {
    const sw = switches[k];
    return html`<button class="sw ${sw ? sw.role : ""}" aria-pressed=${sel === k} onClick=${() => setSel(k)}>
      <span class="led"></span>${jack ? null : html`<span class="cap"></span>`}
      <span class="key">${swName(k)}</span><span class="what">${roleText(sw, pb) || html`<span class="muted">—</span>`}</span>
    </button>`;
  };
  return html`
    <div class="head">
      <label class="field">Surface<input class="title" value=${sf.name} onInput=${(e) => edit((x) => { x.name = e.target.value; })} /></label>
      <span class="muted small">Used by ${usedBy.length ? usedBy.map((r) => r.name).join(", ") : "no rig"}</span>
      <span class="grow"></span>
      <button class="link danger" onClick=${() => {
        if (!confirm(`Delete the surface "${sf.name}"?`)) return;
        project.update((d) => { delete d.surfaces[sid]; Object.values(d.rigs || {}).forEach((r) => { if (r.surface === sid) r.surface = null; }); });
        go({ surface: null });
      }}>Delete surface</button>
    </div>
    <section class="section">
      <header><h3>Footswitches</h3><p>MIDI and Companion switches are plain buttons for ES8 Companion, which switches the parameters,
        moves through the setlist and shows what is on. They no longer recall patches (memory mode).</p></header>
      <div class="board">${BOARD.flat().map((k) => html`<${SwitchBtn} k=${k} />`)}</div>
      <div class="jacks">${JACKS.map((k) => html`<${SwitchBtn} k=${k} jack />`)}</div>
      <div class="meter"><span class="bar">${Array.from({ length: MAX_ASSIGNS }, (_, i) => html`<i class=${i < assigns ? "used" : ""}></i>`)}</span>
        <span>${assigns}/${MAX_ASSIGNS} assigns used by MIDI switches${assigns > MAX_ASSIGNS ? " — too many" : ""}</span></div>
    </section>
    <${SwitchEditor} k=${sel} sw=${switches[sel]} pb=${pb} edit=${edit} companion=${companionOf(doc)}
      groups=${[...new Set(Object.values(switches).map((x) => x.group).filter(Boolean))]} />
    <${CompanionSettings} doc=${doc} />`;
}

/** Canal et CC des switches « Companion » : un réglage du projet, qu'on ne change que s'il gêne un appareil. */
function CompanionSettings({ doc }) {
  const c = companionOf(doc);
  const used = Object.values((doc.pedalboard || {}).devices || {}).filter((d) => d.midi && d.midi.channel === c.channel);
  const onEs8 = Object.values((doc.pedalboard || {}).devices || {}).filter((d) => d.midi && d.midi.channel === c.es8_channel);
  const set = (patch) => project.update((d) => { d.companion = { ...companionOf(d), ...patch }; });
  return html`
    <section class="section">
      <header><h3>Switches → ES8 Companion</h3><p>Each switch sends its own CC on this channel: NUM1 = first CC, NUM2 = next one…
        ES8 Companion reads them from the show; change them only if they collide with something.</p></header>
      <div class="row">
        <label class="field inline">Channel<input type="number" min="1" max="16" value=${c.channel}
          onInput=${(e) => set({ channel: Math.max(1, Math.min(16, Number(e.target.value) || 16)) })} /></label>
        <label class="field inline">First CC<input type="number" min="0" max="112" value=${c.first_cc}
          onInput=${(e) => set({ first_cc: Math.max(0, Math.min(112, Number(e.target.value) || 0)) })} /></label>
        <span class="muted small">CC ${c.first_cc}–${c.first_cc + 15}</span>
        <label class="field inline" title="The ES-8 receives the setlist's program changes on this channel (written to the ES-8)">ES-8 channel
          <input type="number" min="1" max="16" value=${c.es8_channel}
          onInput=${(e) => set({ es8_channel: Math.max(1, Math.min(16, Number(e.target.value) || 1)) })} /></label>
      </div>
      ${onEs8.length ? html`<p class="error small">${onEs8.map((d) => d.name).join(", ")} also listen${onEs8.length === 1 ? "s" : ""} on channel ${c.es8_channel}:
        through the ES-8's MIDI OUT they get the setlist's program changes and Bank Select (CC0). Give the ES-8 another channel.</p>` : null}
      ${used.length ? html`<p class="error small">Channel ${c.channel} is used by ${used.map((d) => d.name).join(", ")}: pick another one.</p>` : null}
    </section>`;
}

function SwitchEditor({ k, sw, pb, edit, companion, groups }) {
  const role = sw ? sw.role : "";
  const set = (next) => edit((x) => { x.switches = x.switches || {}; if (next) x.switches[k] = next; else delete x.switches[k]; });
  const params = allParams(pb);
  const isNum = NUMS.includes(k);
  const roles = [["", "Unchanged"], ["param", "MIDI parameter"], ...(isNum ? [["loop", "Loop"]] : []), ["tap", "Tap tempo"], ["es8", "ES-8 function"], ["companion", "Companion"]];
  const pick = (r) => {
    const label = sw && sw.label;
    if (!r) set(null);
    else if (r === "param") set({ label, role: r, param: (params[0] || {}).ref || "", mode: "toggle" });
    else if (r === "loop") set({ label, role: r, loop: wiredLoops(pb).find((l) => l !== "LV") || "L1" });
    else if (r === "es8") set({ label, role: r, function: "MEM_U" });
    else if (r === "companion") set({ label, role: r, action: "next" });
    else set({ label, role: r });
  };
  return html`
    <div class="editor-box">
      <div class="row"><h2>${swName(k)}</h2><span class="grow"></span>
        ${sw ? html`<label class="field">Label<input value=${sw.label || ""} placeholder=${roleText({ ...sw, label: "" }, pb)}
          onInput=${(e) => set({ ...sw, label: e.target.value || undefined })} /></label>` : null}</div>
      <div class="roles">${roles.map(([r, label]) => html`<button aria-pressed=${role === r} onClick=${() => pick(r)}>${label}</button>`)}</div>
      ${role === "param" ? html`<div class="row">
        <label class="field">Parameter
          <select value=${sw.param} onChange=${(e) => set({ ...sw, param: e.target.value })}>
            ${params.map((p) => html`<option value=${p.ref}>${p.dev.name} · ${p.param.name || p.pid} (CC${p.param.cc}, ch ${p.dev.channel})</option>`)}
          </select></label>
        <label class="field">Behaviour
          <select value=${sw.mode || "toggle"} onChange=${(e) => set({ ...sw, mode: e.target.value })}>
            <option value="toggle">Toggle (latch)</option><option value="momentary">Momentary (while held)</option>
          </select></label>
        <label class="field" title="Leave empty to send the parameter's own 'on' value. Several switches on one parameter with their own values make a selector (e.g. Helix snapshots): pressing the active one goes back to 'off'.">Value when on
          <input type="number" min="0" max="127" placeholder=${String(((params.find((p) => p.ref === sw.param) || {}).param || {}).on ?? 127)}
            value=${sw.value ?? ""} onInput=${(e) => {
              const n = e.target.value === "" ? undefined : Math.max(0, Math.min(127, Number(e.target.value) || 0));
              const { value, ...rest } = sw; set(n === undefined ? rest : { ...rest, value: n });
            }} /></label>
        <label class="field" title="Switches with the same group name are exclusive: turning one on turns the others off.">Group
          <input list="sw-groups" value=${sw.group || ""} placeholder="none"
            onInput=${(e) => { const { group, ...rest } = sw; set(e.target.value.trim() ? { ...rest, group: e.target.value } : rest); }} />
          <datalist id="sw-groups">${(groups || []).map((g) => html`<option value=${g} />`)}</datalist></label>
      </div><p class="hint">The switch sends CC${switchCC(companion, k)} on channel ${companion.channel} to ES8 Companion, which switches this
        parameter on its device and shows its state. Uses one of the 12 assigns of every patch.${k.startsWith("NUM") ? "" : ` ${swName(k)} stops doing its own job.`}</p>` : null}
      ${role === "loop" ? html`<div class="row">
        <label class="field">Loop
          <select value=${sw.loop} onChange=${(e) => set({ ...sw, loop: e.target.value })}>
            ${LOOPS.filter((l) => l !== "LV").map((l) => html`<option value=${l} disabled=${!pb.loops || !pb.loops[l]}>${l} · ${loopTitle(pb, l)}</option>`)}
          </select></label>
      </div><p class="hint">A system setting (manual mode is shared by the whole ES-8): every surface must agree on it.</p>` : null}
      ${role === "tap" ? html`<p class="hint">The switch taps the master tempo.</p>` : null}
      ${role === "es8" ? html`<label class="field">Function
        <select value=${sw.function} onChange=${(e) => set({ ...sw, function: e.target.value })}>
          ${CTL_FUNCTIONS.map((f) => html`<option value=${f}>${f.replace("_", " ")}</option>`)}
        </select></label>` : null}
      ${role === "companion" ? html`<div class="row">
        <label class="field">Action
          <select value=${sw.action} onChange=${(e) => set({ ...sw, action: e.target.value })}>
            ${COMPANION_ACTIONS.map(([a, text]) => html`<option value=${a}>${text}</option>`)}
          </select></label>
      </div><p class="hint">The switch sends CC${switchCC(companion, k)} on channel ${companion.channel} to ES8 Companion, which does the action
        (and sends the program change). Uses one of the 12 assigns.${k.startsWith("NUM") ? "" : ` ${swName(k)} stops doing its own job.`}</p>` : null}
      ${!role ? html`<p class="hint">The switch keeps whatever it does on the ES-8 today.</p>` : null}
    </div>`;
}

// ================================================================= pedalboard

function PedalboardTab({ s, doc, preview }) {
  const pb = doc.pedalboard;
  const view = pbOf(doc);
  const edit = (fn) => project.update((d) => fn(d.pedalboard, d));
  const addDevice = () => edit((p) => {
    p.devices = p.devices || {};
    p.devices[slug("device", Object.keys(p.devices))] = { name: "New device", loops: [] };
  });
  return html`
    <div class="body two">
      <main class="center">
        <div class="head"><h2>Pedalboard</h2>
          <p class="muted small">Everything plugged into the ES-8. A device can sit in a loop, receive MIDI, or both.</p></div>
        <section class="section">
          <header><h3>ES-8 loops</h3><p>Which device is in each loop.</p></header>
          <div class="loop-strip">
            ${LOOPS.map((l) => {
              const v = view.loops[l];
              return html`<div class="slot ${v ? "used" : ""}"><b>${l === "LV" ? "V" : l}</b><span>${v ? v.name : "free"}</span></div>`;
            })}
          </div>
        </section>
        <section class="section">
          <header><h3>Devices</h3><p>Pedals, a DAW, an amp, a multi-effect…</p></header>
          <div class="devices">${Object.entries(pb.devices || {}).map(([did, d]) =>
            html`<${DeviceCard} key=${did} did=${did} d=${d} view=${view} edit=${edit} />`)}</div>
          <div><button class="btn" onClick=${addDevice}>+ Add a device</button></div>
        </section>
      </main>
      <${Tray} s=${s} preview=${preview} />
    </div>`;
}

function DeviceCard({ did, d, view, edit }) {
  const ed = (fn) => edit((p) => fn(p.devices[did], p));
  const midi = d.midi;
  const mode = midi ? midi.program_change || "pc" : "pc";
  const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  const loops = d.loops || [];
  const toggleLoop = (l) => ed((dev) => {
    dev.loops = dev.loops || [];
    dev.loops = dev.loops.includes(l) ? dev.loops.filter((x) => x !== l) : [...dev.loops, l].sort((a, b) => LOOPS.indexOf(a) - LOOPS.indexOf(b));
  });
  const setMidi = (on) => ed((dev, p) => {
    if (!on) { delete dev.midi; return; }
    const channels = Object.values(p.devices).filter((x) => x.midi).map((x) => x.midi.channel);
    let ch = 1;
    while (channels.includes(ch) && ch < 16) ch++;
    dev.midi = { channel: ch, program_change: "pc", programs: {}, params: {} };
  });
  const addItem = (key, item) => ed((dev) => {
    dev.midi[key] = dev.midi[key] || {};
    dev.midi[key][slug(item.name, Object.keys(dev.midi[key]))] = item;
  });
  return html`
    <div class="device ${midi ? "has-midi" : ""} ${loops.length ? "has-loop" : ""}">
      <div class="dev-top">
      <input class="dev-name" value=${d.name} aria-label="Device name" onInput=${(e) => ed((dev) => { dev.name = e.target.value; })} />
      <div class="connect">
        <div class="connect-row">
          <span class="connect-h">In a loop</span>
          <span class="loop-pick">${LOOPS.map((l) => {
            const owner = view.loops[l];
            const mine = loops.includes(l);
            const taken = owner && !mine;
            return html`<button class="lp ${mine ? "on" : ""}" disabled=${taken} aria-pressed=${mine}
              title=${taken ? `Used by ${owner.name}` : mine ? "Remove from this loop" : "Put in this loop"}
              onClick=${() => toggleLoop(l)}>${l === "LV" ? "V" : l.slice(1)}</button>`;
          })}</span>
          <span class="muted small">${loops.length ? loops.map((l) => (l === "LV" ? "V (volume loop)" : l)).join(" + ") : "not in a loop"}</span>
        </div>
        <div class="connect-row">
          <span class="connect-h">MIDI</span>
          <label class="switch"><input type="checkbox" checked=${Boolean(midi)} onChange=${(e) => setMidi(e.target.checked)} />
            <span>${midi ? "receives MIDI from the ES-8" : "no MIDI"}</span></label>
          ${midi ? html`
            <label class="field inline">Channel<input type="number" min="1" max="16" value=${midi.channel}
              onInput=${(e) => ed((dev) => { dev.midi.channel = num(e.target.value, 1, 16); })} /></label>
            <label class="field inline">Program change
              <select value=${mode} onChange=${(e) => ed((dev) => { dev.midi.program_change = e.target.value; })}>
                ${PC_MODES.map(([v, label]) => html`<option value=${v}>${label}</option>`)}</select></label>` : null}
        </div>
      </div>
      <button class="x" title="Remove this device" onClick=${() => { if (confirm(`Remove "${d.name}"?`)) edit((p) => { delete p.devices[did]; }); }}>×</button>
      </div>
      ${midi ? html`<div class="cols">
        ${mode !== "none" ? html`<div>
          <h3>Programs</h3>
          <table class="tbl"><thead><tr><th>Name</th><th>PC</th>${mode.includes("msb") ? html`<th>MSB</th>` : null}${mode.includes("lsb") ? html`<th>LSB</th>` : null}<th></th></tr></thead>
          <tbody>${Object.entries(midi.programs || {}).map(([pid, p]) => html`<tr>
            <td><input value=${p.name || ""} placeholder=${pid} onInput=${(e) => ed((dev) => { dev.midi.programs[pid].name = e.target.value; })} /></td>
            <td><input type="number" min="0" max="127" value=${p.pc} onInput=${(e) => ed((dev) => { dev.midi.programs[pid].pc = num(e.target.value, 0, 127); })} /></td>
            ${mode.includes("msb") ? html`<td><input type="number" min="0" max="127" value=${p.bank_msb ?? 0} onInput=${(e) => ed((dev) => { dev.midi.programs[pid].bank_msb = num(e.target.value, 0, 127); })} /></td>` : null}
            ${mode.includes("lsb") ? html`<td><input type="number" min="0" max="127" value=${p.bank_lsb ?? 0} onInput=${(e) => ed((dev) => { dev.midi.programs[pid].bank_lsb = num(e.target.value, 0, 127); })} /></td>` : null}
            <td><button class="x" onClick=${() => ed((dev) => { delete dev.midi.programs[pid]; })} aria-label="Remove">×</button></td></tr>`)}
          </tbody></table>
          <button class="link" onClick=${() => addItem("programs", { name: "Program", pc: 0, ...(mode.includes("msb") ? { bank_msb: 0 } : {}), ...(mode.includes("lsb") ? { bank_lsb: 0 } : {}) })}>+ program</button>
        </div>` : null}
        <div>
          <h3>Parameters (CC)</h3>
          <table class="tbl"><thead><tr><th>Name</th><th>CC</th><th>Off</th><th>On</th><th></th></tr></thead>
          <tbody>${Object.entries(midi.params || {}).map(([pid, p]) => html`<tr>
            <td><input value=${p.name || ""} placeholder=${pid} onInput=${(e) => ed((dev) => { dev.midi.params[pid].name = e.target.value; })} /></td>
            <td><input type="number" min="0" max="127" value=${p.cc} onInput=${(e) => ed((dev) => { dev.midi.params[pid].cc = num(e.target.value, 0, 127); })} /></td>
            <td><input type="number" min="0" max="127" value=${p.off ?? 0} onInput=${(e) => ed((dev) => { dev.midi.params[pid].off = num(e.target.value, 0, 127); })} /></td>
            <td><input type="number" min="0" max="127" value=${p.on ?? 127} onInput=${(e) => ed((dev) => { dev.midi.params[pid].on = num(e.target.value, 0, 127); })} /></td>
            <td><button class="x" onClick=${() => ed((dev) => { delete dev.midi.params[pid]; })} aria-label="Remove">×</button></td></tr>`)}
          </tbody></table>
          <button class="link" onClick=${() => addItem("params", { name: "Parameter", cc: 0 })}>+ parameter</button>
        </div>
      </div>` : null}
      ${!midi && !loops.length ? html`<p class="hint">Not connected yet: pick a loop and/or turn MIDI on.</p>` : null}
    </div>`;
}

render(html`<${App} />`, document.getElementById("root"));
E.boot();

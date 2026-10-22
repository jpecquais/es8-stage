// ES8 Stage : branche le moteur web de l'éditeur (es8/web/shared/engine.js) sur ce serveur.
// À importer avant le premier appel à `boot()` (ES8 Designer l'importe ; ES8 Control le reçoit du
// serveur, voir control.js). Points d'extension du moteur : `globalThis.ES8_ENGINE`.
//
// - Moteur Python : es8core + es8stage, pont `es8stage.webapp` (les fonctions de l'éditeur, plus les
//   rigs). Servie par un hôte de scène, la page n'est que l'écran : le pont tourne sur l'hôte
//   (`/stage/engine`, engine_host.py), sans Pyodide ni internet. Sinon, Pyodide charge `engine.zip`.
// - MIDI : si la page est servie par un hôte de scène (`es8stage serve --stage`, le Pi), c'est lui qui
//   tient le MIDI de l'ES-8. On lui passe les messages par HTTP et ses réponses arrivent en flux
//   (docs/stage-host.md, « Pont MIDI ») ; l'objet a la forme de celui de Web MIDI. Sinon, Web MIDI.
import { store, toast } from "../shared/engine.js";

const BASE = new URL("../", import.meta.url); // racine du serveur

async function stageHostState() {
  try {
    const r = await fetch(new URL("stage/state", BASE), { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const hostInfo = (state) => ({ edit: !!state.edit, connected: state.midi.connected, port: state.midi.port, playing: state.playing || null });

async function stageMidiAccess() {
  const state = await stageHostState();
  if (!state) return null; // pas d'hôte de scène : Web MIDI du navigateur
  store.set({ stageHost: hostInfo(state) });
  // L'état de l'hôte suit en direct (ES-8 branché ou non, mode édition, qui se coupe seul s'il est oublié).
  const follow = new EventSource(new URL("stage/events", BASE));
  follow.onmessage = (e) => {
    try {
      const next = hostInfo(JSON.parse(e.data));
      const cur = store.state.stageHost || {};
      if (["edit", "connected", "port", "playing"].some((k) => next[k] !== cur[k])) store.set({ stageHost: next });
    } catch { /* message abîmé : le suivant le remplace */ }
  };
  const name = `ES-8 via stage host${state.midi && state.midi.port ? ` (${state.midi.port.split(":")[0]})` : ""}`;
  const listeners = new Set();
  const input = {
    id: "stage-in", name, onmidimessage: null,
    addEventListener(type, fn) { if (type === "midimessage") listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
  };
  const events = new EventSource(new URL("stage/midi/events", BASE));
  events.onmessage = (e) => {
    let data;
    try { data = new Uint8Array(JSON.parse(e.data)); } catch { return; }
    const event = { data };
    if (input.onmidimessage) input.onmidimessage(event);
    listeners.forEach((fn) => fn(event));
  };
  // Le flux doit être ouvert avant le premier envoi : sinon la première réponse serait perdue.
  await new Promise((resolve) => { events.onopen = resolve; setTimeout(resolve, 3000); });
  // Envois dans l'ordre, groupés : un seul POST en vol à la fois.
  let queue = [];
  let flying = false;
  const flush = async () => {
    if (flying || !queue.length) return;
    flying = true;
    const batch = queue;
    queue = [];
    try {
      const res = await fetch(new URL("stage/midi", BASE), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: batch }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error || `The stage host refused the MIDI messages (${res.status}).`, "error", 0);
      }
    } catch {
      toast("The stage host does not answer.", "error");
    }
    flying = false;
    flush();
  };
  const output = { id: "stage-out", name, send(data) { queue.push(Array.from(data)); flush(); } };
  return { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), onstatechange: null };
}

// ---------------------------------------------------------------- pont Python sur l'hôte

const DEVICE = new Set(["read_device", "read_some", "read_names", "write_pending", "select_on_device"]);
const PURE = new Set(["names", "patch_names", "show_export"]); // ne dépendent que de leurs arguments : gardés
const toBase64 = (data) => {
  let binary = "";
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
};
const pack = (args) => args.filter((a) => typeof a !== "function")
  .map((a) => (a instanceof Uint8Array ? { $bytes: toBase64(a) } : a));
const unpack = (r) => (r && r.$bytes !== undefined ? Uint8Array.from(atob(r.$bytes), (c) => c.charCodeAt(0)) : r);

/** Appels du pont : synchrones (le moteur de l'éditeur les attend tels quels), sauf les échanges avec l'ES-8. */
function remoteBridge() {
  const url = new URL("stage/engine", BASE).href;
  const memo = new Map();
  const callNow = (fn, args) => {
    const body = JSON.stringify({ fn, args: pack(args) });
    if (PURE.has(fn) && memo.has(body)) return memo.get(body);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, false);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(body);
    let reply = {};
    try { reply = JSON.parse(xhr.responseText); } catch { /* réponse vide */ }
    if (xhr.status !== 200) throw new Error(reply.error || `The stage host does not answer (${xhr.status}).`);
    const result = unpack(reply.result);
    if (PURE.has(fn)) { if (memo.size > 200) memo.clear(); memo.set(body, result); }
    return result;
  };
  // Échange avec l'ES-8 : la réponse arrive à la fin ; l'avancement est relu en attendant.
  const callDevice = async (fn, args) => {
    const report = args.find((a) => typeof a === "function");
    let done = false;
    const watch = async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const p = await (await fetch(new URL("stage/engine/progress", BASE), { cache: "no-store" })).json();
          if (!done && report && p.running === fn && p.progress.length) report(...p.progress);
        } catch { /* l'appel principal dira l'erreur */ }
      }
    };
    watch();
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fn, args: pack(args) }) });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(reply.error || `The stage host does not answer (${res.status}).`);
      return unpack(reply.result);
    } finally {
      done = true;
    }
  };
  const special = {
    remote: true,
    then: undefined, // l'objet est rendu par une fonction async : ce n'est pas une promesse
    synced: () => JSON.parse(callNow("engine_status", [])).synced,
    set_sender: () => {}, // l'hôte envoie lui-même sur son port MIDI
    push: () => {}, // et reçoit lui-même les réponses de l'ES-8
    syx_bytes: (...args) => { const data = callNow("syx_bytes", args); return { toJs: () => data, destroy() {} }; },
  };
  return new Proxy({}, {
    get: (_, fn) => (fn in special ? special[fn]
      : typeof fn !== "string" ? undefined
        : DEVICE.has(fn) ? (...args) => callDevice(fn, args) : (...args) => callNow(fn, args)),
  });
}

globalThis.ES8_ENGINE = {
  zip: new URL("stage-shared/engine.zip", BASE).href,
  module: "es8stage.webapp",
  midiAccess: stageMidiAccess,
  bridge: async () => ((await stageHostState()) ? remoteBridge() : null),
};

/** Mode édition de l'hôte de scène : la Companion se met en pause et l'écriture sur l'ES-8 est permise. */
export async function setEditMode(on) {
  await fetch(new URL("stage/act", BASE), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "edit", on }) })
    .catch(() => toast("The stage host does not answer.", "error"));
  const state = await stageHostState();
  if (state) store.set({ stageHost: hostInfo(state) });
}

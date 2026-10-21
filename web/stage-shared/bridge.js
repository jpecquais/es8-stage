// ES Eight Stage : branche le moteur web de l'éditeur (es8/web/shared/engine.js) sur ce serveur.
// À importer avant le premier appel à `boot()` (ES8 Designer l'importe ; ES8 Control le reçoit du
// serveur, voir control.js). Points d'extension du moteur : `globalThis.ES8_ENGINE`.
//
// - Moteur Python : es8core + es8stage (`engine.zip`), pont `es8stage.webapp` (les fonctions de
//   l'éditeur, plus les rigs).
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

const hostInfo = (state) => ({ edit: !!state.edit, connected: state.midi.connected, port: state.midi.port });

async function stageMidiAccess() {
  const state = await stageHostState();
  if (!state) return null; // pas d'hôte de scène : Web MIDI du navigateur
  store.set({ stageHost: hostInfo(state) });
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

globalThis.ES8_ENGINE = {
  zip: new URL("stage-shared/engine.zip", BASE).href,
  module: "es8stage.webapp",
  midiAccess: stageMidiAccess,
};

/** Mode édition de l'hôte de scène : la Companion se met en pause et l'écriture sur l'ES-8 est permise. */
export async function setEditMode(on) {
  await fetch(new URL("stage/act", BASE), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "edit", on }) })
    .catch(() => toast("The stage host does not answer.", "error"));
  const state = await stageHostState();
  if (state) store.set({ stageHost: hostInfo(state) });
}

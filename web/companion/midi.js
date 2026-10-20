// ES8 Companion — transport MIDI. Tout le reste de l'app passe par cette
// petite interface, pour qu'un pont natif (iOS, sans Web MIDI) puisse
// remplacer Web MIDI sans rien toucher d'autre :
//
//   ports()          → { inputs: [{id, name}], outputs: [{id, name}] }
//   use(inId, outId) → choisit les ports (id vide = aucun)
//   send(bytes)      → envoie sur la sortie ; false si aucune sortie
//   onMessage(cb)    → cb(data: Uint8Array) pour chaque message de l'entrée
//   onPortsChange(cb)

/** Ouvre Web MIDI, sans SysEx. Rejette avec "insecure", "unsupported" ou "denied". */
export async function openWebMidi() {
  // Les navigateurs ne donnent le MIDI qu'aux pages sûres (HTTPS ou localhost) : une adresse
  // http://<machine>.local du réseau n'y a pas droit, même dans un navigateur qui le gère.
  if (!window.isSecureContext) throw new Error("insecure");
  if (!navigator.requestMIDIAccess) throw new Error("unsupported");
  let access;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch {
    throw new Error("denied");
  }
  let input = null;
  let output = null;
  let messageCb = () => {};
  let portsCb = () => {};
  const list = (map) => [...map.values()].map((p) => ({ id: p.id, name: p.name }));
  const onMidi = (e) => messageCb(e.data);

  const transport = {
    ports: () => ({ inputs: list(access.inputs), outputs: list(access.outputs) }),
    use(inId, outId) {
      if (input) input.onmidimessage = null;
      input = (inId && access.inputs.get(inId)) || null;
      output = (outId && access.outputs.get(outId)) || null;
      if (input) input.onmidimessage = onMidi;
    },
    send(bytes) {
      if (!output) return false;
      output.send(bytes);
      return true;
    },
    onMessage(cb) { messageCb = cb; },
    onPortsChange(cb) { portsCb = cb; },
  };
  access.onstatechange = () => portsCb();
  return transport;
}

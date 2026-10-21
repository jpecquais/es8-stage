// Les applis d'un hôte de scène, pour passer de l'une à l'autre (Designer, Control ; la Companion et la
// page de l'hôte ont leurs propres liens). Adresses relatives à la racine du serveur.
export const APPS = [
  ["companion", "Companion"],
  ["designer", "Designer"],
  ["control", "Control"],
  ["host", "Stage host"],
];

/** Les applis sauf `current`, avec leur adresse depuis une page d'appli (`../<id>/`). */
export const otherApps = (current) => APPS.filter(([id]) => id !== current).map(([id, label]) => ({ id, label, href: `../${id}/` }));

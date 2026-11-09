// Textes des notifications (cloche, système, téléphone) en français : erreurs du moteur
// traduites à l'affichage (le texte brut, reconnu ailleurs par motif, n'est pas modifié chez
// le producteur) et espace insécable avant « : ; ? ! % » et à l'intérieur des guillemets.
import { erreurMoteurEnFrancais } from "../../lib/erreursMoteur";

const NB = "\u00a0";

/** Espaces insécables de la typographie française (les adresses « http:// » ne bougent pas). */
export function typographie(texte: string): string {
  return String(texte ?? "")
    .replace(/[ \u202f]+([:;?!%»])/g, `${NB}$1`)
    .replace(/«[ \u202f]+/g, `«${NB}`);
}

/** Préfixes posés par les producteurs devant une erreur brute. */
const PREFIXES_ERREUR = /^(Échec|Lancement impossible|Envoi impossible|Compaction impossible)\s*:\s*/u;

/** Erreur brute du moteur (anglais) -> français ; un préfixe français déjà posé est gardé. */
export function erreurEnFrancais(texte: string): string {
  const brut = String(texte ?? "");
  const m = PREFIXES_ERREUR.exec(brut);
  if (m) return `${m[1]}${NB}: ${erreurMoteurEnFrancais(brut.slice(m[0].length))}`;
  return erreurMoteurEnFrancais(brut);
}

/** Textes par défaut du moteur, gardés en anglais chez lui (comparés ailleurs). */
const PAR_DEFAUT: Record<string, string> = {
  "new conversation": "Nouvelle conversation",
  untitled: "Sans titre",
};

/** Titre ou corps d'une notification tel qu'il est montré. */
export function texteNotification(texte: string): string {
  const brut = String(texte ?? "");
  const defaut = PAR_DEFAUT[brut.trim().toLowerCase()];
  return typographie(defaut ?? erreurEnFrancais(brut));
}

/** Signalement prêt pour le centre : titre et corps en français. */
export function franciser<T extends { titre: string; texte: string }>(s: T): T {
  return { ...s, titre: texteNotification(s.titre), texte: texteNotification(s.texte) };
}

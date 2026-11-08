// Appel unique au modèle (commande Tauri `ia_appel_unique`) : un seul échange,
// sans session, sans outils, sans harnais, avec les comptes de l'appli.
import { invoke } from "@tauri-apps/api/core";

export interface AppelUniqueOptions {
  /** Consigne système, facultative. */
  systeme?: string;
  /** `fournisseur/modèle` ; défaut : modèle des sous-agents des Réglages, sinon `modeleConversation`. */
  modele?: string;
  /** Plafond de sortie en jetons (défaut 4 000). */
  plafond?: number;
  /** Modèle de la conversation ouverte (`fournisseur/modèle`), en dernier repli. */
  modeleConversation?: string;
}

export interface AppelUniqueReponse {
  texte: string;
  /** `fournisseur/modèle` réellement appelé. */
  modele: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    reasoning_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
  /** Vrai quand la réponse a été coupée par le plafond. */
  tronque: boolean;
}

export function appelUnique(texte: string, options: AppelUniqueOptions = {}): Promise<AppelUniqueReponse> {
  return invoke<AppelUniqueReponse>("ia_appel_unique", { input: { texte, ...options } });
}

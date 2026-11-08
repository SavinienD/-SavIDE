// Ctrl+K « Aller à » : dossiers récents, conversations de tous les dossiers,
// sous-agents, onglets ouverts, terminaux, sections des Réglages ; et, dès 2 lettres, les
// conversations dont le TEXTE contient les mots tapés (extrait autour du mot).
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { fileIcon } from "../../lib/fileIcon";
import { loadRecents } from "../../lib/recents";
import { agentsApi, STATUS_LABEL, type SessionMeta } from "../agents/agentsApi";
import { conversationTitle, displayPath, folderName, relativeTime, samePath } from "../freechat/freechatApi";
import { getActiveConnection } from "../settings/connectionsApi";
import { demanderSectionReglages } from "../../lib/sectionReglages";
import { SECTIONS_REGLAGES } from "./indexReglages";
import { allerAuReglage, tousLesReglages } from "./rechercheReglages";
import { Palette, type ElementPalette } from "./Palette";
import {
  listerConversations,
  rechercherConversations,
  type ListeConversations,
  type RechercheConversations,
} from "./paletteApi";
import { elementsAller, idElement, marquesExtrait, ouOuvrir, terminauxDuDossier, type Source } from "./sourcesAller";

/** Ce que l'écran courant sait faire (absent = pas proposé). */
export type ContexteAller = {
  /** Dossier ouvert (absent sur l'accueil). */
  dossier?: string;
  disposition?: "ide" | "chat";
  ongletsChat?: { id: string; titre: string }[];
  ongletsFichiers?: { relativePath: string }[];
  conversationActive?: string;
  choisirConversation?: (id: string) => unknown;
  ouvrirFichier?: (chemin: string) => unknown;
  ouvrirDossier?: (chemin: string, conversationId?: string) => unknown;
  ouvrirLibre?: (conversationId?: string) => unknown;
  ouvrirReglages?: () => unknown;
  afficherTerminal?: () => unknown;
  /** Actions supplémentaires (« Ouvrir dans VS Code »…), avec leur effet. */
  actions?: { source: Source; faire: () => unknown }[];
};

const MIN_CONTENU = 2;
const DELAI_CONTENU_MS = 200;

/** Clic sur l'onglet du panneau Terminal qui porte ce titre (le panneau vient d'être affiché). */
function activerOngletTerminal(titre: string, essais = 20): void {
  const onglet = Array.from(document.querySelectorAll<HTMLElement>(".terminal-panel .terminal-tab")).find(
    (t) => t.querySelector(".terminal-tab__label")?.textContent?.trim() === titre,
  );
  if (onglet) onglet.click();
  else if (essais > 0) requestAnimationFrame(() => activerOngletTerminal(titre, essais - 1));
}

export function PaletteAller({ contexte, onFermer }: { contexte: ContexteAller; onFermer: () => void }) {
  const [requete, setRequete] = useState("");
  const [liste, setListe] = useState<ListeConversations | null>(null);
  const [sousAgents, setSousAgents] = useState<SessionMeta[]>([]);
  const [contenu, setContenu] = useState<{ requete: string; r: RechercheConversations } | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreurContenu, setErreurContenu] = useState<string | null>(null);
  const contexteRef = useRef(contexte);
  contexteRef.current = contexte;

  useEffect(() => {
    let vivant = true;
    listerConversations()
      .then((l) => vivant && setListe(l))
      .catch(() => vivant && setListe({ racineLibre: "", conversations: [] }));
    if (contexteRef.current.disposition === "ide") {
      agentsApi
        .list()
        .then((s) => vivant && setSousAgents(s))
        .catch(() => undefined);
    }
    // Préchauffage : les textes des conversations sont lus pendant qu'on tape.
    void rechercherConversations("").catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, []);

  // Recherche dans le contenu, après une courte pause de frappe.
  useEffect(() => {
    const q = requete.trim();
    if (q.length < MIN_CONTENU) {
      setContenu(null);
      setEnCours(false);
      return;
    }
    let vivant = true;
    setEnCours(true);
    const minuterie = window.setTimeout(() => {
      rechercherConversations(q)
        .then((r) => {
          if (!vivant) return;
          setContenu({ requete: q, r });
          setErreurContenu(null);
        })
        .catch((e) => vivant && setErreurContenu(e instanceof Error ? e.message : String(e)))
        .finally(() => vivant && setEnCours(false));
    }, DELAI_CONTENU_MS);
    return () => {
      vivant = false;
      window.clearTimeout(minuterie);
    };
  }, [requete]);

  const { sources, effets } = useMemo(() => {
    const c = contexte;
    const sources: Source[] = [];
    const effets = new Map<string, () => unknown>();
    const ajouter = (s: Source, faire: () => unknown) => {
      sources.push(s);
      effets.set(idElement(s), faire);
    };
    const racineLibre = liste?.racineLibre ?? "";
    const ouvrirConversation = (id: string, dossier: string) => {
      const ou = ouOuvrir(dossier, c.dossier, racineLibre);
      if (ou === "ici" && c.choisirConversation) return c.choisirConversation(id);
      if (ou === "libre") return c.ouvrirLibre?.(id);
      return c.ouvrirDossier?.(dossier, id);
    };
    (c.ongletsChat ?? []).forEach((o, i) =>
      ajouter(
        { genre: "onglet", id: o.id, titre: o.titre, detail: "Conversation", icone: "solar:chat-round-dots-linear", indication: o.id === c.conversationActive ? "active" : undefined, ordre: i },
        () => c.choisirConversation?.(o.id),
      ),
    );
    (c.ongletsFichiers ?? []).forEach((o, i) => {
      const coupe = o.relativePath.lastIndexOf("/") + 1;
      ajouter(
        { genre: "fichier", id: o.relativePath, titre: o.relativePath.slice(coupe), detail: coupe ? o.relativePath.slice(0, coupe - 1) : undefined, icone: fileIcon(o.relativePath.slice(coupe)), ordre: 100 + i },
        () => c.ouvrirFichier?.(o.relativePath),
      );
    });
    (liste?.conversations ?? []).forEach((v, i) =>
      ajouter(
        {
          genre: "conversation",
          id: v.id,
          titre: conversationTitle(v.titre),
          detail: racineLibre && samePath(v.dossier, racineLibre) ? "Sans dossier" : folderName(v.dossier),
          icone: "solar:chat-line-linear",
          indication: relativeTime(v.majMs),
          ordre: i,
        },
        () => ouvrirConversation(v.id, v.dossier),
      ),
    );
    loadRecents().forEach((r, i) => {
      const ici = Boolean(c.dossier && samePath(r.path, c.dossier));
      ajouter(
        { genre: "dossier", id: r.path, titre: r.name || folderName(r.path), detail: displayPath(r.path), icone: "solar:folder-linear", indication: ici ? "ouvert" : relativeTime(r.lastOpenedMs), ordre: i },
        () => (ici ? undefined : c.ouvrirDossier?.(r.path)),
      );
    });
    const parId = new Map(sousAgents.map((s) => [s.id, s]));
    sousAgents
      .filter((s) => s.parentId && !s.archived)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, 30)
      .forEach((s, i) =>
        ajouter(
          { genre: "sousAgent", id: s.id, titre: s.name, detail: parId.get(s.parentId!)?.name, icone: "solar:branching-paths-down-linear", indication: STATUS_LABEL[s.status], ordre: i },
          () => window.dispatchEvent(new CustomEvent("axe:open-agent-journal", { detail: { id: s.id, title: s.name, conn: getActiveConnection() } })),
        ),
      );
    if (c.dossier && c.disposition === "ide" && c.afficherTerminal) {
      terminauxDuDossier(c.dossier).forEach((t, i) =>
        ajouter({ genre: "terminal", id: t.id, titre: t.titre, icone: "solar:command-linear", ordre: i }, () => {
          c.afficherTerminal?.();
          activerOngletTerminal(t.titre);
        }),
      );
    }
    if (c.ouvrirReglages) {
      SECTIONS_REGLAGES.forEach((s, i) =>
        ajouter({ genre: "reglage", id: s.id, titre: s.titre, detail: "Réglages", icone: s.icone, ordre: i }, () => {
          c.ouvrirReglages?.();
          demanderSectionReglages(s.id);
        }),
      );
      // Chaque réglage connu (et chaque raccourci), seulement quand on tape.
      tousLesReglages().forEach((r, i) => {
        const s = SECTIONS_REGLAGES.find((x) => x.id === r.section);
        ajouter(
          { genre: "reglage", id: `${r.section}:${r.titre}`, titre: r.titre, detail: `Réglages › ${s?.titre ?? ""}`, cle: r.motsCles, icone: s?.icone ?? "solar:settings-linear", ordre: 100 + i, seulementSiCherche: true },
          () => {
            c.ouvrirReglages?.();
            allerAuReglage(r.section, r.titre);
          },
        );
      });
    }
    for (const a of c.actions ?? []) ajouter(a.source, a.faire);
    return { sources, effets };
  }, [contexte, liste, sousAgents]);

  const cherche = useDeferredValue(requete);
  const elements = useMemo<ElementPalette[]>(() => {
    const base = elementsAller(cherche, sources);
    if (!contenu || !cherche.trim()) return base;
    const extraits = contenu.r.resultats.map<ElementPalette>((r) => ({
      id: `extrait:${r.conversationId}`,
      icone: r.role === "assistant" ? "solar:chat-round-line-linear" : "solar:user-speak-rounded-linear",
      titre: conversationTitle(r.titre),
      detail: r.extrait,
      marquesDetail: marquesExtrait(r.extrait, contenu.requete),
      indication: r.messages > 1 ? `${r.messages} messages` : relativeTime(r.majMs),
      groupe: "Dans les conversations",
      genre: "extrait",
    }));
    return [...base, ...extraits];
  }, [cherche, sources, contenu]);

  const choisir = (el: ElementPalette) => {
    onFermer();
    if (el.id.startsWith("extrait:")) {
      const id = el.id.slice("extrait:".length);
      const r = contenu?.r.resultats.find((x) => x.conversationId === id);
      if (!r) return;
      const ou = ouOuvrir(r.dossier, contexteRef.current.dossier, liste?.racineLibre ?? "");
      if (ou === "ici" && contexteRef.current.choisirConversation) void contexteRef.current.choisirConversation(id);
      else if (ou === "libre") void contexteRef.current.ouvrirLibre?.(id);
      else void contexteRef.current.ouvrirDossier?.(r.dossier, id);
      return;
    }
    void effets.get(el.id)?.();
  };

  const note = erreurContenu
    ? `Recherche dans les conversations impossible\u00a0: ${erreurContenu}`
    : enCours
      ? "Recherche dans le texte des conversations…"
      : contenu && requete.trim()
        ? `Texte de ${contenu.r.conversations.toLocaleString("fr-FR")} conversations parcouru en ${contenu.r.dureeMs.toLocaleString("fr-FR")} ms${contenu.r.tronque ? " (30 premières)" : ""}`
        : null;
  const etat = !liste ? "Chargement…" : !elements.length ? (enCours ? "Recherche…" : "Rien ne correspond") : null;
  return (
    <Palette
      titre="Aller à"
      genre="aller"
      placeholder="Dossier, conversation, onglet, terminal, réglage, ou texte d'une conversation"
      requete={requete}
      onRequete={setRequete}
      elements={elements}
      etat={etat}
      note={note}
      aide={[
        { touches: "Entrée", action: "aller" },
        { touches: "Échap", action: "fermer" },
      ]}
      onChoisir={(el) => choisir(el)}
      onFermer={onFermer}
    />
  );
}

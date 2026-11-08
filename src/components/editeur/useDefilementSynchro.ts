// Défilement synchronisé de l'éditeur Monaco et de l'aperçu Markdown (côte à côte).
// La ligne en haut de l'éditeur est amenée en haut de l'aperçu et inversement ; les ancres
// « data-ligne » de l'aperçu sont mesurées une fois, puis remesurées quand le texte ou la taille
// change (images chargées, colonne élargie). Un défilement provoqué par la synchro ne revient pas
// dans l'autre sens. L'aperçu porte data-defile = haut | milieu | bas.

import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { lignePourY, nettoyerAncres, positionDefilement, yPourLigne, type Ancre } from "./defilementSynchro";

function mesurerAncres(apercu: HTMLElement, nbLignes: number): Ancre[] {
  const base = apercu.getBoundingClientRect().top - apercu.scrollTop;
  const brutes: Ancre[] = [{ ligne: 1, y: 0 }];
  for (const el of apercu.querySelectorAll<HTMLElement>("[data-ligne]")) {
    brutes.push({ ligne: Number(el.dataset.ligne), y: el.getBoundingClientRect().top - base });
  }
  brutes.push({ ligne: nbLignes + 1, y: apercu.scrollHeight });
  return nettoyerAncres(brutes);
}

function ligneEnHaut(editeur: Monaco.editor.IStandaloneCodeEditor): number {
  const haut = editeur.getScrollTop();
  const ligne = editeur.getVisibleRanges()[0]?.startLineNumber ?? 1;
  const debut = editeur.getTopForLineNumber(ligne);
  const hauteur = Math.max(1, editeur.getTopForLineNumber(ligne + 1) - debut);
  return ligne + Math.min(1, Math.max(0, (haut - debut) / hauteur));
}

function hautPourLigne(editeur: Monaco.editor.IStandaloneCodeEditor, ligne: number): number {
  const n = Math.max(1, Math.floor(ligne));
  const debut = editeur.getTopForLineNumber(n);
  return debut + (ligne - n) * Math.max(0, editeur.getTopForLineNumber(n + 1) - debut);
}

export function useDefilementSynchro(
  editeur: Monaco.editor.IStandaloneCodeEditor | null,
  apercu: HTMLElement | null,
  actif: boolean,
  texte: string,
  version: number,
): void {
  const ancresRef = useRef<Ancre[] | null>(null);
  useEffect(() => {
    ancresRef.current = null;
  }, [texte]);

  useEffect(() => {
    if (!actif || !editeur || !apercu || !editeur.getModel()) return;
    ancresRef.current = null;
    const ancres = () => {
      if (!ancresRef.current) ancresRef.current = mesurerAncres(apercu, editeur.getModel()?.getLineCount() ?? 1);
      return ancresRef.current;
    };
    const marquer = () => {
      apercu.dataset.defile = positionDefilement(apercu.scrollTop, apercu.scrollHeight, apercu.clientHeight);
    };
    let attendu: { y: number; t: number } | null = null;
    let depuisApercuEnCours = false;

    const depuisEditeur = () => {
      if (depuisApercuEnCours) return;
      const max = Math.max(0, apercu.scrollHeight - apercu.clientHeight);
      const finEditeur = editeur.getScrollTop() >= editeur.getScrollHeight() - editeur.getLayoutInfo().height - 1;
      const cible = editeur.getScrollTop() <= 0 ? 0 : finEditeur ? max : Math.min(max, Math.round(yPourLigne(ancres(), ligneEnHaut(editeur))));
      if (Math.abs(apercu.scrollTop - cible) >= 1) {
        attendu = { y: cible, t: performance.now() };
        apercu.scrollTop = cible;
      }
      marquer();
    };
    const depuisApercu = () => {
      marquer();
      if (attendu && Math.abs(apercu.scrollTop - attendu.y) < 3 && performance.now() - attendu.t < 600) {
        attendu = null;
        return;
      }
      attendu = null;
      const max = Math.max(0, apercu.scrollHeight - apercu.clientHeight);
      const maxEditeur = Math.max(0, editeur.getScrollHeight() - editeur.getLayoutInfo().height);
      const haut =
        apercu.scrollTop <= 0 ? 0 : apercu.scrollTop >= max - 1 ? maxEditeur : hautPourLigne(editeur, lignePourY(ancres(), apercu.scrollTop));
      depuisApercuEnCours = true;
      editeur.setScrollTop(haut, 1 /* ScrollType.Immediate */);
      depuisApercuEnCours = false;
    };

    const abonnement = editeur.onDidScrollChange((e) => {
      if (e.scrollTopChanged) depuisEditeur();
    });
    apercu.addEventListener("scroll", depuisApercu, { passive: true });
    const observateur = new ResizeObserver(() => {
      ancresRef.current = null;
    });
    observateur.observe(apercu);
    if (apercu.firstElementChild) observateur.observe(apercu.firstElementChild);
    const image = window.requestAnimationFrame(depuisEditeur);
    return () => {
      window.cancelAnimationFrame(image);
      abonnement.dispose();
      apercu.removeEventListener("scroll", depuisApercu);
      observateur.disconnect();
    };
  }, [actif, editeur, apercu, version]);
}

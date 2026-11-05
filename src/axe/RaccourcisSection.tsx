import { useMemo, useState } from "react";
import { RACCOURCIS, combinaisonAffichee } from "./raccourcis";
import { estMac, formaterRaccourci } from "../lib/plateforme";

/** raccourcis — Settings > Raccourcis : pense-bête en lecture seule, lu
 *  directement dans le registre (axe/raccourcis.ts), avec recherche. */
export function RaccourcisSection() {
  const [q, setQ] = useState("");
  const groupes = useMemo(() => {
    const n = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const f = n(q.trim());
    const liste = RACCOURCIS.filter(
      (r) => !f || n(`${r.libelle} ${r.combinaison} ${combinaisonAffichee(r)} ${r.categorie}`).includes(f),
    );
    const m = new Map<string, typeof liste>();
    for (const r of liste) m.set(r.categorie, [...(m.get(r.categorie) ?? []), r]);
    return [...m.entries()];
  }, [q]);

  return (
    <div className="axe-appearance axe-raccourcis" data-mac={estMac() ? "true" : "false"}>
      <header>
        <h2>Raccourcis</h2>
        <p className="axe-appearance__hint">
          Tous les raccourcis clavier de SavIDE.{estMac() ? " ⌘ = Cmd, ⌥ = Option, ⇧ = Maj." : ""}
        </p>
      </header>
      <section className="axe-appearance__block">
        <input
          type="search"
          className="axe-appearance__hex"
          style={{ width: "100%" }}
          placeholder="Rechercher une action ou une touche…"
          aria-label="Rechercher un raccourci"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </section>
      {groupes.length === 0 ? (
        <p className="axe-appearance__hint">Aucun raccourci ne correspond.</p>
      ) : (
        groupes.map(([categorie, liste]) => (
          <section key={categorie} className="axe-appearance__block">
            <h3>{categorie}</h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {liste.map((r) => (
                  <tr key={r.id} data-raccourci={r.id} style={{ borderBottom: "1px solid var(--line-0, rgba(128,128,128,.2))" }}>
                    <td style={{ padding: "6px 0" }}>
                      {r.libelle}
                      {r.windowsSeulement ? " (Windows)" : r.macSeulement ? " (macOS)" : ""}
                    </td>
                    <td style={{ padding: "6px 0 6px 12px", textAlign: "right" }}>
                      <kbd style={{ display: "inline-block", whiteSpace: "normal", overflowWrap: "anywhere", fontFamily: "var(--font-mono, monospace)", padding: "2px 6px", border: "1px solid var(--line-1, rgba(128,128,128,.4))", borderRadius: 4 }}>
                        {formaterRaccourci(r.combinaison)}
                      </kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}

// Faux compteur Axe Cloud : imite les réponses d'ERREUR du vrai compteur (127.0.0.1:8096,
// ~/compteur-axe/app.py, fonction erreur_anthropic) pour montrer leur affichage sans vraie clé.
// Aucune requête ne part vers Anthropic. Usage :
//   node scripts/faux-compteur/faux-compteur.mjs <port> <statut>   (statut : 401 403 429 502 503)
// Chaque appel reçu est noté sur la sortie (méthode, chemin, statut renvoyé, jamais la clé).
import http from "node:http";

const REPONSES = {
  // [type Anthropic, message du compteur, en-tête x-should-retry: false]
  401: ["authentication_error", "Clé Axe invalide ou révoquée.", false],
  403: ["permission_error", "Compte désactivé : l'IA n'est pas accessible.", false],
  429: ["rate_limit_error", "Plafond mensuel IA atteint (20,00 €). Demande à l'administrateur de le relever.", true],
  502: ["api_error", "Anthropic injoignable depuis le serveur, réessaie.", false],
  503: ["api_error", "Clé Anthropic du serveur indisponible. Préviens l'administrateur.", true],
};
const port = Number(process.argv[2] ?? 18096);
const statut = Number(process.argv[3] ?? 503);
const [genre, message, pasDeRelance] = REPONSES[statut] ?? REPONSES[503];
let n = 0;
http
  .createServer((req, res) => {
    n += 1;
    const cle = String(req.headers["x-api-key"] ?? "");
    const morceaux = [];
    req.on("data", (d) => morceaux.push(d));
    req.on("end", () => {
      // Résumé de la demande (jamais la clé ni le texte) : modèle, réflexion, flux.
      let resume = "";
      try {
        const c = JSON.parse(Buffer.concat(morceaux).toString("utf8"));
        resume = ` [model=${c.model} max_tokens=${c.max_tokens} stream=${c.stream} thinking=${JSON.stringify(c.thinking ?? null)} output_config=${JSON.stringify(c.output_config ?? null)} beta=${req.headers["anthropic-beta"] ?? "-"}]`;
      } catch {
        /* corps illisible */
      }
      const corps = JSON.stringify({ type: "error", error: { type: genre, message } });
      const entetes = { "Content-Type": "application/json; charset=utf-8" };
      if (pasDeRelance) entetes["x-should-retry"] = "false";
      res.writeHead(statut, entetes);
      res.end(corps);
      console.log(`${new Date().toISOString()} appel ${n} : ${req.method} ${req.url} clé ${cle ? cle.slice(0, 4) + "…" : "absente"} → ${statut} ${genre}${resume}`);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`faux compteur sur 127.0.0.1:${port}, répond ${statut} (${genre}) : ${message}`));

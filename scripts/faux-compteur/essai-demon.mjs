// Pilote un démon Axecode LOCAL (socket unix) : crée une session avec un modèle Axe Cloud,
// envoie « bonjour », note les événements jusqu'à la fin du tour et affiche l'erreur de tour
// telle que l'appli la reçoit (turn_error → AgentEvent::Error, daemon_client.rs).
// Usage : node scripts/faux-compteur/essai-demon.mjs <socket> <dossier de travail> [fournisseur/modèle[@effort]]
// Note aussi les entrées de journal « turn_error » diffusées en `entry` (échec avant le compteur).
import net from "node:net";

const [socket, dossier, modele = "axe-cloud/claude-haiku-5-5"] = process.argv.slice(2);
const [ref, effort] = modele.split("@");
const [provider, name] = ref.split("/");
const c = net.connect(socket);
let id = 0;
const attentes = new Map();
let tampon = "";
let sessionId = null;
let enCours = false;
const evenements = [];
const appeler = (method, params = {}) =>
  new Promise((resolve, reject) => {
    id += 1;
    attentes.set(id, { resolve, reject });
    c.write(JSON.stringify({ id, method, params }) + "\n");
  });
function fin(code) {
  console.log("événements du tour :", evenements.join(" | "));
  c.end();
  process.exit(code);
}
c.on("data", (d) => {
  tampon += d.toString("utf8");
  let i;
  while ((i = tampon.indexOf("\n")) >= 0) {
    const ligne = tampon.slice(0, i);
    tampon = tampon.slice(i + 1);
    if (!ligne.trim()) continue;
    const m = JSON.parse(ligne);
    if (m.event) {
      if (m.sessionId !== sessionId) continue;
      if (m.event === "stream") {
        const t = m.data?.event?.type ?? "?";
        evenements.push(t);
        if (t === "turn_error") console.log("ERREUR DE TOUR reçue par l'appli :", JSON.stringify(m.data.event.error));
      } else if (m.event === "entry") {
        if (m.data?.kind === "extension") {
          evenements.push(`entry:${m.data.name}`);
          if (m.data.name === "turn_error") console.log("ERREUR DE TOUR (entrée de journal) :", JSON.stringify(m.data.payload?.error));
        }
      } else if (m.event === "status") {
        evenements.push(`status:${m.data?.status}`);
        if (m.data?.status === "running") enCours = true;
        else if (enCours) fin(0);
      }
    } else if (attentes.has(m.id)) {
      const a = attentes.get(m.id);
      attentes.delete(m.id);
      if (m.error) a.reject(new Error(m.error));
      else a.resolve(m.result);
    }
  }
});
c.on("connect", async () => {
  try {
    await appeler("hello", { client: "essai-faux-compteur" });
    const model = effort ? { provider, name, effort } : { provider, name };
    const meta = await appeler("sessions.create", { name: "essai faux compteur", workspaceId: dossier, model });
    sessionId = meta.id;
    console.log(`session ${sessionId.slice(0, 8)} modèle ${provider}/${name}${effort ? " effort " + effort : ""}`);
    await appeler("sessions.attach", { sessionId });
    await appeler("sessions.send", { sessionId, text: "bonjour" });
  } catch (err) {
    console.log("échec :", String(err));
    fin(1);
  }
});
setTimeout(() => {
  console.log("délai dépassé (180 s)");
  fin(2);
}, 180_000);

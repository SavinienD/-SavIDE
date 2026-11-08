//! ds16 — l'orchestrateur : l'agent principal confie des tâches longues à des
//! agents externes (store `axecode-agents`), attend sans dépenser de jetons (sondage
//! disque toutes les 500 ms) et lit leur rapport.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde_json::{json, Value};
use axecode_agents::{AgentStore, AgentsConfig, LancementCli, SpawnRequest};
use axecode_core::ToolDescriptor;

use crate::ToolRunResult;

/// Agents en ligne de commande (catalogue, détection, réglages) : aussi lu par l'IDE.
pub use axecode_agents::catalogue as cli;

pub const AGENTS_SPAWN: &str = "agents_spawn";
pub const AGENTS_WAIT: &str = "agents_wait";
pub const AGENTS_RESULT: &str = "agents_result";
const WAIT_DEFAULT_S: u64 = 600;
const WAIT_MAX_S: u64 = 1800;
const RESULT_MAX: usize = 20_000;

pub fn is_orchestrator_tool(name: &str) -> bool {
    matches!(name, AGENTS_SPAWN | AGENTS_WAIT | AGENTS_RESULT)
}

pub fn descriptors() -> Vec<ToolDescriptor> {
    let rappel = " Un agent externe ne voit ni l'historique ni les secrets de ce fil : le brief doit être autonome.";
    vec![
        ToolDescriptor {
            name: AGENTS_SPAWN.into(),
            description: format!("Confie une tâche longue à un agent externe (gratuit) et continue à travailler. Renvoie {{id, statut}}.{rappel}"),
            input_schema: json!({"type":"object","properties":{
                "brief":{"type":"string","description":"Consigne complète et autonome"},
                "label":{"type":"string"},
                "commande":{"type":"string","description":"Clé de la liste blanche (ex. opencode)"},
                "modele":{"type":"string"}},
                "required":["brief"],"additionalProperties":false}),
        },
        ToolDescriptor {
            name: AGENTS_WAIT.into(),
            description: "Attend, SANS dépenser de jetons, qu'au moins une des tâches se termine (ou le délai, 600 s par défaut, 1800 s maximum).".into(),
            input_schema: json!({"type":"object","properties":{
                "ids":{"type":"array","items":{"type":"string"}},
                "timeoutSecondes":{"type":"integer","minimum":1,"maximum":WAIT_MAX_S}},
                "required":["ids"],"additionalProperties":false}),
        },
        ToolDescriptor {
            name: AGENTS_RESULT.into(),
            description: "Lit le rapport final (resultat.md) d'un agent externe, tronqué à 20 000 caractères.".into(),
            input_schema: json!({"type":"object","properties":{"id":{"type":"string"}},
                "required":["id"],"additionalProperties":false}),
        },
    ]
}

fn data_dir() -> PathBuf {
    directories::ProjectDirs::from("", "", "savide")
        .map(|d| d.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Dossier de données des agents externes (`agents-settings.json`, `agents-cli.json`).
pub fn dossier_donnees() -> PathBuf {
    data_dir()
}

/// Une file par (dossier, sous-dossier) gardée pour tout le processus : la file
/// qui a lancé une tâche est celle qui note sa fin (une file rouverte à chaque
/// appel perdait la fin des tâches et les notait en erreur).
fn file_en_cache(root: &Path, sous_dossier: &str) -> Result<AgentStore, String> {
    static FILES: OnceLock<Mutex<HashMap<PathBuf, AgentStore>>> = OnceLock::new();
    let queue = axecode_harness::project_data_dir(root).join(sous_dossier);
    let mut files = FILES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|p| p.into_inner());
    if let Some(store) = files.get(&queue) {
        return Ok(store.clone());
    }
    let store = AgentStore::open_at(root, &queue, AgentsConfig::load(&data_dir())).map_err(|e| e.to_string())?;
    files.insert(queue, store.clone());
    Ok(store)
}

fn open(root: &Path) -> Result<AgentStore, String> {
    file_en_cache(root, "agents")
}

pub async fn run(workspace_root: &Path, name: &str, input: Value) -> ToolRunResult {
    let store = match open(workspace_root) {
        Ok(s) => s,
        Err(e) => return ToolRunResult::err(e, Vec::new()),
    };
    run_with(&store, name, input, Duration::from_millis(500)).await
}

pub async fn run_with(store: &AgentStore, name: &str, input: Value, pas: Duration) -> ToolRunResult {
    let texte = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    match name {
        AGENTS_SPAWN => {
            let Some(brief) = texte("brief") else {
                return ToolRunResult::err("agents: brief obligatoire", Vec::new());
            };
            match store.spawn(SpawnRequest { brief, label: texte("label"), commande: texte("commande"), modele: texte("modele") }) {
                Ok(s) => ToolRunResult::ok(json!({"id": s.id, "statut": s.statut.as_str()}).to_string(), Vec::new()),
                Err(e) => ToolRunResult::err(e.to_string(), Vec::new()),
            }
        }
        AGENTS_WAIT => {
            let ids: Vec<String> = input.get("ids").and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                return ToolRunResult::err("agents: ids obligatoire", Vec::new());
            }
            let delai = input.get("timeoutSecondes").and_then(Value::as_u64)
                .unwrap_or(WAIT_DEFAULT_S).clamp(1, WAIT_MAX_S);
            let fin = tokio::time::Instant::now() + Duration::from_secs(delai);
            loop {
                store.pump();
                let mut termines = Vec::new();
                let mut encore = Vec::new();
                for id in &ids {
                    match store.status(id) {
                        Ok(v) if v.statut.is_terminal() => {
                            let resume: String = v.journal.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
                            termines.push(json!({"id": v.id, "statut": v.statut.as_str(), "codeSortie": v.code_sortie, "resume": resume}));
                        }
                        Ok(_) => encore.push(id.clone()),
                        Err(e) => termines.push(json!({"id": id, "statut": "erreur", "codeSortie": null, "resume": e.to_string()})),
                    }
                }
                let expire = tokio::time::Instant::now() >= fin;
                if !termines.is_empty() || expire {
                    return ToolRunResult::ok(json!({"termines": termines, "encoreEnCours": encore, "delaiAtteint": termines.is_empty() && expire}).to_string(), Vec::new());
                }
                tokio::time::sleep(pas).await; // non bloquant : rend la main au runtime
            }
        }
        AGENTS_RESULT => {
            let Some(id) = texte("id") else {
                return ToolRunResult::err("agents: id obligatoire", Vec::new());
            };
            match store.result(&id) {
                Ok(r) => {
                    let mut resultat = r.resultat;
                    if resultat.chars().count() > RESULT_MAX {
                        resultat = resultat.chars().take(RESULT_MAX).collect::<String>() + "\n(tronqué)";
                    }
                    ToolRunResult::ok(json!({"id": r.id, "present": r.present, "resultat": resultat}).to_string(), Vec::new())
                }
                Err(e) => ToolRunResult::err(e.to_string(), Vec::new()),
            }
        }
        _ => ToolRunResult::err(format!("unknown tool: {name}"), Vec::new()),
    }
}

// ---------------------------------------------------------------------------
// Agents en ligne de commande depuis le noyau (module Python `agents_cli`) :
// mode non interactif du CLI (`claude -p`, `codex exec`, `opencode run`…),
// dans la file `<données du projet>/agents-cli` (à part des agents externes) ;
// sortie dans le journal de la tâche.

const CLI_TEXTE_MAX: usize = 12_000;
const CLI_TETE: usize = 2_000;
const CLI_LECTURE_MAX: u64 = 256 * 1024;

/// Méthodes `agents_cli.*` du noyau.
pub fn est_appel_cli(methode: &str) -> bool {
    methode.starts_with("agents_cli.")
}

pub async fn appel_cli(workspace: &Path, methode: &str, params: Value) -> Result<Value, String> {
    let reglages = || cli::Reglages::lire(&data_dir());
    match methode {
        "agents_cli.disponibles" => Ok(cli_disponibles(&reglages())),
        "agents_cli.lancer" => cli_lancer(&file_en_cache(workspace, "agents-cli")?, workspace, &reglages(), &params).await,
        "agents_cli.statut" => cli_statut(&file_en_cache(workspace, "agents-cli")?, &id_cli(&params)?),
        "agents_cli.resultat" => cli_resultat(&file_en_cache(workspace, "agents-cli")?, &id_cli(&params)?),
        "agents_cli.arreter" => {
            let store = file_en_cache(workspace, "agents-cli")?;
            let v = store.stop(&id_cli(&params)?).map_err(|e| e.to_string())?;
            Ok(json!({"id": v.id, "statut": v.statut.as_str()}))
        }
        "agents_cli.liste" => {
            let store = file_en_cache(workspace, "agents-cli")?;
            Ok(Value::Array(store.list().into_iter().map(|t| json!({
                "id": t.id, "titre": t.label, "cli": t.commande.trim_start_matches("cli:"), "statut": t.statut.as_str(),
                "code_sortie": t.code_sortie, "debut_ms": t.debut_ms, "fin_ms": t.fin_ms,
            })).collect()))
        }
        _ => Err(format!("agents_cli : méthode inconnue « {methode} »")),
    }
}

fn texte_de(params: &Value, cle: &str) -> Option<String> {
    params.get(cle).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(str::to_string)
}

fn id_cli(params: &Value) -> Result<String, String> {
    texte_de(params, "id").ok_or_else(|| "agents_cli : `id` est obligatoire".to_string())
}

fn cli_disponibles(reglages: &cli::Reglages) -> Value {
    Value::Array(
        cli::etat(reglages)
            .into_iter()
            .filter(|e| e.installe && e.agent.non_interactif.is_some())
            .map(|e| json!({
                "id": e.agent.id, "nom": e.agent.nom, "chemin": e.chemin,
                "autonomie": e.reglage.autonomie, "modele": e.agent.modele.is_some(),
            }))
            .collect(),
    )
}

async fn cli_lancer(store: &AgentStore, workspace: &Path, reglages: &cli::Reglages, params: &Value) -> Result<Value, String> {
    let id = texte_de(params, "cli").ok_or("agents_cli.lancer : `cli` est obligatoire")?;
    let agent = cli::agent(&id).ok_or_else(|| {
        let connus: Vec<&str> = cli::catalogue().iter().map(|a| a.id.as_str()).collect();
        format!("agent inconnu : « {id} » (connus : {})", connus.join(", "))
    })?;
    let prompt = params.get("prompt").and_then(Value::as_str).unwrap_or_default().to_string();
    if prompt.trim().is_empty() {
        return Err("agents_cli.lancer : `prompt` est obligatoire".into());
    }
    let reglage = reglages.de(&id);
    let programme = cli::trouver(agent, &reglage).ok_or_else(|| {
        format!(
            "{} est introuvable sur ce poste : installez-le ({}) ou indiquez son exécutable dans Réglages > Agents CLI.",
            agent.nom, agent.installation
        )
    })?;
    let modele = texte_de(params, "modele");
    let ligne = cli::ligne_non_interactive(agent, &reglage, &prompt_pour_arguments(&programme, &prompt), modele.as_deref())?;

    let demande = texte_de(params, "dossier").map(PathBuf::from);
    let mut dossier = match demande {
        Some(d) if d.is_absolute() => d,
        Some(d) => workspace.join(d),
        None => workspace.to_path_buf(),
    };
    dossier = crate::workspace::os_path(
        &dossier.canonicalize().map_err(|_| format!("dossier introuvable : {}", dossier.display()))?,
    );
    if !dossier.is_dir() {
        return Err(format!("ce n'est pas un dossier : {}", dossier.display()));
    }
    let mut branche = None;
    if params.get("worktree").and_then(Value::as_bool).unwrap_or(false) {
        let b = format!("agent/{id}-{}", horodatage_utc());
        dossier = creer_arbre(&dossier, &b).await?;
        branche = Some(b);
    }
    let dossier_texte = dossier.display().to_string();
    let lancement = LancementCli {
        cli: id.clone(),
        programme: programme.display().to_string(),
        args: ligne.args,
        dossier: dossier_texte.clone(),
        env: ligne.env,
        prompt_stdin: ligne.prompt_stdin,
    };
    let titre = texte_de(params, "titre").unwrap_or_else(|| {
        let debut: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(48).collect();
        format!("{} : {debut}", agent.nom)
    });
    let s = store.spawn_cli(prompt, Some(titre), modele, lancement).map_err(|e| e.to_string())?;
    Ok(json!({
        "id": s.id, "statut": s.statut.as_str(), "cli": id, "nom": agent.nom, "dossier": dossier_texte,
        "branche": branche, "journal": store.root().join(&s.id).join("journal.log").display().to_string(),
    }))
}

/// Sous Windows, un `.cmd` (installation npm) ne reçoit pas de retour à la ligne
/// dans ses arguments : la consigne passée en argument tient alors sur une ligne.
fn prompt_pour_arguments(programme: &Path, prompt: &str) -> String {
    let lot = programme
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if cfg!(windows) && lot {
        prompt.split(['\r', '\n']).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join(" ")
    } else {
        prompt.to_string()
    }
}

fn cli_statut(store: &AgentStore, id: &str) -> Result<Value, String> {
    store.supervise();
    let v = store.status(id).map_err(|e| e.to_string())?;
    Ok(json!({
        "id": v.id, "titre": v.label, "statut": v.statut.as_str(), "fini": v.statut.is_terminal(),
        "code_sortie": v.code_sortie, "debut_ms": v.debut_ms, "fin_ms": v.fin_ms,
    }))
}

fn cli_resultat(store: &AgentStore, id: &str) -> Result<Value, String> {
    let v = store.status(id).map_err(|e| e.to_string())?;
    let journal = store.root().join(id).join("journal.log");
    let brut = lire_bornes(&journal).map_err(|e| format!("journal illisible : {e}"))?;
    let (texte, tronque) = texte_propre(&sans_sequences(&brut), &journal.display().to_string());
    Ok(json!({
        "id": v.id, "statut": v.statut.as_str(), "fini": v.statut.is_terminal(), "code_sortie": v.code_sortie,
        "texte": texte, "tronque": tronque, "journal": journal.display().to_string(),
    }))
}

/// Journal entier s'il est petit, sinon son début et sa fin.
fn lire_bornes(chemin: &Path) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(chemin)?;
    let taille = f.metadata()?.len();
    if taille <= CLI_LECTURE_MAX {
        let mut tout = Vec::new();
        f.read_to_end(&mut tout)?;
        return Ok(String::from_utf8_lossy(&tout).into_owned());
    }
    let mut debut = vec![0u8; 16 * 1024];
    f.read_exact(&mut debut)?;
    let fin_taille = CLI_LECTURE_MAX - 16 * 1024;
    f.seek(SeekFrom::Start(taille - fin_taille))?;
    let mut fin = Vec::new();
    f.read_to_end(&mut fin)?;
    Ok(format!("{}\n…\n{}", String::from_utf8_lossy(&debut), String::from_utf8_lossy(&fin)))
}

/// Retire couleurs et séquences de terminal ; une ligne réécrite (`\r`) garde son dernier état.
fn sans_sequences(texte: &str) -> String {
    static ANSI: OnceLock<regex::Regex> = OnceLock::new();
    let ansi = ANSI.get_or_init(|| {
        regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]").expect("expression valide")
    });
    ansi.replace_all(texte, "")
        .split('\n')
        .map(|ligne| {
            let ligne = ligne.strip_suffix('\r').unwrap_or(ligne);
            ligne.rsplit('\r').next().unwrap_or(ligne)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Texte rendu au noyau : entier jusqu'à 12 000 caractères, sinon le début et la
/// fin (coupés aux lignes) avec ce qui manque et où lire le journal complet.
fn texte_propre(texte: &str, journal: &str) -> (String, bool) {
    let texte = texte.trim_end();
    let total = texte.chars().count();
    if total <= CLI_TEXTE_MAX {
        return (texte.to_string(), false);
    }
    let tete: String = texte.chars().take(CLI_TETE).collect();
    let tete = match tete.rfind('\n') {
        Some(i) if i > CLI_TETE / 2 => tete[..i].to_string(),
        _ => tete,
    };
    let queue: String = texte.chars().skip(total - (CLI_TEXTE_MAX - CLI_TETE)).collect();
    let queue = match queue.find('\n') {
        Some(i) if i < queue.len() / 2 => queue[i + 1..].to_string(),
        _ => queue,
    };
    let omis = total - tete.chars().count() - queue.chars().count();
    (format!("{tete}\n[… {omis} caractères omis — journal complet : {journal} …]\n{queue}"), true)
}

/// Branche horodatée (UTC) : AAAAMMJJ-HHMMSS.
fn horodatage_utc() -> String {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (jours, reste) = (s.div_euclid(86_400), s.rem_euclid(86_400));
    // Jours depuis 1970 -> date civile (algorithme de Howard Hinnant).
    let z = jours + 719_468;
    let ere = z.div_euclid(146_097);
    let jde = z - ere * 146_097;
    let ade = (jde - jde / 1460 + jde / 36_524 - jde / 146_096) / 365;
    let jda = jde - (365 * ade + ade / 4 - ade / 100);
    let mp = (5 * jda + 2) / 153;
    let jour = jda - (153 * mp + 2) / 5 + 1;
    let mois = if mp < 10 { mp + 3 } else { mp - 9 };
    let annee = ade + ere * 400 + i64::from(mois <= 2);
    format!("{annee:04}{mois:02}{jour:02}-{:02}{:02}{:02}", reste / 3600, reste % 3600 / 60, reste % 60)
}

async fn git(dossier: &Path, args: &[&str]) -> Result<String, String> {
    let mut c = tokio::process::Command::new("git");
    c.arg("-C").arg(dossier).args(args).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let sortie = c.output().await.map_err(|e| format!("git introuvable : {e}"))?;
    if !sortie.status.success() {
        return Err(format!("git {} : {}", args.join(" "), String::from_utf8_lossy(&sortie.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&sortie.stdout).trim().to_string())
}

/// Nouvel arbre de travail git à côté de l'arbre principal (`<dépôt>-<branche>`,
/// comme le panneau Git), branche neuve depuis HEAD ; rend le même sous-dossier
/// que `dossier` dans ce nouvel arbre.
async fn creer_arbre(dossier: &Path, branche: &str) -> Result<PathBuf, String> {
    let racine = PathBuf::from(git(dossier, &["rev-parse", "--show-toplevel"]).await.map_err(|_| {
        format!("{} n'est pas dans un dépôt git : impossible de créer un arbre de travail", dossier.display())
    })?);
    let racine = crate::workspace::os_path(&racine.canonicalize().unwrap_or(racine));
    let sous_dossier = dossier.strip_prefix(&racine).map(Path::to_path_buf).unwrap_or_default();
    let liste = git(&racine, &["worktree", "list", "--porcelain"]).await?;
    let principal = liste
        .lines()
        .find_map(|l| l.strip_prefix("worktree "))
        .map(PathBuf::from)
        .unwrap_or_else(|| racine.clone());
    let parent = principal.parent().ok_or("le dépôt n'a pas de dossier parent")?.to_path_buf();
    let nom = principal.file_name().and_then(|n| n.to_str()).unwrap_or("depot").to_string();
    let suffixe: String = branche.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let base = format!("{nom}-{}", suffixe.trim_matches('-'));
    let chemin = (0..1000)
        .map(|n| if n == 0 { parent.join(&base) } else { parent.join(format!("{base}-{n}")) })
        .find(|c| !c.exists())
        .ok_or("aucun nom de dossier libre pour l'arbre de travail")?;
    let texte = chemin.display().to_string();
    git(&racine, &["worktree", "add", "-b", branche, &texte, "HEAD"]).await?;
    Ok(chemin.join(sous_dossier))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(cmd: &[&str]) -> (tempfile::TempDir, AgentStore) {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AgentsConfig::default();
        cfg.agents_commandes.clear();
        cfg.agents_commandes.insert("faux".into(), cmd.iter().map(|s| s.to_string()).collect());
        let s = AgentStore::open_at(dir.path(), &dir.path().join("file"), cfg).unwrap();
        (dir, s)
    }

    fn val(r: &ToolRunResult) -> Value { serde_json::from_str(&r.content).unwrap() }

    #[tokio::test]
    async fn spawn_wait_result_et_erreurs() {
        let (_d, s) = store(&["sh", "-c", "printf rapport > {dir}/resultat.md"]);
        let p = Duration::from_millis(50);
        let r = run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"faux"}), p).await;
        assert!(!r.is_error, "{}", r.content);
        let id = val(&r)["id"].as_str().unwrap().to_string();
        let refus = run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"inconnue"}), p).await;
        assert!(refus.is_error && refus.content.contains("commande inconnue"));
        let w = run_with(&s, AGENTS_WAIT, json!({"ids":[id],"timeoutSecondes":20}), p).await;
        assert_eq!(val(&w)["termines"].as_array().unwrap().len(), 1, "{}", w.content);
        let res = run_with(&s, AGENTS_RESULT, json!({"id": id}), p).await;
        assert_eq!(val(&res)["resultat"], "rapport");
        let absent = run_with(&s, AGENTS_RESULT, json!({"id":"zzz"}), p).await;
        assert!(absent.is_error || val(&absent)["present"] == false);
    }

    #[tokio::test]
    async fn wait_expire() {
        let (_d, s) = store(&["sleep", "30"]);
        let p = Duration::from_millis(50);
        let id = val(&run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"faux"}), p).await)["id"].as_str().unwrap().to_string();
        let w = run_with(&s, AGENTS_WAIT, json!({"ids":[id.clone()],"timeoutSecondes":1}), p).await;
        assert_eq!(val(&w)["delaiAtteint"], true);
        let _ = s.stop(&id);
    }

    #[tokio::test]
    async fn result_tronque() {
        let (_d, s) = store(&["sh", "-c", "head -c 25000 /dev/zero | tr '\\0' a > {dir}/resultat.md"]);
        let p = Duration::from_millis(50);
        let id = val(&run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"faux"}), p).await)["id"].as_str().unwrap().to_string();
        run_with(&s, AGENTS_WAIT, json!({"ids":[id.clone()],"timeoutSecondes":20}), p).await;
        let r = val(&run_with(&s, AGENTS_RESULT, json!({"id": id}), p).await);
        assert!(r["resultat"].as_str().unwrap().ends_with("(tronqué)"));
    }
}

#[cfg(all(test, unix))]
mod tests_cli {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn faux_cli(dossier: &Path) -> PathBuf {
        let exe = dossier.join("faux-claude");
        std::fs::write(&exe, "#!/bin/sh\necho \"args=$*\"\necho \"pwd=$(pwd)\"\nprintf 'consigne='\ncat\necho\nprintf '\\033[32mvert\\033[0m\\n10%%\\r100%%\\n'\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        exe
    }

    fn reglages(exe: &Path) -> cli::Reglages {
        let mut r = cli::Reglages::default();
        r.agents.insert("claude".into(), cli::ReglageAgent { chemin: Some(exe.display().to_string()), ..Default::default() });
        r
    }

    async fn fin(store: &AgentStore, id: &str) -> Value {
        for _ in 0..200 {
            let v = cli_statut(store, id).unwrap();
            if v["fini"] == true {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("tâche {id} sans fin");
    }

    #[tokio::test]
    async fn lancer_attendre_resultat_avec_un_faux_cli() {
        let d = tempfile::tempdir().unwrap();
        let projet = d.path().join("projet");
        std::fs::create_dir_all(projet.join("sous")).unwrap();
        let exe = faux_cli(d.path());
        let store = AgentStore::open_at(&projet, &d.path().join("file"), AgentsConfig::default()).unwrap();
        let r = cli_lancer(&store, &projet, &reglages(&exe), &json!({"cli": "claude", "prompt": "Corrige le test", "modele": "opus", "dossier": "sous"}))
            .await
            .unwrap();
        assert_eq!(r["cli"], "claude");
        assert_eq!(r["branche"], Value::Null);
        assert!(r["journal"].as_str().unwrap().ends_with("journal.log"));
        let id = r["id"].as_str().unwrap().to_string();
        let etat = fin(&store, &id).await;
        assert_eq!(etat["statut"], "termine", "{etat}");
        let res = cli_resultat(&store, &id).unwrap();
        let texte = res["texte"].as_str().unwrap();
        assert!(texte.contains("args=-p --model opus"), "{texte}");
        assert!(texte.contains(&format!("pwd={}", projet.join("sous").canonicalize().unwrap().display())), "{texte}");
        assert!(texte.contains("consigne=Corrige le test"), "{texte}");
        assert!(texte.ends_with("consigne=Corrige le test\nvert\n100%"), "couleurs et ligne réécrite nettoyées : {texte:?}");
        assert_eq!(res["tronque"], false);
    }

    #[tokio::test]
    async fn lancer_dans_un_nouvel_arbre_de_travail() {
        let d = tempfile::tempdir().unwrap();
        let depot = d.path().join("depot");
        std::fs::create_dir_all(&depot).unwrap();
        for args in [vec!["init", "-q"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]] {
            assert!(std::process::Command::new("git").arg("-C").arg(&depot).args(&args).status().unwrap().success());
        }
        let exe = faux_cli(d.path());
        let store = AgentStore::open_at(&depot, &d.path().join("file"), AgentsConfig::default()).unwrap();
        let r = cli_lancer(&store, &depot, &reglages(&exe), &json!({"cli": "claude", "prompt": "p", "worktree": true})).await.unwrap();
        let branche = r["branche"].as_str().unwrap();
        assert!(branche.starts_with("agent/claude-"), "{branche}");
        let dossier = PathBuf::from(r["dossier"].as_str().unwrap());
        assert!(dossier.file_name().unwrap().to_str().unwrap().starts_with("depot-agent-claude-"), "{}", dossier.display());
        assert!(dossier.join(".git").exists(), "arbre de travail créé");
        let id = r["id"].as_str().unwrap().to_string();
        fin(&store, &id).await;
        let texte = cli_resultat(&store, &id).unwrap()["texte"].as_str().unwrap().to_string();
        assert!(texte.contains(&format!("pwd={}", dossier.canonicalize().unwrap().display())), "{texte}");
        let sans_depot = tempfile::tempdir().unwrap();
        let store2 = AgentStore::open_at(sans_depot.path(), &d.path().join("file2"), AgentsConfig::default()).unwrap();
        let e = cli_lancer(&store2, sans_depot.path(), &reglages(&exe), &json!({"cli": "claude", "prompt": "p", "worktree": true})).await.unwrap_err();
        assert!(e.contains("dépôt git"), "{e}");
    }

    #[tokio::test]
    async fn erreurs_claires() {
        let d = tempfile::tempdir().unwrap();
        let store = AgentStore::open_at(d.path(), &d.path().join("file"), AgentsConfig::default()).unwrap();
        let r = cli::Reglages::default();
        let e = cli_lancer(&store, d.path(), &r, &json!({"cli": "inconnu", "prompt": "p"})).await.unwrap_err();
        assert!(e.contains("agent inconnu") && e.contains("claude"), "{e}");
        let e = cli_lancer(&store, d.path(), &r, &json!({"cli": "claude", "prompt": "  "})).await.unwrap_err();
        assert!(e.contains("prompt"), "{e}");
        let absent = reglages(&d.path().join("absent"));
        let e = cli_lancer(&store, d.path(), &absent, &json!({"cli": "claude", "prompt": "p"})).await.unwrap_err();
        assert!(e.contains("introuvable") && e.contains("https://"), "{e}");
        let exe = faux_cli(d.path());
        let e = cli_lancer(&store, d.path(), &reglages(&exe), &json!({"cli": "claude", "prompt": "p", "dossier": "nulle-part"})).await.unwrap_err();
        assert!(e.contains("dossier introuvable"), "{e}");
        let goose = {
            let mut g = cli::Reglages::default();
            g.agents.insert("goose".into(), cli::ReglageAgent { chemin: Some(exe.display().to_string()), ..Default::default() });
            g
        };
        let e = cli_lancer(&store, d.path(), &goose, &json!({"cli": "goose", "prompt": "p", "modele": "x"})).await.unwrap_err();
        assert!(e.contains("modèle"), "{e}");
        assert!(store.list().is_empty());
    }

    #[test]
    fn texte_rendu_tronque_proprement() {
        let court = "ligne 1\nligne 2\n\n";
        assert_eq!(texte_propre(court, "/j"), ("ligne 1\nligne 2".to_string(), false));
        let long: String = (0..3000).map(|i| format!("ligne numéro {i}\n")).collect();
        let (t, tronque) = texte_propre(&long, "/donnees/journal.log");
        assert!(tronque);
        assert!(t.starts_with("ligne numéro 0\n"));
        assert!(t.ends_with("ligne numéro 2999"));
        assert!(t.contains("caractères omis — journal complet : /donnees/journal.log"));
        assert!(t.chars().count() <= CLI_TEXTE_MAX + 120, "{}", t.chars().count());
        let marque = t.find("[…").unwrap();
        assert!(t[..marque].ends_with('\n') && t[marque..].contains("…]\nligne numéro"), "coupé aux lignes");
        assert_eq!(sans_sequences("\x1b[1;31mrouge\x1b[0m\r\n\x1b]0;titre\x07a 1%\rb 100%\n"), "rouge\nb 100%\n");
        let h = horodatage_utc();
        assert_eq!(h.len(), 15, "{h}");
        assert!(h.chars().enumerate().all(|(i, c)| if i == 8 { c == '-' } else { c.is_ascii_digit() }), "{h}");
    }

    /// Essai réel bref (lancé à la main) : OpenCode installé sur la machine, modèle gratuit.
    #[tokio::test]
    #[ignore]
    async fn essai_reel_opencode() {
        let d = tempfile::tempdir().unwrap();
        let store = AgentStore::open_at(d.path(), &d.path().join("file"), AgentsConfig::default()).unwrap();
        let reglages = cli::Reglages::lire(&data_dir());
        println!("disponibles : {}", cli_disponibles(&reglages));
        let r = cli_lancer(&store, d.path(), &reglages, &json!({"cli": "opencode", "prompt": "Réponds seulement par le mot : bonjour", "modele": axecode_agents::DEFAULT_MODELE}))
            .await
            .unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        let mut etat = cli_statut(&store, &id).unwrap();
        for _ in 0..1800 {
            if etat["fini"] == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            etat = cli_statut(&store, &id).unwrap();
        }
        if etat["fini"] != true {
            let _ = store.stop(&id); // pas de processus laissé derrière l'essai
        }
        let res = cli_resultat(&store, &id).unwrap();
        println!("état : {etat}\ntexte :\n{}", res["texte"].as_str().unwrap_or_default());
        assert_eq!(etat["statut"], "termine", "{res}");
        assert!(res["texte"].as_str().unwrap().to_lowercase().contains("bonjour"), "{res}");
    }
}

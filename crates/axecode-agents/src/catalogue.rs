//! Agents en ligne de commande des autres (Claude Code, Codex, Gemini CLI,
//! OpenCode…), lancés dans nos terminaux ou confiés par le noyau.
//!
//! Le catalogue est un fichier de données (`catalogue-cli.json`, embarqué) ;
//! les réglages de l'utilisateur vivent dans `agents-cli.json`, à côté de
//! `agents-settings.json`. Ce module trouve un agent installé (PATH puis
//! dossiers d'installation usuels) et construit ses lignes de commande :
//! terminal interactif (mode normal du CLI par défaut, autonomie complète sur
//! demande, reprise d'une session) ou tâche non interactive (`claude -p`,
//! `codex exec`, `opencode run`…).

use std::{
    collections::BTreeMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};

/// Fichier des réglages, dans le dossier de données des agents.
pub const FICHIER_REGLAGES: &str = "agents-cli.json";
const CATALOGUE: &str = include_str!("../catalogue-cli.json");
/// Longueur maximale d'une ligne d'arguments ou d'un chemin saisi dans les Réglages.
const SAISIE_MAX: usize = 2000;

/// Un agent du catalogue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCli {
    pub id: String,
    pub nom: String,
    /// Exécutable cherché sur le PATH.
    pub commande: String,
    #[serde(default)]
    pub alias: Vec<String>,
    /// Arguments de lancement par défaut (modifiables dans les Réglages).
    #[serde(default)]
    pub args: Vec<String>,
    /// Drapeaux d'autonomie complète : l'agent agit sans demander.
    #[serde(default)]
    pub autonomie: Vec<String>,
    /// Drapeaux d'autonomie du mode non interactif, s'ils diffèrent.
    #[serde(default)]
    pub autonomie_lot: Option<Vec<String>>,
    /// Variables d'environnement de l'autonomie complète.
    #[serde(default)]
    pub autonomie_env: BTreeMap<String, String>,
    /// Arguments qui reprennent une session (absent : le CLI ne sait pas).
    #[serde(default)]
    pub reprise: Option<Vec<String>>,
    /// Mode non interactif : `{options}` (autonomie, modèle), `{prompt}` (la
    /// consigne ; sans lui, elle passe par l'entrée standard).
    #[serde(default)]
    pub non_interactif: Option<Vec<String>>,
    /// Arguments du choix du modèle (`{modele}`).
    #[serde(default)]
    pub modele: Option<Vec<String>>,
    /// Page d'installation.
    pub installation: String,
    /// Expressions qui reconnaissent, à l'écran, l'attente d'une réponse.
    #[serde(default)]
    pub invites: Vec<String>,
}

#[derive(Deserialize)]
struct FichierCatalogue {
    agents: Vec<AgentCli>,
}

/// Les agents connus, dans l'ordre du catalogue.
pub fn catalogue() -> &'static [AgentCli] {
    static AGENTS: OnceLock<Vec<AgentCli>> = OnceLock::new();
    AGENTS.get_or_init(|| {
        serde_json::from_str::<FichierCatalogue>(CATALOGUE)
            .map(|f| f.agents)
            .unwrap_or_default()
    })
}

pub fn agent(id: &str) -> Option<&'static AgentCli> {
    catalogue().iter().find(|a| a.id == id)
}

/// Réglages d'un agent choisis par l'utilisateur.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReglageAgent {
    /// Arguments de lancement (une ligne, guillemets acceptés) ; absent :
    /// ceux du catalogue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    /// Autonomie complète (désactivée par défaut : le CLI demande avant d'agir).
    #[serde(default)]
    pub autonomie: bool,
    /// Exécutable choisi à la main, s'il n'est pas sur le PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chemin: Option<String>,
}

/// Contenu de `agents-cli.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reglages {
    #[serde(default)]
    pub agents: BTreeMap<String, ReglageAgent>,
}

fn propre(texte: &str) -> String {
    texte
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(SAISIE_MAX)
        .collect::<String>()
        .trim()
        .to_string()
}

impl Reglages {
    pub fn chemin(dossier: &Path) -> PathBuf {
        dossier.join(FICHIER_REGLAGES)
    }

    /// Lit les réglages ; fichier absent ou illisible : réglages par défaut.
    pub fn lire(dossier: &Path) -> Self {
        std::fs::read_to_string(Self::chemin(dossier))
            .ok()
            .and_then(|brut| serde_json::from_str::<Self>(&brut).ok())
            .map(Self::nettoyes)
            .unwrap_or_default()
    }

    pub fn ecrire(&self, dossier: &Path) -> std::io::Result<()> {
        let octets = serde_json::to_vec_pretty(&self.clone().nettoyes())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        crate::atomic_write(&Self::chemin(dossier), &octets)
    }

    pub fn de(&self, id: &str) -> ReglageAgent {
        self.agents.get(id).cloned().unwrap_or_default()
    }

    /// Sans agent inconnu, sans caractère de contrôle, sans réglage vide.
    pub fn nettoyes(mut self) -> Self {
        self.agents.retain(|id, _| agent(id).is_some());
        for reglage in self.agents.values_mut() {
            reglage.args = reglage.args.as_deref().map(propre);
            reglage.chemin = reglage.chemin.as_deref().map(propre).filter(|c| !c.is_empty());
        }
        self.agents.retain(|_, r| r != &ReglageAgent::default());
        self
    }
}

/// Un agent du catalogue, sa détection et ses réglages (pour l'interface).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EtatAgent {
    #[serde(flatten)]
    pub agent: AgentCli,
    pub installe: bool,
    pub chemin: Option<String>,
    pub reglage: ReglageAgent,
}

/// Tous les agents, installés ou non.
pub fn etat(reglages: &Reglages) -> Vec<EtatAgent> {
    catalogue()
        .iter()
        .map(|agent| {
            let reglage = reglages.de(&agent.id);
            let chemin = trouver(agent, &reglage);
            EtatAgent {
                agent: agent.clone(),
                installe: chemin.is_some(),
                chemin: chemin.map(|c| c.display().to_string()),
                reglage,
            }
        })
        .collect()
}

/// Exécutable de l'agent : le chemin réglé (seul, s'il est donné), sinon la
/// commande puis ses alias sur le PATH et dans les dossiers usuels.
pub fn trouver(agent: &AgentCli, reglage: &ReglageAgent) -> Option<PathBuf> {
    if let Some(chemin) = reglage.chemin.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        let chemin = PathBuf::from(chemin);
        return est_executable(&chemin).then_some(chemin);
    }
    let path = std::env::var_os("PATH");
    let usuels = dossiers_usuels();
    std::iter::once(&agent.commande)
        .chain(agent.alias.iter())
        .find_map(|nom| chercher_programme(nom, path.as_deref(), &usuels))
}

/// Cherche `nom` dans les dossiers de `path` puis dans `en_plus`.
pub fn chercher_programme(nom: &str, path: Option<&OsStr>, en_plus: &[PathBuf]) -> Option<PathBuf> {
    if nom.is_empty() || nom.contains('/') || nom.contains('\\') {
        return None;
    }
    let mut dossiers: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    dossiers.extend(en_plus.iter().cloned());
    dossiers
        .iter()
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| candidats(d, nom))
        .find(|c| est_executable(c))
}

#[cfg(windows)]
fn candidats(dossier: &Path, nom: &str) -> Vec<PathBuf> {
    // npm installe `claude.cmd` (et `claude.ps1`) : ordre de PATHEXT.
    let mut extensions: Vec<String> = std::env::var("PATHEXT")
        .map(|v| v.split(';').map(str::trim).filter(|e| !e.is_empty()).map(str::to_ascii_lowercase).collect())
        .unwrap_or_default();
    if extensions.is_empty() {
        extensions = vec![".com".into(), ".exe".into(), ".bat".into(), ".cmd".into()];
    }
    extensions.iter().map(|e| dossier.join(format!("{nom}{e}"))).collect()
}

#[cfg(not(windows))]
fn candidats(dossier: &Path, nom: &str) -> Vec<PathBuf> {
    vec![dossier.join(nom)]
}

#[cfg(unix)]
fn est_executable(chemin: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(chemin)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn est_executable(chemin: &Path) -> bool {
    std::fs::metadata(chemin).map(|m| m.is_file()).unwrap_or(false)
}

/// Dossiers d'installation usuels, souvent absents du PATH d'une appli lancée
/// hors d'un shell (macOS surtout).
pub fn dossiers_usuels() -> Vec<PathBuf> {
    let mut dossiers = Vec::new();
    if let Some(maison) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let maison = PathBuf::from(maison);
        for d in [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin", ".opencode/bin", ".amp/bin", ".volta/bin", "go/bin"] {
            dossiers.push(maison.join(d));
        }
    }
    #[cfg(windows)]
    if let Some(roaming) = std::env::var_os("APPDATA") {
        dossiers.push(PathBuf::from(roaming).join("npm"));
    }
    #[cfg(not(windows))]
    for d in ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/snap/bin"] {
        dossiers.push(PathBuf::from(d));
    }
    dossiers
}

/// Découpe une ligne d'arguments comme un shell simple : espaces, "…" et '…'.
pub fn decouper_args(ligne: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut courant = String::new();
    let mut guillemet: Option<char> = None;
    let mut present = false;
    for c in ligne.chars() {
        match guillemet {
            Some(g) if c == g => guillemet = None,
            Some(_) => courant.push(c),
            None if c == '"' || c == '\'' => {
                guillemet = Some(c);
                present = true;
            }
            None if c.is_whitespace() => {
                if present {
                    args.push(std::mem::take(&mut courant));
                    present = false;
                }
            }
            None => {
                courant.push(c);
                present = true;
            }
        }
    }
    if present {
        args.push(courant);
    }
    args
}

/// Arguments d'un terminal d'agent (sans le programme) : reprise, arguments de
/// lancement, puis drapeaux d'autonomie complète s'ils sont réglés.
pub fn args_interactifs(agent: &AgentCli, reglage: &ReglageAgent, reprendre: bool) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    if reprendre {
        let reprise = agent
            .reprise
            .as_ref()
            .ok_or_else(|| format!("{} ne sait pas reprendre une session", agent.nom))?;
        args.extend(reprise.iter().cloned());
    }
    match &reglage.args {
        Some(ligne) => args.extend(decouper_args(ligne)),
        None => args.extend(agent.args.iter().cloned()),
    }
    if reglage.autonomie {
        args.extend(agent.autonomie.iter().cloned());
    }
    Ok(args)
}

/// Variables d'environnement à ajouter au lancement (autonomie de Goose…).
pub fn env_agent(agent: &AgentCli, reglage: &ReglageAgent) -> BTreeMap<String, String> {
    if reglage.autonomie {
        agent.autonomie_env.clone()
    } else {
        BTreeMap::new()
    }
}

/// Ligne d'une tâche non interactive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LigneLot {
    pub args: Vec<String>,
    /// Vrai : la consigne passe par l'entrée standard (aucun `{prompt}`).
    pub prompt_stdin: bool,
    pub env: BTreeMap<String, String>,
}

/// Arguments d'une tâche non interactive (`claude -p`, `codex exec`…). Les
/// arguments de lancement des Réglages n'y vont pas ; l'autonomie complète
/// suit le réglage de l'agent.
pub fn ligne_non_interactive(
    agent: &AgentCli,
    reglage: &ReglageAgent,
    prompt: &str,
    modele: Option<&str>,
) -> Result<LigneLot, String> {
    let gabarit = agent
        .non_interactif
        .as_ref()
        .ok_or_else(|| format!("{} n'a pas de mode non interactif", agent.nom))?;
    let mut options = Vec::new();
    if reglage.autonomie {
        options.extend(agent.autonomie_lot.clone().unwrap_or_else(|| agent.autonomie.clone()));
    }
    if let Some(modele) = modele.map(str::trim).filter(|m| !m.is_empty()) {
        let drapeau = agent
            .modele
            .as_ref()
            .ok_or_else(|| format!("{} ne permet pas de choisir le modèle en ligne de commande", agent.nom))?;
        options.extend(drapeau.iter().map(|a| a.replace("{modele}", modele)));
    }
    let mut args = Vec::new();
    let mut prompt_stdin = true;
    let mut placees = false;
    for morceau in gabarit {
        if morceau == "{options}" {
            args.extend(options.iter().cloned());
            placees = true;
        } else if morceau.contains("{prompt}") {
            args.push(morceau.replace("{prompt}", prompt));
            prompt_stdin = false;
        } else {
            args.push(morceau.clone());
        }
    }
    if !placees {
        args.extend(options);
    }
    Ok(LigneLot { args, prompt_stdin, env: env_agent(agent, reglage) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reglage(autonomie: bool, args: Option<&str>) -> ReglageAgent {
        ReglageAgent { args: args.map(str::to_string), autonomie, chemin: None }
    }

    #[test]
    fn catalogue_complet_et_coherent() {
        let agents = catalogue();
        assert!(agents.len() >= 12, "{}", agents.len());
        let mut ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), agents.len(), "identifiants en double");
        for a in agents {
            assert!(!a.nom.is_empty() && !a.commande.is_empty(), "{}", a.id);
            assert!(a.installation.starts_with("https://"), "{}", a.id);
            let gabarit = a.non_interactif.as_ref().expect(&a.id);
            assert!(gabarit.iter().filter(|m| *m == "{options}").count() <= 1, "{}", a.id);
            for invite in &a.invites {
                assert!(regex_valide(invite), "{} : {invite}", a.id);
            }
        }
        for id in ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "amp", "goose", "aider", "qwen", "kimi", "crush"] {
            assert!(agent(id).is_some(), "{id}");
        }
    }

    /// Les invites sont lues par l'interface (RegExp) : syntaxe simple, sans groupe nommé.
    fn regex_valide(motif: &str) -> bool {
        !motif.is_empty() && !motif.contains("(?<") && !motif.contains("(?P")
    }

    #[test]
    fn decoupe_les_arguments_comme_un_shell() {
        assert_eq!(decouper_args(""), Vec::<String>::new());
        assert_eq!(decouper_args("  --model opus  "), vec!["--model", "opus"]);
        assert_eq!(
            decouper_args(r#"--model "claude opus" -x 'a b' --vide """#),
            vec!["--model", "claude opus", "-x", "a b", "--vide", ""]
        );
    }

    #[test]
    fn lancement_interactif_mode_normal_autonomie_reprise() {
        let claude = agent("claude").unwrap();
        assert!(args_interactifs(claude, &ReglageAgent::default(), false).unwrap().is_empty());
        assert_eq!(args_interactifs(claude, &reglage(true, None), false).unwrap(), vec!["--dangerously-skip-permissions"]);
        assert_eq!(args_interactifs(claude, &reglage(false, Some("--model opus")), true).unwrap(), vec!["--resume", "--model", "opus"]);
        let codex = agent("codex").unwrap();
        assert_eq!(
            args_interactifs(codex, &reglage(true, None), true).unwrap(),
            vec!["resume", "--dangerously-bypass-approvals-and-sandbox"]
        );
        let crush = agent("crush").unwrap();
        assert!(args_interactifs(crush, &ReglageAgent::default(), true).unwrap_err().contains("reprendre"));
        let goose = agent("goose").unwrap();
        assert!(env_agent(goose, &ReglageAgent::default()).is_empty());
        assert_eq!(env_agent(goose, &reglage(true, None)).get("GOOSE_MODE").map(String::as_str), Some("auto"));
    }

    #[test]
    fn ligne_non_interactive_stdin_ou_argument() {
        let claude = agent("claude").unwrap();
        let l = ligne_non_interactive(claude, &ReglageAgent::default(), "Fais X", Some("opus")).unwrap();
        assert_eq!(l.args, vec!["-p", "--model", "opus"]);
        assert!(l.prompt_stdin);
        let l = ligne_non_interactive(claude, &reglage(true, Some("--ignore")), "Fais X", None).unwrap();
        assert_eq!(l.args, vec!["-p", "--dangerously-skip-permissions"], "les arguments des Réglages restent au terminal");
        let cursor = agent("cursor").unwrap();
        let l = ligne_non_interactive(cursor, &ReglageAgent::default(), "Fais X", None).unwrap();
        assert_eq!(l.args.last().map(String::as_str), Some("Fais X"));
        assert!(!l.prompt_stdin);
        let opencode = agent("opencode").unwrap();
        assert_eq!(ligne_non_interactive(opencode, &reglage(true, None), "p", None).unwrap().args, vec!["run", "--auto"]);
        let goose = agent("goose").unwrap();
        let l = ligne_non_interactive(goose, &reglage(true, None), "p", None).unwrap();
        assert_eq!(l.args, vec!["run", "-t", "p"]);
        assert_eq!(l.env.get("GOOSE_MODE").map(String::as_str), Some("auto"));
        assert!(ligne_non_interactive(goose, &ReglageAgent::default(), "p", Some("x")).unwrap_err().contains("modèle"));
    }

    #[test]
    fn reglages_aller_retour_et_nettoyage() {
        let dossier = std::env::temp_dir().join(format!("agents-cli-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dossier).unwrap();
        assert_eq!(Reglages::lire(&dossier), Reglages::default());
        let mut r = Reglages::default();
        r.agents.insert("claude".into(), reglage(true, Some(" --model\nopus ")));
        r.agents.insert("inconnu".into(), reglage(true, None));
        r.agents.insert("codex".into(), ReglageAgent { chemin: Some("  ".into()), ..Default::default() });
        r.ecrire(&dossier).unwrap();
        let lu = Reglages::lire(&dossier);
        assert_eq!(lu.agents.len(), 1, "{lu:?}");
        assert_eq!(lu.de("claude").args.as_deref(), Some("--model opus"));
        assert!(lu.de("claude").autonomie);
        assert_eq!(lu.de("codex"), ReglageAgent::default());
        std::fs::write(Reglages::chemin(&dossier), "{ illisible").unwrap();
        assert_eq!(Reglages::lire(&dossier), Reglages::default());
        let _ = std::fs::remove_dir_all(&dossier);
    }

    #[cfg(unix)]
    #[test]
    fn detection_sur_le_path_et_chemin_regle() {
        use std::os::unix::fs::PermissionsExt;
        let dossier = std::env::temp_dir().join(format!("agents-cli-path-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dossier).unwrap();
        let exe = dossier.join("faux-cli");
        std::fs::write(&exe, "#!/bin/sh\necho ok\n").unwrap();
        let path = std::env::join_paths([PathBuf::from("/nulle-part"), dossier.clone()]).unwrap();
        assert_eq!(chercher_programme("faux-cli", Some(&path), &[]), None, "non exécutable");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(chercher_programme("faux-cli", Some(&path), &[]), Some(exe.clone()));
        assert_eq!(chercher_programme("faux-cli", None, &[dossier.clone()]), Some(exe.clone()));
        assert_eq!(chercher_programme("../faux-cli", Some(&path), &[]), None);
        let a = agent("claude").unwrap();
        let regle = ReglageAgent { chemin: Some(exe.display().to_string()), ..Default::default() };
        assert_eq!(trouver(a, &regle), Some(exe.clone()));
        let absent = ReglageAgent { chemin: Some(dossier.join("absent").display().to_string()), ..Default::default() };
        assert_eq!(trouver(a, &absent), None, "un chemin réglé faux ne se rabat pas sur le PATH");
        let _ = std::fs::remove_dir_all(&dossier);
    }
}

//! uh-cli — arguments du mode sans interface (`SavIDE -p …`, `--mode json|acp`).
//! Lecture à la main, sans dépendance : les options sont peu nombreuses et l'exécutable
//! reste celui de l'appli (Tauri n'en voit rien : le mode sans interface sort avant).

use std::path::PathBuf;

use axecode_core::{Effort, ModelRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Texte,
    Json,
    Acp,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Autonome {
    pub actif: bool,
    pub gates: Vec<String>,
    pub max_turns: Option<u64>,
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub mode: Mode,
    pub texte: Option<String>,
    pub continuer: bool,
    pub reprendre: Option<String>,
    pub modele: Option<ModelRef>,
    pub effort: Option<Effort>,
    pub objectif: Option<String>,
    pub budget: Option<u64>,
    pub autonome: Autonome,
    /// Attente maximale des réveils avant de sortir (ms) ; 0 = sortir à la fin du tour.
    pub attente_max_ms: u64,
    pub dossier: Option<PathBuf>,
    pub aide: bool,
}

pub const ATTENTE_DEFAUT_MS: u64 = 600_000;

pub const AIDE: &str = "SavIDE sans interface

  SavIDE -p \"<texte>\"            un tour ; la réponse sur la sortie standard
  SavIDE --mode json -p \"…\"      un événement JSON par ligne
  SavIDE --mode acp               Agent Client Protocol (JSON-RPC sur stdin/stdout)

Options :
  -p, --print [texte]          texte du message (sinon l'entrée standard redirigée)
  --mode text|json|acp         format de sortie (text par défaut)
  -c, --continue               continuer la dernière conversation du dossier
  -r, --resume <id>            reprendre une conversation (identifiant ou début)
  --model <fournisseur/modèle> modèle (ex. anthropic/claude-opus-4-5)
  --thinking <niveau>          none, low, medium, high, xhigh, max
  --goal <objectif>            objectif persistant (le service relance l'agent)
  --goal-budget <jetons>       budget de jetons de l'objectif
  --autonomous                 mode autonome borné
  --gate <commande>            contrôle à passer pour finir (répétable)
  --max-turns <n> --max-tokens <n> --timeout-ms <n>   limites du mode autonome
  --wait-max <ms>              attente maximale des réveils (guets, objectif, sous-agents)
                               avant de sortir ; 600000 par défaut, 0 = pas d'attente
  --cwd <dossier>              dossier de travail (le dossier courant par défaut)

Codes de sortie : 0 réussi ; 1 erreur du tour ou mode autonome arrêté sans réussir ;
2 arguments invalides ; 3 service injoignable.";

/// Vrai si la ligne de commande demande le mode sans interface.
pub fn demande(args: &[String]) -> bool {
    args.iter().any(|a| matches!(a.as_str(), "-p" | "--print" | "--mode") || a.starts_with("--mode="))
}

pub fn effort(v: &str) -> Result<Effort, String> {
    Ok(match v.trim().to_ascii_lowercase().as_str() {
        "none" | "off" | "aucun" => Effort::None,
        "low" | "bas" => Effort::Low,
        "medium" | "moyen" => Effort::Medium,
        "high" | "haut" => Effort::High,
        "xhigh" => Effort::Xhigh,
        "max" => Effort::Max,
        autre => return Err(format!("niveau de réflexion inconnu : {autre}")),
    })
}

/// `fournisseur/modèle` (le nom peut lui-même contenir des `/`).
pub fn modele(v: &str) -> Result<ModelRef, String> {
    match v.trim().split_once('/') {
        Some((p, n)) if !p.is_empty() && !n.is_empty() => Ok(ModelRef::new(p, n)),
        _ => Err(format!("modèle « {v} » : écrire fournisseur/modèle (ex. anthropic/claude-opus-4-5)")),
    }
}

fn nombre(nom: &str, v: &str) -> Result<u64, String> {
    let propre: String = v.chars().filter(|c| !matches!(c, '_' | ' ')).collect();
    propre.parse().map_err(|_| format!("{nom} : nombre attendu, pas « {v} »"))
}

/// `args` sans le nom du programme.
pub fn lire(args: &[String]) -> Result<Options, String> {
    let mut o = Options {
        mode: Mode::Texte,
        texte: None,
        continuer: false,
        reprendre: None,
        modele: None,
        effort: None,
        objectif: None,
        budget: None,
        autonome: Autonome::default(),
        attente_max_ms: ATTENTE_DEFAUT_MS,
        dossier: None,
        aide: false,
    };
    let mut libres: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let (cle, en_ligne) = match a.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k, Some(v.to_string())),
            _ => (a, None),
        };
        let valeur = |i: &mut usize| -> Result<String, String> {
            if let Some(v) = en_ligne.clone() {
                return Ok(v);
            }
            *i += 1;
            args.get(*i).cloned().ok_or_else(|| format!("{cle} : valeur manquante"))
        };
        match cle {
            "-p" | "--print" => {
                if let Some(v) = en_ligne.clone() {
                    o.texte = Some(v);
                } else if let Some(suivant) = args.get(i + 1).filter(|s| !s.starts_with('-') || s.as_str() == "-") {
                    if suivant != "-" {
                        o.texte = Some(suivant.clone());
                    }
                    i += 1;
                }
            }
            "--mode" => {
                o.mode = match valeur(&mut i)?.as_str() {
                    "text" | "texte" => Mode::Texte,
                    "json" => Mode::Json,
                    "acp" => Mode::Acp,
                    autre => return Err(format!("--mode : text, json ou acp, pas « {autre} »")),
                }
            }
            "-c" | "--continue" => o.continuer = true,
            "-r" | "--resume" => o.reprendre = Some(valeur(&mut i)?),
            "--model" | "-m" => o.modele = Some(modele(&valeur(&mut i)?)?),
            "--thinking" | "--effort" => o.effort = Some(effort(&valeur(&mut i)?)?),
            "--goal" => o.objectif = Some(valeur(&mut i)?),
            "--goal-budget" | "--goal-token-budget" => o.budget = Some(nombre(cle, &valeur(&mut i)?)?),
            "--autonomous" => o.autonome.actif = true,
            "--gate" | "--autonomous-gate" => {
                o.autonome.actif = true;
                o.autonome.gates.push(valeur(&mut i)?);
            }
            "--max-turns" | "--autonomous-max-turns" => o.autonome.max_turns = Some(nombre(cle, &valeur(&mut i)?)?),
            "--max-tokens" | "--autonomous-max-tokens" => o.autonome.max_tokens = Some(nombre(cle, &valeur(&mut i)?)?),
            "--timeout-ms" | "--autonomous-timeout-ms" => o.autonome.timeout_ms = Some(nombre(cle, &valeur(&mut i)?)?),
            "--wait-max" | "--background-wait-ms" => o.attente_max_ms = nombre(cle, &valeur(&mut i)?)?,
            "--cwd" => o.dossier = Some(PathBuf::from(valeur(&mut i)?)),
            "-h" | "--help" => o.aide = true,
            _ if a.starts_with('-') && a.len() > 1 => return Err(format!("option inconnue : {a}")),
            _ => libres.push(a.to_string()),
        }
        i += 1;
    }
    if o.texte.is_none() && !libres.is_empty() {
        o.texte = Some(libres.join(" "));
    } else if !libres.is_empty() {
        return Err(format!("argument en trop : {}", libres.join(" ")));
    }
    if o.continuer && o.reprendre.is_some() {
        return Err("-c et -r ensemble : choisir l'un des deux".into());
    }
    if o.autonome.gates.iter().any(|g| g.contains('"')) {
        return Err("--gate : pas de guillemets doubles dans la commande (utiliser des guillemets simples)".into());
    }
    if let (Some(m), Some(e)) = (o.modele.as_mut(), o.effort) {
        m.effort = Some(e);
    }
    Ok(o)
}

/// Le message envoyé au service : les commandes `/autonomous` et `/goal` que le service
/// interprète déjà (session_commands), puis le texte. `/goal` va sur sa propre ligne :
/// hors tête, sa phrase s'arrête à la fin de la ligne.
pub fn message(o: &Options) -> String {
    let texte = o.texte.as_deref().map(str::trim).unwrap_or("");
    let mut tete = String::new();
    if o.autonome.actif {
        tete.push_str("/autonomous");
        let mut flag = |nom: &str, v: Option<u64>| {
            if let Some(v) = v {
                tete.push_str(&format!(" --{nom} {v}"));
            }
        };
        flag("max-turns", o.autonome.max_turns);
        flag("max-tokens", o.autonome.max_tokens);
        flag("timeout-ms", o.autonome.timeout_ms);
        if !o.autonome.gates.is_empty() {
            let gate = o.autonome.gates.join(" && ");
            tete.push_str(&format!(" --gate {}", guillemets(&gate)));
        }
    }
    // Le mode autonome du service finit sur `goal.complete()` : sans --goal, l'objectif
    // est le texte du message.
    let objectif_brut = match o.objectif.as_deref() {
        Some(g) => Some(g),
        None if o.autonome.actif => Some(texte),
        None => None,
    };
    let objectif = objectif_brut.map(str::trim).filter(|g| !g.is_empty()).map(|g| {
        let budget = o.budget.map(|b| format!("--budget {b} ")).unwrap_or_default();
        format!("/goal {budget}{}", g.replace('\n', " "))
    });
    let mut lignes: Vec<String> = Vec::new();
    match (tete.is_empty(), texte.is_empty()) {
        (false, false) => lignes.push(format!("{tete} {texte}")),
        (false, true) => lignes.push(tete),
        (true, false) => lignes.push(texte.to_string()),
        (true, true) => {}
    }
    lignes.extend(objectif);
    lignes.join("\n")
}

/// Une valeur pour `split_args` du service : entre guillemets doubles (il ne connaît pas
/// d'échappement, d'où le refus des `"` dans `lire`).
fn guillemets(v: &str) -> String {
    format!("\"{v}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detection_du_mode_sans_interface() {
        assert!(demande(&a(&["-p", "x"])));
        assert!(demande(&a(&["--mode", "acp"])));
        assert!(demande(&a(&["--mode=json"])));
        assert!(!demande(&a(&["--daemon", "serve"])));
        assert!(!demande(&a(&["/home/x/projet"])));
    }

    #[test]
    fn options_lues() {
        let o = lire(&a(&["--mode", "json", "-p", "bonjour", "--model", "openrouter/anthropic/claude", "--thinking", "high",
            "-r", "abc", "--goal", "finir", "--goal-budget", "200_000", "--autonomous", "--gate", "cargo test",
            "--max-turns", "4", "--wait-max", "0", "--cwd", "/tmp"])).unwrap();
        assert_eq!(o.mode, Mode::Json);
        assert_eq!(o.texte.as_deref(), Some("bonjour"));
        let m = o.modele.clone().unwrap();
        assert_eq!((m.provider.as_str(), m.name.as_str(), m.effort), ("openrouter", "anthropic/claude", Some(Effort::High)));
        assert_eq!(o.reprendre.as_deref(), Some("abc"));
        assert_eq!(o.budget, Some(200_000));
        assert_eq!(o.autonome.max_turns, Some(4));
        assert_eq!(o.attente_max_ms, 0);
        assert_eq!(o.dossier, Some(PathBuf::from("/tmp")));
    }

    #[test]
    fn texte_positionnel_et_erreurs() {
        assert_eq!(lire(&a(&["-p", "--mode", "json", "deux", "mots"])).unwrap().texte.as_deref(), Some("deux mots"));
        assert_eq!(lire(&a(&["--print=salut"])).unwrap().texte.as_deref(), Some("salut"));
        assert!(lire(&a(&["-p", "x", "--inconnue"])).is_err());
        assert!(lire(&a(&["-p", "x", "-c", "-r", "id"])).is_err());
        assert!(lire(&a(&["-p", "x", "--model", "sansbarre"])).is_err());
        assert!(lire(&a(&["-p", "x", "--gate", "echo \"a\""])).is_err());
        assert!(lire(&a(&["-p", "x", "--mode", "xml"])).is_err());
    }

    #[test]
    fn message_avec_commandes_du_service() {
        let o = lire(&a(&["-p", "corrige le parseur", "--autonomous", "--gate", "cargo test", "--gate", "cargo clippy",
            "--max-turns", "3", "--goal", "les tests passent", "--goal-budget", "5000"])).unwrap();
        let m = message(&o);
        assert_eq!(m, "/autonomous --max-turns 3 --gate \"cargo test && cargo clippy\" corrige le parseur\n/goal --budget 5000 les tests passent");
        let cmds = axecode_app::session_commands::parse_slashes(&m);
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].name, "autonomous");
        assert!(cmds[0].args.contains(&"cargo test && cargo clippy".to_string()));
        assert_eq!(cmds[1].name, "goal");
        assert_eq!(cmds[1].rest, "--budget 5000 les tests passent");
        let simple = lire(&a(&["-p", "bonjour"])).unwrap();
        assert_eq!(message(&simple), "bonjour");
        let objectif = lire(&a(&["-p", "--goal", "finir"])).unwrap();
        assert_eq!(message(&objectif), "/goal finir");
        let auto = lire(&a(&["-p", "crée ok.txt", "--autonomous", "--gate", "test -f ok.txt"])).unwrap();
        assert_eq!(message(&auto), "/autonomous --gate \"test -f ok.txt\" crée ok.txt\n/goal crée ok.txt");
    }
}

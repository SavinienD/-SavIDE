//! axe:guet — guets : réveiller la conversation quand une tâche se termine
//! (commande finie, condition devenue vraie, fichier apparu), au lieu d'un
//! heartbeat ou d'un sous-agent qui boucle.
//!
//! Les guets vivent dans l'état de session (`session_state/<id>.json`, champ
//! `guets`) et sont exécutés par le crochet de session, donc dans le DÉMON :
//! ils survivent à la fin du tour et au redémarrage du noyau Python. Une fois
//! la tâche finie, le résultat est livré comme message `<guet id=… statut=…>`
//! qui lance un tour (attend la fin du tour en cours s'il y en a un).
//! Ce module contient la partie pure (types, textes, décisions) et l'exécution
//! des commandes ; l'orchestration est dans `session_commands`.

use std::{path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Fin de sortie gardée pour le message de réveil (octets).
pub const GUET_SORTIE_MAX: usize = 3_000;
pub const GUET_INTERVALLE_DEFAUT_MS: u64 = 30_000;
pub const GUET_INTERVALLE_FICHIER_MS: u64 = 5_000;
pub const GUET_TIMEOUT_DEFAUT_MS: u64 = 2 * 3_600_000;
pub const GUET_INTERVALLE_MIN_MS: u64 = 200;
/// Durée maximale d'un essai de `condition` (une commande qui ne rend pas la main).
pub const GUET_ESSAI_MAX_MS: u64 = 300_000;
pub const GUET_MAX_ACTIFS: usize = 20;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GuetResultat {
    /// `termine` (commande finie), `reussi` (condition/fichier), `delai_depasse`,
    /// `interrompu` (service redémarré pendant la commande), `erreur`.
    pub statut: String,
    #[serde(default)]
    pub code: Option<i32>,
    #[serde(default)]
    pub sortie: String,
    pub fin_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Guet {
    pub id: String,
    /// `commande`, `condition` ou `fichier`.
    pub genre: String,
    #[serde(default)]
    pub cmd: Option<String>,
    #[serde(default)]
    pub chemin: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub intervalle_ms: u64,
    pub timeout_ms: u64,
    pub cree_ms: i64,
    /// Prochain essai (condition / fichier), affiché par l'indicateur.
    #[serde(default)]
    pub prochain_ms: Option<i64>,
    #[serde(default)]
    pub essais: u32,
    /// `actif` puis `a_livrer` (résultat prêt, attend la fin du tour en cours).
    pub statut: String,
    #[serde(default)]
    pub resultat: Option<GuetResultat>,
    /// Lancé par `/guet` (true) ou par l'agent.
    #[serde(default)]
    pub par_utilisateur: bool,
}

impl Guet {
    pub fn libelle(&self) -> String {
        match self.genre.as_str() {
            "fichier" => format!("fichier {}", self.chemin.clone().unwrap_or_default()),
            _ => self.cmd.clone().unwrap_or_default(),
        }
    }
}

pub fn nouvel_id() -> String {
    format!("g{}", &uuid::Uuid::new_v4().simple().to_string()[..6])
}

fn texte(params: &Value, k: &str) -> Option<String> {
    params.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// Guet décrit par les paramètres de `guet.commande` / `guet.condition` / `guet.fichier`.
pub fn depuis_params(genre: &str, params: &Value, now: i64) -> Result<Guet, String> {
    let ms = |k: &str, defaut: u64| params.get(k).and_then(Value::as_u64).unwrap_or(defaut);
    let mut g = Guet {
        id: nouvel_id(),
        genre: genre.into(),
        message: texte(params, "message"),
        cwd: texte(params, "cwd"),
        timeout_ms: ms("timeout_ms", GUET_TIMEOUT_DEFAUT_MS).max(1_000),
        cree_ms: now,
        statut: "actif".into(),
        par_utilisateur: params.get("par_utilisateur").and_then(Value::as_bool).unwrap_or(false),
        ..Default::default()
    };
    match genre {
        "commande" | "condition" => {
            g.cmd = Some(texte(params, "cmd").ok_or_else(|| format!("guet.{genre} : `cmd` est obligatoire"))?);
        }
        "fichier" => {
            g.chemin = Some(texte(params, "chemin").ok_or("guet.fichier : `chemin` est obligatoire")?);
        }
        autre => return Err(format!("genre de guet inconnu `{autre}`")),
    }
    if genre != "commande" {
        let defaut = if genre == "fichier" { GUET_INTERVALLE_FICHIER_MS } else { GUET_INTERVALLE_DEFAUT_MS };
        g.intervalle_ms = ms("intervalle_ms", defaut).max(GUET_INTERVALLE_MIN_MS);
        g.prochain_ms = Some(now);
    }
    Ok(g)
}

pub fn libelle_statut(statut: &str) -> &str {
    match statut {
        "termine" => "terminée",
        "reussi" => "condition remplie",
        "delai_depasse" => "délai dépassé",
        "interrompu" => "interrompue (service redémarré)",
        "erreur" => "erreur",
        autre => autre,
    }
}

/// Message de réveil : `<guet id="…" statut="…" at_ms="…">…</guet>`.
pub fn texte_reveil(g: &Guet, r: &GuetResultat) -> String {
    let mut corps = String::new();
    if let Some(m) = &g.message {
        corps.push_str(m);
        corps.push('\n');
    }
    let duree = crate::commandes_naturelles::decrire_duree((r.fin_ms - g.cree_ms).max(0) as u64);
    let quoi = match g.genre.as_str() {
        "commande" => format!("Commande `{}` : {} après {duree}", g.libelle(), libelle_statut(&r.statut)),
        "condition" => format!("Condition `{}` : {} après {duree} ({} essai{})", g.libelle(), libelle_statut(&r.statut), g.essais, if g.essais > 1 { "s" } else { "" }),
        _ => format!("Guet du {} : {} après {duree}", g.libelle(), libelle_statut(&r.statut)),
    };
    corps.push_str(&quoi);
    if let Some(c) = r.code {
        corps.push_str(&format!(" (code de sortie {c})"));
    }
    corps.push('\n');
    if !r.sortie.trim().is_empty() {
        corps.push_str("Fin de la sortie :\n```\n");
        corps.push_str(r.sortie.trim_end());
        corps.push_str("\n```\n");
    }
    format!(
        "<guet id=\"{}\" statut=\"{}\" at_ms=\"{}\">\n{}</guet>",
        g.id, r.statut, r.fin_ms, corps
    )
}

/// `(id, statut, corps)` d'un message de réveil.
pub fn lire_reveil(texte: &str) -> Option<(String, String, String)> {
    let rest = texte.trim().strip_prefix("<guet ")?;
    let (attrs, corps) = rest.split_once('>')?;
    let corps = corps.strip_suffix("</guet>")?;
    let attr = |k: &str| attrs.split(&format!("{k}=\"")).nth(1).and_then(|v| v.split('"').next()).map(str::to_string);
    Some((attr("id")?, attr("statut").unwrap_or_default(), corps.trim().to_string()))
}

pub fn est_reveil(texte: &str) -> bool {
    texte.trim_start().starts_with("<guet ")
}

/// Fin d'un texte (≤ `max` octets, coupe sur une frontière de caractère).
pub fn fin_de(texte: &str, max: usize) -> String {
    if texte.len() <= max {
        return texte.to_string();
    }
    let mut debut = texte.len() - max;
    while !texte.is_char_boundary(debut) {
        debut += 1;
    }
    format!("…\n{}", &texte[debut..])
}

pub fn shell_cmd(cmd: &str) -> tokio::process::Command {
    let mut c = if cfg!(windows) {
        let mut c = tokio::process::Command::new("pwsh");
        c.args(["-NoProfile", "-NonInteractive", "-Command", cmd]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    c.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Un essai de condition : `(réussi, code, sortie)`.
pub async fn essai(cwd: &Path, cmd: &str, max: Duration) -> (bool, Option<i32>, String) {
    let mut c = shell_cmd(cmd);
    c.current_dir(cwd).kill_on_drop(true);
    match tokio::time::timeout(max, c.output()).await {
        Ok(Ok(out)) => {
            let mut t = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                t.push_str(&err);
            }
            (out.status.success(), out.status.code(), fin_de(&t, GUET_SORTIE_MAX))
        }
        Ok(Err(e)) => (false, None, format!("impossible de lancer la commande : {e}")),
        Err(_) => (false, None, format!("essai arrêté après {} s", max.as_secs())),
    }
}

/// Résumé pour `guet.liste()` et le bloc d'état.
pub fn vue(g: &Guet) -> Value {
    json!({
        "id": g.id, "genre": g.genre, "cible": g.libelle(), "message": g.message,
        "statut": g.statut, "depuis_ms": g.cree_ms, "prochain_ms": g.prochain_ms,
        "essais": g.essais, "timeout_ms": g.timeout_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveil_aller_retour() {
        let g = depuis_params("commande", &json!({"cmd": "make", "message": "construction"}), 1_000).unwrap();
        let r = GuetResultat { statut: "termine".into(), code: Some(0), sortie: "ok".into(), fin_ms: 61_000 };
        let t = texte_reveil(&g, &r);
        assert!(t.contains("Commande `make` : terminée après 1 min (code de sortie 0)"), "{t}");
        let (id, statut, corps) = lire_reveil(&t).unwrap();
        assert_eq!((id, statut.as_str()), (g.id.clone(), "termine"));
        assert!(corps.starts_with("construction"));
        assert!(est_reveil(&t) && !est_reveil("<heartbeat>x</heartbeat>"));
    }

    #[test]
    fn parametres() {
        assert!(depuis_params("commande", &json!({}), 0).is_err());
        let c = depuis_params("condition", &json!({"cmd": "true"}), 5).unwrap();
        assert_eq!((c.intervalle_ms, c.prochain_ms, c.timeout_ms), (GUET_INTERVALLE_DEFAUT_MS, Some(5), GUET_TIMEOUT_DEFAUT_MS));
        let f = depuis_params("fichier", &json!({"chemin": "a.txt", "intervalle_ms": 1}), 0).unwrap();
        assert_eq!(f.intervalle_ms, GUET_INTERVALLE_MIN_MS);
        assert_eq!(fin_de("abcdef", 3), "…\ndef");
    }
}

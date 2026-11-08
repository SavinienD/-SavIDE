//! rlm186 — suivi des sous-agents : fiche de lancement (brief, modèle,
//! worktree), statut final (réussi / échoué / bloqué / arrêté), worktree git
//! par enfant, arrêt, nouvelle tentative et comparaison (course de modèles).

use std::path::PathBuf;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use axecode_core::session::{CreateSessionRequest, SessionMeta, SessionStatus};

use super::{max_utilization, now_ms, parse_model, req, s, FamilyHost, SubagentResult, FANOUT_GUARD, QUOTA_WARN_PERCENT};
use crate::rlm_git::{self, Worktree};

/// Statuts finaux d'une tâche de sous-agent.
pub const REUSSI: &str = "réussi";
pub const ECHOUE: &str = "échoué";
pub const BLOQUE: &str = "bloqué";
pub const ARRETE: &str = "arrêté";

/// Fiche d'un sous-agent, écrite à son lancement sous `<data>/rlm/fiches/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fiche {
    pub id: String,
    pub nom: String,
    pub parent: String,
    /// La tâche donnée au lancement (sans les ajouts d'une nouvelle tentative).
    pub brief: String,
    /// `fournisseur/modèle`.
    pub modele: String,
    #[serde(default)]
    pub profil: Option<String>,
    #[serde(default)]
    pub worktree: Option<Worktree>,
    /// Demande de worktree d'origine (`true` ou un nom), reprise par `retry`.
    #[serde(default)]
    pub worktree_demande: Option<Value>,
    pub cree_ms: i64,
    /// Enfant dont celui-ci est la nouvelle tentative.
    #[serde(default)]
    pub reprise_de: Option<String>,
    /// Arrêté par le parent (`rlm.stop`).
    #[serde(default)]
    pub arrete_ms: Option<i64>,
}

/// Ce qu'il faut pour lancer un enfant.
#[derive(Debug, Clone, Default)]
pub(super) struct Lancement {
    pub brief: String,
    /// Premier message réellement envoyé (défaut : le brief).
    pub message: Option<String>,
    pub nom: Option<String>,
    pub modele: Option<String>,
    pub profil: Option<String>,
    /// `true` ou un nom de worktree ; `None` : pas de worktree.
    pub worktree: Option<Value>,
    pub reprise_de: Option<String>,
}

/// Lit `worktree=` : faux/absent → `None`, vrai → `Some(true)`, nom → `Some("nom")`.
pub(super) fn option_worktree(params: &Value) -> Result<Option<Value>> {
    match params.get("worktree") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
        Some(Value::Bool(true)) => Ok(Some(Value::Bool(true))),
        Some(Value::String(nom)) if !nom.trim().is_empty() => Ok(Some(json!(nom.trim()))),
        Some(other) => bail!("`worktree` doit valoir True, False ou un nom (reçu {other})"),
    }
}

/// Dernière ligne `STATUT: réussi|échoué|bloqué` d'un rapport (casse, accents
/// et gras Markdown tolérés, parmi les 3 dernières lignes non vides) ; rend
/// le statut et le texte sans cette ligne.
pub fn lire_statut(texte: &str) -> (Option<&'static str>, String) {
    let lignes: Vec<&str> = texte.lines().collect();
    let non_vides: Vec<usize> = (0..lignes.len()).filter(|&i| !lignes[i].trim().is_empty()).collect();
    for &i in non_vides.iter().rev().take(3) {
        let brut = lignes[i].trim().trim_matches(|c| c == '*' || c == '_' || c == '`').trim();
        let bas = brut.to_lowercase();
        let Some(reste) = bas.strip_prefix("statut") else { continue };
        let Some(valeur) = reste.trim_start().strip_prefix(':') else { continue };
        let valeur = valeur.trim().trim_matches(|c: char| !c.is_alphanumeric());
        let statut = if valeur.starts_with("réussi") || valeur.starts_with("reussi") {
            REUSSI
        } else if valeur.starts_with("échou") || valeur.starts_with("echou") {
            ECHOUE
        } else if valeur.starts_with("bloqu") {
            BLOQUE
        } else if valeur.starts_with("arrêt") || valeur.starts_with("arret") {
            ARRETE
        } else {
            continue;
        };
        let mut reste: Vec<&str> = lignes.clone();
        reste.remove(i);
        return (Some(statut), reste.join("\n").trim_end().to_string());
    }
    (None, texte.to_string())
}

/// Début du message remis au parent : le statut d'abord.
pub(super) fn message_parent(nom: &str, statut: &str, erreur: bool, tronque: bool, fichiers: &[String], texte: &str) -> String {
    let mut tete = if erreur {
        format!("STATUT: {statut} — sous-agent `{nom}` arrêté sur une erreur")
    } else {
        format!("STATUT: {statut} — sous-agent `{nom}` a fini sa tâche")
    };
    if tronque {
        tete.push_str(" (rapport tronqué)");
    }
    if !fichiers.is_empty() {
        let mut liste = fichiers.iter().take(10).cloned().collect::<Vec<_>>().join(", ");
        if fichiers.len() > 10 {
            liste.push_str(&format!(", … (+{})", fichiers.len() - 10));
        }
        tete.push_str(&format!(" ; fichiers modifiés dans son worktree : {liste}"));
    }
    format!("{tete} :\n\n{texte}")
}

/// Statut d'un résultat écrit avant rlm186 (sans `statut`).
pub(super) fn completer(mut r: SubagentResult) -> SubagentResult {
    if r.statut.is_none() {
        r.statut = Some(if r.error { ECHOUE } else { REUSSI }.into());
    }
    r
}

async fn bloquant<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| anyhow!("{e}"))?.map_err(|e| anyhow!(e))
}

fn court(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

impl FamilyHost {
    fn fiches_dir(&self) -> PathBuf {
        self.data_dir.join("rlm").join("fiches")
    }

    pub(super) fn lire_fiche(&self, id: &str) -> Option<Fiche> {
        let texte = std::fs::read_to_string(self.fiches_dir().join(format!("{id}.json"))).ok()?;
        serde_json::from_str(&texte).ok()
    }

    fn ecrire_fiche(&self, fiche: &Fiche) -> Result<()> {
        std::fs::create_dir_all(self.fiches_dir())?;
        std::fs::write(
            self.fiches_dir().join(format!("{}.json", fiche.id)),
            serde_json::to_vec_pretty(fiche)?,
        )?;
        Ok(())
    }

    /// Fichiers modifiés dans le worktree de la session `id` (vide sans worktree).
    pub(super) async fn fichiers_de(&self, id: &str) -> Vec<String> {
        let Some(wt) = self.lire_fiche(id).and_then(|f| f.worktree) else {
            return Vec::new();
        };
        bloquant(move || rlm_git::fichiers_modifies(&wt)).await.unwrap_or_default()
    }

    /// Lance un enfant : modèle, nom unique, garde de quota, worktree éventuel,
    /// préambule (worktree, ligne de statut), fiche.
    pub(super) async fn lancer(&self, l: Lancement) -> Result<Value> {
        let me = self.me().await?;
        let (_, children, _) = self.family().await?;
        let profile = match l.profil.as_deref() {
            Some(key) => Some(
                self.find_profile(key)
                    .cloned()
                    .ok_or_else(|| anyhow!("unknown sub-agent profile `{key}`"))?,
            ),
            None => None,
        };
        let model = match l.modele.as_deref() {
            Some(raw) => parse_model(raw).ok_or_else(|| anyhow!("model must be `provider/model`"))?,
            None => profile
                .as_ref()
                .and_then(|p| p.model.clone())
                // sub-m — default sub-agent model from the REPL settings.
                .or_else(|| {
                    crate::repl::ReplSettings::load(&self.data_dir)
                        .subagent_default_model
                        .as_deref()
                        .and_then(|m| parse_model(m.trim()))
                })
                .unwrap_or_else(|| me.model.clone()),
        };
        let base = l
            .nom
            .clone()
            .or_else(|| profile.as_ref().map(|p| p.name.clone()))
            .unwrap_or_else(|| "subagent".into());
        let mut name = base.clone();
        let mut n = 2;
        while children.iter().any(|c| c.name == name) {
            name = format!("{base}-{n}");
            n += 1;
        }

        // Quota guard before fanning out (never blocking).
        let spawned = {
            let mut count = self.spawned_this_turn.lock().map_err(|_| anyhow!("poisoned"))?;
            *count += 1;
            *count
        };
        let mut avertissements = Vec::new();
        if spawned > FANOUT_GUARD {
            if let Some(pct) = self.current_quota().await.as_ref().and_then(max_utilization) {
                if pct >= QUOTA_WARN_PERCENT {
                    avertissements.push(format!(
                        "subscription quota at {pct:.0}% — {spawned} sub-agents spawned this turn; consider sequencing the rest unless the user asked for parallelism"
                    ));
                }
            }
        }

        let worktree = match &l.worktree {
            None => None,
            Some(demande) => {
                let nom_wt = demande.as_str().map(str::to_string).unwrap_or_else(|| name.clone());
                let dossier = PathBuf::from(&me.workspace_id);
                let (wt, avertissement) = bloquant(move || rlm_git::creer(&dossier, &nom_wt)).await?;
                avertissements.extend(avertissement);
                Some(wt)
            }
        };

        let mut extra = format!(
            "# Sub-agent\n\nYou are the sub-agent `{name}`, spawned by the session `{}`. Work autonomously on the task in the first user message. Your final answer is delivered to your parent automatically; use `messages.send(..., receiver_role=\"parent\")` only for intermediate questions or heads-ups. You stay alive after your task: your parent may send follow-ups.",
            me.name
        );
        if let Some(wt) = &worktree {
            extra.push_str(&format!(
                "\n\n# Git worktree\n\nYou work in your own git worktree `{}` on the branch `{}` (created from commit `{}` of the parent's repository `{}`). Stay in this folder and never modify the parent's folder. Commit your work on your branch; your parent reviews it with `rlm.worktree()` and merges it with `rlm.fusionner()` (anything left uncommitted is committed for you then).",
                wt.dossier.display(),
                wt.branche,
                court(&wt.base),
                wt.depot.display()
            ));
        }
        extra.push_str(&format!(
            "\n\n# Final status\n\nEnd your final answer with one last line `STATUT: {REUSSI}`, `STATUT: {ECHOUE}` or `STATUT: {BLOQUE}` ({REUSSI}: the task is done; {ECHOUE}: you could not do it; {BLOQUE}: you need a decision, an access or information from your parent)."
        ));
        if let Some(profile) = &profile {
            extra.push_str(&format!("\n\n# Profile: {}\n\n{}", profile.name, profile.prompt.trim()));
        }
        let workspace_id = worktree
            .as_ref()
            .map(|wt| wt.dossier.display().to_string())
            .unwrap_or_else(|| me.workspace_id.clone());
        let created = self
            .host
            .create_session(CreateSessionRequest {
                name: name.clone(),
                workspace_id,
                model: model.clone(),
                parent_id: Some(me.id.clone()),
                system_prompt_extra: Some(extra),
                initial_message: Some(l.message.clone().unwrap_or_else(|| l.brief.clone())),
            })
            .await;
        let child = match created {
            Ok(child) => child,
            Err(err) => {
                if let Some(wt) = worktree {
                    let _ = bloquant(move || rlm_git::liberer(&wt, "", false)).await;
                }
                bail!("{err}");
            }
        };
        self.ecrire_fiche(&Fiche {
            id: child.id.clone(),
            nom: child.name.clone(),
            parent: me.id.clone(),
            brief: l.brief,
            modele: format!("{}/{}", model.provider, model.name),
            profil: l.profil,
            worktree: worktree.clone(),
            worktree_demande: l.worktree,
            cree_ms: now_ms(),
            reprise_de: l.reprise_de,
            arrete_ms: None,
        })?;
        let mut out = json!({ "id": child.id, "session_name": child.name, "model": format!("{}/{}", model.provider, model.name) });
        if let Some(wt) = &worktree {
            out["worktree"] = json!(wt.dossier.display().to_string());
            out["branche"] = json!(wt.branche);
        }
        if !avertissements.is_empty() {
            out["warning"] = json!(avertissements.join(" ; "));
        }
        Ok(out)
    }

    /// `rlm.stop` : arrête le tour en cours de l'enfant (comme le bouton Stop)
    /// et note son statut « arrêté ». Sans tour en cours, rien ne change.
    pub(super) async fn arreter(&self, params: &Value) -> Result<Value> {
        let child = self.resolve_child(req(params, "id")?).await?;
        if child.status != SessionStatus::Running {
            let statut = self.read_result(&child.id)?.map(completer).and_then(|r| r.statut);
            return Ok(json!({
                "id": child.id, "session_name": child.name, "etait_en_cours": false,
                "statut": statut, "message": format!("`{}` ne travaillait pas : rien à arrêter", child.name),
            }));
        }
        self.host.stop_turn(&child.id).await.map_err(|e| anyhow!("{e}"))?;
        if let Some(mut fiche) = self.lire_fiche(&child.id) {
            fiche.arrete_ms = Some(now_ms());
            self.ecrire_fiche(&fiche)?;
        }
        let fichiers = self.fichiers_de(&child.id).await;
        self.write_result(&SubagentResult {
            id: child.id.clone(),
            session_name: child.name.clone(),
            text: "Arrêté par le parent (rlm.stop) avant la fin de sa tâche.".into(),
            ts: now_ms(),
            truncated: false,
            error: false,
            statut: Some(ARRETE.into()),
            fichiers,
        })?;
        Ok(json!({
            "id": child.id, "session_name": child.name, "etait_en_cours": true, "statut": ARRETE,
            "message": format!("`{}` arrêté", child.name),
        }))
    }

    /// `rlm.retry` : nouvel enfant avec le même brief, le même modèle, le même
    /// profil et la même demande de worktree, plus le rapport de la tentative
    /// précédente et la note du parent. L'ancien est arrêté s'il travaille encore.
    pub(super) async fn reprendre(&self, params: &Value) -> Result<Value> {
        let child = self.resolve_child(req(params, "id")?).await?;
        let fiche = self.lire_fiche(&child.id).ok_or_else(|| {
            anyhow!("`{}` n'a pas de fiche de lancement (lancé avant cette version) : relancez-le avec rlm.spawn", child.name)
        })?;
        if child.status == SessionStatus::Running {
            self.arreter(&json!({ "id": child.id })).await?;
        }
        let precedent = self.read_result(&child.id)?.map(completer);
        let (statut, rapport) = match &precedent {
            Some(r) => (r.statut.clone().unwrap_or_default(), r.text.trim().to_string()),
            None => ("inconnu".into(), "(aucun rapport)".into()),
        };
        let mut message = format!(
            "{}\n\n---\nTentative précédente : le sous-agent `{}` a déjà essayé cette tâche (statut : {statut}). Son rapport :\n\n{rapport}\n",
            fiche.brief.trim_end(),
            child.name
        );
        if let Some(note) = s(params, "note") {
            message.push_str(&format!("\nNote du parent : {note}\n"));
        }
        message.push_str("\nReprends la tâche en tenant compte de cette tentative.");
        let mut base = fiche.nom.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-').to_string();
        if let Some(sans) = base.strip_suffix("-reprise") {
            base = sans.to_string();
        }
        let base = if base.is_empty() { fiche.nom.clone() } else { base };
        let mut out = self
            .lancer(Lancement {
                brief: fiche.brief.clone(),
                message: Some(message),
                nom: Some(format!("{base}-reprise")),
                modele: Some(fiche.modele.clone()),
                profil: fiche.profil.clone(),
                worktree: fiche.worktree_demande.clone().map(|d| if d.is_string() { Value::Bool(true) } else { d }),
                reprise_de: Some(child.id.clone()),
            })
            .await?;
        out["reprise_de"] = json!(child.id);
        Ok(out)
    }

    async fn avec_worktree(&self, key: &str) -> Result<(SessionMeta, Worktree)> {
        let child = self.resolve_child(key).await?;
        let wt = self.lire_fiche(&child.id).and_then(|f| f.worktree).ok_or_else(|| {
            anyhow!("`{}` n'a pas de worktree (lancez-le avec rlm.spawn(..., worktree=True))", child.name)
        })?;
        Ok((child, wt))
    }

    fn pas_en_cours(child: &SessionMeta, action: &str) -> Result<()> {
        if child.status == SessionStatus::Running {
            bail!("`{}` travaille encore : attendez son résultat (rlm.wait) ou arrêtez-le (rlm.stop) avant de {action}", child.name);
        }
        Ok(())
    }

    /// `rlm.worktree` : chemin, branche, fichiers modifiés, diff --stat, commits.
    pub(super) async fn worktree_etat(&self, params: &Value) -> Result<Value> {
        let (child, wt) = self.avec_worktree(req(params, "id")?).await?;
        let mut v = bloquant(move || rlm_git::etat(&wt)).await?;
        v["enfant"] = json!(child.name);
        v["en_cours"] = json!(child.status == SessionStatus::Running);
        Ok(v)
    }

    /// `rlm.fusionner` : fusionne la branche de l'enfant dans la branche courante du parent.
    pub(super) async fn fusionner(&self, params: &Value) -> Result<Value> {
        let (child, wt) = self.avec_worktree(req(params, "id")?).await?;
        Self::pas_en_cours(&child, "fusionner")?;
        let nom = child.name.clone();
        bloquant(move || rlm_git::fusionner(&wt, &nom)).await
    }

    /// `rlm.liberer` : supprime le worktree de l'enfant (branche gardée par défaut).
    pub(super) async fn liberer(&self, params: &Value) -> Result<Value> {
        let (child, wt) = self.avec_worktree(req(params, "id")?).await?;
        Self::pas_en_cours(&child, "libérer son worktree")?;
        let garder = params.get("garder_branche").and_then(Value::as_bool).unwrap_or(true);
        let nom = child.name.clone();
        bloquant(move || rlm_git::liberer(&wt, &nom, garder)).await
    }

    /// `rlm.comparer` : une ligne par enfant (statut, durée, fichiers, diff --stat).
    pub(super) async fn comparer(&self, params: &Value) -> Result<Value> {
        let cles: Vec<String> = params
            .get("ids")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("`ids` doit être une liste de sous-agents"))?
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let mut lignes = Vec::new();
        for cle in cles {
            let child = self.resolve_child(&cle).await?;
            let fiche = self.lire_fiche(&child.id);
            let resultat = self.read_result(&child.id)?.map(completer);
            let en_cours = child.status == SessionStatus::Running;
            let statut = if en_cours {
                "en cours".to_string()
            } else {
                resultat.as_ref().and_then(|r| r.statut.clone()).unwrap_or_else(|| "sans résultat".into())
            };
            let debut = fiche.as_ref().map_or(child.created_at_ms, |f| f.cree_ms);
            let fin = match (&resultat, en_cours) {
                (Some(r), false) if r.ts >= debut => r.ts,
                _ => now_ms(),
            };
            let (fichiers, stat, branche) = match fiche.as_ref().and_then(|f| f.worktree.clone()) {
                Some(wt) => {
                    let branche = wt.branche.clone();
                    let etat = bloquant(move || rlm_git::etat(&wt)).await.unwrap_or(Value::Null);
                    let fichiers: Vec<String> = serde_json::from_value(etat["fichiers"].clone()).unwrap_or_default();
                    (fichiers, etat["diff_stat"].as_str().unwrap_or_default().to_string(), Some(branche))
                }
                None => (Vec::new(), String::new(), None),
            };
            let resume = stat
                .lines()
                .rev()
                .find(|l| l.contains("changed"))
                .unwrap_or_default()
                .trim()
                .to_string();
            lignes.push(json!({
                "id": child.id,
                "session_name": child.name,
                "modele": fiche.as_ref().map_or_else(|| format!("{}/{}", child.model.provider, child.model.name), |f| f.modele.clone()),
                "statut": statut,
                "duree_s": (fin - debut).max(0) / 1000,
                "fichiers": fichiers,
                "diff_stat": resume,
                "diff_stat_complet": stat,
                "branche": branche,
            }));
        }
        Ok(Value::Array(lignes))
    }
}

impl FamilyHost {
    /// `messages.send(receiver_role="all")` : le même message à chaque cible.
    pub(super) async fn broadcast(&self, cibles: Vec<SessionMeta>, body: String) -> Result<Value> {
        if cibles.is_empty() {
            bail!("receiver_role=\"all\" : aucun enfant ni frère ou sœur à qui écrire");
        }
        let mut messages = Vec::new();
        for cible in &cibles {
            let id = self
                .host
                .post_peer_message(&self.session_id, &cible.id, body.clone())
                .await
                .map_err(|e| anyhow!("{e}"))?;
            messages.push(json!({ "session_id": cible.id, "session_name": cible.name, "message_id": id }));
        }
        Ok(json!({
            "delivered_to": cibles.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            "messages": messages,
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::{Arc, Mutex}};

    use async_trait::async_trait;
    use axecode_core::session::{EntryId, JournalEntryKind, SessionError, SessionHost, SessionResult};

    use super::*;
    use crate::rlm_git::git;

    #[derive(Default)]
    struct FauxHote {
        sessions: Mutex<Vec<SessionMeta>>,
        messages: Mutex<Vec<(String, String, String)>>,
        arrets: Mutex<Vec<String>>,
        demandes: Mutex<Vec<CreateSessionRequest>>,
    }

    fn meta(id: &str, parent: Option<&str>, nom: &str, dossier: &str, modele: &str) -> SessionMeta {
        let (p, m) = modele.split_once('/').unwrap();
        let mut s: SessionMeta = serde_json::from_value(json!({
            "id": id, "name": nom, "workspaceId": dossier, "model": {"provider": p, "name": m},
            "status": SessionStatus::Idle, "createdAtMs": now_ms(), "updatedAtMs": now_ms()
        }))
        .unwrap();
        s.parent_id = parent.map(Into::into);
        s
    }

    #[async_trait]
    impl SessionHost for FauxHote {
        async fn create_session(&self, r: CreateSessionRequest) -> SessionResult<SessionMeta> {
            let mut sessions = self.sessions.lock().unwrap();
            let id = format!("enfant{}", sessions.len());
            let modele = format!("{}/{}", r.model.provider, r.model.name);
            let mut m = meta(&id, r.parent_id.as_deref(), &r.name, &r.workspace_id, &modele);
            m.status = SessionStatus::Running;
            sessions.push(m.clone());
            self.demandes.lock().unwrap().push(r);
            Ok(m)
        }
        async fn get_session(&self, id: &str) -> SessionResult<SessionMeta> {
            let sessions = self.sessions.lock().unwrap();
            sessions.iter().find(|m| m.id == id).cloned().ok_or_else(|| SessionError::NotFound(id.into()))
        }
        async fn list_sessions(&self) -> Vec<SessionMeta> {
            self.sessions.lock().unwrap().clone()
        }
        async fn send_user_message(&self, _id: &str, _t: String) -> SessionResult<EntryId> {
            Ok("u".into())
        }
        async fn post_peer_message(&self, from: &str, to: &str, text: String) -> SessionResult<EntryId> {
            let mut messages = self.messages.lock().unwrap();
            messages.push((from.into(), to.into(), text));
            Ok(format!("msg{}", messages.len()))
        }
        async fn record(&self, _id: &str, _k: JournalEntryKind) -> SessionResult<EntryId> {
            Ok("r".into())
        }
        async fn stop_turn(&self, id: &str) -> SessionResult<()> {
            self.arrets.lock().unwrap().push(id.into());
            self.fin(id);
            Ok(())
        }
    }

    impl FauxHote {
        fn fin(&self, id: &str) {
            if let Some(m) = self.sessions.lock().unwrap().iter_mut().find(|m| m.id == id) {
                m.status = SessionStatus::Idle;
            }
        }
        fn dernier_message(&self) -> (String, String, String) {
            self.messages.lock().unwrap().last().cloned().unwrap()
        }
    }

    struct Banc {
        hote: Arc<FauxHote>,
        data: tempfile::TempDir,
        depot: PathBuf,
        _tmp: tempfile::TempDir,
    }

    /// Dépôt git « projet » (a.txt) et session parente qui y travaille.
    fn banc() -> Banc {
        let tmp = tempfile::tempdir().unwrap();
        let depot = tmp.path().join("projet");
        std::fs::create_dir_all(&depot).unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@exemple.fr"], &["config", "user.name", "Test"]] {
            git(&depot, args).unwrap();
        }
        std::fs::write(depot.join("a.txt"), "un\n").unwrap();
        git(&depot, &["add", "-A"]).unwrap();
        git(&depot, &["commit", "-q", "-m", "départ"]).unwrap();
        let hote = Arc::new(FauxHote::default());
        let racine = rlm_git::racine_depot(&depot).unwrap();
        hote.sessions.lock().unwrap().push(meta("parent", None, "parent", &racine.display().to_string(), "anthropic/claude"));
        Banc { hote, data: tempfile::tempdir().unwrap(), depot: racine, _tmp: tmp }
    }

    fn famille(b: &Banc, id: &str) -> FamilyHost {
        FamilyHost::new(b.hote.clone(), id, b.data.path(), vec![], None)
    }

    fn texte(dossier: &Path, fichier: &str) -> String {
        std::fs::read_to_string(dossier.join(fichier)).unwrap()
    }

    #[tokio::test]
    async fn worktree_statut_final_fusion_et_liberation() {
        let b = banc();
        let parent = famille(&b, "parent");
        let v = parent
            .dispatch("rlm.spawn", &json!({"prompt": "corrige a.txt", "name": "fix", "worktree": true}))
            .await
            .unwrap();
        assert_eq!(v["branche"], "sous-agent/fix", "{v}");
        let dossier = PathBuf::from(v["worktree"].as_str().unwrap());
        assert_eq!(dossier, b.depot.parent().unwrap().join("projet-sous-agents").join("fix"));
        {
            let demandes = b.hote.demandes.lock().unwrap();
            assert_eq!(demandes[0].workspace_id, dossier.display().to_string(), "l'enfant travaille dans son worktree");
            let extra = demandes[0].system_prompt_extra.clone().unwrap();
            assert!(extra.contains("# Git worktree") && extra.contains("sous-agent/fix"), "{extra}");
            assert!(extra.contains("`STATUT: réussi`, `STATUT: échoué` or `STATUT: bloqué`"), "{extra}");
            assert_eq!(demandes[0].initial_message.as_deref(), Some("corrige a.txt"));
        }
        // L'enfant modifie a.txt sans valider, puis finit « bloqué ».
        std::fs::write(dossier.join("a.txt"), "UN\n").unwrap();
        let enfant = famille(&b, "enfant1");
        enfant.on_turn_finished("J'ai corrigé a.txt.\n\n**STATUT : bloqué**").await.unwrap();
        b.hote.fin("enfant1");
        let (de, a, corps) = b.hote.dernier_message();
        assert_eq!((de.as_str(), a.as_str()), ("enfant1", "parent"));
        assert!(
            corps.starts_with("STATUT: bloqué — sous-agent `fix` a fini sa tâche ; fichiers modifiés dans son worktree : a.txt :"),
            "{corps}"
        );
        assert!(corps.ends_with("J'ai corrigé a.txt."), "ligne de statut retirée du rapport : {corps}");
        for methode in ["rlm.result", "rlm.wait"] {
            let r = parent.dispatch(methode, &json!({"id": "fix", "timeout_ms": 2000})).await.unwrap();
            assert_eq!((r["statut"].as_str(), r["fichiers"].clone()), (Some("bloqué"), json!(["a.txt"])), "{methode} {r}");
        }
        assert_eq!(parent.dispatch("rlm.list", &json!({})).await.unwrap()[0]["statut"], "bloqué");
        let e = parent.dispatch("rlm.worktree", &json!({"id": "fix"})).await.unwrap();
        assert_eq!(e["fichiers"], json!(["a.txt"]));
        assert!(e["diff_stat"].as_str().unwrap().contains("a.txt"), "{e}");
        let f = parent.dispatch("rlm.fusionner", &json!({"id": "fix"})).await.unwrap();
        assert_eq!(f["fusionne"], true, "{f}");
        assert_eq!(texte(&b.depot, "a.txt"), "UN\n");
        let l = parent.dispatch("rlm.liberer", &json!({"id": "fix", "garder_branche": false})).await.unwrap();
        assert_eq!(l["branche_gardee"], false, "{l}");
        assert!(!dossier.exists());
    }

    #[tokio::test]
    async fn statut_par_defaut_erreur_et_hors_depot() {
        let b = banc();
        let parent = famille(&b, "parent");
        parent.dispatch("rlm.spawn", &json!({"prompt": "lis", "name": "lecteur"})).await.unwrap();
        assert!(b.hote.demandes.lock().unwrap()[0].workspace_id.ends_with("projet"), "sans worktree : dossier du parent");
        let enfant = famille(&b, "enfant1");
        enfant.on_turn_finished("Lu.").await.unwrap();
        assert!(b.hote.dernier_message().2.starts_with("STATUT: réussi — sous-agent `lecteur` a fini sa tâche :\n\nLu."));
        enfant.on_turn_failed("HTTP 429 rate_limit_error").await.unwrap();
        assert!(b.hote.dernier_message().2.starts_with("STATUT: échoué — sous-agent `lecteur` arrêté sur une erreur"));
        b.hote.fin("enfant1");
        let r = parent.dispatch("rlm.result", &json!({"id": "enfant1"})).await.unwrap();
        assert_eq!((r["statut"].as_str(), r["error"].as_bool()), (Some("échoué"), Some(true)));
        // Dossier du parent hors de tout dépôt : erreur claire, aucun enfant créé.
        let ailleurs = tempfile::tempdir().unwrap();
        b.hote.sessions.lock().unwrap().push(meta("seul", None, "seul", &ailleurs.path().display().to_string(), "anthropic/claude"));
        let err = famille(&b, "seul")
            .dispatch("rlm.spawn", &json!({"prompt": "x", "worktree": "essai"}))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("n'est pas un dépôt git"), "{err}");
        assert_eq!(b.hote.demandes.lock().unwrap().len(), 1);
    }

    #[test]
    fn lecture_du_statut() {
        assert_eq!(lire_statut("ok\nSTATUT: réussi").0, Some(REUSSI));
        assert_eq!(lire_statut("ok\n**Statut : Echoue.**\n").0, Some(ECHOUE));
        assert_eq!(lire_statut("STATUT: bloqué\nsuite 1\nsuite 2\nsuite 3").0, None, "trop loin de la fin");
        assert_eq!(lire_statut("statut: inconnu").0, None);
        let (s, texte) = lire_statut("Rapport.\nSTATUT: bloqué\nMerci.");
        assert_eq!((s, texte.as_str()), (Some(BLOQUE), "Rapport.\nMerci."));
    }

    #[tokio::test]
    async fn stop_puis_retry_avec_rapport_et_note() {
        let b = banc();
        let parent = famille(&b, "parent");
        parent
            .dispatch("rlm.spawn", &json!({"prompt": "migre la base", "name": "migr", "worktree": true, "model": "openai/gpt-x"}))
            .await
            .unwrap();
        let v = parent.dispatch("rlm.stop", &json!({"id": "migr"})).await.unwrap();
        assert_eq!((v["statut"].as_str(), v["etait_en_cours"].as_bool()), (Some("arrêté"), Some(true)), "{v}");
        assert_eq!(*b.hote.arrets.lock().unwrap(), vec!["enfant1".to_string()]);
        let r = parent.dispatch("rlm.result", &json!({"id": "migr"})).await.unwrap();
        assert_eq!(r["statut"], "arrêté");
        let again = parent.dispatch("rlm.stop", &json!({"id": "migr"})).await.unwrap();
        assert_eq!(again["etait_en_cours"], false, "rien à arrêter : {again}");
        let h = parent
            .dispatch("rlm.retry", &json!({"id": "migr", "note": "commence par les index"}))
            .await
            .unwrap();
        assert_eq!((h["session_name"].as_str(), h["reprise_de"].as_str()), (Some("migr-reprise"), Some("enfant1")), "{h}");
        assert_eq!(h["branche"], "sous-agent/migr-reprise", "nouveau worktree : {h}");
        let demandes = b.hote.demandes.lock().unwrap();
        let message = demandes[1].initial_message.clone().unwrap();
        assert!(message.starts_with("migre la base\n\n---\nTentative précédente : le sous-agent `migr`"), "{message}");
        assert!(message.contains("(statut : arrêté)") && message.contains("Arrêté par le parent"), "{message}");
        assert!(message.contains("Note du parent : commence par les index"), "{message}");
        assert_eq!((demandes[1].model.provider.as_str(), demandes[1].model.name.as_str()), ("openai", "gpt-x"));
        drop(demandes);
        // Une reprise d'un enfant encore au travail l'arrête d'abord.
        parent.dispatch("rlm.retry", &json!({"id": "migr-reprise"})).await.unwrap();
        assert_eq!(b.hote.arrets.lock().unwrap().last().map(String::as_str), Some("enfant2"));
    }

    #[tokio::test]
    async fn diffusion_a_toute_la_famille() {
        let b = banc();
        let parent = famille(&b, "parent");
        for nom in ["a", "b"] {
            parent.dispatch("rlm.spawn", &json!({"prompt": "x", "name": nom})).await.unwrap();
        }
        let n0 = b.hote.messages.lock().unwrap().len();
        let v = parent.dispatch("messages.send", &json!({"text": "cible changée", "receiver_role": "all"})).await.unwrap();
        assert_eq!(v["delivered_to"], json!(["enfant1", "enfant2"]), "{v}");
        let messages = b.hote.messages.lock().unwrap()[n0..].to_vec();
        assert!(messages.iter().all(|(de, _, t)| de == "parent" && t == "[new task] cible changée"), "{messages:?}");
        let v = famille(&b, "enfant1")
            .dispatch("messages.send", &json!({"text": "j'ai fini types.ts", "receiver_role": "all", "mode": "follow_up"}))
            .await
            .unwrap();
        assert_eq!(v["delivered_to"], json!(["enfant2"]), "un enfant écrit à ses frères et sœurs : {v}");
        b.hote.sessions.lock().unwrap().push(meta("seul", None, "seul", "/tmp", "anthropic/claude"));
        let err = famille(&b, "seul")
            .dispatch("messages.send", &json!({"text": "x", "receiver_role": "all"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("aucun enfant"), "{err}");
    }

    #[tokio::test]
    async fn comparer_une_course() {
        let b = banc();
        let parent = famille(&b, "parent");
        for (nom, modele) in [("course-claude", "anthropic/claude"), ("course-gpt", "openai/gpt")] {
            parent
                .dispatch("rlm.spawn", &json!({"prompt": "corrige", "name": nom, "model": modele, "worktree": true}))
                .await
                .unwrap();
        }
        let dossier = b.depot.parent().unwrap().join("projet-sous-agents").join("course-claude");
        std::fs::write(dossier.join("a.txt"), "deux\n").unwrap();
        famille(&b, "enfant1").on_turn_finished("Fait.\nSTATUT: réussi").await.unwrap();
        b.hote.fin("enfant1");
        let t = parent.dispatch("rlm.comparer", &json!({"ids": ["course-claude", "enfant2"]})).await.unwrap();
        assert_eq!(t[0]["statut"], "réussi", "{t}");
        assert_eq!(t[0]["modele"], "anthropic/claude");
        assert_eq!(t[0]["fichiers"], json!(["a.txt"]));
        assert!(t[0]["diff_stat"].as_str().unwrap().contains("1 file changed"), "{t}");
        assert_eq!((t[1]["statut"].as_str(), t[1]["modele"].as_str()), (Some("en cours"), Some("openai/gpt")));
        assert_eq!(t[1]["fichiers"], json!([]));
        assert!(t[0]["duree_s"].as_i64().unwrap() >= 0);
    }
}

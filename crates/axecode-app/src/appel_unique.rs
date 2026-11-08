//! Appel unique au modèle : un seul échange, sans session, sans outils, sans
//! harnais. C'est l'appel léger des Recursive Language Models : traiter un gros
//! document par morceaux (`rlm.query`, `rlm.query_lot` dans le noyau, commande
//! `ia_appel_unique` de l'interface).
//!
//! Le fournisseur est résolu comme pour les sessions ([`ProviderResolver`] :
//! abonnement OAuth ou clé API du compte configuré pour le fournisseur du modèle
//! choisi). Le modèle par défaut est celui des sous-agents des Réglages, sinon
//! celui de la conversation. Aucune réflexion étendue (effort retiré) : l'appel
//! reste rapide et économe.

use std::{path::Path, time::Duration};

use axecode_core::{
    AppError, ChatMessage, ModelRef, ProviderRequest, StopReason, StreamEvent, Usage,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::repl::{ProviderResolver, ReplSettings};

/// Plafond de sortie par défaut (jetons).
pub const PLAFOND_DEFAUT: u32 = 4_000;
/// Plafond de sortie le plus haut accepté (jetons).
pub const PLAFOND_MAX: u32 = 64_000;
/// Délai maximal d'un échange.
pub const DELAI: Duration = Duration::from_secs(600);
/// Pauses avant chaque nouvel essai sur une erreur passagère (réseau, 429…).
const PAUSES: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(5)];

/// Une demande d'appel unique.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Demande {
    /// Consigne système, facultative.
    #[serde(default)]
    pub systeme: Option<String>,
    /// Le texte envoyé au modèle (message de l'utilisateur).
    pub texte: String,
    /// `fournisseur/modèle`, facultatif (voir [`choisir_modele`]).
    #[serde(default)]
    pub modele: Option<String>,
    /// Plafond de sortie en jetons (défaut [`PLAFOND_DEFAUT`]).
    #[serde(default)]
    pub plafond: Option<u32>,
}

/// La réponse d'un appel unique.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reponse {
    /// Texte de la réponse (sans la réflexion).
    pub texte: String,
    /// `fournisseur/modèle` réellement appelé.
    pub modele: String,
    /// Jetons consommés (`input_tokens`, `output_tokens`…).
    pub usage: Usage,
    /// Vrai quand la réponse a été coupée par le plafond de sortie.
    pub tronque: bool,
}

/// Modèle de l'appel : `explicite` (`fournisseur/modèle`), sinon le modèle des
/// sous-agents des Réglages (`repl-settings.json` de `data_dir`), sinon celui de
/// la conversation. L'effort est retiré (pas de réflexion étendue).
pub fn choisir_modele(
    explicite: Option<&str>,
    data_dir: &Path,
    conversation: Option<&ModelRef>,
) -> Result<ModelRef, String> {
    let choisi = match explicite.map(str::trim).filter(|v| !v.is_empty()) {
        Some(brut) => Some(crate::rlm::parse_model(brut).ok_or_else(|| {
            format!("modèle « {brut} » invalide : écrivez `fournisseur/modèle`")
        })?),
        None => ReplSettings::load(data_dir)
            .subagent_default_model
            .as_deref()
            .and_then(|m| crate::rlm::parse_model(m.trim()))
            .or_else(|| conversation.cloned()),
    };
    let mut modele = choisi.ok_or_else(|| {
        "aucun modèle : passez `fournisseur/modèle` ou réglez le modèle des sous-agents dans Réglages > Outils".to_string()
    })?;
    modele.effort = None;
    Ok(modele)
}

/// Choisit le modèle, résout son fournisseur comme pour les sessions, puis fait
/// l'appel ([`appeler`]).
pub async fn appel_unique(
    fournisseurs: &dyn ProviderResolver,
    data_dir: &Path,
    conversation: Option<&ModelRef>,
    demande: Demande,
) -> Result<Reponse, String> {
    if demande.texte.trim().is_empty() {
        return Err("appel unique : le texte est vide".into());
    }
    let modele = choisir_modele(demande.modele.as_deref(), data_dir, conversation)?;
    let fournisseur = resoudre(fournisseurs, &modele)?;
    appeler(
        fournisseur.as_ref(),
        modele,
        demande.systeme.as_deref(),
        &demande.texte,
        demande.plafond,
    )
    .await
}

/// Le fournisseur du modèle, résolu comme pour les sessions.
fn resoudre(
    fournisseurs: &dyn ProviderResolver,
    modele: &ModelRef,
) -> Result<std::sync::Arc<dyn axecode_core::Provider>, String> {
    fournisseurs.provider(&modele.provider).map_err(|err| {
        format!(
            "appel unique : fournisseur « {} » indisponible ({err}) ; connectez-le dans Réglages > Fournisseurs",
            modele.provider
        )
    })
}

fn passagere(err: &AppError) -> bool {
    matches!(
        err,
        AppError::Network(_)
            | AppError::Stream(_)
            | AppError::Decode(_)
            | AppError::RetryableStream { .. }
            | AppError::RateLimit(_)
    )
}

/// Un échange avec `fournisseur` : un message utilisateur, aucun outil.
/// Les erreurs passagères sont réessayées deux fois.
pub async fn appeler(
    fournisseur: &dyn axecode_core::Provider,
    modele: ModelRef,
    systeme: Option<&str>,
    texte: &str,
    plafond: Option<u32>,
) -> Result<Reponse, String> {
    let mut modele = modele;
    modele.effort = None;
    let nom = format!("{}/{}", modele.provider, modele.name);
    let plafond = plafond.unwrap_or(PLAFOND_DEFAUT).clamp(1, PLAFOND_MAX);
    let mut requete = ProviderRequest::new(modele, vec![ChatMessage::user_text(texte)]);
    if let Some(systeme) = systeme.filter(|s| !s.trim().is_empty()) {
        requete = requete.with_system(systeme);
    }
    requete.max_output_tokens = Some(plafond);
    let mut pauses = PAUSES.iter();
    loop {
        let erreur = match tokio::time::timeout(DELAI, echange(fournisseur, requete.clone())).await {
            Err(_) => {
                return Err(format!(
                    "appel unique à {nom} : pas de réponse après {} s",
                    DELAI.as_secs()
                ))
            }
            Ok(Ok((texte, usage, arret))) => {
                return Ok(Reponse {
                    texte,
                    modele: nom,
                    usage,
                    tronque: arret == StopReason::MaxTokens,
                })
            }
            Ok(Err(err)) => err,
        };
        match pauses.next() {
            Some(pause) if passagere(&erreur) => {
                let pause = match &erreur {
                    AppError::RetryableStream { delay_ms: Some(ms), .. } => {
                        Duration::from_millis(*ms).min(Duration::from_secs(30))
                    }
                    _ => *pause,
                };
                tokio::time::sleep(pause).await;
            }
            _ => return Err(format!("appel unique à {nom} : {erreur}")),
        }
    }
}

async fn echange(
    fournisseur: &dyn axecode_core::Provider,
    requete: ProviderRequest,
) -> Result<(String, Usage, StopReason), AppError> {
    let mut flux = fournisseur.stream(requete).await?;
    let mut texte = String::new();
    let mut usage = Usage::default();
    let mut arret = None;
    while let Some(evenement) = flux.next().await {
        match evenement? {
            StreamEvent::TextDelta { delta, .. } => texte.push_str(&delta),
            StreamEvent::Usage { usage: u } => usage = u,
            StreamEvent::MessageStop { stop_reason, usage: u } => {
                if u.input_tokens > 0 || u.output_tokens > 0 {
                    usage = u;
                }
                arret = Some(stop_reason);
                break;
            }
            _ => {}
        }
    }
    match arret {
        Some(arret) => Ok((texte, usage, arret)),
        None if !texte.is_empty() => Ok((texte, usage, StopReason::Other)),
        None => Err(AppError::Stream("flux terminé sans réponse".into())),
    }
}

// ----- noyau : rlm.query et rlm.query_lot -----------------------------------

/// Parallélisme par défaut de `rlm.query_lot`.
pub const PARALLELE_DEFAUT: usize = 4;
/// Parallélisme le plus haut accepté.
pub const PARALLELE_MAX: usize = 16;
/// Nombre de textes le plus haut d'un lot.
pub const LOT_MAX: usize = 2_000;

/// Réglages communs à tous les éléments d'un lot.
#[derive(Debug, Clone, Default)]
pub struct Commun {
    pub systeme: Option<String>,
    pub modele: Option<String>,
    pub plafond: Option<u32>,
}

/// Méthodes du noyau servies par [`host_call`].
pub fn handles(method: &str) -> bool {
    matches!(method, "rlm.query" | "rlm.query_lot")
}

fn chaine(params: &Value, cle: &str) -> Option<String> {
    params.get(cle).and_then(Value::as_str).map(str::to_string)
}

/// Appels du noyau `rlm.query` (`{texte, systeme?, modele?, plafond?}` →
/// [`Reponse`]) et `rlm.query_lot` (`{textes, systeme?, modele?, plafond?,
/// parallele?}` → une réponse ou `{"erreur"}` par texte, dans l'ordre).
/// `conversation` est le modèle de la session (dernier repli).
pub async fn host_call(
    fournisseurs: &dyn ProviderResolver,
    data_dir: &Path,
    conversation: &ModelRef,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let commun = Commun {
        systeme: chaine(params, "systeme"),
        modele: chaine(params, "modele"),
        plafond: params
            .get("plafond")
            .and_then(Value::as_u64)
            .map(|p| p.min(u64::from(u32::MAX)) as u32),
    };
    match method {
        "rlm.query" => {
            let demande = Demande {
                systeme: commun.systeme,
                texte: chaine(params, "texte").unwrap_or_default(),
                modele: commun.modele,
                plafond: commun.plafond,
            };
            let reponse = appel_unique(fournisseurs, data_dir, Some(conversation), demande).await?;
            serde_json::to_value(reponse).map_err(|e| e.to_string())
        }
        "rlm.query_lot" => {
            let liste = "rlm.query_lot : `textes` doit être une liste de chaînes";
            let textes = params
                .get("textes")
                .and_then(Value::as_array)
                .ok_or(liste)?
                .iter()
                .map(|v| v.as_str().map(str::to_string).ok_or(liste))
                .collect::<Result<Vec<_>, _>>()?;
            let parallele = params
                .get("parallele")
                .and_then(Value::as_u64)
                .map_or(PARALLELE_DEFAUT, |p| p as usize);
            let resultats =
                lot(fournisseurs, data_dir, Some(conversation), &commun, textes, parallele).await?;
            Ok(Value::Array(
                resultats
                    .into_iter()
                    .map(|r| match r {
                        Ok(reponse) => serde_json::to_value(reponse).unwrap_or(Value::Null),
                        Err(erreur) => json!({ "erreur": erreur }),
                    })
                    .collect(),
            ))
        }
        other => Err(format!("méthode inconnue `{other}`")),
    }
}

/// Plusieurs appels uniques avec la même consigne et le même modèle, au plus
/// `parallele` à la fois (borné à [`PARALLELE_MAX`]). Les réponses gardent
/// l'ordre des textes ; l'erreur d'un élément est rendue à sa place sans
/// arrêter les autres. Seul un modèle ou un fournisseur introuvable fait
/// échouer tout le lot.
pub async fn lot(
    fournisseurs: &dyn ProviderResolver,
    data_dir: &Path,
    conversation: Option<&ModelRef>,
    commun: &Commun,
    textes: Vec<String>,
    parallele: usize,
) -> Result<Vec<Result<Reponse, String>>, String> {
    if textes.len() > LOT_MAX {
        return Err(format!(
            "rlm.query_lot : {} textes, {LOT_MAX} au plus par lot",
            textes.len()
        ));
    }
    if textes.is_empty() {
        return Ok(Vec::new());
    }
    let modele = choisir_modele(commun.modele.as_deref(), data_dir, conversation)?;
    let fournisseur = resoudre(fournisseurs, &modele)?;
    let fournisseur = fournisseur.as_ref();
    let systeme = commun.systeme.as_deref();
    let plafond = commun.plafond;
    let appels: Vec<_> = textes
        .into_iter()
        .map(|texte| {
            let modele = modele.clone();
            async move {
                if texte.trim().is_empty() {
                    return Err("texte vide".to_string());
                }
                appeler(fournisseur, modele, systeme, &texte, plafond).await
            }
        })
        .collect();
    let resultats = futures_util::stream::iter(appels)
        .buffered(parallele.clamp(1, PARALLELE_MAX))
    .collect::<Vec<_>>()
    .await;
    Ok(resultats)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axecode_core::Provider;
    use axecode_openai::{Credential, OpenAiConfig, OpenAiProvider};
    use serde_json::{json, Value};

    use super::*;
    use crate::faux_http::{lancer, Reponse as Rep};

    struct Registre(Option<Arc<dyn Provider>>);

    impl ProviderResolver for Registre {
        fn provider(&self, id: &str) -> Result<Arc<dyn Provider>, String> {
            match (&self.0, id) {
                (Some(p), "openai") => Ok(p.clone()),
                _ => Err(format!("provider `{id}` is not configured or missing credentials")),
            }
        }
    }

    /// Fournisseur OpenAI par clé API, dirigé vers le faux serveur (SSE, pas de websocket).
    fn openai(base: &str) -> Registre {
        let config = OpenAiConfig {
            credential: Credential::ApiKey("cle-test".into()),
            api_base_url: base.to_string(),
            codex_base_url: base.to_string(),
            websocket_enabled: false,
        };
        Registre(Some(Arc::new(OpenAiProvider::new(config).unwrap())))
    }

    fn sse(deltas: &[&str], fin: Value) -> Rep {
        let mut events = vec![json!({"type": "response.created", "response": {"id": "r1", "model": "gpt-test"}})];
        for d in deltas {
            events.push(json!({"type": "response.output_text.delta", "output_index": 0, "delta": d}));
        }
        events.push(fin);
        Rep::sse(&events)
    }

    fn fini(entree: u32, sortie: u32) -> Value {
        json!({"type": "response.completed", "response": {"id": "r1", "status": "completed",
            "usage": {"input_tokens": entree, "output_tokens": sortie, "total_tokens": entree + sortie}}})
    }

    fn conversation() -> ModelRef {
        ModelRef::new("openai", "gpt-test").with_effort(axecode_core::Effort::High)
    }

    #[tokio::test]
    async fn un_seul_echange_sans_outils_avec_texte_et_usage() {
        let serveur = lancer(|_, _| sse(&["Bonjour ", "le monde"], fini(12, 4))).await;
        let dir = tempfile::tempdir().unwrap();
        let demande = Demande {
            systeme: Some("Réponds en français.".into()),
            texte: "Dis bonjour".into(),
            ..Default::default()
        };
        let rep = appel_unique(&openai(&serveur.base), dir.path(), Some(&conversation()), demande)
            .await
            .unwrap();
        assert_eq!(rep.texte, "Bonjour le monde");
        assert_eq!(rep.modele, "openai/gpt-test");
        assert_eq!((rep.usage.input_tokens, rep.usage.output_tokens), (12, 4));
        assert!(!rep.tronque);
        let reqs = serveur.requetes();
        assert_eq!(reqs.len(), 1, "un seul appel : {reqs:?}");
        assert_eq!(reqs[0].path, "/responses");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer cle-test"));
        let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
        assert!(body.get("tools").is_none(), "aucun outil : {body}");
        assert_eq!(body["instructions"], "Réponds en français.");
        assert_eq!(body["max_output_tokens"], PLAFOND_DEFAUT);
        assert_eq!(body["model"], "gpt-test");
        assert!(body["input"].to_string().contains("Dis bonjour"), "{body}");
        // L'effort « high » de la conversation n'est pas repris (appel léger).
        assert_eq!(body["reasoning"]["effort"], "medium", "{body}");
        // La réponse se sérialise pour l'interface et le noyau.
        let v = serde_json::to_value(&rep).unwrap();
        assert_eq!(v["texte"], "Bonjour le monde");
        assert_eq!(v["usage"]["output_tokens"], 4);
    }

    #[tokio::test]
    async fn plafond_et_reponse_coupee() {
        let coupe = json!({"type": "response.incomplete", "response": {"id": "r1", "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"}, "usage": {"input_tokens": 5, "output_tokens": 50}}});
        let serveur = lancer(move |_, _| sse(&["Début d'une longue"], coupe.clone())).await;
        let dir = tempfile::tempdir().unwrap();
        let demande = Demande { texte: "Raconte".into(), plafond: Some(50), ..Default::default() };
        let rep = appel_unique(&openai(&serveur.base), dir.path(), Some(&conversation()), demande)
            .await
            .unwrap();
        assert!(rep.tronque);
        assert_eq!(rep.texte, "Début d'une longue");
        let body: Value = serde_json::from_str(&serveur.requetes()[0].body).unwrap();
        assert_eq!(body["max_output_tokens"], 50);
        assert!(body.get("instructions").is_none(), "pas de consigne système : {body}");
    }

    #[tokio::test]
    async fn erreur_claire_sans_nouvel_essai_sur_une_cle_refusee() {
        let serveur = lancer(|_, _| {
            Rep::status(401, r#"{"error":{"message":"Incorrect API key","type":"invalid_request_error"}}"#)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let demande = Demande { texte: "x".into(), ..Default::default() };
        let err = appel_unique(&openai(&serveur.base), dir.path(), Some(&conversation()), demande)
            .await
            .unwrap_err();
        assert!(err.contains("openai/gpt-test") && err.contains("Incorrect API key"), "{err}");
        assert_eq!(serveur.requetes().len(), 1);
    }

    #[tokio::test]
    async fn erreur_passagere_reessayee() {
        let serveur = lancer(|_, n| {
            if n == 0 {
                Rep::status(503, r#"{"error":{"message":"surcharge","type":"server_error"}}"#)
            } else {
                sse(&["ok"], fini(1, 1))
            }
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let demande = Demande { texte: "x".into(), ..Default::default() };
        let rep = appel_unique(&openai(&serveur.base), dir.path(), Some(&conversation()), demande)
            .await
            .unwrap();
        assert_eq!(rep.texte, "ok");
        assert_eq!(serveur.requetes().len(), 2);
    }

    #[tokio::test]
    async fn fournisseur_absent_ou_texte_vide() {
        let dir = tempfile::tempdir().unwrap();
        let demande = Demande { texte: "x".into(), ..Default::default() };
        let err = appel_unique(&Registre(None), dir.path(), Some(&conversation()), demande)
            .await
            .unwrap_err();
        assert!(err.contains("« openai » indisponible") && err.contains("Réglages"), "{err}");
        let vide = Demande { texte: "  ".into(), ..Default::default() };
        let err = appel_unique(&Registre(None), dir.path(), Some(&conversation()), vide)
            .await
            .unwrap_err();
        assert!(err.contains("vide"), "{err}");
    }

    #[test]
    fn choix_du_modele() {
        let dir = tempfile::tempdir().unwrap();
        let conv = conversation();
        // Sans réglage : le modèle de la conversation, sans son effort.
        let m = choisir_modele(None, dir.path(), Some(&conv)).unwrap();
        assert_eq!((m.provider.as_str(), m.name.as_str(), m.effort), ("openai", "gpt-test", None));
        // Le modèle des sous-agents des Réglages passe avant.
        let mut reglages = ReplSettings::default();
        reglages.subagent_default_model = Some("anthropic/claude-sous-agent".into());
        reglages.save(dir.path()).unwrap();
        let m = choisir_modele(None, dir.path(), Some(&conv)).unwrap();
        assert_eq!((m.provider.as_str(), m.name.as_str()), ("anthropic", "claude-sous-agent"));
        // Le modèle demandé passe avant tout.
        let m = choisir_modele(Some(" google/gemini-x "), dir.path(), Some(&conv)).unwrap();
        assert_eq!((m.provider.as_str(), m.name.as_str()), ("google", "gemini-x"));
        assert!(choisir_modele(Some("pas-de-barre"), dir.path(), None).unwrap_err().contains("fournisseur/modèle"));
        let vide = tempfile::tempdir().unwrap();
        assert!(choisir_modele(None, vide.path(), None).unwrap_err().contains("aucun modèle"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 6)]
    async fn lot_garde_l_ordre_borne_le_parallelisme_et_isole_les_erreurs() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let en_cours = Arc::new(AtomicUsize::new(0));
        let maxi = Arc::new(AtomicUsize::new(0));
        let (c, m) = (en_cours.clone(), maxi.clone());
        let serveur = lancer(move |r, _| {
            let n = c.fetch_add(1, SeqCst) + 1;
            m.fetch_max(n, SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(150));
            c.fetch_sub(1, SeqCst);
            if r.body.contains("ÉCHEC") {
                return Rep::status(400, r#"{"error":{"message":"morceau refusé","type":"invalid_request_error"}}"#);
            }
            let vu = (0..7).map(|i| format!("morceau {i}")).find(|t| r.body.contains(t.as_str())).unwrap();
            sse(&[&format!("vu {vu}")], fini(2, 1))
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let textes: Vec<String> =
            (0..7).map(|i| if i == 3 { "ÉCHEC".to_string() } else { format!("morceau {i}") }).collect();
        let commun = Commun { systeme: Some("Résume.".into()), ..Default::default() };
        let r = lot(&openai(&serveur.base), dir.path(), Some(&conversation()), &commun, textes, 2)
            .await
            .unwrap();
        assert_eq!(r.len(), 7);
        for (i, x) in r.iter().enumerate() {
            if i == 3 {
                assert!(x.as_ref().unwrap_err().contains("morceau refusé"), "{x:?}");
            } else {
                assert_eq!(x.as_ref().unwrap().texte, format!("vu morceau {i}"));
            }
        }
        assert_eq!(maxi.load(SeqCst), 2, "2 appels à la fois au plus, et le lot les utilise");
        assert_eq!(serveur.requetes().len(), 7, "l'erreur 400 n'est pas réessayée");
    }

    #[tokio::test]
    async fn appels_du_noyau() {
        let serveur = lancer(|_, _| sse(&["réponse"], fini(3, 2))).await;
        let dir = tempfile::tempdir().unwrap();
        let reg = openai(&serveur.base);
        assert!(handles("rlm.query") && handles("rlm.query_lot") && !handles("rlm.spawn"));
        let v = host_call(&reg, dir.path(), &conversation(), "rlm.query",
            &json!({"texte": "x", "systeme": "s", "plafond": 100})).await.unwrap();
        assert_eq!(v["texte"], "réponse");
        assert_eq!(v["usage"]["input_tokens"], 3);
        let body: Value = serde_json::from_str(&serveur.requetes()[0].body).unwrap();
        assert_eq!((body["max_output_tokens"].as_u64(), body["instructions"].as_str()), (Some(100), Some("s")));
        let v = host_call(&reg, dir.path(), &conversation(), "rlm.query_lot",
            &json!({"textes": ["a", " ", "b"], "parallele": 2})).await.unwrap();
        assert_eq!(v[0]["texte"], "réponse");
        assert!(v[1]["erreur"].as_str().unwrap().contains("vide"), "{v}");
        assert_eq!(v[2]["texte"], "réponse");
        assert_eq!(serveur.requetes().len(), 3, "le texte vide n'est pas envoyé");
        let err = host_call(&reg, dir.path(), &conversation(), "rlm.query_lot", &json!({"textes": "abc"}))
            .await.unwrap_err();
        assert!(err.contains("liste de chaînes"), "{err}");
        let err = host_call(&Registre(None), dir.path(), &conversation(), "rlm.query_lot", &json!({"textes": ["a"]}))
            .await.unwrap_err();
        assert!(err.contains("indisponible"), "tout le lot échoue sans fournisseur : {err}");
        let vide = host_call(&reg, dir.path(), &conversation(), "rlm.query_lot", &json!({"textes": []})).await.unwrap();
        assert_eq!(vide, json!([]));
    }
}

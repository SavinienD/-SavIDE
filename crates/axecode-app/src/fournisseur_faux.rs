//! Fournisseur « faux » (provider `faux`) : réponses écrites d'avance, lues dans la
//! variable d'environnement `AXECODE_FAUX_SCRIPT`. Il sert aux essais de bout en
//! bout du mode sans interface (`axecode -p`, `--mode json`, `--mode acp`) sans
//! appeler de vraie API. Idée reprise du fournisseur scripté d'Unharnessed
//! (`UNHARNESSED_FAUX_SCRIPT`), écrite ici avec nos types.
//!
//! Script : JSON en ligne, ou `@chemin` d'un fichier JSON.
//! ```json
//! {"responses": [
//!    "texte simple",
//!    {"code": "print(6*7)"},
//!    {"content": [{"type": "thinking", "thinking": "…"},
//!                 {"type": "text", "text": "…"},
//!                 {"type": "python", "code": "…"}],
//!     "delayMs": 2000},
//!    {"error": "message d'erreur du fournisseur"}],
//!  "repeatLast": false, "contextWindow": 128000}
//! ```
//! Chaque appel au modèle consomme la réponse suivante (le curseur est global au
//! processus : il survit à la reconstruction du registre des fournisseurs). Script
//! épuisé : la dernière réponse si `repeatLast`, sinon le texte « (script épuisé) ».

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use axecode_core::{
    AppError, EffortMode, ModelCapabilities, ModelRef, PartKind, Provider, ProviderRequest,
    ProviderStream, StopReason, StreamEvent, TokenEstimate, ToolCallIntro, Usage,
};

pub const FAUX_PROVIDER_ID: &str = "faux";
pub const FAUX_ENV: &str = "AXECODE_FAUX_SCRIPT";

#[derive(Debug, Clone, PartialEq)]
pub enum FauxBloc {
    Reflexion(String),
    Texte(String),
    Python(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum FauxEtape {
    Reponse { blocs: Vec<FauxBloc>, delai_ms: u64 },
    Erreur(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FauxScript {
    pub etapes: Vec<FauxEtape>,
    pub repeter_derniere: bool,
    pub fenetre: u32,
}

fn bloc(v: &Value) -> Result<FauxBloc, String> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    match v.get("type").and_then(Value::as_str) {
        Some("thinking") => s("thinking").map(FauxBloc::Reflexion).ok_or("bloc thinking sans `thinking`".into()),
        Some("text") => s("text").map(FauxBloc::Texte).ok_or("bloc text sans `text`".into()),
        Some("python") | Some("toolCall") => s("code")
            .or_else(|| v.get("arguments").and_then(|a| a.get("code")).and_then(Value::as_str).map(str::to_string))
            .map(FauxBloc::Python)
            .ok_or("bloc python sans `code`".into()),
        autre => Err(format!("type de bloc inconnu : {autre:?}")),
    }
}

fn etape(v: &Value) -> Result<FauxEtape, String> {
    if let Some(t) = v.as_str() {
        return Ok(FauxEtape::Reponse { blocs: vec![FauxBloc::Texte(t.into())], delai_ms: 0 });
    }
    let Some(o) = v.as_object() else { return Err("réponse ni texte ni objet".into()) };
    if let Some(e) = o.get("error").and_then(Value::as_str) {
        return Ok(FauxEtape::Erreur(e.into()));
    }
    let mut blocs = Vec::new();
    if let Some(liste) = o.get("content").and_then(Value::as_array) {
        for b in liste {
            blocs.push(bloc(b)?);
        }
    }
    if let Some(t) = o.get("text").and_then(Value::as_str) {
        blocs.push(FauxBloc::Texte(t.into()));
    }
    if let Some(c) = o.get("code").and_then(Value::as_str) {
        blocs.push(FauxBloc::Python(c.into()));
    }
    let delai_ms = o.get("delayMs").and_then(Value::as_u64).unwrap_or(0);
    Ok(FauxEtape::Reponse { blocs, delai_ms })
}

pub fn lire_script(brut: &str) -> Result<FauxScript, String> {
    let texte = match brut.trim().strip_prefix('@') {
        Some(chemin) => std::fs::read_to_string(chemin).map_err(|e| format!("{chemin} : {e}"))?,
        None => brut.to_string(),
    };
    let v: Value = serde_json::from_str(&texte).map_err(|e| format!("script faux illisible : {e}"))?;
    let etapes = match v.get("responses") {
        Some(Value::Array(l)) => l.iter().map(etape).collect::<Result<Vec<_>, _>>()?,
        None => Vec::new(),
        Some(_) => return Err("`responses` doit être une liste".into()),
    };
    Ok(FauxScript {
        etapes,
        repeter_derniere: v.get("repeatLast").and_then(Value::as_bool).unwrap_or(false),
        fenetre: v.get("contextWindow").and_then(Value::as_u64).map(|n| n as u32).unwrap_or(128_000),
    })
}

pub struct FauxProvider {
    script: FauxScript,
    curseur: Mutex<usize>,
}

impl FauxProvider {
    pub fn new(script: FauxScript) -> Self {
        Self { script, curseur: Mutex::new(0) }
    }

    /// Étape suivante (avance le curseur).
    pub fn suivante(&self) -> FauxEtape {
        let mut i = self.curseur.lock().unwrap_or_else(|e| e.into_inner());
        let n = self.script.etapes.len();
        let etape = if *i < n {
            self.script.etapes[*i].clone()
        } else if self.script.repeter_derniere && n > 0 {
            self.script.etapes[n - 1].clone()
        } else {
            FauxEtape::Reponse { blocs: vec![FauxBloc::Texte("(script épuisé)".into())], delai_ms: 0 }
        };
        *i += 1;
        etape
    }
}

/// Le fournisseur du processus, si `AXECODE_FAUX_SCRIPT` est posé (lu une fois).
pub fn depuis_env() -> Option<Arc<FauxProvider>> {
    static UNIQUE: OnceLock<Option<Arc<FauxProvider>>> = OnceLock::new();
    UNIQUE
        .get_or_init(|| {
            let brut = std::env::var(FAUX_ENV).ok().filter(|v| !v.trim().is_empty())?;
            match lire_script(&brut) {
                Ok(script) => Some(Arc::new(FauxProvider::new(script))),
                Err(e) => {
                    tracing::warn!(error = %e, "AXECODE_FAUX_SCRIPT ignoré");
                    None
                }
            }
        })
        .clone()
}

/// Événements du flux d'une réponse (texte découpé en morceaux pour qu'il arrive en direct).
pub fn evenements(blocs: &[FauxBloc]) -> (Vec<StreamEvent>, StopReason) {
    let usage = Usage { input_tokens: 10, output_tokens: 5, total_tokens: 15, ..Default::default() };
    let mut ev = vec![StreamEvent::MessageStart { model: "faux-1".into() }];
    let mut outil = false;
    for (index, b) in blocs.iter().enumerate() {
        match b {
            FauxBloc::Texte(t) | FauxBloc::Reflexion(t) => {
                let reflexion = matches!(b, FauxBloc::Reflexion(_));
                ev.push(StreamEvent::PartStart {
                    index,
                    kind: if reflexion { PartKind::Thinking } else { PartKind::Text },
                    tool: None,
                });
                let mots: Vec<&str> = t.split_inclusive(' ').collect();
                for morceau in mots.chunks(4) {
                    let delta = morceau.concat();
                    ev.push(if reflexion {
                        StreamEvent::ThinkingDelta { index, delta }
                    } else {
                        StreamEvent::TextDelta { index, delta }
                    });
                }
            }
            FauxBloc::Python(code) => {
                outil = true;
                ev.push(StreamEvent::PartStart {
                    index,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro {
                        id: format!("call_{}", uuid::Uuid::new_v4().simple()),
                        name: "python".into(),
                    }),
                });
                ev.push(StreamEvent::ToolJsonDelta { index, chunk: json!({ "code": code }).to_string() });
            }
        }
        ev.push(StreamEvent::PartStop { index });
    }
    let fin = if outil { StopReason::ToolUse } else { StopReason::EndTurn };
    ev.push(StreamEvent::MessageStop { stop_reason: fin, usage });
    (ev, fin)
}

#[async_trait]
impl Provider for FauxProvider {
    fn name(&self) -> &str {
        FAUX_PROVIDER_ID
    }

    fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities> {
        Some(ModelCapabilities {
            model: model.clone(),
            context_window: self.script.fenetre,
            preferred_window: self.script.fenetre,
            max_output_tokens: 16_384,
            supports_thinking: true,
            visible_thinking: true,
            supports_tools: true,
            supports_images: false,
            effort_mode: EffortMode::Tier,
        })
    }

    async fn estimate_tokens(&self, request: ProviderRequest) -> axecode_core::Result<TokenEstimate> {
        let taille = request.system_prompt.as_deref().map_or(0, str::len)
            + serde_json::to_string(&request.transcript).map_or(0, |s| s.len());
        Ok(TokenEstimate { input_tokens: (taille / 4) as u32, exact: false })
    }

    async fn stream(&self, _request: ProviderRequest) -> axecode_core::Result<ProviderStream> {
        match self.suivante() {
            FauxEtape::Erreur(message) => Err(AppError::Provider(message)),
            FauxEtape::Reponse { blocs, delai_ms } => {
                let (ev, _) = evenements(&blocs);
                let attente = Duration::from_millis(delai_ms);
                // Le délai retient le flux avant le premier morceau (annulation pendant l'attente).
                let flux = futures_util::stream::once(async move {
                    if !attente.is_zero() {
                        tokio::time::sleep(attente).await;
                    }
                })
                .flat_map(move |_| futures_util::stream::iter(ev.clone().into_iter().map(Ok)));
                Ok(Box::pin(flux))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_lu_et_consomme_dans_l_ordre() {
        let s = lire_script(r#"{"responses": ["bonjour", {"code": "print(1)"}, {"error": "panne"},
            {"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "ok"}], "delayMs": 5}]}"#)
            .unwrap();
        let p = FauxProvider::new(s);
        assert_eq!(p.suivante(), FauxEtape::Reponse { blocs: vec![FauxBloc::Texte("bonjour".into())], delai_ms: 0 });
        assert_eq!(p.suivante(), FauxEtape::Reponse { blocs: vec![FauxBloc::Python("print(1)".into())], delai_ms: 0 });
        assert_eq!(p.suivante(), FauxEtape::Erreur("panne".into()));
        assert!(matches!(p.suivante(), FauxEtape::Reponse { delai_ms: 5, ref blocs } if blocs.len() == 2));
        assert!(matches!(p.suivante(), FauxEtape::Reponse { ref blocs, .. } if blocs == &vec![FauxBloc::Texte("(script épuisé)".into())]));
    }

    #[test]
    fn repetition_de_la_derniere() {
        let p = FauxProvider::new(lire_script(r#"{"responses": ["a"], "repeatLast": true}"#).unwrap());
        p.suivante();
        assert_eq!(p.suivante(), FauxEtape::Reponse { blocs: vec![FauxBloc::Texte("a".into())], delai_ms: 0 });
    }

    #[test]
    fn appel_python_termine_par_tool_use() {
        let (ev, fin) = evenements(&[FauxBloc::Texte("je calcule".into()), FauxBloc::Python("6*7".into())]);
        assert_eq!(fin, StopReason::ToolUse);
        assert!(ev.iter().any(|e| matches!(e, StreamEvent::ToolJsonDelta { chunk, .. } if chunk.contains("6*7"))));
        let texte: String = ev.iter().filter_map(|e| match e { StreamEvent::TextDelta { delta, .. } => Some(delta.clone()), _ => None }).collect();
        assert_eq!(texte, "je calcule");
    }

    #[test]
    fn erreurs_de_script() {
        assert!(lire_script("pas du json").is_err());
        assert!(lire_script(r#"{"responses": {}}"#).is_err());
        assert!(lire_script(r#"{"responses": [{"content": [{"type": "x"}]}]}"#).is_err());
    }
}

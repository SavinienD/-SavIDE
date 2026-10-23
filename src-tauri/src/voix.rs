// axe:voix — dictée vocale « comme le message vocal de ChatGPT ».
//
// L'interface (src/axe/voix) enregistre la voix (MediaRecorder, webm/opus) puis
// appelle `voix_transcrire`, qui essaie dans l'ordre :
//   1. le service de l'espace cloud : RPC `voice.transcribe` -> whisper.cpp de la
//      VM (large-v3-turbo, amorce de vocabulaire), tâche de fond lue par
//      `voice.result` (une longue dictée dépasse la limite de 60 s d'un appel) ;
//      puis le service local (utile seulement si un whisper-server tourne sur le poste) ;
//   2. l'API OpenAI (gpt-4o-transcribe, puis whisper-1) si une clé est configurée :
//      instance « compatible OpenAI » sur api.openai.com dans les fournisseurs, ou
//      variable OPENAI_API_KEY ;
//   3. sinon une erreur explicite : l'interface propose la dictée Windows (Win+H).
// Le nettoyage IA (option, désactivé par défaut) passe par `voice.clean` sur la
// connexion du chat, avec le modèle du chat. Rien n'est jamais envoyé au chat.

use crate::*;

use axecode_daemon::voice_rpc::{
    canonical_terms, multipart_body, new_boundary, sanitize_mime, tidy_transcript, BASE_PROMPT,
};

const ANNULE: &str = "dictée annulée";
const DELAI_SERVICE: Duration = Duration::from_secs(25 * 60);
const MODELES_OPENAI: [&str; 2] = ["gpt-4o-transcribe", "whisper-1"];

fn annulations() -> &'static StdMutex<HashSet<String>> {
    static ANNULEES: std::sync::OnceLock<StdMutex<HashSet<String>>> = std::sync::OnceLock::new();
    ANNULEES.get_or_init(|| StdMutex::new(HashSet::new()))
}

fn est_annulee(demande: Option<&str>) -> bool {
    demande.is_some_and(|id| {
        annulations()
            .lock()
            .map(|set| set.contains(id))
            .unwrap_or(false)
    })
}

fn oublier(demande: Option<&str>) {
    if let (Some(id), Ok(mut set)) = (demande, annulations().lock()) {
        set.remove(id);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoixTranscrireInput {
    /// Audio encodé en base64 (sans préfixe `data:`).
    audio: String,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    /// Espace courant : `axe-cloud://<connexion>/...` désigne la connexion à essayer d'abord.
    #[serde(default)]
    workspace_path: Option<String>,
    /// Termes ajoutés à l'amorce (réglage « Vocabulaire »).
    #[serde(default)]
    vocabulaire: Option<String>,
    #[serde(default)]
    nettoyer: bool,
    /// Modèle du chat, pour le nettoyage.
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// Dictée rapide : fenêtre Whisper réduite (moins précise), désactivée par défaut.
    #[serde(default)]
    rapide: bool,
    /// Repli OpenAI autorisé (défaut : oui, seulement si une clé existe).
    #[serde(default)]
    repli_openai: Option<bool>,
    /// Identifiant choisi par l'interface pour `voix_annuler`.
    #[serde(default)]
    demande: Option<String>,
}

/// Connexions de service à essayer, dans l'ordre : celle de l'espace cloud
/// ouvert, la connexion active, Axe Cloud, les autres ; le service local en dernier.
fn connexions(workspace_path: Option<&str>) -> Vec<Option<String>> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(id) = workspace_path.and_then(|p| crate::daemon_client::cloud_connection_id(Path::new(p))) {
        ids.push(id);
    }
    let file = crate::connections::load_file();
    if !file.active.is_empty() && file.active != crate::connections::LOCAL_ID {
        ids.push(file.active.clone());
    }
    ids.push(crate::cloud::CLOUD_CONNECTION_ID.to_string());
    for connection in &file.connections {
        ids.push(connection.id.clone());
    }
    let known: HashSet<String> = file.connections.iter().map(|c| c.id.clone()).collect();
    let mut seen = HashSet::new();
    let mut out: Vec<Option<String>> = ids
        .into_iter()
        .filter(|id| known.contains(id) && seen.insert(id.clone()))
        .take(3)
        .map(Some)
        .collect();
    out.push(None);
    out
}

fn nom_connexion(connexion: &Option<String>) -> String {
    connexion.clone().unwrap_or_else(|| "service local".into())
}

/// Transcription par un service (tâche de fond + lecture du résultat).
async fn par_service(
    app: &AppHandle,
    connexion: Option<&str>,
    params: Value,
    demande: Option<&str>,
) -> std::result::Result<Value, String> {
    let lance = crate::connections::call_on(app, connexion, "voice.transcribe", params).await?;
    let job = lance
        .get("jobId")
        .and_then(Value::as_str)
        .ok_or("réponse de voice.transcribe sans jobId")?
        .to_string();
    let fin = std::time::Instant::now() + DELAI_SERVICE;
    let mut pause = Duration::from_millis(250);
    loop {
        if est_annulee(demande) || std::time::Instant::now() > fin {
            let _ = crate::connections::call_on(app, connexion, "voice.cancel", json!({"jobId": job})).await;
            return Err(if est_annulee(demande) { ANNULE.into() } else { "délai dépassé".into() });
        }
        tokio::time::sleep(pause).await;
        pause = (pause * 5 / 4).min(Duration::from_millis(800));
        let etat = crate::connections::call_on(app, connexion, "voice.result", json!({"jobId": job})).await?;
        match etat.get("status").and_then(Value::as_str) {
            Some("pending") => continue,
            Some("done") => return Ok(etat),
            Some("error") => {
                return Err(etat
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("échec de la transcription")
                    .to_string())
            }
            _ => return Err(format!("réponse inattendue de voice.result : {etat}")),
        }
    }
}

/// Clé OpenAI des fournisseurs (instance sur api.openai.com) ou de l'environnement.
fn cle_openai() -> Option<(String, String)> {
    crate::custom_providers::openai_api_credentials().or_else(|| {
        std::env::var("OPENAI_API_KEY")
            .ok()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .map(|key| ("https://api.openai.com/v1".to_string(), key))
    })
}

async fn par_openai(
    base: &str,
    cle: &str,
    audio: &[u8],
    mime: &str,
    amorce: &str,
    vocabulaire: Option<&str>,
) -> std::result::Result<Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let debut = std::time::Instant::now();
    let mut echecs = Vec::new();
    for modele in MODELES_OPENAI {
        let boundary = new_boundary();
        let champs = [
            ("model", modele.to_string()),
            ("language", "fr".to_string()),
            ("prompt", amorce.to_string()),
            ("response_format", "json".to_string()),
        ];
        let reponse = client
            .post(format!("{}/audio/transcriptions", base.trim_end_matches('/')))
            .bearer_auth(cle)
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .body(multipart_body(&boundary, audio, mime, &champs))
            .send()
            .await
            .map_err(|e| format!("OpenAI injoignable : {e}"))?;
        let statut = reponse.status();
        let corps = reponse.text().await.unwrap_or_default();
        if statut.is_success() {
            let valeur: Value = serde_json::from_str(&corps).map_err(|_| "réponse OpenAI illisible".to_string())?;
            let texte = canonical_terms(
                &tidy_transcript(valeur.get("text").and_then(Value::as_str).unwrap_or("")),
                vocabulaire,
            );
            return Ok(json!({
                "text": texte,
                "engine": "openai",
                "model": format!("OpenAI {modele}"),
                "ms": debut.elapsed().as_millis() as u64,
            }));
        }
        if statut.as_u16() == 401 || statut.as_u16() == 429 {
            return Err(format!("OpenAI a refusé la demande (HTTP {statut})"));
        }
        echecs.push(format!("{modele} : HTTP {statut}"));
    }
    Err(format!("OpenAI : {}", echecs.join(", ")))
}

async fn nettoyer(
    app: &AppHandle,
    workspace_path: Option<&str>,
    texte: &str,
    provider: &str,
    model: &str,
    vocabulaire: Option<&str>,
) -> std::result::Result<String, String> {
    let connexion = workspace_path.and_then(|p| crate::daemon_client::cloud_connection_id(Path::new(p)));
    let reponse = crate::connections::call_on(
        app,
        connexion.as_deref(),
        "voice.clean",
        json!({"text": texte, "provider": provider, "model": model, "vocabulary": vocabulaire}),
    )
    .await?;
    reponse
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "réponse de voice.clean sans texte".to_string())
}

/// Message court d'un échec de service (méthode absente = service pas encore redéployé).
fn echec_service(connexion: &Option<String>, err: &str) -> String {
    let raison = if err.contains("unknown method") {
        "service sans dictée (à redéployer)".to_string()
    } else {
        err.chars().take(240).collect()
    };
    format!("{} : {raison}", nom_connexion(connexion))
}

#[tauri::command]
pub(crate) async fn voix_transcrire(
    app: AppHandle,
    input: VoixTranscrireInput,
) -> std::result::Result<Value, String> {
    let demande = input.demande.clone();
    let resultat = transcrire(&app, input).await;
    oublier(demande.as_deref());
    resultat
}

async fn transcrire(app: &AppHandle, input: VoixTranscrireInput) -> std::result::Result<Value, String> {
    let demande = input.demande.as_deref();
    let audio_b64 = input.audio.trim();
    if audio_b64.is_empty() {
        return Err("enregistrement vide".into());
    }
    let mime = sanitize_mime(input.mime.as_deref().unwrap_or("audio/webm"));
    let vocabulaire = input
        .vocabulaire
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let debut = std::time::Instant::now();
    let mut echecs: Vec<String> = Vec::new();
    let mut obtenu: Option<Value> = None;

    let params = json!({
        "audio": audio_b64,
        "mime": mime,
        "durationMs": input.duration_ms,
        "language": "fr",
        "prompt": vocabulaire,
        "fast": input.rapide,
    });
    for connexion in connexions(input.workspace_path.as_deref()) {
        if est_annulee(demande) {
            return Err(ANNULE.into());
        }
        match par_service(app, connexion.as_deref(), params.clone(), demande).await {
            Ok(valeur) => {
                obtenu = Some(valeur);
                break;
            }
            Err(err) if err == ANNULE => return Err(err),
            Err(err) => echecs.push(echec_service(&connexion, &err)),
        }
    }

    if obtenu.is_none() && input.repli_openai.unwrap_or(true) {
        match cle_openai() {
            Some((base, cle)) => {
                let audio = base64::engine::general_purpose::STANDARD
                    .decode(audio_b64.as_bytes())
                    .map_err(|e| format!("audio illisible : {e}"))?;
                let mut amorce = BASE_PROMPT.to_string();
                if let Some(v) = vocabulaire {
                    amorce.push_str(" Autres termes : ");
                    amorce.push_str(v);
                }
                match par_openai(&base, &cle, &audio, &mime, &amorce, vocabulaire).await {
                    Ok(valeur) => obtenu = Some(valeur),
                    Err(err) => echecs.push(err),
                }
            }
            None => echecs.push("OpenAI : aucune clé API configurée".into()),
        }
    }

    let Some(valeur) = obtenu else {
        return Err(format!("Transcription impossible. {}", echecs.join(" · ")));
    };
    if est_annulee(demande) {
        return Err(ANNULE.into());
    }
    let brut = valeur.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let mut texte = brut.clone();
    let mut avertissements: Vec<String> = Vec::new();
    let mut nettoye = false;
    if input.nettoyer && !brut.is_empty() {
        match (input.provider.as_deref(), input.model.as_deref()) {
            (Some(provider), Some(model)) if !provider.is_empty() && !model.is_empty() => {
                match nettoyer(app, input.workspace_path.as_deref(), &brut, provider, model, vocabulaire).await {
                    Ok(propre) => {
                        texte = propre;
                        nettoye = true;
                    }
                    Err(err) => avertissements.push(format!(
                        "Nettoyage IA indisponible ({}) : texte brut inséré.",
                        err.chars().take(160).collect::<String>()
                    )),
                }
            }
            _ => avertissements.push("Nettoyage IA : aucun modèle de chat choisi.".into()),
        }
    }
    Ok(json!({
        "text": texte,
        "brut": brut,
        "nettoye": nettoye,
        "moteur": valeur.get("model").cloned().unwrap_or(Value::Null),
        "engine": valeur.get("engine").cloned().unwrap_or(Value::Null),
        "transcriptionMs": valeur.get("ms").cloned().unwrap_or(Value::Null),
        "ms": debut.elapsed().as_millis() as u64,
        "echecs": echecs,
        "avertissements": avertissements,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoixAnnulerInput {
    demande: String,
}

/// Annule une transcription en cours (bouton ✕ pendant « Transcription… »).
#[tauri::command]
pub(crate) async fn voix_annuler(input: VoixAnnulerInput) -> std::result::Result<(), String> {
    if let Ok(mut set) = annulations().lock() {
        set.insert(input.demande);
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoixEtatInput {
    #[serde(default)]
    workspace_path: Option<String>,
}

/// État des moteurs pour Réglages > Dictée : `voice.status` de chaque service,
/// présence d'une clé OpenAI (jamais la clé elle-même).
#[tauri::command]
pub(crate) async fn voix_etat(
    app: AppHandle,
    input: Option<VoixEtatInput>,
) -> std::result::Result<Value, String> {
    let workspace_path = input.and_then(|i| i.workspace_path);
    let mut services = Vec::new();
    for connexion in connexions(workspace_path.as_deref()) {
        let etat = crate::connections::call_on(&app, connexion.as_deref(), "voice.status", json!({})).await;
        services.push(match etat {
            Ok(valeur) => json!({"connexion": nom_connexion(&connexion), "ok": true, "moteurs": valeur.get("engines").cloned().unwrap_or(Value::Null)}),
            Err(err) => json!({"connexion": nom_connexion(&connexion), "ok": false, "erreur": echec_service(&connexion, &err)}),
        });
    }
    Ok(json!({"services": services, "openai": cle_openai().is_some()}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn echec_service_signale_un_service_a_redeployer() {
        let msg = super::echec_service(&Some("axe-cloud".into()), "protocol error: unknown method voice.transcribe");
        assert_eq!(msg, "axe-cloud\u{a0}: service sans dictée (à redéployer)");
        assert_eq!(super::echec_service(&None, "refus"), "service local\u{a0}: refus");
    }
}

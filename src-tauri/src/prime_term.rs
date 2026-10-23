// axe:v2-e12 — onglet « Prime Agent » epingle : l'application s'attache a la session que
// Prime occupe DEJA en production, a travers le WebSocket terminal du portail
// (`wss://<hote>/prime/ws/terminal?mode=prime`). Aucune seconde instance de Prime n'est
// lancee : on ne fait que relayer des octets de terminal, comme le navigateur le fait.
//
// Pourquoi cote Rust et pas dans la page : un WebSocket de navigateur ne peut pas porter
// l'en-tete `Authorization: Bearer` (et l'application n'a pas de cookie de portail). C'est
// donc l'application qui ouvre la connexion, puis pousse les octets a l'ecran par evenements.
use crate::*;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub(super) const PRIME_DATA_EVENT: &str = "prime-term-data";
pub(super) const PRIME_EXIT_EVENT: &str = "prime-term-exit";

/// Les sessions ouvertes : un canal par session, ou tombe ce que tape l'ecran.
#[derive(Default)]
pub(crate) struct PrimeTerms {
    canaux: StdMutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrimeOpenInput {
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrimeSessionInput {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrimeWriteInput {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrimeResizeInput {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrimeDataEvent {
    id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrimeExitEvent {
    id: String,
    raison: String,
}

/// Adresse du WebSocket terminal du portail, deduite de l'adresse de la connexion
/// (`wss://cloud.exemple.invalid/ws` -> `wss://cloud.exemple.invalid/prime/ws/terminal?mode=prime`).
pub(super) fn portail_ws(url: &str) -> std::result::Result<String, String> {
    let base = crate::connections::ws_url(url)?;
    let (schema, reste) = base.split_once("://").ok_or("adresse de connexion illisible")?;
    let autorite = reste.split('/').next().unwrap_or(reste);
    if autorite.is_empty() {
        return Err("adresse de connexion illisible".into());
    }
    Ok(format!("{schema}://{autorite}/prime/ws/terminal?mode=prime"))
}

/// Identifiant de session, unique par processus (l'ecran s'en sert pour trier les evenements).
fn nouvel_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COMPTEUR: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duree| duree.as_millis())
        .unwrap_or(0);
    format!("prime-{millis}-{}", COMPTEUR.fetch_add(1, Ordering::Relaxed))
}

/// Traduction lisible d'un echec de connexion (l'utilisateur lit ce texte).
fn raison_de(e: &str) -> String {
    if e.contains("429") {
        "Le portail a déjà trop de terminaux ouverts : fermez-en un et réessayez.".to_string()
    } else if e.contains("403") {
        "Le portail a refusé l'accès (jeton expiré ?). Reconnectez-vous.".to_string()
    } else {
        format!("Prime Agent injoignable ({e}).")
    }
}

#[tauri::command]
pub(crate) async fn prime_term_open(
    app: AppHandle,
    terms: State<'_, PrimeTerms>,
    input: PrimeOpenInput,
) -> std::result::Result<String, String> {
    let connexion = crate::connections::find(&input.connection_id).ok_or("connexion inconnue")?;
    let url = portail_ws(&connexion.url)?;
    let autorisation = crate::connections::authorization_for(&input.connection_id)
        .ok_or("aucun jeton pour cette connexion : reconnectez-vous")?;

    let id = nouvel_id();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    terms
        .canaux
        .lock()
        .expect("prime terms lock")
        .insert(id.clone(), tx);

    let identifiant = id.clone();
    tokio::spawn(async move {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut requete = match url.clone().into_client_request() {
            Ok(requete) => requete,
            Err(e) => {
                fin(&app, &identifiant, format!("adresse refusée ({e})"));
                return;
            }
        };
        match autorisation.parse() {
            Ok(valeur) => {
                requete.headers_mut().insert("authorization", valeur);
            }
            Err(_) => {
                fin(&app, &identifiant, "jeton illisible".to_string());
                return;
            }
        }
        let flux = match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            connect_async(requete),
        )
        .await
        {
            Ok(Ok((flux, _))) => flux,
            Ok(Err(e)) => {
                fin(&app, &identifiant, raison_de(&e.to_string()));
                return;
            }
            Err(_) => {
                fin(&app, &identifiant, "le portail n'a pas répondu en 20 s".to_string());
                return;
            }
        };

        let (mut ecrire, mut lire) = flux.split();
        let mut en_attente: Vec<u8> = Vec::new();
        let cloture = loop {
            tokio::select! {
                recu = lire.next() => match recu {
                    Some(Ok(Message::Binary(octets))) => {
                        en_attente.extend_from_slice(&octets);
                        pousser(&app, &identifiant, &mut en_attente);
                    }
                    Some(Ok(Message::Text(texte))) => {
                        en_attente.extend_from_slice(texte.as_bytes());
                        pousser(&app, &identifiant, &mut en_attente);
                    }
                    Some(Ok(Message::Close(_))) | None => break "session fermée".to_string(),
                    Some(Err(e)) => break e.to_string(),
                    _ => {}
                },
                a_envoyer = rx.recv() => match a_envoyer {
                    Some(message) => {
                        if ecrire.send(message).await.is_err() {
                            break "le portail a coupe la session".to_string();
                        }
                    }
                    // L'ecran a ferme l'onglet : on detache proprement.
                    None => {
                        let _ = ecrire.send(Message::Close(None)).await;
                        break String::new();
                    }
                },
            }
        };
        fin(&app, &identifiant, cloture);
    });

    Ok(id)
}

#[tauri::command]
pub(crate) async fn prime_term_write(
    terms: State<'_, PrimeTerms>,
    input: PrimeWriteInput,
) -> std::result::Result<(), String> {
    let canaux = terms.canaux.lock().expect("prime terms lock");
    let canal = canaux.get(&input.id).ok_or("session inconnue")?;
    // Le portail lit les frappes en binaire et les redimensionnements en texte JSON.
    canal
        .send(Message::Binary(input.data.into_bytes().into()))
        .map_err(|_| "session fermée".to_string())
}

#[tauri::command]
pub(crate) async fn prime_term_resize(
    terms: State<'_, PrimeTerms>,
    input: PrimeResizeInput,
) -> std::result::Result<(), String> {
    let canaux = terms.canaux.lock().expect("prime terms lock");
    let canal = canaux.get(&input.id).ok_or("session inconnue")?;
    let taille = json!({ "rows": input.rows.max(1), "cols": input.cols.max(1) }).to_string();
    canal
        .send(Message::Text(taille.into()))
        .map_err(|_| "session fermée".to_string())
}

#[tauri::command]
pub(crate) async fn prime_term_close(
    terms: State<'_, PrimeTerms>,
    input: PrimeSessionInput,
) -> std::result::Result<(), String> {
    // Retirer le canal ferme la boucle : la connexion est rendue au portail.
    terms.canaux.lock().expect("prime terms lock").remove(&input.id);
    Ok(())
}

fn pousser(app: &AppHandle, id: &str, en_attente: &mut Vec<u8>) {
    loop {
        match std::str::from_utf8(en_attente) {
            Ok(texte) => {
                if !texte.is_empty() {
                    let _ = app.emit(
                        PRIME_DATA_EVENT,
                        PrimeDataEvent { id: id.to_string(), data: texte.to_string() },
                    );
                }
                en_attente.clear();
                return;
            }
            Err(erreur) => {
                let valide = erreur.valid_up_to();
                if valide > 0 {
                    let texte = String::from_utf8_lossy(&en_attente[..valide]).to_string();
                    let _ = app.emit(
                        PRIME_DATA_EVENT,
                        PrimeDataEvent { id: id.to_string(), data: texte },
                    );
                    en_attente.drain(..valide);
                    continue;
                }
                if let Some(longueur) = erreur.error_len() {
                    let texte = String::from_utf8_lossy(&en_attente[..longueur]).to_string();
                    let _ = app.emit(
                        PRIME_DATA_EVENT,
                        PrimeDataEvent { id: id.to_string(), data: texte },
                    );
                    en_attente.drain(..longueur);
                    continue;
                }
                return;
            }
        }
    }
}

fn fin(app: &AppHandle, id: &str, raison: String) {
    let _ = app.emit(PRIME_EXIT_EVENT, PrimeExitEvent { id: id.to_string(), raison });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portail_ws_deduit_l_adresse_du_portail() {
        assert_eq!(
            portail_ws("wss://cloud.exemple.invalid/ws").unwrap(),
            "wss://cloud.exemple.invalid/prime/ws/terminal?mode=prime"
        );
        assert_eq!(
            portail_ws("https://cloud.exemple.invalid").unwrap(),
            "wss://cloud.exemple.invalid/prime/ws/terminal?mode=prime"
        );
    }

    #[test]
    fn portail_ws_refuse_une_adresse_vide() {
        assert!(portail_ws("   ").is_err());
    }

    #[test]
    fn les_raisons_sont_lisibles() {
        assert!(raison_de("HTTP 429").contains("trop de terminaux"));
        assert!(raison_de("HTTP 403").contains("refusé l'accès"));
    }
}

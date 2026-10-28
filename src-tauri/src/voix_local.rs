// axe:micro-local — dictée 100 % locale : whisper.cpp embarqué (whisper-rs),
// modèle multilingue « base » (≈ 148 Mo) ou « small » (≈ 488 Mo) téléchargé au
// premier usage dans le dossier de données de l'appli, empreinte SHA-256
// vérifiée avant usage. Aucun appel réseau pendant la transcription.
//
// L'interface décode l'enregistrement en PCM mono 16 kHz (float 32 bits LE,
// base64, type `audio/pcm-f32-16k`) : pas de décodage audio côté Rust.

use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const MIME_PCM: &str = "audio/pcm-f32-16k";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModeleLocal {
    pub nom: &'static str,
    pub fichier: &'static str,
    pub sha256: &'static str,
    pub octets: u64,
}

/// Empreintes = « X-Linked-ETag » de Hugging Face (vérifiées le 28/10/2026).
pub const MODELES: [ModeleLocal; 2] = [
    ModeleLocal {
        nom: "base",
        fichier: "ggml-base.bin",
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        octets: 147_951_465,
    },
    ModeleLocal {
        nom: "small",
        fichier: "ggml-small.bin",
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        octets: 487_601_967,
    },
];

const URL_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

pub fn modele(nom: Option<&str>) -> ModeleLocal {
    MODELES.iter().copied().find(|m| Some(m.nom) == nom).unwrap_or(MODELES[0])
}

fn dossier(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("dossier de données introuvable\u{a0}: {e}"))?
        .join("whisper");
    std::fs::create_dir_all(&d).map_err(|e| format!("dossier {}\u{a0}: {e}", d.display()))?;
    Ok(d)
}

pub fn chemin(app: &AppHandle, m: ModeleLocal) -> Result<PathBuf, String> {
    Ok(dossier(app)?.join(m.fichier))
}

/// Présent = fichier complet à la bonne taille (l'empreinte est vérifiée au téléchargement).
pub fn present(app: &AppHandle, m: ModeleLocal) -> bool {
    chemin(app, m)
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .is_some_and(|md| md.len() == m.octets)
}

pub fn sha256_hex(octets: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(octets);
    format!("{:x}", h.finalize())
}

fn verrou_telechargement() -> &'static tokio::sync::Mutex<()> {
    static V: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    V.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Télécharge le modèle s'il manque (une seule fois à la fois), empreinte vérifiée.
/// Progression : événement `axe://voix-modele` {modele, recu, total}.
pub async fn assurer(app: &AppHandle, m: ModeleLocal) -> Result<PathBuf, String> {
    let _g = verrou_telechargement().lock().await;
    let dest = chemin(app, m)?;
    if present(app, m) {
        return Ok(dest);
    }
    let part = dest.with_extension("part");
    let client = reqwest::Client::new();
    let mut rep = client
        .get(format!("{URL_BASE}{}", m.fichier))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("téléchargement du modèle {} impossible\u{a0}: {e}", m.nom))?;
    let mut fichier = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut recu: u64 = 0;
    let mut dernier = 0u64;
    use tokio::io::AsyncWriteExt;
    while let Some(bloc) = rep.chunk().await.map_err(|e| format!("téléchargement interrompu\u{a0}: {e}"))? {
        h.update(&bloc);
        fichier.write_all(&bloc).await.map_err(|e| e.to_string())?;
        recu += bloc.len() as u64;
        if recu - dernier > 4 * 1024 * 1024 || recu == m.octets {
            dernier = recu;
            let _ = app.emit("axe://voix-modele", json!({"modele": m.nom, "recu": recu, "total": m.octets}));
        }
    }
    fichier.flush().await.map_err(|e| e.to_string())?;
    drop(fichier);
    let empreinte = format!("{:x}", h.finalize());
    if empreinte != m.sha256 || recu != m.octets {
        let _ = std::fs::remove_file(&part);
        return Err(format!("modèle {} corrompu (empreinte SHA-256 différente)\u{a0}: supprimé", m.nom));
    }
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// PCM float 32 bits little-endian -> échantillons.
pub fn pcm_depuis_base64(b64: &str) -> Result<Vec<f32>, String> {
    let octets = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("audio illisible\u{a0}: {e}"))?;
    if octets.len() % 4 != 0 {
        return Err("audio PCM tronqué".into());
    }
    Ok(octets
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

fn contexte() -> &'static Mutex<Option<(String, WhisperContext)>> {
    static C: OnceLock<Mutex<Option<(String, WhisperContext)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// Transcription (bloquante : à lancer dans spawn_blocking).
pub fn transcrire_pcm(chemin: &std::path::Path, echantillons: &[f32], amorce: &str) -> Result<String, String> {
    if echantillons.len() < 1600 {
        return Ok(String::new()); // moins de 0,1 s
    }
    let cle = chemin.display().to_string();
    let mut garde = contexte().lock().map_err(|_| "moteur local bloqué".to_string())?;
    if garde.as_ref().map(|(c, _)| c != &cle).unwrap_or(true) {
        *garde = None;
        let ctx = WhisperContext::new_with_params(&cle, WhisperContextParameters::default())
            .map_err(|e| format!("modèle illisible\u{a0}: {e}"))?;
        *garde = Some((cle, ctx));
    }
    let (_, ctx) = garde.as_ref().expect("contexte chargé");
    let mut etat = ctx.create_state().map_err(|e| e.to_string())?;
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some("fr"));
    p.set_initial_prompt(amorce);
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    p.set_suppress_blank(true);
    let fils = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    p.set_n_threads(fils as _);
    etat.full(p, echantillons).map_err(|e| format!("transcription locale\u{a0}: {e}"))?;
    let mut texte = String::new();
    for seg in etat.as_iter() {
        if let Ok(s) = seg.to_str_lossy() {
            texte.push_str(&s);
            texte.push('\n');
        }
    }
    Ok(texte)
}

/// État pour Réglages / disponibilité : modèles présents sur le poste.
pub fn etat(app: &AppHandle) -> Value {
    json!({
        "ok": true,
        "modeles": MODELES.iter().map(|m| json!({"nom": m.nom, "octets": m.octets, "present": present(app, *m)})).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modeles_et_pcm() {
        assert_eq!(modele(Some("small")).fichier, "ggml-small.bin");
        assert_eq!(modele(None).nom, "base");
        assert_eq!(modele(Some("inconnu")).nom, "base");
        let b = base64::engine::general_purpose::STANDARD.encode([0f32.to_le_bytes(), 0.5f32.to_le_bytes()].concat());
        assert_eq!(pcm_depuis_base64(&b).unwrap(), vec![0.0, 0.5]);
        assert!(pcm_depuis_base64("AAA=").is_err());
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    /// Essai réel (manuel) : AXE_TEST_WHISPER_MODEL=…/ggml-base.bin AXE_TEST_WAV=…/jfk.wav
    /// cargo test -p axecode --lib voix_local -- --ignored
    #[test]
    #[ignore]
    fn transcription_reelle() {
        let (Ok(m), Ok(w)) = (std::env::var("AXE_TEST_WHISPER_MODEL"), std::env::var("AXE_TEST_WAV")) else { return };
        let o = std::fs::read(w).unwrap();
        let pcm: Vec<f32> = o[44..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        let t = transcrire_pcm(std::path::Path::new(&m), &pcm, "").unwrap();
        eprintln!("TRANSCRIT: {t}");
        assert!(t.trim().len() > 10);
    }
}

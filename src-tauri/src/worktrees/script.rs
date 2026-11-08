//! Scripts des worktrees (préparation, suppression) dans un vrai terminal (PTY) :
//! couleurs, barres de progression et questions éventuelles, comme dans un
//! terminal ouvert à la main. Une commande par ligne, arrêt à la première erreur.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Terminal lancé : l'appelant attend `enfant`, lit `lecteur`, peut arrêter
/// par `arret` et rend `maitre` / `ecriture` joignables (saisie, taille).
pub(crate) struct Lance {
    pub(crate) enfant: Box<dyn Child + Send + Sync>,
    pub(crate) arret: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    pub(crate) ecriture: Arc<Mutex<Box<dyn Write + Send>>>,
    pub(crate) maitre: Box<dyn MasterPty + Send>,
    pub(crate) lecteur: Box<dyn Read + Send>,
}

/// Lance `script` dans `dossier` avec les variables `env`.
pub(crate) fn lancer(dossier: &Path, script: &str, env: &[(String, String)]) -> Result<Lance, String> {
    let paire = native_pty_system()
        .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|err| format!("terminal impossible à ouvrir : {err}"))?;
    let mut cmd = commande(script);
    cmd.cwd(super::depot::chemin_os(dossier).as_os_str());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (cle, valeur) in env {
        cmd.env(cle, valeur);
    }
    let enfant = paire
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("script impossible à lancer : {err}"))?;
    drop(paire.slave);
    let lecteur = paire.master.try_clone_reader().map_err(|err| err.to_string())?;
    let ecriture = paire.master.take_writer().map_err(|err| err.to_string())?;
    let arret = enfant.clone_killer();
    Ok(Lance {
        enfant,
        arret: Arc::new(Mutex::new(arret)),
        ecriture: Arc::new(Mutex::new(ecriture)),
        maitre: paire.master,
        lecteur,
    })
}

#[cfg(target_os = "windows")]
fn commande(script: &str) -> CommandBuilder {
    // PowerShell 7 s'il est là (celui des terminaux), sinon Windows PowerShell.
    let shell = axecode_app::find_powershell_7_executable()
        .map(|p| p.into_os_string())
        .unwrap_or_else(|| "powershell.exe".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    cmd.arg(encoder_powershell(&texte_powershell(script)));
    cmd.env("POWERSHELL_TELEMETRY_OPTOUT", "1");
    cmd
}

#[cfg(not(target_os = "windows"))]
fn commande(script: &str) -> CommandBuilder {
    let (shell, connexion) = shell_posix();
    let mut cmd = CommandBuilder::new(shell);
    if connexion {
        cmd.arg("-l"); // PATH du profil (Homebrew, nvm…)
    }
    cmd.arg("-c");
    cmd.arg(texte_posix(script));
    cmd
}

#[cfg(not(target_os = "windows"))]
fn shell_posix() -> (String, bool) {
    if let Ok(shell) = std::env::var("SHELL") {
        let nom = Path::new(&shell).file_name().and_then(|n| n.to_str()).unwrap_or("");
        if matches!(nom, "bash" | "zsh" | "sh" | "dash" | "ksh") && Path::new(&shell).is_file() {
            return (shell, true);
        }
    }
    ("/bin/sh".to_string(), true)
}

/// Lignes utiles du script (ni vides ni commentaires `#`).
fn lignes(script: &str) -> Vec<&str> {
    script
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

/// Script POSIX : `set -e`, et chaque commande affichée avant d'être lancée.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub(crate) fn texte_posix(script: &str) -> String {
    let mut texte = String::from("set -e\n");
    for ligne in lignes(script) {
        let echappee = ligne.replace('\'', "'\\''");
        texte.push_str(&format!("printf '\\033[2m> %s\\033[0m\\n' '{echappee}'\n{ligne}\n"));
    }
    texte
}

/// Script PowerShell : arrêt au premier code de sortie non nul ou à la première erreur.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn texte_powershell(script: &str) -> String {
    let mut texte = String::from(
        "$ErrorActionPreference = 'Stop'\r\n$ProgressPreference = 'SilentlyContinue'\r\n",
    );
    for ligne in lignes(script) {
        let echappee = ligne.replace('\'', "''");
        texte.push_str(&format!(
            "Write-Host '> {echappee}' -ForegroundColor DarkGray\r\n$global:LASTEXITCODE = 0\r\n{ligne}\r\nif ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}\r\n"
        ));
    }
    texte.push_str("exit 0\r\n");
    texte
}

/// `-EncodedCommand` : UTF-16LE en base64 (aucun souci de guillemets).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn encoder_powershell(texte: &str) -> String {
    let octets: Vec<u8> = texte.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(octets)
}

/// Découpe `attente` + `nouveau` en texte UTF-8 valide (le reste attend la suite).
pub(crate) fn decouper_utf8(attente: &mut Vec<u8>) -> String {
    match std::str::from_utf8(attente) {
        Ok(texte) => {
            let sortie = texte.to_string();
            attente.clear();
            sortie
        }
        Err(err) => {
            let valide = err.valid_up_to();
            if err.error_len().is_some() {
                // Octets invalides : remplacés, rien ne reste en attente.
                let sortie = String::from_utf8_lossy(attente).to_string();
                attente.clear();
                return sortie;
            }
            let sortie = String::from_utf8_lossy(&attente[..valide]).to_string();
            attente.drain(..valide);
            sortie
        }
    }
}

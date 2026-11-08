use crate::*;

#[tauri::command]
pub(super) async fn run_terminal_command(
    app: AppHandle,
    input: TerminalCommandInput,
) -> std::result::Result<TerminalCommandOutput, String> {
    let command = input.command.trim();
    if command.is_empty() {
        return Err("la commande ne peut pas être vide".into());
    }

    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let result = BashTool::new(workspace_root.clone())
        .run(json!({
            "command": command,
            "timeout_secs": 120,
        }))
        .await;

    for change in &result.file_changes {
        emit_workspace_file_change(&app, &workspace_root, &change.relative_path);
    }

    Ok(TerminalCommandOutput {
        content: result.content,
        is_error: result.is_error,
    })
}

#[tauri::command]
pub(super) async fn spawn_terminal(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: TerminalSpawnInput,
) -> std::result::Result<TerminalSpawnOutput, String> {
    let session_id = validate_terminal_value(&input.session_id, "identifiant de session")?.to_string();
    let token = validate_terminal_value(&input.token, "jeton de session")?.to_string();
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;

    let mut command = if input.shell.as_deref() == Some("bash") {
        bash_terminal_command().await.map_err(error_to_string)?
    } else {
        default_terminal_command().await.map_err(error_to_string)?
    };
    let workspace_dir = axecode_app::workspace::os_path(&workspace_root);
    command.cwd(workspace_dir.as_os_str());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("AXECODE_WORKSPACE", workspace_dir.as_os_str());

    let size = terminal_size(input.cols, input.rows, input.pixel_width, input.pixel_height);
    lancer_pty(app, &state, session_id, token, size, command).await
}

/// Ouvre un pseudo-terminal, y lance `command` et relaie sa sortie (événements
/// terminal-data / terminal-exit) ; remplace un terminal de même identifiant.
async fn lancer_pty(
    app: AppHandle,
    state: &DesktopState,
    session_id: String,
    token: String,
    size: PtySize,
    command: CommandBuilder,
) -> std::result::Result<TerminalSpawnOutput, String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(size).map_err(error_to_string)?;
    let child = pair.slave.spawn_command(command).map_err(error_to_string)?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(error_to_string)?;
    let writer = Arc::new(StdMutex::new(
        pair.master.take_writer().map_err(error_to_string)?,
    ));
    let killer = Arc::new(StdMutex::new(child.clone_killer()));

    if let Some(previous) = state.terminal_sessions.lock().await.remove(&session_id) {
        terminate_terminal_process(previous);
    }

    state.terminal_sessions.lock().await.insert(
        session_id.clone(),
        TerminalProcess {
            token: token.clone(),
            master: pair.master,
            writer,
            killer,
        },
    );

    spawn_terminal_reader(app.clone(), session_id.clone(), token.clone(), reader);
    spawn_terminal_waiter(
        app,
        state.terminal_sessions.clone(),
        session_id.clone(),
        token,
        child,
    );

    Ok(TerminalSpawnOutput { session_id })
}

async fn bash_terminal_command() -> Result<CommandBuilder> {
    #[cfg(windows)]
    {
        let wsl = wsl_executable().ok_or_else(|| {
            anyhow::anyhow!("WSL absent. Installe-le depuis PowerShell avec `wsl --install`, redémarre Windows puis relance Bash.")
        })?;
        let mut command = CommandBuilder::new(wsl.as_os_str());
        command.arg("--cd");
        command.arg("~");
        command.arg("--");
        command.arg("bash");
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        Ok(CommandBuilder::new("bash"))
    }
}

async fn default_terminal_command() -> Result<CommandBuilder> {
    #[cfg(windows)]
    {
        let shell = axecode_app::ensure_powershell_7_executable().await?;
        let mut command = CommandBuilder::new(shell.as_os_str());
        command.arg("-NoLogo");
        command.arg("-NoProfile");
        command.arg("-ExecutionPolicy");
        command.arg("Bypass");
        command.env("POWERSHELL_TELEMETRY_OPTOUT", "1");
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        Ok(CommandBuilder::new_default_prog())
    }
}

#[cfg(windows)]
fn wsl_executable() -> Option<std::path::PathBuf> {
    let output = __nw_std("where.exe").arg("wsl.exe").output().ok()?;
    if !output.status.success() { return None; }
    String::from_utf8_lossy(&output.stdout).lines().next().map(std::path::PathBuf::from)
}

#[cfg(not(windows))]
fn wsl_executable() -> Option<std::path::PathBuf> { None }

#[tauri::command]
pub(super) async fn write_terminal(
    state: State<'_, DesktopState>,
    input: TerminalWriteInput,
) -> std::result::Result<(), String> {
    let writer = {
        let sessions = state.terminal_sessions.lock().await;
        let Some(process) = sessions.get(&input.session_id) else {
            return Ok(());
        };
        if process.token != input.token {
            return Ok(());
        }
        process.writer.clone()
    };

    let mut writer = writer
        .lock()
        .map_err(|_| "écriture dans le terminal indisponible".to_string())?;
    writer
        .write_all(input.data.as_bytes())
        .map_err(error_to_string)?;
    writer.flush().map_err(error_to_string)?;
    Ok(())
}

#[tauri::command]
pub(super) async fn resize_terminal(
    state: State<'_, DesktopState>,
    input: TerminalResizeInput,
) -> std::result::Result<(), String> {
    let sessions = state.terminal_sessions.lock().await;
    let Some(process) = sessions.get(&input.session_id) else {
        return Ok(());
    };
    if process.token != input.token {
        return Ok(());
    }
    process
        .master
        .resize(terminal_size(
            input.cols,
            input.rows,
            input.pixel_width,
            input.pixel_height,
        ))
        .map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn kill_terminal(
    state: State<'_, DesktopState>,
    input: TerminalControlInput,
) -> std::result::Result<bool, String> {
    let process = {
        let mut sessions = state.terminal_sessions.lock().await;
        match sessions.get(&input.session_id) {
            Some(process) if process.token == input.token => sessions.remove(&input.session_id),
            _ => None,
        }
    };

    if let Some(process) = process {
        terminate_terminal_process(process);
        Ok(true)
    } else {
        Ok(false)
    }
}

pub(super) fn validate_terminal_value<'a>(
    value: &'a str,
    label: &str,
) -> std::result::Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} : ne peut pas être vide"));
    }
    if trimmed.len() > 256 {
        return Err(format!("{label} : trop long"));
    }
    Ok(trimmed)
}

pub(super) fn terminal_size(cols: u16, rows: u16, pixel_width: u16, pixel_height: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(4, 200),
        cols: cols.clamp(20, 500),
        pixel_width,
        pixel_height,
    }
}

pub(super) fn spawn_terminal_reader(
    app: AppHandle,
    session_id: String,
    token: String,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::<u8>::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    emit_terminal_utf8_chunks(&app, &session_id, &token, &mut pending);
                }
                Err(_) => break,
            }
        }

        if !pending.is_empty() {
            emit_terminal_data(
                &app,
                &session_id,
                &token,
                String::from_utf8_lossy(&pending).to_string(),
            );
        }
    });
}

pub(super) fn emit_terminal_utf8_chunks(
    app: &AppHandle,
    session_id: &str,
    token: &str,
    pending: &mut Vec<u8>,
) {
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                if !valid.is_empty() {
                    emit_terminal_data(app, session_id, token, valid.to_string());
                }
                pending.clear();
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let data = String::from_utf8_lossy(&pending[..valid_up_to]).to_string();
                    emit_terminal_data(app, session_id, token, data);
                    pending.drain(..valid_up_to);
                    continue;
                }

                if let Some(error_len) = err.error_len() {
                    let data = String::from_utf8_lossy(&pending[..error_len]).to_string();
                    emit_terminal_data(app, session_id, token, data);
                    pending.drain(..error_len);
                    continue;
                }

                break;
            }
        }
    }
}

pub(super) fn emit_terminal_data(app: &AppHandle, session_id: &str, token: &str, data: String) {
    if data.is_empty() {
        return;
    }

    let _ = app.emit(
        TERMINAL_DATA_EVENT_NAME,
        TerminalDataEvent {
            session_id: session_id.to_string(),
            token: token.to_string(),
            data,
        },
    );
}

pub(super) fn spawn_terminal_waiter(
    app: AppHandle,
    terminal_sessions: Arc<Mutex<HashMap<String, TerminalProcess>>>,
    session_id: String,
    token: String,
    mut child: Box<dyn Child + Send + Sync>,
) {
    std::thread::spawn(move || {
        let status = child.wait();
        let (exit_code, signal) = match status {
            Ok(status) => (
                Some(status.exit_code()),
                status.signal().map(std::string::ToString::to_string),
            ),
            Err(err) => (None, Some(err.to_string())),
        };

        tauri::async_runtime::spawn(async move {
            let mut sessions = terminal_sessions.lock().await;
            let is_current = sessions
                .get(&session_id)
                .map(|process| process.token == token)
                .unwrap_or(false);
            if !is_current {
                return;
            }

            sessions.remove(&session_id);
            let _ = app.emit(
                TERMINAL_EXIT_EVENT_NAME,
                TerminalExitEvent {
                    session_id,
                    token,
                    exit_code,
                    signal,
                },
            );
        });
    });
}

pub(super) fn terminate_terminal_process(process: TerminalProcess) {
    if let Ok(mut killer) = process.killer.lock() {
        let _ = killer.kill();
    }
}

/// 0.1.75 : aucun lancement de processus n'ouvre de fenetre console sous Windows.
#[allow(dead_code)]
fn __nw_std<S: AsRef<std::ffi::OsStr>>(p: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(p);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}


// ---------------------------------------------------------------------------
// Agents en ligne de commande (Claude Code, Codex, Gemini CLI…) : catalogue,
// détection et réglages (Réglages > Agents en ligne de commande).

use axecode_app::orchestre::{cli, dossier_donnees};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentsCliReglagesInput {
    reglages: cli::Reglages,
}

/// Les agents du catalogue, installés ou non, avec leurs réglages.
#[tauri::command]
pub(super) async fn agents_cli_etat() -> std::result::Result<Vec<cli::EtatAgent>, String> {
    Ok(cli::etat(&cli::Reglages::lire(&dossier_donnees())))
}

/// Enregistre les réglages et renvoie l'état relu.
#[tauri::command]
pub(super) async fn agents_cli_enregistrer(
    input: AgentsCliReglagesInput,
) -> std::result::Result<Vec<cli::EtatAgent>, String> {
    let dossier = dossier_donnees();
    input.reglages.ecrire(&dossier).map_err(error_to_string)?;
    Ok(cli::etat(&cli::Reglages::lire(&dossier)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentTerminalInput {
    dossier: String,
    cli: String,
    #[serde(default)]
    reprendre: bool,
    session_id: String,
    token: String,
    cols: u16,
    rows: u16,
    #[serde(default)]
    pixel_width: u16,
    #[serde(default)]
    pixel_height: u16,
}

/// Terminal d'un agent en ligne de commande : son programme tourne seul dans
/// le pseudo-terminal (pas de shell), dans le dossier demandé ; quand il
/// s'arrête, l'onglet reçoit son code de sortie (terminal-exit).
#[tauri::command]
pub(super) async fn spawn_agent_terminal(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: AgentTerminalInput,
) -> std::result::Result<TerminalSpawnOutput, String> {
    let session_id = validate_terminal_value(&input.session_id, "identifiant de session")?.to_string();
    let token = validate_terminal_value(&input.token, "jeton de session")?.to_string();
    let dossier = normalize_workspace_root(&input.dossier).map_err(error_to_string)?;
    let command = commande_agent(&input.cli, input.reprendre, &dossier).await?;
    let size = terminal_size(input.cols, input.rows, input.pixel_width, input.pixel_height);
    lancer_pty(app, &state, session_id, token, size, command).await
}

/// Programme de l'agent (réglage, PATH, dossiers usuels) avec ses arguments :
/// reprise, arguments de lancement, autonomie complète si elle est réglée.
async fn commande_agent(
    id: &str,
    reprendre: bool,
    dossier: &std::path::Path,
) -> std::result::Result<CommandBuilder, String> {
    let agent = cli::agent(id).ok_or_else(|| format!("agent inconnu : {id}"))?;
    let reglage = cli::Reglages::lire(&dossier_donnees()).de(id);
    let programme = cli::trouver(agent, &reglage).ok_or_else(|| {
        format!(
            "{} est introuvable sur ce poste. Installez-le ({}) ou indiquez son exécutable dans Réglages > Agents CLI.",
            agent.nom, agent.installation
        )
    })?;
    let args = cli::args_interactifs(agent, &reglage, reprendre)?;
    let mut command = programme_dans_pty(&programme, &args).await?;
    let dir = axecode_app::workspace::os_path(dossier);
    command.cwd(dir.as_os_str());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(parent) = programme.parent() {
        // node (nvm, volta…) est souvent à côté du programme, hors du PATH de l'appli.
        let mut chemins = vec![parent.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            chemins.extend(std::env::split_paths(&path));
        }
        if let Ok(path) = std::env::join_paths(chemins) {
            command.env("PATH", path);
        }
    }
    for (cle, valeur) in cli::env_agent(agent, &reglage) {
        command.env(cle, valeur);
    }
    Ok(command)
}

#[cfg(windows)]
async fn programme_dans_pty(
    programme: &std::path::Path,
    args: &[String],
) -> std::result::Result<CommandBuilder, String> {
    let extension = programme
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension == "exe" || extension == "com" {
        let mut command = CommandBuilder::new(programme.as_os_str());
        for arg in args {
            command.arg(arg);
        }
        return Ok(command);
    }
    // .cmd, .bat, .ps1 (installations npm) : PowerShell 7 les lance tous et rend leur code.
    let shell = axecode_app::ensure_powershell_7_executable()
        .await
        .map_err(error_to_string)?;
    let mut command = CommandBuilder::new(shell.as_os_str());
    for arg in ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"] {
        command.arg(arg);
    }
    command.arg(ligne_powershell(programme, args));
    command.env("POWERSHELL_TELEMETRY_OPTOUT", "1");
    Ok(command)
}

#[cfg(not(windows))]
async fn programme_dans_pty(
    programme: &std::path::Path,
    args: &[String],
) -> std::result::Result<CommandBuilder, String> {
    let mut command = CommandBuilder::new(programme.as_os_str());
    for arg in args {
        command.arg(arg);
    }
    Ok(command)
}

/// `& 'C:\…\claude.cmd' '--model' 'opus'; exit $LASTEXITCODE` : chaque argument
/// entre guillemets simples (doublés à l'intérieur), rien n'est interprété.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn ligne_powershell(programme: &std::path::Path, args: &[String]) -> String {
    let cite = |texte: &str| format!("'{}'", texte.replace('\'', "''"));
    let mut ligne = format!("& {}", cite(&programme.to_string_lossy()));
    for arg in args {
        ligne.push(' ');
        ligne.push_str(&cite(arg));
    }
    ligne.push_str("; exit $LASTEXITCODE");
    ligne
}

#[cfg(test)]
mod tests_agents {
    use super::*;

    #[test]
    fn ligne_powershell_cite_tout() {
        let p = std::path::Path::new(r"C:\Users\moi\AppData\Roaming\npm\claude.cmd");
        assert_eq!(
            ligne_powershell(p, &["--model".into(), "l'opus $x".into()]),
            r"& 'C:\Users\moi\AppData\Roaming\npm\claude.cmd' '--model' 'l''opus $x'; exit $LASTEXITCODE"
        );
        assert_eq!(ligne_powershell(std::path::Path::new("codex.cmd"), &[]), "& 'codex.cmd'; exit $LASTEXITCODE");
    }
}

//! axe:cua — cua-driver comme OUTIL intégré (plus besoin de passer par MCP).
//! Lance `cua-driver <args...>` (binaire dans le PATH ou CUA_DRIVER_BIN), sortie texte rendue au modèle.
use std::time::Duration;
use serde_json::{json, Value};
use axecode_core::ToolDescriptor;
use crate::ToolRunResult;

pub const CUA_DRIVER: &str = "cua_driver";

pub fn descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: CUA_DRIVER.into(),
        description: "Pilote le bureau de ce poste (capture, clic, clavier, fenêtres) via cua-driver. À utiliser UNIQUEMENT quand l'utilisateur le demande explicitement (jamais de soi-même). Exemples d'args : [\"snapshot\"], [\"click\",\"--x\",\"100\",\"--y\",\"200\"], [\"type\",\"bonjour\"].".into(),
        input_schema: json!({"type":"object","properties":{
            "args":{"type":"array","items":{"type":"string"},"description":"Arguments de cua-driver"},
            "timeoutSecondes":{"type":"integer","minimum":1,"maximum":300}},
            "required":["args"],"additionalProperties":false}),
    }
}

pub async fn run(input: Value) -> ToolRunResult {
    let args: Vec<String> = input.get("args").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    if args.is_empty() { return ToolRunResult::err("cua_driver: args obligatoire", Vec::new()); }
    let delai = input.get("timeoutSecondes").and_then(Value::as_u64).unwrap_or(60).clamp(1, 300);
    let bin = binaire();
    let fut = __nw_tokio(&bin).args(&args).kill_on_drop(true).output();
    match tokio::time::timeout(Duration::from_secs(delai), fut).await {
        Err(_) => ToolRunResult::err(format!("cua_driver: délai de {delai} s dépassé"), Vec::new()),
        Ok(Err(e)) => ToolRunResult::err(format!("cua_driver: lancement impossible ({bin}) : {e}"), Vec::new()),
        Ok(Ok(o)) => {
            let mut t = String::from_utf8_lossy(&o.stdout).into_owned();
            let err = String::from_utf8_lossy(&o.stderr);
            if !err.trim().is_empty() { t.push_str("\n[stderr] "); t.push_str(err.trim()); }
            if t.len() > 20_000 { t.truncate(20_000); t.push_str("\n(tronqué)"); }
            if o.status.success() { ToolRunResult::ok(t, Vec::new()) } else { ToolRunResult::err(t, Vec::new()) }
        }
    }
}

/// Binaire embarqué (ressource `cua-driver/` de l'appli), sinon CUA_DRIVER_BIN, sinon PATH.
pub fn binaire() -> String {
    if let Ok(b) = std::env::var("CUA_DRIVER_BIN") { return b; }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        let nom = if cfg!(windows) { "cua-driver.exe" } else { "cua-driver" };
        // Windows : à côté de l'exe ; macOS : Contents/Resources ; Linux (.deb, AppImage) : usr/lib/SavIDE.
        for base in [dir.clone(), dir.join("../Resources"), dir.join("../lib/SavIDE")] {
            let p = base.join("cua-driver").join(nom);
            if p.is_file() { return p.to_string_lossy().into_owned(); }
        }
    }
    "cua-driver".into()
}

/// axe:0.1.75 : aucun lancement de processus n'ouvre de fenetre console sous Windows.
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
#[allow(dead_code)]
fn __nw_tokio<S: AsRef<std::ffi::OsStr>>(p: S) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(p);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c
}

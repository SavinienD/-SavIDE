//! cua — cua-driver comme OUTIL intégré (plus besoin de passer par MCP).
//! Lance `cua-driver <args...>` (CUA_DRIVER_BIN, sinon le binaire embarqué dans l'installeur, sinon le PATH), sortie texte rendue au modèle.
use std::time::Duration;
use serde_json::{json, Value};
use axecode_core::ToolDescriptor;
use crate::ToolRunResult;

pub const CUA_DRIVER: &str = "cua_driver";

pub fn descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: CUA_DRIVER.into(),
        description: "Pilote le bureau de ce poste (capture, clic, clavier, fenêtres) via cua-driver. À utiliser UNIQUEMENT quand l'utilisateur le demande explicitement (jamais de soi-même). Syntaxe de cua-driver 0.59 : [\"list-tools\"], [\"describe\",\"click\"], [\"call\",\"list_windows\"], [\"call\",\"get_window_state\",\"{\\\"pid\\\":844,\\\"window_id\\\":10725}\"], [\"call\",\"click\",\"{\\\"window_id\\\":10725,\\\"x\\\":100,\\\"y\\\":200}\"], [\"call\",\"type_text\",\"{\\\"pid\\\":844,\\\"text\\\":\\\"bonjour\\\"}\"] (x/y = pixels dans la fenêtre). Le démon (serve) est lancé tout seul si besoin.".into(),
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
    run_avec(&binaire(), &args, delai).await
}

/// cua-059 — Lance `bin args`. Depuis cua-driver 0.38, les commandes d'outil (`call <outil> <json>`)
/// passent par un démon (`cua-driver serve`) : s'il ne tourne pas, on le démarre une fois en arrière-plan
/// puis on réessaie dans le délai restant.
async fn run_avec(bin: &str, args: &[String], delai: u64) -> ToolRunResult {
    let debut = std::time::Instant::now();
    let mut r = executer(bin, args, delai).await;
    if matches!(&r, Ok((false, t)) if demon_absent(t)) && args.first().map(String::as_str) != Some("serve") {
        if demarrer_demon(bin).await {
            let reste = delai.saturating_sub(debut.elapsed().as_secs()).max(1);
            r = executer(bin, args, reste).await;
        }
    }
    match r {
        Err(e) => ToolRunResult::err(e, Vec::new()),
        Ok((true, t)) => ToolRunResult::ok(t, Vec::new()),
        Ok((false, t)) => ToolRunResult::err(t, Vec::new()),
    }
}

async fn executer(bin: &str, args: &[String], delai: u64) -> Result<(bool, String), String> {
    let fut = __nw_tokio(bin).args(args).kill_on_drop(true).output();
    match tokio::time::timeout(Duration::from_secs(delai), fut).await {
        Err(_) => Err(format!("cua_driver: délai de {delai} s dépassé")),
        Ok(Err(e)) => Err(format!("cua_driver: lancement impossible ({bin}) : {e}")),
        Ok(Ok(o)) => {
            let mut t = String::from_utf8_lossy(&o.stdout).into_owned();
            let err = String::from_utf8_lossy(&o.stderr);
            if !err.trim().is_empty() { t.push_str("\n[stderr] "); t.push_str(err.trim()); }
            if t.len() > 20_000 {
                let mut n = 20_000;
                while !t.is_char_boundary(n) { n -= 1; }
                t.truncate(n);
                t.push_str("\n(tronqué)");
            }
            Ok((o.status.success(), t))
        }
    }
}

/// Message de cua-driver quand aucun démon n'écoute (0.38 à 0.59.4).
fn demon_absent(sortie: &str) -> bool {
    sortie.contains("daemon is not running")
}

/// Lance `cua-driver serve` détaché (il survit à l'appel) et attend que `cua-driver status` réussisse (10 s au plus).
async fn demarrer_demon(bin: &str) -> bool {
    use std::process::Stdio;
    let lance = __nw_tokio(bin).arg("serve")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .kill_on_drop(false).spawn();
    if lance.is_err() { return false; }
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let st = __nw_tokio(bin).arg("status")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .kill_on_drop(true).status();
        if let Ok(Ok(s)) = tokio::time::timeout(Duration::from_secs(5), st).await {
            if s.success() { return true; }
        }
    }
    false
}

/// cua-059 — cua-driver embarqué dans l'installeur (ressource `cua-driver/`) : Windows à côté de l'exe,
/// macOS dans Contents/Resources, Linux (.deb, AppImage) dans usr/lib/<produit>.
fn chercher_embarque(dir_exe: &std::path::Path, produit: &str) -> Option<std::path::PathBuf> {
    let nom = if cfg!(windows) { "cua-driver.exe" } else { "cua-driver" };
    [dir_exe.to_path_buf(), dir_exe.join("../Resources"), dir_exe.join("../lib").join(produit)]
        .into_iter()
        .map(|base| base.join("cua-driver").join(nom))
        .find(|p| p.is_file())
}

fn binaire_embarque(produit: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    chercher_embarque(exe.parent()?, produit).map(|p| p.to_string_lossy().into_owned())
}


/// CUA_DRIVER_BIN, sinon le binaire embarqué (ressource `cua-driver/` de l'installeur), sinon le PATH.
pub fn binaire() -> String {
    if let Ok(b) = std::env::var("CUA_DRIVER_BIN") { return b; }
    binaire_embarque("SavIDE").unwrap_or_else(|| "cua-driver".into())
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
#[allow(dead_code)]
fn __nw_tokio<S: AsRef<std::ffi::OsStr>>(p: S) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(p);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c
}

#[cfg(all(test, unix))]
mod tests {
    // cua-059 — démon absent : `serve` lancé une fois, puis la commande réussit.
    #[tokio::test]
    async fn demarre_le_demon_quand_il_manque() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cua059-demon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let faux = dir.join("cua-driver");
        std::fs::write(&faux, "#!/bin/sh\nD=$(dirname \"$0\")\ncase \"$1\" in\n serve) touch \"$D/demon\"; sleep 3;;\n status) [ -f \"$D/demon\" ];;\n *) if [ -f \"$D/demon\" ]; then echo \"ok $*\"; else echo \"Cua Driver daemon is not running on x\" >&2; exit 1; fi;;\nesac\n").unwrap();
        std::fs::set_permissions(&faux, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = faux.to_string_lossy().into_owned();
        let args = vec!["call".to_string(), "list_windows".to_string()];
        let r = super::run_avec(&bin, &args, 20).await;
        assert!(!r.is_error, "{}", r.content);
        assert_eq!(r.content.trim(), "ok call list_windows");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // cua-059 — le binaire embarqué est trouvé dans <dossier de l'exe>/cua-driver/ ou ../lib/<produit>/cua-driver/.
    #[test]
    fn trouve_le_binaire_embarque() {
        let dir = std::env::temp_dir().join(format!("cua059-embarque-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        assert!(super::chercher_embarque(&bin, "Produit").is_none());
        let lib = dir.join("lib/Produit/cua-driver");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("cua-driver"), "").unwrap();
        assert!(super::chercher_embarque(&bin, "Produit").is_some());
        std::fs::create_dir_all(bin.join("cua-driver")).unwrap();
        std::fs::write(bin.join("cua-driver/cua-driver"), "").unwrap();
        assert_eq!(super::chercher_embarque(&bin, "Produit").unwrap(), bin.join("cua-driver/cua-driver"));
        assert!(!super::demon_absent("ok") && super::demon_absent("Cua Driver daemon is not running on /x.sock"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

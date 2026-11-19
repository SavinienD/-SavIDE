//! uh-cli — mode sans interface de l'exécutable de l'appli : `axecode -p "<texte>"`,
//! `--mode json`, `--mode acp`. Le travail se fait dans le service de l'appli (même
//! stockage, mêmes conversations) ; ce processus n'en est qu'un client. Aucune fenêtre :
//! il sort avant que Tauri ne démarre, et marche sans affichage (DISPLAY absent).

mod acp;
mod acp_maj;
mod args;
mod commun;
mod print;

/// Vrai si le processus a été lancé en mode sans interface (et l'a exécuté : le code de
/// sortie est déjà rendu au système).
pub(crate) fn run_if_requested() -> bool {
    let brut: Vec<String> = std::env::args().skip(1).collect();
    if !args::demande(&brut) {
        return false;
    }
    console_du_parent();
    let options = match args::lire(&brut) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("axecode : {e}\n\n{}", args::AIDE);
            std::process::exit(2);
        }
    };
    if options.aide {
        println!("{}", args::AIDE);
        std::process::exit(0);
    }
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("AXECODE_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("error")),
        )
        .with_writer(std::io::stderr)
        .try_init();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("axecode : {e}");
            std::process::exit(1);
        }
    };
    let code = runtime.block_on(async move {
        match options.mode {
            args::Mode::Acp => acp::executer().await,
            _ => print::executer(options).await,
        }
    });
    // Les tâches du client (lecture du service) ne doivent pas retenir la sortie.
    runtime.shutdown_timeout(std::time::Duration::from_millis(200));
    std::process::exit(code);
}

/// Windows : l'exécutable de l'appli n'a pas de console (sous-système « windows ») ;
/// lancé depuis un terminal, il se rattache à celui-ci pour écrire ses sorties. Sans
/// effet quand les sorties sont déjà redirigées (pipes) ou hors Windows.
#[cfg(windows)]
fn console_du_parent() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn console_du_parent() {}

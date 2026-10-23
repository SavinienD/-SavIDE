// axe:gemini-web — Gemini through the gemini.google.com web app: sign-in in a
// dedicated browser profile, status, sign-out, provider registration.

use crate::*;

use axecode_gemini_web::{GeminiWebProvider, GeminiWebStatus, PROVIDER_ID as GEMINI_WEB_PROVIDER_ID};

type Registry = Arc<StdMutex<HashMap<String, Arc<dyn Provider>>>>;

/// Registers the provider when a session was saved (no network access).
pub(crate) fn install_gemini_web_provider(registry: &Registry) -> bool {
    match GeminiWebProvider::from_default_sources() {
        Ok(provider) => {
            if let Ok(mut providers) = registry.lock() {
                providers.insert(GEMINI_WEB_PROVIDER_ID.into(), Arc::new(provider) as Arc<dyn Provider>);
            }
            true
        }
        Err(_) => false,
    }
}

/// `verify` opens the app (headless browser) to check the session and list
/// the models of the account; otherwise only local state is read.
#[tauri::command]
pub(crate) async fn gemini_web_status(verify: Option<bool>) -> std::result::Result<GeminiWebStatus, String> {
    Ok(axecode_gemini_web::status(verify.unwrap_or(false)).await)
}

/// Opens a browser window on Google sign-in (dedicated profile) and waits up
/// to 10 minutes for the user to sign in.
#[tauri::command]
pub(crate) async fn gemini_web_login(state: State<'_, DesktopState>) -> std::result::Result<GeminiWebStatus, String> {
    let status = axecode_gemini_web::login(Duration::from_secs(600))
        .await
        .map_err(|err| err.to_string())?;
    install_gemini_web_provider(&state.providers);
    Ok(status)
}

#[tauri::command]
pub(crate) async fn gemini_web_logout(state: State<'_, DesktopState>) -> std::result::Result<GeminiWebStatus, String> {
    if let Ok(mut providers) = state.providers.lock() {
        providers.remove(GEMINI_WEB_PROVIDER_ID);
    }
    axecode_gemini_web::logout().map_err(|err| err.to_string())?;
    Ok(axecode_gemini_web::status(false).await)
}

//! axe:comfyui — outil ComfyUI : envoie un workflow (format API) à un serveur ComfyUI
//! (COMFYUI_URL, défaut http://127.0.0.1:8188), attend la fin et renvoie les fichiers produits.
use std::time::Duration;
use serde_json::{json, Value};
use axecode_core::ToolDescriptor;
use crate::ToolRunResult;

pub const COMFYUI: &str = "comfyui";

pub fn descriptor() -> ToolDescriptor {
    ToolDescriptor {
        name: COMFYUI.into(),
        description: "Génère des images/vidéos avec ComfyUI (serveur local avec GPU). Donne un workflow au format API ComfyUI ; renvoie les noms des fichiers produits et leurs URL.".into(),
        input_schema: json!({"type":"object","properties":{
            "workflow":{"type":"object","description":"Workflow ComfyUI au format API"},
            "timeoutSecondes":{"type":"integer","minimum":5,"maximum":1800}},
            "required":["workflow"],"additionalProperties":false}),
    }
}

pub async fn run(input: Value) -> ToolRunResult {
    let base = std::env::var("COMFYUI_URL").unwrap_or_else(|_| "http://127.0.0.1:8188".into());
    let Some(wf) = input.get("workflow").cloned() else { return ToolRunResult::err("comfyui: workflow obligatoire", Vec::new()) };
    let delai = input.get("timeoutSecondes").and_then(Value::as_u64).unwrap_or(600).clamp(5, 1800);
    let c = reqwest::Client::new();
    let rep = match c.post(format!("{base}/prompt")).json(&json!({"prompt": wf})).send().await {
        Ok(r) => r, Err(e) => return ToolRunResult::err(format!("comfyui injoignable ({base}) : {e}"), Vec::new()),
    };
    let v: Value = match rep.json().await { Ok(v) => v, Err(e) => return ToolRunResult::err(format!("comfyui: réponse illisible : {e}"), Vec::new()) };
    let Some(id) = v.get("prompt_id").and_then(Value::as_str).map(str::to_string) else {
        return ToolRunResult::err(format!("comfyui a refusé le workflow : {v}"), Vec::new());
    };
    let fin = tokio::time::Instant::now() + Duration::from_secs(delai);
    loop {
        if let Ok(r) = c.get(format!("{base}/history/{id}")).send().await {
            if let Ok(h) = r.json::<Value>().await {
                if let Some(entree) = h.get(&id) {
                    let mut fichiers = Vec::new();
                    if let Some(outs) = entree.get("outputs").and_then(Value::as_object) {
                        for o in outs.values() {
                            for k in ["images", "gifs", "videos"] {
                                for f in o.get(k).and_then(Value::as_array).into_iter().flatten() {
                                    let n = f.get("filename").and_then(Value::as_str).unwrap_or("");
                                    let sf = f.get("subfolder").and_then(Value::as_str).unwrap_or("");
                                    fichiers.push(json!({"fichier": n, "url": format!("{base}/view?filename={n}&subfolder={sf}&type=output")}));
                                }
                            }
                        }
                    }
                    return ToolRunResult::ok(json!({"prompt_id": id, "fichiers": fichiers}).to_string(), Vec::new());
                }
            }
        }
        if tokio::time::Instant::now() >= fin { return ToolRunResult::err(format!("comfyui: délai dépassé (prompt {id})"), Vec::new()); }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

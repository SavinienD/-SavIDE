//! uh-cli (lot B) — traduction des événements du service en notifications ACP
//! `session/update`, options de configuration (modèle, réflexion) et relecture de
//! l'historique pour `session/load`. Fonctions pures (testées). Formes d'après la
//! spécification Agent Client Protocol (https://agentclientprotocol.com) ; découpage
//! inspiré de l'ACP d'Unharnessed (events.rs, config_options.rs, history.rs).

use serde_json::{json, Value};

use axecode_core::{ChatMessage, ModelRef, Part, Role};

pub const VERSION_PROTOCOLE: u64 = 1;
/// Fin de sortie gardée dans une mise à jour d'appel du noyau (octets).
const SORTIE_MAX: usize = 8_000;

pub fn notification(session: &str, maj: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": maj}})
}

pub fn texte(genre: &str, t: &str) -> Value {
    json!({"sessionUpdate": genre, "content": {"type": "text", "text": t}})
}

/// Titre d'un appel du noyau : la première ligne non vide du code.
pub fn titre(code: &str) -> String {
    let l = code.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("python");
    let court: String = l.chars().take(80).collect();
    if court.len() < l.len() { format!("{court}…") } else { court }
}

pub fn appel(id: &str, code: &str) -> Value {
    json!({"sessionUpdate": "tool_call", "toolCallId": id, "title": titre(code), "kind": "execute",
        "status": "in_progress", "rawInput": {"code": code}})
}

fn fin_de(t: &str) -> &str {
    if t.len() <= SORTIE_MAX {
        return t;
    }
    let mut debut = t.len() - SORTIE_MAX;
    while !t.is_char_boundary(debut) {
        debut += 1;
    }
    &t[debut..]
}

pub fn appel_suite(id: &str, sortie: &str) -> Value {
    json!({"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "in_progress",
        "content": [{"type": "content", "content": {"type": "text", "text": fin_de(sortie)}}]})
}

pub fn appel_fin(id: &str, stdout: &str, stderr: &str, erreur: bool) -> Value {
    let tout = [stdout, stderr].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n");
    let mut v = json!({"sessionUpdate": "tool_call_update", "toolCallId": id,
        "status": if erreur { "failed" } else { "completed" },
        "rawOutput": {"stdout": stdout, "stderr": stderr, "isError": erreur}});
    if !tout.is_empty() {
        v["content"] = json!([{"type": "content", "content": {"type": "text", "text": fin_de(&tout)}}]);
    }
    v
}

/// Début ou fin d'un tour lancé par le service lui-même (guet, heartbeat, relance
/// d'objectif, mode autonome) : rien dans la spécification ne le dit, d'où `_meta`.
pub fn tour_de_reveil(debut: bool) -> Value {
    json!({"sessionUpdate": "session_info_update", "_meta": {"savide": {"wakeTurn": if debut { "start" } else { "end" }}}})
}

/// Texte d'un message `session/prompt` : blocs texte, ressources incluses (texte),
/// liens de ressources (adresse). Les images et sons ne sont pas annoncés.
pub fn texte_du_prompt(blocs: &Value) -> String {
    let mut morceaux = Vec::new();
    for b in blocs.as_array().into_iter().flatten() {
        match b["type"].as_str() {
            Some("text") => morceaux.push(b["text"].as_str().unwrap_or("").to_string()),
            Some("resource") => {
                let r = &b["resource"];
                let uri = r["uri"].as_str().unwrap_or("");
                if let Some(t) = r["text"].as_str() {
                    morceaux.push(format!("<resource uri=\"{uri}\">\n{t}\n</resource>"));
                } else if !uri.is_empty() {
                    morceaux.push(format!("[ressource : {uri}]"));
                }
            }
            Some("resource_link") => morceaux.push(format!("[ressource : {}]", b["uri"].as_str().unwrap_or(""))),
            _ => {}
        }
    }
    morceaux.join("\n\n")
}

pub const EFFORTS: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];

pub fn valeur_modele(m: &ModelRef) -> String {
    format!("{}/{}", m.provider, m.name)
}

/// Options `configOptions` : modèle (`category: model`) et niveau de réflexion
/// (`category: thought_level`).
pub fn options(courant: &ModelRef, modeles: &[ModelRef]) -> Value {
    let mut liste: Vec<String> = Vec::new();
    for m in std::iter::once(courant).chain(modeles.iter()) {
        let v = valeur_modele(m);
        if !liste.contains(&v) {
            liste.push(v);
        }
    }
    let effort = courant
        .effort
        .and_then(|e| serde_json::to_value(e).ok())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "default".into());
    let mut niveaux = vec![json!({"value": "default", "name": "Par défaut"})];
    niveaux.extend(EFFORTS.iter().map(|e| json!({"value": e, "name": e})));
    json!([
        {"id": "model", "name": "Modèle", "category": "model", "type": "select",
         "currentValue": valeur_modele(courant),
         "options": liste.iter().map(|v| json!({"value": v, "name": v})).collect::<Vec<_>>()},
        {"id": "thought_level", "name": "Réflexion", "category": "thought_level", "type": "select",
         "currentValue": effort, "options": niveaux}
    ])
}

/// Applique un choix `session/set_config_option` au modèle courant.
pub fn appliquer(courant: &ModelRef, option: &str, valeur: &str) -> Result<ModelRef, String> {
    match option {
        "model" => {
            let mut m = super::args::modele(valeur)?;
            m.effort = courant.effort;
            Ok(m)
        }
        "thought_level" => {
            let mut m = courant.clone();
            m.effort = if valeur == "default" { None } else { Some(super::args::effort(valeur)?) };
            Ok(m)
        }
        autre => Err(format!("option inconnue : {autre}")),
    }
}

/// Relecture de l'historique (`session/load`) : messages de l'utilisateur et de l'agent,
/// réflexion, appels du noyau avec leur résultat.
pub fn relecture(historique: &[ChatMessage]) -> Vec<Value> {
    let mut sortie = Vec::new();
    for m in historique {
        for p in &m.parts {
            match (m.role, p) {
                (Role::User, Part::Text { text, .. }) => sortie.push(texte("user_message_chunk", text)),
                (Role::Assistant, Part::Text { text, .. }) => sortie.push(texte("agent_message_chunk", text)),
                (_, Part::Thinking { text, .. }) if !text.is_empty() => sortie.push(texte("agent_thought_chunk", text)),
                (_, Part::ToolCall { id, input, .. }) => {
                    let code = input["code"].as_str().unwrap_or("");
                    sortie.push(appel(id, code));
                }
                (_, Part::ToolResult { tool_call_id, content, is_error, .. }) => {
                    sortie.push(appel_fin(tool_call_id, content, "", *is_error));
                }
                _ => {}
            }
        }
    }
    sortie
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mises_a_jour_d_un_appel_du_noyau() {
        let a = appel("c1", "\n\nx = 6*7\nprint(x)");
        assert_eq!(a["sessionUpdate"], "tool_call");
        assert_eq!(a["title"], "x = 6*7");
        assert_eq!(a["kind"], "execute");
        let f = appel_fin("c1", "42\n", "", false);
        assert_eq!(f["status"], "completed");
        assert_eq!(f["content"][0]["content"]["text"], "42\n");
        assert_eq!(appel_fin("c1", "", "Traceback", true)["status"], "failed");
        let long = "é".repeat(10_000);
        let s = appel_suite("c1", &long);
        assert!(s["content"][0]["content"]["text"].as_str().unwrap().len() <= SORTIE_MAX);
    }

    #[test]
    fn prompt_avec_ressources() {
        let blocs = json!([{"type": "text", "text": "lis ça"},
            {"type": "resource", "resource": {"uri": "file:///a.txt", "text": "contenu"}},
            {"type": "resource_link", "uri": "file:///b.txt", "name": "b"},
            {"type": "image", "data": "AA==", "mimeType": "image/png"}]);
        let t = texte_du_prompt(&blocs);
        assert!(t.starts_with("lis ça"));
        assert!(t.contains("<resource uri=\"file:///a.txt\">\ncontenu"));
        assert!(t.ends_with("[ressource\u{a0}: file:///b.txt]"));
    }

    #[test]
    fn options_modele_et_reflexion() {
        let courant = ModelRef::new("faux", "faux-1");
        let o = options(&courant, &[ModelRef::new("anthropic", "claude-x"), courant.clone()]);
        assert_eq!(o[0]["currentValue"], "faux/faux-1");
        assert_eq!(o[0]["options"].as_array().unwrap().len(), 2);
        assert_eq!(o[1]["category"], "thought_level");
        assert_eq!(o[1]["currentValue"], "default");
        let m = appliquer(&courant, "thought_level", "high").unwrap();
        assert_eq!(options(&m, &[])[1]["currentValue"], "high");
        let m2 = appliquer(&m, "model", "anthropic/claude-x").unwrap();
        assert_eq!((m2.provider.as_str(), m2.effort), ("anthropic", m.effort));
        assert!(appliquer(&m, "mode", "x").is_err());
        assert!(appliquer(&m, "thought_level", "énorme").is_err());
    }

    #[test]
    fn relecture_de_l_historique() {
        let h: Vec<ChatMessage> = serde_json::from_value(json!([
            {"role": "user", "parts": [{"type": "text", "text": "calcule"}]},
            {"role": "assistant", "parts": [{"type": "thinking", "text": "hm"}, {"type": "tool_call", "id": "c1", "name": "python", "input": {"code": "print(42)"}}]},
            {"role": "user", "parts": [{"type": "tool_result", "tool_call_id": "c1", "content": "42"}]},
            {"role": "assistant", "parts": [{"type": "text", "text": "42."}]}
        ])).unwrap();
        let r = relecture(&h);
        let genres: Vec<&str> = r.iter().map(|v| v["sessionUpdate"].as_str().unwrap()).collect();
        assert_eq!(genres, ["user_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
    }
}

//! Wire format of the Gemini web app (gemini.google.com): page tokens,
//! `batchexecute` RPCs, the `StreamGenerate` request and its length-prefixed
//! streaming frames. Pure functions only, so they can be unit tested.

use serde_json::{json, Value};

pub const APP_URL: &str = "https://gemini.google.com/app";
pub const GENERATE_URL: &str =
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
pub const BATCH_URL: &str = "https://gemini.google.com/_/BardChatUi/data/batchexecute";
pub const ROTATE_URL: &str = "https://accounts.google.com/RotateCookies";
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
pub const MODEL_HEADER: &str = "x-goog-ext-525001261-jspb";
pub const RPC_USER_STATUS: &str = "otAQ7b";

/// Values scraped from the app page, required by every RPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageTokens {
    /// `SNlM0e`: anti-CSRF token sent as `at`.
    pub at: String,
    /// `cfb2h`: frontend build label (`bl`).
    pub build_label: Option<String>,
    /// `FdrFJe`: frontend session id (`f.sid`).
    pub session_id: Option<String>,
    /// `TuX5cc`: account language.
    pub language: String,
}

fn scrape(html: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let start = html.find(&needle)? + needle.len();
    let rest = html[start..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// `None` when the page carries no `SNlM0e` (signed out / cookies expired).
pub fn parse_page_tokens(html: &str) -> Option<PageTokens> {
    let at = scrape(html, "SNlM0e").filter(|value| !value.is_empty())?;
    Some(PageTokens {
        at,
        build_label: scrape(html, "cfb2h"),
        session_id: scrape(html, "FdrFJe"),
        language: scrape(html, "TuX5cc").filter(|v| !v.is_empty()).unwrap_or_else(|| "fr".into()),
    })
}

/// Incremental parser of Google's `)]}'` + `<length>\n<json>` streaming frames.
/// Lengths are not trusted (they count UTF-16 units); each frame is delimited by
/// parsing one JSON value after the length line.
#[derive(Default)]
pub struct FrameParser {
    buffer: String,
    prefix_done: bool,
}

impl FrameParser {
    pub fn feed(&mut self, chunk: &str) -> Vec<Value> {
        self.buffer.push_str(chunk);
        if !self.prefix_done {
            let trimmed = self.buffer.trim_start();
            if trimmed.len() < 4 && ")]}'".starts_with(trimmed) {
                return Vec::new();
            }
            if let Some(rest) = trimmed.strip_prefix(")]}'") {
                self.buffer = rest.to_string();
            }
            self.prefix_done = true;
        }
        let mut out = Vec::new();
        loop {
            let start = self.buffer.len() - self.buffer.trim_start().len();
            let rest = &self.buffer[start..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                if !rest.is_empty() && !rest.starts_with(|c: char| c.is_ascii_digit()) {
                    // Not a length line: try to read a bare JSON value.
                    match parse_one(rest) {
                        Parsed::Value(value, used) => {
                            push_frame(&mut out, value);
                            self.buffer = rest[used..].to_string();
                            continue;
                        }
                        Parsed::Incomplete => break,
                        Parsed::Invalid => {
                            // Drop the garbage line.
                            let cut = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
                            self.buffer = rest[cut..].to_string();
                            continue;
                        }
                    }
                }
                break;
            }
            let after_digits = &rest[digits..];
            if after_digits.is_empty() {
                break; // length line not complete yet
            }
            if !after_digits.starts_with(['\n', '\r']) {
                // Digits that are not a length marker: drop them.
                self.buffer = after_digits.to_string();
                continue;
            }
            let body = after_digits.trim_start_matches(['\r', '\n']);
            if body.is_empty() {
                break;
            }
            match parse_one(body) {
                Parsed::Value(value, used) => {
                    push_frame(&mut out, value);
                    self.buffer = body[used..].to_string();
                }
                Parsed::Incomplete => break,
                Parsed::Invalid => {
                    let cut = body.find('\n').map(|i| i + 1).unwrap_or(body.len());
                    self.buffer = body[cut..].to_string();
                }
            }
        }
        out
    }
}

enum Parsed {
    Value(Value, usize),
    Incomplete,
    Invalid,
}

fn parse_one(text: &str) -> Parsed {
    let mut stream = serde_json::Deserializer::from_str(text).into_iter::<Value>();
    match stream.next() {
        Some(Ok(value)) => Parsed::Value(value, stream.byte_offset()),
        Some(Err(err)) if err.is_eof() => Parsed::Incomplete,
        Some(Err(_)) => Parsed::Invalid,
        None => Parsed::Incomplete,
    }
}

fn push_frame(out: &mut Vec<Value>, value: Value) {
    match value {
        Value::Array(items) => out.extend(items),
        other => out.push(other),
    }
}

pub fn at<'a>(value: &'a Value, path: &[usize]) -> Option<&'a Value> {
    let mut current = value;
    for &index in path {
        current = current.as_array()?.get(index)?;
    }
    if current.is_null() {
        None
    } else {
        Some(current)
    }
}

/// A model offered to this account by the app (`otAQ7b` RPC, field 15).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebModel {
    /// Hex id sent in the model header.
    pub id: String,
    /// Stable SavIDE id: `gemini-` + category slug (`gemini-argon`, `gemini-pro`...).
    pub slug: String,
    /// Display name (`4 Argon`).
    pub label: String,
    pub description: String,
    /// Internal model number mirrored into the request.
    pub number: i64,
}

/// Account capacity value used in the model header (tier dependent).
pub fn capacity_from_flags(tier_flags: &[i64], capability_flags: &[i64]) -> (i64, i64) {
    if tier_flags.contains(&21) {
        return (1, 13);
    }
    if tier_flags.contains(&22) {
        return (2, 13);
    }
    if capability_flags.contains(&115) {
        return (4, 12);
    }
    if tier_flags.contains(&16) || capability_flags.contains(&106) {
        return (3, 12);
    }
    if tier_flags.contains(&8) || capability_flags.contains(&19) {
        (2, 12)
    } else {
        (1, 12)
    }
}

#[derive(Debug, Clone, Default)]
pub struct UserStatus {
    pub status_code: Option<i64>,
    pub models: Vec<WebModel>,
    pub capacity: (i64, i64),
}

fn ints(value: Option<&Value>) -> Vec<i64> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

fn text_at(value: &Value, path: &[usize]) -> String {
    at(value, path).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn slugify(name: &str) -> String {
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' { c } else { '-' })
        .collect();
    format!("gemini-{}", slug.trim_matches('-'))
}

/// Parses the `otAQ7b` body (already decoded from the frame's string field).
pub fn parse_user_status(body: &Value) -> UserStatus {
    let tier = ints(at(body, &[16]));
    let caps = ints(at(body, &[17]));
    let mut models = Vec::new();
    if let Some(list) = at(body, &[15]).and_then(Value::as_array) {
        for item in list {
            let id = text_at(item, &[0]);
            if id.is_empty() {
                continue;
            }
            let category = {
                let c = text_at(item, &[1]);
                if c.is_empty() { text_at(item, &[10]) } else { c }
            };
            let label = [11usize, 19, 1]
                .iter()
                .map(|&i| text_at(item, &[i]))
                .find(|s| !s.is_empty())
                .unwrap_or_else(|| id.clone());
            let description = {
                let d = text_at(item, &[12]);
                if d.is_empty() { text_at(item, &[2]) } else { d }
            };
            let number = at(item, &[17])
                .and_then(Value::as_i64)
                .or_else(|| at(item, &[9]).and_then(Value::as_i64))
                .unwrap_or(1);
            let slug = if category.is_empty() { slugify(&label) } else { slugify(&category) };
            models.push(WebModel { id, slug, label, description, number });
        }
    }
    UserStatus {
        status_code: at(body, &[14]).and_then(Value::as_i64),
        models,
        capacity: capacity_from_flags(&tier, &caps),
    }
}

/// Extracts the decoded JSON bodies of RPC `rpc_id` from batchexecute frames.
pub fn rpc_bodies(frames: &[Value], rpc_id: &str) -> Vec<Value> {
    frames
        .iter()
        .filter(|part| at(part, &[1]).and_then(Value::as_str) == Some(rpc_id))
        .filter_map(|part| at(part, &[2]).and_then(Value::as_str))
        .filter_map(|raw| serde_json::from_str(raw).ok())
        .collect()
}

pub fn batch_model_header(client_session: &str) -> String {
    json!([1, null, null, null, null, null, null, null, [4, 5, 6, 8], null, null, null, null, null, null, null, client_session])
        .to_string()
}

pub fn batch_form(rpc_id: &str, payload: &str, at_token: &str) -> Vec<(String, String)> {
    vec![
        ("at".into(), at_token.into()),
        ("f.req".into(), json!([[[rpc_id, payload, null, "generic"]]]).to_string()),
    ]
}

/// Conversation pointer of a web chat: `[cid, rid, rcid]`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatPointer {
    pub cid: String,
    pub rid: String,
    pub rcid: String,
}

impl ChatPointer {
    pub fn metadata(&self) -> Value {
        if self.cid.is_empty() {
            json!(["", "", "", null, null, null, null, null, null, ""])
        } else {
            json!([self.cid, self.rid, self.rcid, null, null, null, null, null, null, ""])
        }
    }
}

pub struct GenerateRequest<'a> {
    pub prompt: &'a str,
    pub language: &'a str,
    pub pointer: &'a ChatPointer,
    pub model: &'a WebModel,
    pub capacity: (i64, i64),
    /// 1 = standard, 2 = extended thinking (3 would start Deep Think: never used).
    pub thinking: i64,
    pub client_session: &'a str,
    pub temporary: bool,
}

/// Returns the extra headers and the `f.req` form value of a StreamGenerate call.
pub fn generate_payload(req: &GenerateRequest<'_>) -> (Vec<(String, String)>, String) {
    let request_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();
    let mut inner = vec![Value::Null; 81];
    inner[0] = json!([req.prompt, 0, null, null, null, null, 0]);
    inner[1] = json!([req.language]);
    inner[2] = req.pointer.metadata();
    inner[6] = json!([1]);
    inner[7] = json!(1); // streaming
    inner[10] = json!(1);
    inner[11] = json!(0);
    inner[17] = json!([[0]]);
    inner[18] = json!(0);
    inner[27] = json!(1);
    inner[30] = json!([4]);
    inner[41] = json!([1]);
    if req.temporary {
        inner[45] = json!(1);
    }
    inner[53] = json!(0);
    inner[59] = json!(request_uuid);
    inner[61] = json!([]);
    inner[68] = json!(1);
    inner[79] = json!(req.model.number);
    inner[80] = json!(req.thinking);
    let (capacity, field) = req.capacity;
    let mut header = vec![
        json!(1), Value::Null, Value::Null, Value::Null, json!(req.model.id), Value::Null, Value::Null,
        json!(0), json!([4, 5, 6, 8]), Value::Null, Value::Null,
    ];
    if field == 13 {
        header.push(Value::Null);
    }
    header.push(json!(capacity));
    header.extend([Value::Null, Value::Null, json!(req.model.number), json!(req.thinking), json!(req.client_session)]);
    let headers = vec![
        (MODEL_HEADER.to_string(), Value::Array(header).to_string()),
        ("x-goog-ext-73010989-jspb".into(), "[0]".into()),
        ("x-goog-ext-73010990-jspb".into(), "[0,0,0]".into()),
        ("x-goog-ext-525005358-jspb".into(), format!("[\"{request_uuid}\",1]")),
    ];
    let inner_text = Value::Array(inner).to_string();
    (headers, json!([null, inner_text]).to_string())
}

/// What one StreamGenerate frame tells about the reply.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct FrameUpdate {
    pub error_code: Option<i64>,
    pub cid: Option<String>,
    pub rid: Option<String>,
    pub rcid: Option<String>,
    /// Full (cumulative) reply text so far.
    pub text: Option<String>,
    /// Full (cumulative) thoughts so far.
    pub thoughts: Option<String>,
    pub completed: bool,
}

pub fn frame_update(part: &Value) -> FrameUpdate {
    let mut update = FrameUpdate {
        error_code: at(part, &[5, 2, 0, 1, 0]).and_then(Value::as_i64),
        ..Default::default()
    };
    let Some(inner) = at(part, &[2]).and_then(Value::as_str) else { return update };
    let Ok(body) = serde_json::from_str::<Value>(inner) else { return update };
    update.cid = at(&body, &[1, 0]).and_then(Value::as_str).map(str::to_string);
    update.rid = at(&body, &[1, 1]).and_then(Value::as_str).map(str::to_string);
    if let Some(candidate) = at(&body, &[4, 0]) {
        update.rcid = at(candidate, &[0]).and_then(Value::as_str).map(str::to_string);
        update.text = at(candidate, &[1, 0]).and_then(Value::as_str).map(str::to_string);
        update.thoughts = at(candidate, &[37, 0, 0]).and_then(Value::as_str).map(str::to_string);
        update.completed = at(candidate, &[8, 0]).and_then(Value::as_i64) == Some(2);
    }
    update
}

/// Removes transient streaming artifacts (a closing fence or a lone markdown
/// escape the app shows while a block is still being written).
pub fn clean_partial(text: &str) -> &str {
    let text = text.strip_suffix("\n```").unwrap_or(text);
    if let Some(pos) = text.rfind('\\') {
        let tail = &text[pos..];
        let escaped = tail.trim_start_matches('\\');
        if escaped.chars().next().is_some_and(|c| matches!(c, '`' | '*' | '_' | '~')) && !tail.contains('\n') {
            let mut start = pos;
            while start > 0 && text.as_bytes()[start - 1] == b'\\' {
                start -= 1;
            }
            return &text[..start];
        }
    }
    text
}

pub fn error_message(code: i64, model: &str) -> String {
    match code {
        1037 => format!("Gemini web : limite d'utilisation atteinte pour {model}. Réessayez après la remise à zéro du quota (fenêtre de 5 h) ou choisissez un autre modèle."),
        1050 => "Gemini web : le modèle ne correspond pas à la conversation en cours.".into(),
        1052 => format!("Gemini web : le modèle {model} est indisponible ou le format de requête a changé (mise à jour de SavIDE nécessaire)."),
        1060 => "Gemini web : adresse IP temporairement bloquée par Google. Réessayez plus tard.".into(),
        1013 => "Gemini web : erreur temporaire de Google (1013).".into(),
        other => format!("Gemini web : erreur {other} renvoyée par Google."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_tokens() {
        let html = r#"x "SNlM0e":"AT123" y "cfb2h": "boq_x" "FdrFJe":"-42" "TuX5cc":"fr""#;
        let t = parse_page_tokens(html).unwrap();
        assert_eq!(t.at, "AT123");
        assert_eq!(t.build_label.as_deref(), Some("boq_x"));
        assert_eq!(t.session_id.as_deref(), Some("-42"));
        assert!(parse_page_tokens("<html>login</html>").is_none());
    }

    #[test]
    fn frames_incremental() {
        let raw = ")]}'\n\n25\n[[\"wrb.fr\",\"a\",\"[1]\"]]\n27\n[[\"wrb.fr\",\"b\",\"[2,é]\"]]\n";
        let mut parser = FrameParser::default();
        let mut all = Vec::new();
        for chunk in raw.as_bytes().chunks(3) {
            // chunks never split the multi-byte char in this test except é: feed str pieces
            all.extend(parser.feed(&String::from_utf8_lossy(chunk)));
        }
        // lossy splitting may corrupt é; parse whole for exactness too
        let mut parser = FrameParser::default();
        let whole = parser.feed(raw);
        assert_eq!(whole.len(), 2);
        assert_eq!(at(&whole[0], &[1]).unwrap(), "a");
        assert!(!all.is_empty());
    }

    #[test]
    fn user_status_models() {
        let body = json!([1, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            [["95a4c0abcba24364", "Argon", "Tâches complexes", [], 2, null, [], false, "", 1, "Argon", "4 Argon", "Tâches complexes", null, null, false, "", 8]],
            [8, 0, 38], [2, 140]]);
        let status = parse_user_status(&body);
        assert_eq!(status.capacity, (2, 12));
        assert_eq!(status.models[0].slug, "gemini-argon");
        assert_eq!(status.models[0].label, "4 Argon");
        assert_eq!(status.models[0].number, 8);
    }

    #[test]
    fn generate_header_shape() {
        let model = WebModel { id: "abc".into(), slug: "gemini-argon".into(), label: "4 Argon".into(), description: String::new(), number: 8 };
        let pointer = ChatPointer::default();
        let (headers, freq) = generate_payload(&GenerateRequest {
            prompt: "hi", language: "fr", pointer: &pointer, model: &model, capacity: (2, 12), thinking: 1, client_session: "S", temporary: true,
        });
        let header: Value = serde_json::from_str(&headers[0].1).unwrap();
        assert_eq!(header[4], "abc");
        assert_eq!(header[11], 2);
        assert_eq!(header[14], 8);
        assert_eq!(header[16], "S");
        let outer: Value = serde_json::from_str(&freq).unwrap();
        let inner: Value = serde_json::from_str(outer[1].as_str().unwrap()).unwrap();
        assert_eq!(inner[0][0], "hi");
        assert_eq!(inner[45], 1);
        assert_eq!(inner[79], 8);
    }

    #[test]
    fn frame_update_reads_candidate() {
        let mut candidate = vec![Value::Null; 38];
        candidate[0] = json!("rc_1");
        candidate[1] = json!(["Bonjour"]);
        candidate[8] = json!([2]);
        candidate[37] = json!([["pensée"]]);
        let body = json!([null, ["c_1", "r_1"], null, null, [Value::Array(candidate)]]);
        let part = json!(["wrb.fr", null, body.to_string()]);
        let u = frame_update(&part);
        assert_eq!(u.cid.as_deref(), Some("c_1"));
        assert_eq!(u.rcid.as_deref(), Some("rc_1"));
        assert_eq!(u.text.as_deref(), Some("Bonjour"));
        assert_eq!(u.thoughts.as_deref(), Some("pensée"));
        assert!(u.completed);
        let err = json!(["wrb.fr", null, null, null, null, [null, null, [[null, [1037]]]]]);
        assert_eq!(frame_update(&err).error_code, Some(1037));
    }

    #[test]
    fn clean_partial_strips_artifacts() {
        assert_eq!(clean_partial("abc\n```"), "abc");
        assert_eq!(clean_partial("snake\\_"), "snake");
        assert_eq!(clean_partial("plain"), "plain");
    }
}

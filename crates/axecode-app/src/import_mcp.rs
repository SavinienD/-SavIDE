//! serveurs MCP déclarés pour d'autres outils, repris ici.
//!
//! Sources : Claude Code (`~/.claude.json` : serveurs de l'utilisateur et du
//! projet ouvert ; `<projet>/.mcp.json`), Codex (`~/.codex/config.toml`,
//! `[mcp_servers.<nom>]`), Cursor (`~/.cursor/mcp.json`, `<projet>/.cursor/mcp.json`)
//! et VS Code (`<projet>/.vscode/mcp.json`, `mcp.json` du profil utilisateur).
//! `scanner` rend une liste SANS aucune valeur secrète (noms des variables et des
//! en-têtes seulement, arguments et adresses masqués) ; `importer` relit les
//! fichiers et ajoute les serveurs choisis à la configuration MCP.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

use crate::mcp::{McpEnvVar, McpHeader, McpServerConfig, McpSettings};

/// Valeur affichée à la place d'un secret.
pub const MASQUE: &str = "••••";

/// Un fichier de configuration d'un autre outil.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceMcp {
    /// `claude_code`, `codex`, `cursor` ou `vscode`.
    pub outil: &'static str,
    pub chemin: PathBuf,
    /// Forme courte affichée (`~/.claude.json`).
    pub libelle: String,
}

/// Un serveur trouvé, tel qu'il est montré (sans secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeurTrouve {
    /// Identifiant de la ligne : `<outil>|<fichier>|<nom>`.
    pub cle: String,
    pub nom: String,
    pub outil: String,
    pub fichier: String,
    /// `stdio` (commande) ou `http` (adresse).
    pub transport: String,
    /// Commande et arguments, secrets masqués.
    pub commande: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Noms des variables d'environnement (jamais leurs valeurs).
    pub variables: Vec<String>,
    /// Noms des en-têtes HTTP (jamais leurs valeurs).
    pub entetes: Vec<String>,
    /// Déjà configuré, ou même serveur qu'une ligne plus haut.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doublon: Option<String>,
    /// Le nom est déjà pris : impossible à importer tel quel.
    pub nom_pris: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avertissement: Option<String>,
}

/// Résultat d'un import.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMcp {
    pub settings: McpSettings,
    pub importes: Vec<String>,
    pub erreurs: Vec<String>,
}

/// Fichiers lus, dans l'ordre d'affichage (`workspace_root` absent : sources de l'utilisateur seulement).
pub fn sources(home: &Path, workspace_root: Option<&Path>, codex_home: Option<&Path>, vscode_user: Option<&Path>) -> Vec<SourceMcp> {
    let source = |outil, chemin: PathBuf, libelle: &str| SourceMcp { outil, chemin, libelle: libelle.to_string() };
    let mut out = vec![source("claude_code", home.join(".claude.json"), "~/.claude.json")];
    if let Some(ws) = workspace_root {
        out.push(source("claude_code", ws.join(".mcp.json"), ".mcp.json"));
    }
    out.push(match codex_home {
        Some(c) => source("codex", c.join("config.toml"), "$CODEX_HOME/config.toml"),
        None => source("codex", home.join(".codex").join("config.toml"), "~/.codex/config.toml"),
    });
    out.push(source("cursor", home.join(".cursor").join("mcp.json"), "~/.cursor/mcp.json"));
    if let Some(ws) = workspace_root {
        out.push(source("cursor", ws.join(".cursor").join("mcp.json"), ".cursor/mcp.json"));
        out.push(source("vscode", ws.join(".vscode").join("mcp.json"), ".vscode/mcp.json"));
    }
    if let Some(dir) = vscode_user {
        out.push(source("vscode", dir.join("mcp.json"), "mcp.json (VS Code)"));
    }
    out
}

/// Sources du poste : dossier personnel, `$CODEX_HOME`, profil de VS Code.
pub fn sources_du_poste(workspace_root: Option<&Path>) -> Vec<SourceMcp> {
    let Some(base) = directories::BaseDirs::new() else { return Vec::new() };
    let codex = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from);
    let vscode = base.config_dir().join("Code").join("User");
    sources(base.home_dir(), workspace_root, codex.as_deref(), Some(&vscode))
}

fn nom_outil(outil: &str) -> &'static str {
    match outil {
        "claude_code" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        _ => "VS Code",
    }
}

/// Un serveur tel que l'outil le décrit (vraies valeurs).
#[derive(Debug, Clone, Default)]
struct Brut {
    nom: String,
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    url: Option<String>,
    headers: Vec<(String, String)>,
    cwd: Option<String>,
    actif: bool,
    /// Variable d'environnement qui porte le jeton (Codex `bearer_token_env_var`).
    jeton_env: Option<String>,
}

fn chemin_cle(p: &str) -> String {
    let p = p.trim().replace('\\', "/");
    let p = p.strip_prefix("//?/").unwrap_or(&p);
    p.trim_end_matches('/').to_lowercase()
}

fn texte(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn paires(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| texte(v).map(|t| (k.clone(), t))).collect())
        .unwrap_or_default()
}

fn depuis_json(nom: &str, v: &Value) -> Option<Brut> {
    let o = v.as_object()?;
    let url = o.get("url").or_else(|| o.get("serverUrl")).and_then(Value::as_str).map(str::to_string);
    let command = o.get("command").and_then(Value::as_str).unwrap_or("").to_string();
    if command.is_empty() && url.is_none() {
        return None;
    }
    Some(Brut {
        nom: nom.to_string(),
        command,
        args: o.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(texte).collect()).unwrap_or_default(),
        env: paires(o.get("env")),
        url,
        headers: paires(o.get("headers")),
        cwd: o.get("cwd").and_then(Value::as_str).map(str::to_string),
        actif: !(o.get("disabled").and_then(Value::as_bool).unwrap_or(false) || o.get("enabled").and_then(Value::as_bool) == Some(false)),
        jeton_env: None,
    })
}

fn serveurs_json(map: Option<&Value>) -> Vec<Brut> {
    map.and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(nom, v)| depuis_json(nom, v)).collect())
        .unwrap_or_default()
}

fn lire_source(source: &SourceMcp, workspace_root: Option<&Path>) -> Vec<Brut> {
    let Ok(contenu) = std::fs::read_to_string(&source.chemin) else { return Vec::new() };
    if source.outil == "codex" {
        let Ok(table) = toml::from_str::<toml::Table>(&contenu) else { return Vec::new() };
        let Some(serveurs) = table.get("mcp_servers").and_then(toml::Value::as_table) else { return Vec::new() };
        return serveurs
            .iter()
            .filter_map(|(nom, v)| {
                let json = serde_json::to_value(v).ok()?;
                let mut brut = depuis_json(nom, &json)?;
                let o = json.as_object()?;
                brut.headers.extend(paires(o.get("http_headers")));
                // `env_http_headers` : nom d'en-tête → variable qui porte sa valeur.
                for (entete, var) in paires(o.get("env_http_headers")) {
                    brut.headers.push((entete, format!("${{{var}}}")));
                }
                brut.jeton_env = o.get("bearer_token_env_var").and_then(Value::as_str).map(str::to_string);
                Some(brut)
            })
            .collect();
    }
    let Ok(json) = serde_json::from_str::<Value>(&contenu) else { return Vec::new() };
    match source.libelle.as_str() {
        "~/.claude.json" => {
            let mut out = serveurs_json(json.get("mcpServers"));
            if let (Some(ws), Some(projets)) = (workspace_root, json.get("projects").and_then(Value::as_object)) {
                let cle = chemin_cle(&ws.display().to_string());
                if let Some((_, p)) = projets.iter().find(|(k, _)| chemin_cle(k) == cle) {
                    out.extend(serveurs_json(p.get("mcpServers")));
                }
            }
            out
        }
        _ if source.outil == "vscode" => serveurs_json(json.get("servers").or_else(|| json.get("mcp").and_then(|m| m.get("servers")))),
        _ => serveurs_json(json.get("mcpServers")),
    }
}

/// Indices d'arguments qui suivent un drapeau de secret (`--api-key VALEUR`).
fn drapeau_secret(arg: &str) -> bool {
    let a = arg.trim_start_matches('-').to_ascii_lowercase();
    arg.starts_with('-') && ["key", "token", "secret", "password", "passwd", "pwd", "auth", "credential", "bearer"].iter().any(|m| a.contains(m))
}

/// Une valeur qui ressemble à un jeton (préfixe connu, ou longue suite de lettres ET chiffres).
fn ressemble_a_un_secret(v: &str) -> bool {
    const PREFIXES: [&str; 12] = ["sk-", "ghp_", "gho_", "ghs_", "github_pat_", "xoxb-", "xoxp-", "glpat-", "AKIA", "AIza", "pk_", "ctx7sk-"];
    if PREFIXES.iter().any(|p| v.starts_with(p)) {
        return true;
    }
    let jeton = v.len() >= 24 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '+' | '/'));
    jeton && v.chars().any(|c| c.is_ascii_digit()) && v.chars().any(|c| c.is_ascii_alphabetic()) && !v.contains('/')
}

/// Masque mot de passe d'une adresse (`schéma://compte:secret@`) et paramètres sensibles.
fn masquer_url(u: &str) -> String {
    let mut out = u.to_string();
    if let Some(pos) = out.find("://") {
        let reste = &out[pos + 3..];
        let fin = reste.find(['/', '?', '#']).unwrap_or(reste.len());
        if let Some(arobase) = reste[..fin].rfind('@') {
            if let Some(deux_points) = reste[..arobase].find(':') {
                out = format!("{}{}:{}{}", &out[..pos + 3], &reste[..deux_points], MASQUE, &reste[arobase..]);
            }
        }
    }
    if let Some(q) = out.find('?') {
        let (base, requete) = out.split_at(q + 1);
        let masque: Vec<String> = requete
            .split('&')
            .map(|p| match p.split_once('=') {
                Some((k, v)) if !v.is_empty() && (drapeau_secret(&format!("-{k}")) || ressemble_a_un_secret(v)) => format!("{k}={MASQUE}"),
                _ => p.to_string(),
            })
            .collect();
        out = format!("{base}{}", masque.join("&"));
    }
    out
}

fn masquer_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut suivant = false;
    for a in args {
        if suivant && !a.starts_with('-') {
            out.push(MASQUE.to_string());
            suivant = false;
            continue;
        }
        suivant = false;
        if let Some((k, v)) = a.split_once('=').filter(|(k, _)| k.starts_with('-')) {
            if drapeau_secret(k) || ressemble_a_un_secret(v) {
                out.push(format!("{k}={MASQUE}"));
                continue;
            }
        }
        if drapeau_secret(a) && !a.contains('=') {
            suivant = true;
            out.push(a.clone());
        } else if a.contains("://") {
            out.push(masquer_url(a));
        } else if ressemble_a_un_secret(a) {
            out.push(MASQUE.to_string());
        } else {
            out.push(a.clone());
        }
    }
    out
}

/// Identité d'un serveur pour repérer un doublon : commande + arguments, ou adresse.
fn identite(command: &str, args: &[String], url: Option<&str>) -> String {
    match url.filter(|u| !u.trim().is_empty()) {
        Some(u) => format!("url:{}", u.trim().trim_end_matches('/').to_lowercase()),
        None => format!("cmd:{} {}", command.trim(), args.join(" ")),
    }
}

fn avertissement(b: &Brut, outil: &str) -> Option<String> {
    let mut notes = Vec::new();
    if !b.actif {
        notes.push(format!("désactivé dans {}", nom_outil(outil)));
    }
    if let Some(var) = &b.jeton_env {
        let present = std::env::var(var).is_ok_and(|v| !v.is_empty());
        notes.push(if present { format!("jeton lu dans la variable {var}") } else { format!("jeton attendu dans la variable {var} (absente) : à renseigner") });
    }
    let valeurs = b.args.iter().chain(b.env.iter().map(|(_, v)| v)).chain(b.headers.iter().map(|(_, v)| v));
    if valeurs.clone().any(|v| v.contains("${input:")) {
        notes.push("valeur demandée par VS Code (${input:…}) : à saisir dans Réglages > MCP".into());
    } else if valeurs.clone().any(|v| v.contains("${")) {
        notes.push("variables ${…} remplacées par celles de l'environnement".into());
    }
    (!notes.is_empty()).then(|| notes.join(" ; "))
}

/// Serveurs trouvés, comparés à la configuration MCP.
pub fn scanner(sources: &[SourceMcp], workspace_root: Option<&Path>, actuels: &McpSettings) -> Vec<ServeurTrouve> {
    let mut out: Vec<ServeurTrouve> = Vec::new();
    let mut vus: Vec<(String, String, String)> = Vec::new(); // (identité, nom, outil)
    for source in sources {
        for b in lire_source(source, workspace_root) {
            let id = identite(&b.command, &b.args, b.url.as_deref());
            let pris = actuels.servers.iter().find(|s| s.name.eq_ignore_ascii_case(&b.nom));
            let meme = actuels.servers.iter().find(|s| identite(&s.command, &s.args, s.url.as_deref()) == id);
            let doublon = match (pris.or(meme), vus.iter().find(|(i, _, _)| *i == id)) {
                (Some(s), _) => Some(format!("déjà configuré (« {} »)", s.name)),
                (None, Some((_, nom, outil))) => Some(format!("même serveur que « {nom} » ({})", nom_outil(outil))),
                _ => None,
            };
            vus.push((id, b.nom.clone(), source.outil.to_string()));
            let commande = if b.url.is_some() && b.command.is_empty() {
                String::new()
            } else {
                std::iter::once(b.command.clone()).chain(masquer_args(&b.args)).collect::<Vec<_>>().join(" ")
            };
            out.push(ServeurTrouve {
                cle: format!("{}|{}|{}", source.outil, source.libelle, b.nom),
                nom: b.nom.clone(),
                outil: source.outil.to_string(),
                fichier: source.libelle.clone(),
                transport: if b.url.is_some() && b.command.is_empty() { "http".into() } else { "stdio".into() },
                commande,
                url: b.url.as_deref().map(masquer_url),
                variables: b.env.iter().map(|(k, _)| k.clone()).collect(),
                entetes: b.headers.iter().map(|(k, _)| k.clone()).collect(),
                doublon,
                nom_pris: pris.is_some(),
                avertissement: avertissement(&b, source.outil),
            });
        }
    }
    out
}

/// Remplace `${workspaceFolder}`, `${userHome}`, `${VAR}`, `${env:VAR}` et
/// `${VAR:-défaut}` ; `${input:…}` (demandé par VS Code) reste tel quel.
fn developper(v: &str, workspace_root: Option<&Path>) -> String {
    let mut out = String::new();
    let mut reste = v;
    while let Some(debut) = reste.find("${") {
        out.push_str(&reste[..debut]);
        let Some(fin) = reste[debut..].find('}') else {
            out.push_str(&reste[debut..]);
            return out;
        };
        let nom = &reste[debut + 2..debut + fin];
        let (var, defaut) = match nom.split_once(":-") {
            Some((v, d)) => (v, Some(d)),
            None => (nom, None),
        };
        let valeur = match var {
            "workspaceFolder" | "workspaceRoot" => workspace_root.map(|w| w.display().to_string()),
            "userHome" => directories::BaseDirs::new().map(|b| b.home_dir().display().to_string()),
            _ if var.starts_with("input:") => None,
            _ => std::env::var(var.strip_prefix("env:").unwrap_or(var)).ok().filter(|v| !v.is_empty()).or(defaut.map(str::to_string)),
        };
        match valeur {
            Some(val) => out.push_str(&val),
            None => out.push_str(&reste[debut..debut + fin + 1]),
        }
        reste = &reste[debut + fin + 1..];
    }
    out.push_str(reste);
    out
}

fn slug(nom: &str) -> String {
    let s: String = nom.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let s = s.split('_').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("_");
    if s.is_empty() { "server".into() } else { s }
}

/// Ajoute les serveurs choisis (par `cle`) à la configuration.
pub fn importer(sources: &[SourceMcp], workspace_root: Option<&Path>, actuels: &McpSettings, cles: &[String]) -> Result<ImportMcp> {
    let mut settings = actuels.clone();
    let mut importes = Vec::new();
    let mut erreurs = Vec::new();
    for source in sources {
        for b in lire_source(source, workspace_root) {
            let cle = format!("{}|{}|{}", source.outil, source.libelle, b.nom);
            if !cles.contains(&cle) {
                continue;
            }
            if settings.servers.iter().any(|s| s.name.eq_ignore_ascii_case(&b.nom)) {
                erreurs.push(format!("{} ({}) : nom déjà pris", b.nom, nom_outil(source.outil)));
                continue;
            }
            let mut id = format!("mcp_{}", slug(&b.nom));
            let mut n = 2;
            while settings.servers.iter().any(|s| s.id == id) {
                id = format!("mcp_{}_{n}", slug(&b.nom));
                n += 1;
            }
            let dev = |v: &str| developper(v, workspace_root);
            let mut headers: Vec<McpHeader> = b.headers.iter().map(|(k, v)| McpHeader { key: k.clone(), value: dev(v) }).collect();
            if let Some(jeton) = b.jeton_env.as_deref().and_then(|v| std::env::var(v).ok()).filter(|v| !v.is_empty()) {
                headers.push(McpHeader { key: "Authorization".into(), value: format!("Bearer {jeton}") });
            }
            let http = b.url.is_some() && b.command.is_empty();
            settings.servers.push(McpServerConfig {
                id,
                name: b.nom.clone(),
                command: if http { String::new() } else { dev(&b.command) },
                url: b.url.as_deref().map(dev),
                args: b.args.iter().map(|a| dev(a)).collect(),
                env: b.env.iter().map(|(k, v)| McpEnvVar { key: k.clone(), value: dev(v) }).collect(),
                headers,
                auth: None,
                cwd: b.cwd.as_deref().map(dev),
                enabled: b.actif,
            });
            importes.push(b.nom.clone());
        }
    }
    Ok(ImportMcp { settings, importes, erreurs })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Banc {
        home: PathBuf,
        ws: PathBuf,
    }

    fn banc(nom: &str) -> Banc {
        let base = std::env::temp_dir().join(format!("test-import-mcp-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (home, ws) = (base.join("home"), base.join("projet"));
        for d in [home.join(".codex"), home.join(".cursor"), ws.join(".vscode"), ws.join(".cursor"), home.join("vscode-user")] {
            std::fs::create_dir_all(d).unwrap();
        }
        Banc { home, ws }
    }

    fn ecrire(p: &Path, texte: &str) {
        std::fs::write(p, texte).unwrap();
    }

    fn sources_banc(b: &Banc) -> Vec<SourceMcp> {
        sources(&b.home, Some(&b.ws), None, Some(&b.home.join("vscode-user")))
    }

    fn remplir(b: &Banc) {
        let ws = b.ws.display().to_string().replace('\\', "\\\\");
        ecrire(
            &b.home.join(".claude.json"),
            &format!(
                r#"{{"numStartups": 3, "mcpServers": {{"github": {{"type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {{"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_SECRETSECRETSECRET1234"}}}}}},
                "projects": {{"{ws}": {{"mcpServers": {{"base": {{"command": "uvx", "args": ["mcp-server-postgres", "postgres://admin:motdepasse@db:5432/app"]}}}}}}, "/autre": {{"mcpServers": {{"ailleurs": {{"command": "x"}}}}}}}}}}"#
            ),
        );
        ecrire(&b.ws.join(".mcp.json"), r#"{"mcpServers": {"sentry": {"type": "http", "url": "https://mcp.sentry.dev/mcp?token=abc123secret", "headers": {"Authorization": "Bearer sk-abcdefghijklmnopqrstuv"}}}}"#);
        ecrire(
            &b.home.join(".codex/config.toml"),
            "model = \"o3\"\n\n[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\", \"--api-key\", \"ctx7sk-0123456789abcdef\"]\n\n[mcp_servers.docs]\nurl = \"https://docs.exemple.fr/mcp\"\nbearer_token_env_var = \"DOCS_TOKEN\"\nenabled = false\n\n[mcp_servers.docs.http_headers]\n\"X-Equipe\" = \"alpha\"\n",
        );
        ecrire(&b.home.join(".cursor/mcp.json"), r#"{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}, "fetch": {"command": "uvx", "args": ["mcp-server-fetch"]}}}"#);
        ecrire(
            &b.ws.join(".vscode/mcp.json"),
            r#"{"inputs": [{"id": "cle", "type": "promptString", "password": true}], "servers": {"playwright": {"type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest", "--output-dir", "${workspaceFolder}/sorties"], "env": {"CLE": "${input:cle}"}}}}"#,
        );
    }

    #[test]
    fn sources_des_quatre_outils_dans_l_ordre() {
        let b = banc("sources");
        let libelles: Vec<(&str, String)> = sources_banc(&b).iter().map(|s| (s.outil, s.libelle.clone())).collect();
        assert_eq!(
            libelles,
            vec![
                ("claude_code", "~/.claude.json".to_string()),
                ("claude_code", ".mcp.json".to_string()),
                ("codex", "~/.codex/config.toml".to_string()),
                ("cursor", "~/.cursor/mcp.json".to_string()),
                ("cursor", ".cursor/mcp.json".to_string()),
                ("vscode", ".vscode/mcp.json".to_string()),
                ("vscode", "mcp.json (VS Code)".to_string()),
            ]
        );
        assert!(sources(&b.home, None, None, None).iter().all(|s| !s.chemin.starts_with(&b.ws)), "sans dossier : sources de l'utilisateur seulement");
    }

    #[test]
    fn scanner_trouve_tout_sans_jamais_montrer_un_secret() {
        let b = banc("scan");
        remplir(&b);
        let actuels = McpSettings { servers: vec![] };
        let liste = scanner(&sources_banc(&b), Some(&b.ws), &actuels);
        let noms: Vec<(&str, &str)> = liste.iter().map(|s| (s.outil.as_str(), s.nom.as_str())).collect();
        assert_eq!(
            noms,
            // Ordre des fichiers, puis des noms dans chaque fichier.
            vec![("claude_code", "github"), ("claude_code", "base"), ("claude_code", "sentry"), ("codex", "context7"), ("codex", "docs"), ("cursor", "fetch"), ("cursor", "github"), ("vscode", "playwright")]
        );
        let un = |outil: &str, nom: &str| liste.iter().find(|s| s.outil == outil && s.nom == nom).unwrap().clone();
        let texte = serde_json::to_string(&liste).unwrap();
        for secret in ["ghp_SECRET", "motdepasse", "abc123secret", "sk-abcdef", "ctx7sk-0123"] {
            assert!(!texte.contains(secret), "secret affiché : {secret} dans {texte}");
        }
        let gh = &liste[0];
        assert_eq!((gh.transport.as_str(), gh.variables.clone()), ("stdio", vec!["GITHUB_PERSONAL_ACCESS_TOKEN".to_string()]));
        assert_eq!(gh.commande, "npx -y @modelcontextprotocol/server-github");
        assert!(liste[1].commande.contains("postgres://admin:••••@db:5432/app"), "{}", liste[1].commande);
        let sentry = &liste[2];
        assert_eq!((sentry.transport.as_str(), sentry.entetes.clone()), ("http", vec!["Authorization".to_string()]));
        assert_eq!(sentry.url.as_deref(), Some("https://mcp.sentry.dev/mcp?token=••••"));
        assert!(liste[3].commande.ends_with("--api-key ••••"), "{}", liste[3].commande);
        assert!(liste[4].avertissement.as_deref().unwrap_or("").contains("DOCS_TOKEN"));
        assert_eq!(un("cursor", "github").doublon.as_deref(), Some("même serveur que « github » (Claude Code)"));
        assert_eq!(un("cursor", "fetch").doublon, None);
        assert!(un("vscode", "playwright").avertissement.as_deref().unwrap_or("").contains("VS Code"), "${{input:…}} signalé");
        assert!(liste.iter().all(|s| s.nom != "ailleurs"), "serveurs d'un autre projet ignorés");
    }

    #[test]
    fn deja_configure_signale_et_nom_pris_bloque() {
        let b = banc("doublons");
        remplir(&b);
        let actuels = McpSettings {
            servers: vec![
                McpServerConfig { id: "mcp_fetch".into(), name: "Fetch".into(), command: "uvx".into(), url: None, args: vec!["mcp-server-fetch".into()], env: vec![], headers: vec![], auth: None, cwd: None, enabled: true },
                McpServerConfig { id: "mcp_gh".into(), name: "Mon GitHub".into(), command: "npx".into(), url: None, args: vec!["-y".into(), "@modelcontextprotocol/server-github".into()], env: vec![], headers: vec![], auth: None, cwd: None, enabled: true },
            ],
        };
        let liste = scanner(&sources_banc(&b), Some(&b.ws), &actuels);
        let fetch = liste.iter().find(|s| s.nom == "fetch").unwrap();
        assert!(fetch.nom_pris && fetch.doublon.as_deref() == Some("déjà configuré (« Fetch »)"));
        let gh = liste.iter().find(|s| s.nom == "github" && s.outil == "claude_code").unwrap();
        assert!(!gh.nom_pris && gh.doublon.as_deref() == Some("déjà configuré (« Mon GitHub »)"));
    }

    #[test]
    fn importer_ajoute_les_serveurs_choisis_avec_leurs_vraies_valeurs() {
        let b = banc("import");
        remplir(&b);
        let actuels = McpSettings { servers: vec![McpServerConfig { id: "mcp_fetch".into(), name: "fetch".into(), command: "uvx".into(), url: None, args: vec![], env: vec![], headers: vec![], auth: None, cwd: None, enabled: true }] };
        let src = sources_banc(&b);
        let liste = scanner(&src, Some(&b.ws), &actuels);
        let cle = |outil: &str, nom: &str| liste.iter().find(|s| s.outil == outil && s.nom == nom).unwrap().cle.clone();
        let choix = vec![cle("claude_code", "github"), cle("claude_code", "sentry"), cle("codex", "docs"), cle("vscode", "playwright"), cle("cursor", "fetch"), cle("cursor", "github")];
        let r = importer(&src, Some(&b.ws), &actuels, &choix).unwrap();
        assert_eq!(r.importes, vec!["github", "sentry", "docs", "playwright"]);
        assert_eq!(r.erreurs.len(), 2, "{:?}", r.erreurs);
        assert!(r.erreurs.iter().all(|e| e.contains("nom déjà pris")));
        let s = |nom: &str| r.settings.servers.iter().find(|s| s.name == nom).unwrap().clone();
        assert_eq!(r.settings.servers.len(), 5);
        let gh = s("github");
        assert_eq!((gh.id.as_str(), gh.command.as_str()), ("mcp_github", "npx"));
        assert_eq!(gh.env[0].value, "ghp_SECRETSECRETSECRET1234", "la vraie valeur est reprise");
        let sentry = s("sentry");
        assert_eq!(sentry.url.as_deref(), Some("https://mcp.sentry.dev/mcp?token=abc123secret"));
        assert_eq!(sentry.headers[0].value, "Bearer sk-abcdefghijklmnopqrstuv");
        let docs = s("docs");
        assert!(!docs.enabled, "désactivé dans Codex : reste désactivé");
        assert_eq!(docs.headers.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(), vec!["X-Equipe"]);
        let pw = s("playwright");
        assert_eq!(pw.args[2], format!("{}/sorties", b.ws.display()), "${{workspaceFolder}} remplacé");
        assert_eq!(pw.env[0].value, "${input:cle}", "valeur demandée par VS Code : gardée telle quelle");
    }
}

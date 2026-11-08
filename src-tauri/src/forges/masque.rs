//! Ce qui ne part jamais vers le modèle : fichiers de secrets (exclus en entier) et
//! valeurs qui ressemblent à des secrets dans un diff (masquées ligne à ligne).

/// Fichier dont le contenu ne quitte jamais le poste (clés, jetons, .env…).
pub(crate) fn fichier_secret(chemin: &str) -> bool {
    let nom = chemin
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(chemin)
        .to_ascii_lowercase();
    if nom == ".env" || (nom.starts_with(".env.") && !nom.ends_with(".example") && !nom.ends_with(".sample") && !nom.ends_with(".template") && !nom.ends_with(".dist")) {
        return true;
    }
    const NOMS: &[&str] = &[
        ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd",
        "credentials", "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml",
        "secrets.toml", "auth.json", "connection-secrets.json", "provider-keys.json",
    ];
    if NOMS.contains(&nom.as_str()) {
        return true;
    }
    const DEBUTS: &[&str] = &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "service-account"];
    if DEBUTS.iter().any(|d| nom.starts_with(d)) && !nom.ends_with(".pub") {
        return true;
    }
    const EXTENSIONS: &[&str] = &[
        ".pem", ".key", ".p12", ".pfx", ".kdbx", ".keystore", ".jks", ".gpg", ".asc", ".ppk",
    ];
    EXTENSIONS.iter().any(|e| nom.ends_with(e)) || nom.ends_with("-auth.json")
}

/// Fichier généré dont le contenu n'apprend rien au modèle (verrous, code minifié).
pub(crate) fn fichier_bruit(chemin: &str) -> bool {
    let nom = chemin
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(chemin)
        .to_ascii_lowercase();
    const NOMS: &[&str] = &[
        "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
        "cargo.lock", "poetry.lock", "pipfile.lock", "gemfile.lock", "composer.lock", "go.sum",
        "uv.lock", "flake.lock",
    ];
    NOMS.contains(&nom.as_str()) || nom.ends_with(".min.js") || nom.ends_with(".min.css") || nom.ends_with(".map")
}

const PREFIXES_JETONS: &[&str] = &[
    "github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-", "sk-ant-", "sk-proj-", "sk-",
    "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xapp-", "AKIA", "ASIA", "AIza", "ya29.", "npm_", "pypi-",
    "hf_", "shpat_", "sq0atp-", "rk_live_", "sk_live_", "pk_live_", "glsa_", "dop_v1_",
];

const MOTS_SENSIBLES: &[&str] = &[
    "password", "passwd", "secret", "token", "api_key", "apikey", "api-key", "access_key",
    "accesskey", "private_key", "privatekey", "client_secret", "mot_de_passe", "motdepasse",
    "credential", "auth_key", "bearer",
];

pub(crate) const MASQUE: &str = "[masqué]";

fn car_jeton(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn car_identifiant(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.')
}

/// Masque les secrets d'un texte (diff, journal). Rend le texte et le nombre de masques.
pub(crate) fn masquer(texte: &str) -> (String, u32) {
    let mut lignes: Vec<String> = Vec::new();
    let mut compte = 0;
    let mut dans_cle = false;
    for ligne in texte.split('\n') {
        if dans_cle {
            if ligne.contains("-----END") {
                dans_cle = false;
            }
            continue;
        }
        if ligne.contains("-----BEGIN") && ligne.contains("PRIVATE KEY") {
            let marque: String = ligne.chars().next().filter(|c| matches!(c, '+' | '-' | ' ')).into_iter().collect();
            lignes.push(format!("{marque}[clé privée masquée]"));
            compte += 1;
            dans_cle = !ligne.contains("-----END");
            continue;
        }
        let (propre, n) = masquer_ligne(ligne);
        compte += n;
        lignes.push(propre);
    }
    (lignes.join("\n"), compte)
}

fn masquer_ligne(ligne: &str) -> (String, u32) {
    let mut chars: Vec<char> = ligne.chars().collect();
    let mut compte = 0;
    compte += masquer_url(&mut chars);
    compte += masquer_jetons(&mut chars);
    compte += masquer_affectations(&mut chars);
    (chars.into_iter().collect(), compte)
}

fn remplacer(chars: &mut Vec<char>, debut: usize, fin: usize, par: &str) {
    chars.splice(debut..fin, par.chars());
}

/// https://utilisateur:motdepasse@hote → https://[masqué]@hote
fn masquer_url(chars: &mut Vec<char>) -> u32 {
    let mut compte = 0;
    let mut i = 0;
    while i + 3 <= chars.len() {
        if chars[i] == ':' && chars.get(i + 1) == Some(&'/') && chars.get(i + 2) == Some(&'/') {
            let debut = i + 3;
            let mut j = debut;
            let mut deux_points = false;
            let mut arobase = None;
            while j < chars.len() && !chars[j].is_whitespace() && !matches!(chars[j], '/' | '"' | '\'' | '`') {
                if chars[j] == ':' {
                    deux_points = true;
                }
                if chars[j] == '@' {
                    arobase = Some(j);
                }
                j += 1;
            }
            if let (true, Some(a)) = (deux_points, arobase) {
                let deja: String = chars[debut..a].iter().collect();
                if a > debut && deja != MASQUE && deja.contains(':') {
                    remplacer(chars, debut, a, MASQUE);
                    compte += 1;
                    i = debut + MASQUE.chars().count();
                    continue;
                }
            }
            i = j.max(i + 1);
            continue;
        }
        i += 1;
    }
    compte
}

fn masquer_jetons(chars: &mut Vec<char>) -> u32 {
    let mut compte = 0;
    let mut i = 0;
    while i < chars.len() {
        if i > 0 && car_jeton(chars[i - 1]) {
            i += 1;
            continue;
        }
        let mut trouve = None;
        for prefixe in PREFIXES_JETONS {
            let p: Vec<char> = prefixe.chars().collect();
            if chars.len() >= i + p.len() && chars[i..i + p.len()] == p[..] {
                let mut j = i + p.len();
                while j < chars.len() && (car_jeton(chars[j]) || chars[j] == '.') {
                    j += 1;
                }
                let corps = j - i - p.len();
                let assez = if prefixe.starts_with("AKIA") || prefixe.starts_with("ASIA") {
                    corps == 16 && chars[i + p.len()..j].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
                } else {
                    corps >= 16 && chars[i + p.len()..j].iter().any(|c| c.is_ascii_digit())
                };
                if assez {
                    trouve = Some(j);
                    break;
                }
            }
        }
        if let Some(fin) = trouve {
            remplacer(chars, i, fin, MASQUE);
            compte += 1;
            i += MASQUE.chars().count();
        } else {
            i += 1;
        }
    }
    compte
}

/// Valeur sans guillemets qui est du code, pas un secret : appel, type, chemin
/// d'attribut (props.secret), mot-clé, variable de l'environnement…
fn valeur_de_code(valeur: &str) -> bool {
    let bas = valeur.to_ascii_lowercase();
    if matches!(bas.as_str(), "true" | "false" | "null" | "none" | "undefined" | "nil") {
        return true;
    }
    if valeur.contains(['(', '<', '{']) || valeur.contains("::") || valeur.contains("->")
        || valeur.starts_with(['$', '&', '[', '*', '%'])
    {
        return true;
    }
    let mot = |s: &str| {
        let mut c = s.chars();
        matches!(c.next(), Some(p) if p.is_ascii_alphabetic() || p == '_')
            && c.all(|x| x.is_ascii_alphanumeric() || x == '_')
    };
    // a.b.c (attribut, module) ; Type (CamelCase sans chiffre).
    let morceaux: Vec<&str> = valeur.split('.').collect();
    if morceaux.len() > 1 && morceaux.iter().all(|m| mot(m)) && !valeur.chars().any(|c| c.is_ascii_digit()) {
        return true;
    }
    valeur.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && valeur.chars().all(|c| c.is_ascii_alphabetic())
        && valeur.chars().any(|c| c.is_ascii_lowercase())
}

/// mot_de_passe = "…", "apiKey": "…", TOKEN=… : la valeur est masquée, pas le nom.
fn masquer_affectations(chars: &mut Vec<char>) -> u32 {
    let mut compte = 0;
    let mut i = 0;
    while i < chars.len() {
        if !car_identifiant(chars[i]) || (i > 0 && car_identifiant(chars[i - 1])) {
            i += 1;
            continue;
        }
        let mut fin_id = i;
        while fin_id < chars.len() && car_identifiant(chars[fin_id]) {
            fin_id += 1;
        }
        let identifiant: String = chars[i..fin_id].iter().collect::<String>().to_lowercase();
        if !MOTS_SENSIBLES.iter().any(|m| identifiant.contains(m)) {
            i = fin_id;
            continue;
        }
        // Après le nom : guillemet fermant éventuel, espaces, « = », « : », « := » ou « => ».
        let mut j = fin_id;
        if j < chars.len() && matches!(chars[j], '"' | '\'') {
            j += 1;
        }
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        let signe = match (chars.get(j), chars.get(j + 1)) {
            (Some(':'), Some('=')) | (Some('='), Some('>')) => 2,
            (Some('='), Some('=')) => 0,
            (Some(':'), _) | (Some('='), _) => 1,
            _ => 0,
        };
        if signe == 0 {
            i = fin_id;
            continue;
        }
        j += signe;
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        let Some(&premier) = chars.get(j) else {
            i = fin_id;
            continue;
        };
        if matches!(premier, '"' | '\'' | '`') {
            let debut = j + 1;
            let Some(fin) = chars[debut..].iter().position(|c| *c == premier).map(|p| debut + p) else {
                i = fin_id;
                continue;
            };
            let valeur: String = chars[debut..fin].iter().collect();
            if fin - debut >= 6 && valeur != MASQUE && !valeur.starts_with("${") && !valeur.starts_with('<') {
                remplacer(chars, debut, fin, MASQUE);
                compte += 1;
                i = debut + MASQUE.chars().count() + 1;
                continue;
            }
            i = fin + 1;
            continue;
        }
        let debut = j;
        let mut fin = j;
        while fin < chars.len() && !chars[fin].is_whitespace() && !matches!(chars[fin], ',' | ';' | ')' | '}' | ']') {
            fin += 1;
        }
        let valeur: String = chars[debut..fin].iter().collect();
        if fin - debut >= 8 && !valeur_de_code(&valeur) && valeur != MASQUE {
            remplacer(chars, debut, fin, MASQUE);
            compte += 1;
            i = debut + MASQUE.chars().count();
            continue;
        }
        i = fin.max(fin_id);
    }
    compte
}

#[cfg(test)]
mod tests {
    use super::*;

    fn propre(texte: &str) -> String {
        masquer(texte).0
    }

    #[test]
    fn fichiers_de_secrets_reconnus() {
        for f in [".env", "app/.env.local", "certs/serveur.pem", "C:\\clefs\\id_rsa", "deploy.key", "x/provider-keys.json", "openai-auth.json"] {
            assert!(fichier_secret(f), "{f}");
        }
        for f in [".env.example", "src/token.rs", "id_rsa.pub", "README.md", "src/secretariat.ts"] {
            assert!(!fichier_secret(f), "{f}");
        }
        assert!(fichier_bruit("package-lock.json") && fichier_bruit("Cargo.lock") && !fichier_bruit("src/lock.rs"));
    }

    #[test]
    fn affectations_masquees_mais_pas_le_code() {
        assert_eq!(propre("+PASSWORD=hunter2hunter2"), "+PASSWORD=[masqué]");
        assert_eq!(propre(r#"+  "apiKey": "abcdef123456","#), r#"+  "apiKey": "[masqué]","#);
        assert_eq!(propre("+let mot_de_passe = 'correct horse';"), "+let mot_de_passe = '[masqué]';");
        assert_eq!(propre("+    client_secret: s3cr3t-valeur-longue"), "+    client_secret: [masqué]");
        assert_eq!(propre("+password: monmotdepasse"), "+password: [masqué]");
        for code in [
            "+let token = get_token();",
            "+if token == other {",
            "+const secret = props.secret;",
            "+    password: None,",
            "+token: String,",
            "+    password: Option<String>,",
            "+    token: TokenKind,",
            "+api_key: &str = \"\"",
        ] {
            assert_eq!(propre(code), code, "{code}");
        }
    }

    #[test]
    fn jetons_connus_masques() {
        let (t, n) = masquer("+const k = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789;\n+aws AKIAIOSFODNN7EXAMPLE fin");
        assert!(!t.contains("ghp_ABC") && !t.contains("AKIAIOSFODNN7EXAMPLE"), "{t}");
        assert_eq!(n, 2);
        let (t, _) = masquer("+Authorization: Bearer sk-ant-api03-abcdefghij0123456789xyz");
        assert!(!t.contains("abcdefghij0123456789"), "{t}");
        // Mots ordinaires qui commencent comme un préfixe : intacts.
        assert_eq!(propre("+ask-me-anything and sk-short"), "+ask-me-anything and sk-short");
    }

    #[test]
    fn cles_privees_et_urls_masquees() {
        let diff = "+a\n+-----BEGIN OPENSSH PRIVATE KEY-----\n+b3BlbnNzaC1rZXktdjEAAAAA\n+-----END OPENSSH PRIVATE KEY-----\n+fin";
        let (t, n) = masquer(diff);
        assert_eq!(t, "+a\n+[clé privée masquée]\n+fin");
        assert_eq!(n, 1);
        assert_eq!(
            propre("+url = https://camille:motdepasse@git.exemple.fr/depot.git"),
            "+url = https://[masqué]@git.exemple.fr/depot.git"
        );
        assert_eq!(propre("+voir https://exemple.fr/a:b@c"), "+voir https://exemple.fr/a:b@c");
    }

    #[test]
    fn texte_accentue_sans_panique() {
        let t = "+// é à ç ü — 日本語 token=  \"\"\n+secret";
        assert_eq!(propre(t), t);
    }
}

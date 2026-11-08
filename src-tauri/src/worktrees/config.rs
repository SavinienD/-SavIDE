//! Fichier de projet des worktrees : `worktrees.toml` à la racine du dépôt.
//! On lit aussi les scripts `setup` / `archive` d'un `orca.yaml` (seulement ces
//! deux clés, et seulement si `worktrees.toml` ne donne pas déjà le script).
//! Doc : docs/worktrees-toml.md.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub(crate) const FICHIER: &str = "worktrees.toml";
pub(crate) const FICHIER_ORCA: &str = "orca.yaml";
const TAILLE_MAX: u64 = 256 * 1024;
const MAX_CHEMINS: usize = 100;
const MAX_TERMINAUX: usize = 10;
const MAX_NOM_TERMINAL: usize = 48;

/// Réglages lus pour un dépôt (fichier absent = tout vide).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    /// Branche de départ indiquée par le fichier.
    pub(crate) base: Option<String>,
    /// Script lancé dans le nouveau worktree (une commande par ligne).
    pub(crate) script_creation: Option<String>,
    /// Script lancé avant la suppression ou l'archivage d'un worktree.
    pub(crate) script_suppression: Option<String>,
    /// Fichier d'où vient chaque script (worktrees.toml ou orca.yaml).
    pub(crate) source_creation: Option<String>,
    pub(crate) source_suppression: Option<String>,
    /// Chemins partagés par un lien (jonction sous Windows pour un dossier).
    pub(crate) liens: Vec<String>,
    /// Chemins copiés dans chaque nouveau worktree.
    pub(crate) copies: Vec<String>,
    /// Terminaux ouverts avec le worktree.
    pub(crate) terminaux: Vec<TerminalDefaut>,
    /// Fichiers trouvés à la racine du dépôt.
    pub(crate) fichiers: Vec<String>,
    /// Problèmes de lecture (fichier refusé, chemin refusé…), en français.
    pub(crate) erreurs: Vec<String>,
    /// Empreinte des commandes du projet (scripts + terminaux) : l'utilisateur
    /// les approuve une fois ; toute modification redemande son accord.
    pub(crate) empreinte: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalDefaut {
    pub(crate) nom: String,
    pub(crate) commande: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Brut {
    #[serde(alias = "baseRef", alias = "base_ref")]
    base: Option<String>,
    scripts: ScriptsBrut,
    #[serde(alias = "partages", alias = "shared")]
    partage: PartageBrut,
    #[serde(alias = "terminals")]
    terminaux: Vec<TerminalBrut>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ScriptsBrut {
    #[serde(alias = "setup")]
    creation: Option<Script>,
    #[serde(alias = "archive")]
    suppression: Option<Script>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Script {
    Texte(String),
    Lignes(Vec<String>),
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct PartageBrut {
    #[serde(alias = "links", alias = "sharedDirectories")]
    liens: Vec<String>,
    #[serde(alias = "copy")]
    copies: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalBrut {
    #[serde(default, alias = "name", alias = "title")]
    nom: Option<String>,
    #[serde(default, alias = "command")]
    commande: Option<String>,
}

/// Lit `worktrees.toml` (et les scripts d'`orca.yaml`) à la racine `racine`.
pub(crate) fn lire(racine: &Path) -> Config {
    let mut config = Config::default();
    if let Some(texte) = lire_fichier(&racine.join(FICHIER), FICHIER, &mut config.erreurs) {
        config.fichiers.push(FICHIER.to_string());
        match analyser_toml(&texte) {
            Ok(brut) => appliquer(&mut config, brut),
            Err(message) => config.erreurs.push(message),
        }
    }
    if let Some(texte) = lire_fichier(&racine.join(FICHIER_ORCA), FICHIER_ORCA, &mut config.erreurs) {
        config.fichiers.push(FICHIER_ORCA.to_string());
        let (setup, archive) = scripts_orca(&texte);
        if config.script_creation.is_none() {
            if let Some(script) = setup.and_then(|s| nettoyer_script(&s)) {
                config.script_creation = Some(script);
                config.source_creation = Some(FICHIER_ORCA.to_string());
            }
        }
        if config.script_suppression.is_none() {
            if let Some(script) = archive.and_then(|s| nettoyer_script(&s)) {
                config.script_suppression = Some(script);
                config.source_suppression = Some(FICHIER_ORCA.to_string());
            }
        }
    }
    config.empreinte = empreinte(&config);
    config
}

fn lire_fichier(chemin: &Path, nom: &str, erreurs: &mut Vec<String>) -> Option<String> {
    let meta = fs::metadata(chemin).ok()?;
    if !meta.is_file() {
        return None;
    }
    if meta.len() > TAILLE_MAX {
        erreurs.push(format!("{nom} : fichier trop gros (256 Ko au plus), ignoré"));
        return None;
    }
    match fs::read(chemin) {
        Ok(octets) => match String::from_utf8(octets) {
            Ok(texte) => Some(texte.trim_start_matches('\u{feff}').to_string()),
            Err(_) => {
                erreurs.push(format!("{nom} : le fichier n'est pas en UTF-8, ignoré"));
                None
            }
        },
        Err(err) => {
            erreurs.push(format!("{nom} : lecture impossible ({err})"));
            None
        }
    }
}

fn analyser_toml(texte: &str) -> Result<Brut, String> {
    toml::from_str::<Brut>(texte).map_err(|err| {
        let detail = err.to_string();
        let detail = detail.trim();
        format!("{FICHIER} invalide, ignoré : {detail}")
    })
}

fn appliquer(config: &mut Config, brut: Brut) {
    config.base = brut
        .base
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    if let Some(script) = brut.scripts.creation.and_then(script_texte) {
        config.script_creation = Some(script);
        config.source_creation = Some(FICHIER.to_string());
    }
    if let Some(script) = brut.scripts.suppression.and_then(script_texte) {
        config.script_suppression = Some(script);
        config.source_suppression = Some(FICHIER.to_string());
    }
    config.liens = chemins_valides(&brut.partage.liens, "liens", &mut config.erreurs);
    config.copies = chemins_valides(&brut.partage.copies, "copies", &mut config.erreurs);
    if brut.terminaux.len() > MAX_TERMINAUX {
        config.erreurs.push(format!(
            "terminaux : {MAX_TERMINAUX} au plus, les suivants sont ignorés"
        ));
    }
    config.terminaux = brut
        .terminaux
        .into_iter()
        .take(MAX_TERMINAUX)
        .enumerate()
        .map(|(i, t)| {
            let nom = t
                .nom
                .map(|n| n.trim().chars().take(MAX_NOM_TERMINAL).collect::<String>())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| format!("Terminal {}", i + 1));
            let commande = t
                .commande
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty());
            TerminalDefaut { nom, commande }
        })
        .collect();
}

fn script_texte(script: Script) -> Option<String> {
    match script {
        Script::Texte(texte) => nettoyer_script(&texte),
        Script::Lignes(lignes) => nettoyer_script(&lignes.join("\n")),
    }
}

/// Script sans fins de ligne Windows ni lignes vides au début ou à la fin.
pub(crate) fn nettoyer_script(texte: &str) -> Option<String> {
    let lignes: Vec<&str> = texte.lines().map(|l| l.trim_end()).collect();
    let debut = lignes.iter().position(|l| !l.trim().is_empty())?;
    let fin = lignes.iter().rposition(|l| !l.trim().is_empty())?;
    Some(lignes[debut..=fin].join("\n"))
}

/// Chemins relatifs au dépôt, sans `..`, sans chemin absolu ni `.git`.
fn chemins_valides(liste: &[String], cle: &str, erreurs: &mut Vec<String>) -> Vec<String> {
    let mut sortie: Vec<String> = Vec::new();
    for brut in liste.iter().take(MAX_CHEMINS) {
        match normaliser_chemin(brut) {
            Some(chemin) => {
                if !sortie.contains(&chemin) {
                    sortie.push(chemin);
                }
            }
            None => erreurs.push(format!(
                "partage.{cle} : « {} » refusé (chemin relatif au dépôt, sans « .. »)",
                brut.trim()
            )),
        }
    }
    if liste.len() > MAX_CHEMINS {
        erreurs.push(format!("partage.{cle} : {MAX_CHEMINS} chemins au plus"));
    }
    sortie
}

pub(crate) fn normaliser_chemin(brut: &str) -> Option<String> {
    let texte = brut.trim().replace('\\', "/");
    let texte = texte.trim_start_matches("./").trim_end_matches('/');
    if texte.is_empty()
        || texte.starts_with('/')
        || texte.contains(':')
        || texte.contains('*')
        || texte.contains('?')
    {
        return None;
    }
    let morceaux: Vec<&str> = texte.split('/').collect();
    if morceaux
        .iter()
        .any(|m| m.is_empty() || *m == "." || *m == ".." || m.eq_ignore_ascii_case(".git"))
    {
        return None;
    }
    Some(morceaux.join("/"))
}

/// Empreinte (SHA-256 abrégé) des commandes que le projet ferait lancer.
pub(crate) fn empreinte(config: &Config) -> Option<String> {
    let commandes_terminaux: Vec<String> = config
        .terminaux
        .iter()
        .filter_map(|t| t.commande.as_ref().map(|c| format!("{}\t{}", t.nom, c)))
        .collect();
    if config.script_creation.is_none()
        && config.script_suppression.is_none()
        && commandes_terminaux.is_empty()
    {
        return None;
    }
    let texte = format!(
        "creation:\n{}\nsuppression:\n{}\nterminaux:\n{}",
        config.script_creation.as_deref().unwrap_or(""),
        config.script_suppression.as_deref().unwrap_or(""),
        commandes_terminaux.join("\n")
    );
    let condensat = ring::digest::digest(&ring::digest::SHA256, texte.as_bytes());
    Some(
        condensat.as_ref()[..12]
            .iter()
            .map(|octet| format!("{octet:02x}"))
            .collect(),
    )
}

/// Scripts `scripts.setup` et `scripts.archive` d'un orca.yaml. Lecture
/// volontairement limitée : chaîne simple ou entre guillemets, bloc `|` / `>`,
/// ou liste `- commande`. Le reste du fichier est ignoré.
pub(crate) fn scripts_orca(texte: &str) -> (Option<String>, Option<String>) {
    let lignes: Vec<&str> = texte.lines().collect();
    let mut setup = None;
    let mut archive = None;
    let mut i = 0;
    while i < lignes.len() {
        let ligne = lignes[i];
        if indentation(ligne) == 0 && sans_commentaire(ligne).trim_end() == "scripts:" {
            i += 1;
            let mut indent_cles: Option<usize> = None;
            while i < lignes.len() {
                let ligne = lignes[i];
                let utile = sans_commentaire(ligne);
                if utile.trim().is_empty() {
                    i += 1;
                    continue;
                }
                let ind = indentation(ligne);
                if ind == 0 {
                    break;
                }
                let attendu = *indent_cles.get_or_insert(ind);
                if ind != attendu {
                    i += 1;
                    continue;
                }
                let Some((cle, reste)) = utile.trim().split_once(':') else {
                    i += 1;
                    continue;
                };
                let (valeur, suivant) = valeur_yaml(&lignes, i + 1, attendu, reste.trim());
                match cle.trim() {
                    "setup" => setup = valeur,
                    "archive" => archive = valeur,
                    _ => {}
                }
                i = suivant;
            }
            continue;
        }
        i += 1;
    }
    (setup, archive)
}

fn indentation(ligne: &str) -> usize {
    ligne.len() - ligne.trim_start_matches([' ', '\t']).len()
}

/// Retire un commentaire ` # …` de fin de ligne (hors guillemets).
fn sans_commentaire(ligne: &str) -> &str {
    let mut simple = false;
    let mut double = false;
    let mut precedent = ' ';
    for (i, c) in ligne.char_indices() {
        match c {
            '\'' if !double => simple = !simple,
            '"' if !simple => double = !double,
            '#' if !simple && !double && (precedent == ' ' || precedent == '\t' || i == 0) => {
                return &ligne[..i];
            }
            _ => {}
        }
        precedent = c;
    }
    ligne
}

/// Valeur d'une clé dont le texte après « : » est `reste` ; renvoie aussi
/// l'indice de la première ligne qui ne lui appartient pas.
fn valeur_yaml(lignes: &[&str], debut: usize, indent_cle: usize, reste: &str) -> (Option<String>, usize) {
    // Lignes plus indentées que la clé (ou vides) : contenu de la valeur.
    let mut fin = debut;
    while fin < lignes.len() {
        let ligne = lignes[fin];
        if !ligne.trim().is_empty() && indentation(ligne) <= indent_cle {
            break;
        }
        fin += 1;
    }
    let bloc = &lignes[debut..fin];
    if reste.starts_with('|') || reste.starts_with('>') {
        let plie = reste.starts_with('>');
        let marge = bloc
            .iter()
            .filter(|l| !l.trim().is_empty())
            .map(|l| indentation(l))
            .min()
            .unwrap_or(0);
        let corps: Vec<String> = bloc
            .iter()
            .map(|l| if l.len() >= marge { l[marge..].trim_end().to_string() } else { String::new() })
            .collect();
        let texte = if plie { plier(&corps) } else { corps.join("\n") };
        return (nettoyer_script(&texte), fin);
    }
    if reste.is_empty() {
        let elements: Vec<String> = bloc
            .iter()
            .map(|l| sans_commentaire(l).trim())
            .filter_map(|l| l.strip_prefix("- ").or_else(|| (l == "-").then_some("")))
            .map(|l| sans_guillemets(l.trim()))
            .filter(|l| !l.is_empty())
            .collect();
        return (nettoyer_script(&elements.join("\n")), fin);
    }
    (nettoyer_script(&sans_guillemets(reste)), fin)
}

fn plier(lignes: &[String]) -> String {
    let mut sortie = String::new();
    for ligne in lignes {
        if ligne.is_empty() {
            sortie.push('\n');
        } else {
            if !sortie.is_empty() && !sortie.ends_with('\n') {
                sortie.push(' ');
            }
            sortie.push_str(ligne);
        }
    }
    sortie
}

fn sans_guillemets(valeur: &str) -> String {
    let v = valeur.trim();
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        let interieur = &v[1..v.len() - 1];
        let mut sortie = String::new();
        let mut car = interieur.chars();
        while let Some(c) = car.next() {
            if c == '\\' {
                match car.next() {
                    Some('n') => sortie.push('\n'),
                    Some('t') => sortie.push('\t'),
                    Some(autre) => sortie.push(autre),
                    None => {}
                }
            } else {
                sortie.push(c);
            }
        }
        return sortie;
    }
    v.to_string()
}

/// Fichier de départ proposé quand le dépôt n'a pas encore de worktrees.toml :
/// il partage ce qui existe déjà (node_modules, .env).
pub(crate) fn modele(racine: &Path) -> String {
    let existe = |nom: &str| racine.join(nom).exists();
    let liens: Vec<&str> = ["node_modules"].into_iter().filter(|n| existe(n)).collect();
    let copies: Vec<&str> = [".env", ".env.local"].into_iter().filter(|n| existe(n)).collect();
    let liste = |v: &[&str]| v.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", ");
    let mut texte = String::from(
        "# Réglages des worktrees de ce dépôt.\n\
         # Branche de départ des nouveaux worktrees (sinon : la branche principale).\n\
         # base = \"main\"\n\n\
         [scripts]\n\
         # Lancé dans chaque nouveau worktree, une commande par ligne (arrêt à la première erreur).\n\
         # creation = \"npm install\"\n\
         # Lancé avant la suppression ou l'archivage d'un worktree.\n\
         # suppression = \"\"\n\n\
         [partage]\n\
         # Partagés avec le dépôt principal par un lien (jonction sous Windows) : à ignorer dans git.\n",
    );
    texte.push_str(&format!("liens = [{}]\n", liste(&liens)));
    texte.push_str("# Copiés dans chaque nouveau worktree.\n");
    texte.push_str(&format!("copies = [{}]\n\n", liste(&copies)));
    texte.push_str(
        "# Terminaux ouverts avec le worktree.\n\
         # [[terminaux]]\n\
         # nom = \"Serveur\"\n\
         # commande = \"npm run dev\"\n",
    );
    texte
}

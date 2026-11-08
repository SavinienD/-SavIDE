//! skills de Claude Code et de Codex repris dans le harnais.
//!
//! Dossiers lus : `~/.claude/skills`, `<projet>/.claude/skills` (Claude Code),
//! `~/.codex/skills` (Codex, ou `$CODEX_HOME/skills`) et `~/.agents/skills`
//! (format Agent Skills). Chaque sous-dossier avec un `SKILL.md` est un skill.
//! L'import COPIE le skill dans le harnais (SKILL.md → corps Markdown, fichiers
//! voisins → dossier du paquet) et note sa source dans `.origine.json` : si la
//! source change ensuite, une mise à jour est proposée.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::model::{parse_file, slugify, Entry, EntryKind, EntryPatch, NewEntry, Scope};
use crate::store::{HarnessStore, SKILL_FILE_NAME, SKILL_INIT_FILE_NAME};

/// Fichier de la source d'un skill repris (dans le dossier du paquet).
pub const ORIGINE_FICHIER: &str = ".origine.json";
/// Fichiers copiés au plus par skill (SKILL.md non compté).
pub const MAX_FICHIERS: usize = 200;
/// Taille totale copiée au plus par skill.
pub const MAX_OCTETS: u64 = 5 * 1024 * 1024;

/// Outil d'où vient un skill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outil {
    ClaudeCode,
    Codex,
    Agents,
    Url,
}

impl Outil {
    pub fn as_str(self) -> &'static str {
        match self {
            Outil::ClaudeCode => "claude_code",
            Outil::Codex => "codex",
            Outil::Agents => "agents",
            Outil::Url => "url",
        }
    }
}

/// Un dossier de skills d'un autre outil.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RacineExterne {
    pub outil: Outil,
    /// Portée donnée au skill importé (dossier de l'utilisateur → global).
    pub portee: Scope,
    pub chemin: PathBuf,
    /// Forme courte affichée (`~/.claude/skills`).
    pub libelle: String,
}

/// Source notée d'un skill repris (`.origine.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origine {
    /// `dossier` (copie d'un dossier local) ou `url` (installé depuis une adresse).
    pub genre: String,
    pub outil: String,
    /// Dossier source (genre `dossier`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chemin: Option<String>,
    /// Adresse git ou .zip (genre `url`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Sous-dossier du skill dans le dépôt ou l'archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sous_dossier: Option<String>,
    /// Version lisible : commit git, empreinte de l'archive ou `version` du SKILL.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Empreinte du contenu copié (détecte une source modifiée).
    pub empreinte: String,
    pub importe_le: i64,
}

/// État d'un skill externe par rapport au harnais.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EtatImport {
    /// Pas encore dans le harnais.
    Nouveau,
    /// Déjà importé, identique.
    Importe,
    /// Déjà importé, la source a changé depuis.
    MiseAJour,
    /// Un autre skill du harnais porte déjà ce nom.
    Conflit,
}

/// Un skill trouvé dans un dossier d'un autre outil.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExterne {
    /// Dossier du skill (sert d'identifiant).
    pub chemin: String,
    /// Nom dans le harnais (paquet Python).
    pub nom: String,
    /// Nom donné par la source (`name:` du SKILL.md, sinon le dossier).
    pub nom_source: String,
    pub description: String,
    pub outil: Outil,
    pub portee: Scope,
    pub racine: String,
    pub fichiers: usize,
    pub octets: u64,
    pub empreinte: String,
    pub etat: EtatImport,
    /// Skill du harnais lié (importé, ou celui qui porte déjà le nom).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_harnais: Option<String>,
}

/// Dossiers de skills des autres outils, dans l'ordre d'affichage. `$CODEX_HOME`
/// remplace `~/.codex` quand il est défini (comme Codex lui-même).
pub fn racines(workspace_root: &Path, home: &Path) -> Vec<RacineExterne> {
    let codex_env = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from);
    let codex = codex_env.clone().unwrap_or_else(|| home.join(".codex"));
    let mut out = vec![
        RacineExterne { outil: Outil::ClaudeCode, portee: Scope::Global, chemin: home.join(".claude").join("skills"), libelle: "~/.claude/skills".into() },
        RacineExterne { outil: Outil::ClaudeCode, portee: Scope::Project, chemin: workspace_root.join(".claude").join("skills"), libelle: ".claude/skills".into() },
        RacineExterne {
            outil: Outil::Codex,
            portee: Scope::Global,
            chemin: codex.join("skills"),
            libelle: if codex_env.is_some() { "$CODEX_HOME/skills".into() } else { "~/.codex/skills".into() },
        },
        RacineExterne { outil: Outil::Agents, portee: Scope::Global, chemin: home.join(".agents").join("skills"), libelle: "~/.agents/skills".into() },
    ];
    // Dossier de travail = dossier personnel : `.claude/skills` n'est lu qu'une fois (global).
    let mut vus = std::collections::HashSet::new();
    out.retain(|r| vus.insert(canonique(&r.chemin)));
    out
}

fn canonique(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Contenu d'un dossier de skill, prêt à copier.
#[derive(Debug, Clone)]
pub struct SourceSkill {
    pub dossier: PathBuf,
    pub nom_source: String,
    pub nom: String,
    pub description: String,
    /// `version` du SKILL.md (ou `metadata.version`), s'il y en a une.
    pub version: Option<String>,
    /// Corps Markdown du SKILL.md, sans son en-tête.
    pub corps: String,
    /// Fichiers voisins (chemin relatif, chemin absolu), SKILL.md exclu.
    pub fichiers: Vec<(PathBuf, PathBuf)>,
    pub octets: u64,
    pub empreinte: String,
    /// Le parcours s'est arrêté : plus de [`MAX_FICHIERS`] fichiers.
    pub trop_de_fichiers: bool,
}

impl SourceSkill {
    /// Corps de l'entrée du harnais : la description d'abord (c'est elle que
    /// l'agent voit dans la liste des skills), puis le Markdown d'origine.
    pub fn corps_harnais(&self) -> String {
        match (self.description.trim(), self.corps.trim()) {
            ("", c) => c.to_string(),
            (d, "") => d.to_string(),
            (d, c) => format!("{d}\n\n{c}"),
        }
    }

    /// Refuse un skill trop gros pour être copié.
    pub fn verifier_taille(&self) -> Result<()> {
        if self.trop_de_fichiers || self.fichiers.len() > MAX_FICHIERS {
            bail!("trop de fichiers dans {} : {MAX_FICHIERS} fichiers au plus", self.dossier.display());
        }
        if self.octets > MAX_OCTETS {
            bail!("{} pèse {} Ko : {} Ko au plus", self.dossier.display(), self.octets / 1024, MAX_OCTETS / 1024);
        }
        Ok(())
    }
}

/// Lit un dossier de skill (`SKILL.md` + fichiers voisins).
pub fn lire_source(dossier: &Path) -> Result<SourceSkill> {
    let skill_md = dossier.join(SKILL_FILE_NAME);
    let texte = std::fs::read_to_string(&skill_md).with_context(|| format!("lecture de {}", skill_md.display()))?;
    let (champs, corps) = entete(&texte);
    let nom_dossier = dossier.file_name().and_then(|n| n.to_str()).unwrap_or("skill").to_string();
    let nom_source = champs.iter().find(|(k, _)| k == "name").map(|(_, v)| v.clone()).filter(|v| !v.is_empty()).unwrap_or(nom_dossier);
    let description = champs.iter().find(|(k, _)| k == "description").map(|(_, v)| v.clone()).unwrap_or_default();
    let version = champs.iter().find(|(k, _)| k == "version").map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
    let mut fichiers = Vec::new();
    let mut trop = false;
    parcourir(dossier, Path::new(""), &mut fichiers, &mut trop);
    fichiers.sort();
    let mut octets = texte.len() as u64;
    let mut h = Fnv::default();
    h.ecrire(SKILL_FILE_NAME.as_bytes());
    h.ecrire(texte.as_bytes());
    for (rel, abs) in &fichiers {
        let contenu = std::fs::read(abs).with_context(|| format!("lecture de {}", abs.display()))?;
        octets += contenu.len() as u64;
        h.ecrire(rel.to_string_lossy().replace('\\', "/").as_bytes());
        h.ecrire(&contenu);
    }
    Ok(SourceSkill {
        dossier: dossier.to_path_buf(),
        nom: slugify(&nom_source),
        nom_source,
        description,
        version,
        corps,
        fichiers,
        octets,
        empreinte: h.hex(),
        trop_de_fichiers: trop,
    })
}

/// Fichiers voisins du SKILL.md : ni dossiers cachés, ni caches, ni le paquet Python du harnais.
fn parcourir(dossier: &Path, rel: &Path, out: &mut Vec<(PathBuf, PathBuf)>, trop: &mut bool) {
    let Ok(lecture) = std::fs::read_dir(dossier) else { return };
    let mut items: Vec<_> = lecture.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for item in items {
        if *trop {
            return;
        }
        let nom = item.file_name().to_string_lossy().to_string();
        if nom.starts_with('.') || nom == "__pycache__" || nom == "node_modules" {
            continue;
        }
        let racine = rel.as_os_str().is_empty();
        if racine && (nom == SKILL_FILE_NAME || nom == SKILL_INIT_FILE_NAME) {
            continue;
        }
        let chemin = item.path();
        let relatif = rel.join(&nom);
        let Ok(genre) = item.file_type() else { continue };
        if genre.is_dir() {
            parcourir(&chemin, &relatif, out, trop);
        } else if genre.is_file() || chemin.is_file() {
            if out.len() >= MAX_FICHIERS {
                *trop = true;
                return;
            }
            out.push((relatif, chemin));
        }
    }
}

/// Champs simples de l'en-tête YAML d'un SKILL.md (`name`, `description`,
/// `version`, `metadata.version`), blocs `>` / `|` compris, et le corps.
fn entete(texte: &str) -> (Vec<(String, String)>, String) {
    let texte = texte.strip_prefix('\u{feff}').unwrap_or(texte);
    let parsed = parse_file(texte);
    let mut lignes = texte.lines();
    if lignes.next().map(str::trim) != Some("---") {
        return (Vec::new(), texte.trim().to_string());
    }
    let mut champs: Vec<(String, String)> = Vec::new();
    let entete: Vec<&str> = lignes.take_while(|l| l.trim() != "---").collect();
    let mut i = 0;
    while i < entete.len() {
        let ligne = entete[i];
        i += 1;
        let indente = ligne.starts_with(' ') || ligne.starts_with('\t');
        let Some((cle, valeur)) = ligne.trim().split_once(':') else { continue };
        let cle = cle.trim();
        let valeur = valeur.trim();
        let cle = match (indente, cle) {
            (false, "name" | "description" | "version") => cle.to_string(),
            (true, "version") => "version".to_string(),
            _ => continue,
        };
        let valeur = if matches!(valeur, ">" | ">-" | ">+" | "|" | "|-" | "|+") || (valeur.is_empty() && cle == "description") {
            let replie = valeur.starts_with('>') || valeur.is_empty();
            let mut bloc = Vec::new();
            while i < entete.len() && (entete[i].starts_with(' ') || entete[i].starts_with('\t') || entete[i].trim().is_empty()) {
                bloc.push(entete[i].trim());
                i += 1;
            }
            let sep = if replie { " " } else { "\n" };
            bloc.join(sep).trim().to_string()
        } else {
            sans_guillemets(valeur)
        };
        if !champs.iter().any(|(k, _)| *k == cle) {
            champs.push((cle, valeur));
        }
    }
    (champs, parsed.body.trim().to_string())
}

fn sans_guillemets(v: &str) -> String {
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        if let Ok(s) = serde_json::from_str::<String>(v) {
            return s;
        }
    }
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    v.to_string()
}

/// FNV-1a 64 bits : repère un contenu changé (pas une signature).
#[derive(Clone, Copy)]
struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
}

impl Fnv {
    fn ecrire(&mut self, octets: &[u8]) {
        for b in octets.iter().chain(&[0xff]) {
            self.0 ^= u64::from(*b);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    fn hex(self) -> String {
        format!("{:016x}", self.0)
    }
}

/// Empreinte courte (12 caractères) d'un contenu, pour une version lisible.
pub fn empreinte_octets(octets: &[u8]) -> String {
    let mut h = Fnv::default();
    h.ecrire(octets);
    h.hex()[..12].to_string()
}

/// Skills trouvés dans les dossiers des autres outils, avec leur état dans le harnais.
pub fn lister(store: &HarnessStore, racines: &[RacineExterne]) -> Vec<SkillExterne> {
    let harnais = store.list(Some(EntryKind::Skill), None).unwrap_or_default();
    let origines: Vec<(&Entry, Origine)> = harnais.iter().filter_map(|e| origine(e).map(|o| (e, o))).collect();
    let mut vus = std::collections::HashSet::new();
    let mut out = Vec::new();
    for racine in racines {
        let Ok(lecture) = std::fs::read_dir(&racine.chemin) else { continue };
        let mut dossiers: Vec<PathBuf> = lecture
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join(SKILL_FILE_NAME).is_file())
            .collect();
        dossiers.sort();
        for dossier in dossiers {
            if !vus.insert(canonique(&dossier)) {
                continue;
            }
            let Ok(source) = lire_source(&dossier) else { continue };
            let chemin = dossier.display().to_string();
            let lie = origines.iter().find(|(_, o)| o.genre == "dossier" && o.chemin.as_deref() == Some(chemin.as_str()));
            let (etat, id_harnais) = match lie {
                Some((e, o)) => (
                    if o.empreinte == source.empreinte { EtatImport::Importe } else { EtatImport::MiseAJour },
                    Some(e.meta.id.clone()),
                ),
                None => match harnais.iter().find(|e| e.meta.title == source.nom || e.meta.id == source.nom) {
                    Some(e) => (EtatImport::Conflit, Some(e.meta.id.clone())),
                    None => (EtatImport::Nouveau, None),
                },
            };
            out.push(SkillExterne {
                chemin,
                nom: source.nom.clone(),
                nom_source: source.nom_source.clone(),
                description: source.description.clone(),
                outil: racine.outil,
                portee: racine.portee,
                racine: racine.libelle.clone(),
                fichiers: source.fichiers.len() + 1,
                octets: source.octets,
                empreinte: source.empreinte.clone(),
                etat,
                id_harnais,
            });
        }
    }
    out
}

/// Copie un skill externe dans le harnais (portée donnée par sa racine).
pub fn importer(store: &HarnessStore, racines: &[RacineExterne], chemin: &Path) -> Result<Entry> {
    let parent = chemin.parent().map(canonique);
    let Some(racine) = racines.iter().find(|r| parent.as_deref() == Some(canonique(&r.chemin).as_path())) else {
        bail!("{} n'est pas dans un dossier de skills connu", chemin.display());
    };
    let source = lire_source(chemin)?;
    let origine = Origine {
        genre: "dossier".into(),
        outil: racine.outil.as_str().into(),
        chemin: Some(chemin.display().to_string()),
        version: source.version.clone(),
        empreinte: source.empreinte.clone(),
        importe_le: crate::model::now_ms(),
        ..Default::default()
    };
    creer_depuis(store, racine.portee, &source, &origine)
}

/// Crée le skill du harnais à partir d'une source lue (dossier local ou téléchargé).
pub fn creer_depuis(store: &HarnessStore, portee: Scope, source: &SourceSkill, origine: &Origine) -> Result<Entry> {
    source.verifier_taille()?;
    if let Some(existant) = store
        .list(Some(EntryKind::Skill), None)?
        .into_iter()
        .find(|e| e.meta.title == source.nom || e.meta.id == source.nom)
    {
        bail!("un skill « {} » existe déjà dans le harnais ({})", source.nom, existant.meta.scope);
    }
    let entry = store.create(
        portee,
        EntryKind::Skill,
        NewEntry {
            title: source.nom_source.clone(),
            body: source.corps_harnais(),
            source: Some(format!("import:{}", origine.outil)),
            evidence: vec![origine.url.clone().or(origine.chemin.clone()).unwrap_or_default()],
            tags: Vec::new(),
            code: None,
        },
    )?;
    if let Err(e) = copier_contenu(&entry, source, origine) {
        let _ = store.delete(&entry.meta.id);
        return Err(e);
    }
    store.get_kind(EntryKind::Skill, &entry.meta.id)?.context("skill importé introuvable")
}

/// Remplace le contenu d'un skill repris par une nouvelle lecture de sa source.
pub fn remplacer_depuis(store: &HarnessStore, id: &str, source: &SourceSkill, origine: &Origine) -> Result<Entry> {
    source.verifier_taille()?;
    let entry = store.get_kind(EntryKind::Skill, id)?.with_context(|| format!("skill « {id} » introuvable"))?;
    let paquet = PathBuf::from(entry.package_dir.clone().context("skill sans dossier")?);
    for item in std::fs::read_dir(&paquet)?.flatten() {
        let nom = item.file_name().to_string_lossy().to_string();
        if matches!(nom.as_str(), SKILL_FILE_NAME | SKILL_INIT_FILE_NAME | ORIGINE_FICHIER | "__pycache__") {
            continue;
        }
        let p = item.path();
        if p.is_dir() { std::fs::remove_dir_all(&p)? } else { std::fs::remove_file(&p)? }
    }
    let entry = store.update(id, EntryPatch { body: Some(source.corps_harnais()), ..Default::default() })?;
    copier_contenu(&entry, source, origine)?;
    store.get_kind(EntryKind::Skill, id)?.context("skill mis à jour introuvable")
}

fn copier_contenu(entry: &Entry, source: &SourceSkill, origine: &Origine) -> Result<()> {
    let paquet = PathBuf::from(entry.package_dir.clone().context("skill sans dossier")?);
    for (rel, abs) in &source.fichiers {
        let cible = paquet.join(rel);
        if let Some(parent) = cible.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(abs, &cible).with_context(|| format!("copie de {}", abs.display()))?;
    }
    std::fs::write(paquet.join(ORIGINE_FICHIER), serde_json::to_string_pretty(origine)?)?;
    Ok(())
}

/// Recopie la source d'un skill déjà importé depuis un dossier local.
pub fn mettre_a_jour(store: &HarnessStore, id: &str) -> Result<Entry> {
    let entry = store.get_kind(EntryKind::Skill, id)?.with_context(|| format!("skill « {id} » introuvable"))?;
    let Some(mut o) = origine(&entry) else { bail!("« {id} » n'a pas été importé : rien à mettre à jour") };
    if o.genre != "dossier" {
        bail!("« {id} » vient d'une adresse : utilisez « Installer depuis une URL » pour le mettre à jour");
    }
    let chemin = PathBuf::from(o.chemin.clone().unwrap_or_default());
    let source = lire_source(&chemin)?;
    o.empreinte = source.empreinte.clone();
    o.version = source.version.clone();
    o.importe_le = crate::model::now_ms();
    remplacer_depuis(store, id, &source, &o)
}

/// Source notée d'un skill du harnais (`None` : skill créé ici).
pub fn origine(entry: &Entry) -> Option<Origine> {
    let dir = entry.package_dir.as_deref()?;
    let texte = std::fs::read_to_string(Path::new(dir).join(ORIGINE_FICHIER)).ok()?;
    serde_json::from_str(&texte).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HarnessPaths;

    struct Banc {
        home: PathBuf,
        ws: PathBuf,
        store: HarnessStore,
    }

    fn banc(nom: &str) -> Banc {
        let base = std::env::temp_dir().join(format!("test-skills-ext-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (home, ws) = (base.join("home"), base.join("projet"));
        std::fs::create_dir_all(&ws).unwrap();
        let store = HarnessStore::new(HarnessPaths::with_home(&ws, Some(home.clone())));
        Banc { home, ws, store }
    }

    fn skill(dossier: &Path, nom: &str, description: &str, corps: &str) {
        std::fs::create_dir_all(dossier.join("references")).unwrap();
        std::fs::write(
            dossier.join("SKILL.md"),
            format!("---\nname: {nom}\ndescription: {description}\n---\n\n{corps}\n"),
        )
        .unwrap();
        std::fs::write(dossier.join("references/guide.md"), "Guide détaillé.").unwrap();
    }

    #[test]
    fn racines_des_quatre_dossiers_avec_leur_portee() {
        let b = banc("racines");
        let r = racines(&b.ws, &b.home);
        let vus: Vec<(Outil, Scope, String)> = r.iter().map(|r| (r.outil, r.portee, r.libelle.clone())).collect();
        assert_eq!(
            vus,
            vec![
                (Outil::ClaudeCode, Scope::Global, "~/.claude/skills".to_string()),
                (Outil::ClaudeCode, Scope::Project, ".claude/skills".to_string()),
                (Outil::Codex, Scope::Global, "~/.codex/skills".to_string()),
                (Outil::Agents, Scope::Global, "~/.agents/skills".to_string()),
            ]
        );
        assert_eq!(r[1].chemin, b.ws.join(".claude").join("skills"));
    }

    #[test]
    fn lister_puis_importer_copie_le_markdown_et_note_la_source() {
        let b = banc("import");
        let src = b.home.join(".claude/skills/revue-pr");
        skill(&src, "Revue PR", "Relire une PR avant fusion.", "# Revue\n\nLire le diff.");
        std::fs::create_dir_all(b.ws.join(".claude/skills/vide")).unwrap(); // sans SKILL.md : ignoré
        let r = racines(&b.ws, &b.home);
        let liste = lister(&b.store, &r);
        assert_eq!(liste.len(), 1);
        let s = &liste[0];
        assert_eq!((s.nom.as_str(), s.nom_source.as_str(), s.outil, s.portee, s.etat), ("revue_pr", "Revue PR", Outil::ClaudeCode, Scope::Global, EtatImport::Nouveau));
        assert_eq!(s.description, "Relire une PR avant fusion.");
        assert_eq!(s.fichiers, 2);

        let entry = importer(&b.store, &r, &src).unwrap();
        assert_eq!((entry.meta.kind, entry.meta.scope, entry.meta.title.as_str()), (EntryKind::Skill, Scope::Global, "revue_pr"));
        assert!(entry.body.starts_with("Relire une PR avant fusion."), "{}", entry.body);
        assert!(entry.body.contains("# Revue") && !entry.body.contains("name: Revue PR"), "frontmatter d'origine retiré");
        assert_eq!(entry.meta.source, "import:claude_code");
        let paquet = PathBuf::from(entry.package_dir.clone().unwrap());
        assert_eq!(std::fs::read_to_string(paquet.join("references/guide.md")).unwrap(), "Guide détaillé.");
        assert!(paquet.join("__init__.py").is_file(), "reste un paquet importable");
        let o = origine(&entry).unwrap();
        assert_eq!((o.genre.as_str(), o.outil.as_str()), ("dossier", "claude_code"));
        assert_eq!(o.chemin.as_deref(), Some(src.display().to_string().as_str()));
        assert_eq!(lister(&b.store, &r)[0].etat, EtatImport::Importe);
        assert!(importer(&b.store, &r, &src).is_err(), "pas deux fois");
    }

    #[test]
    fn source_modifiee_propose_puis_fait_la_mise_a_jour() {
        let b = banc("maj");
        let src = b.home.join(".codex/skills/deploy");
        skill(&src, "deploy", "Déployer.", "Étape 1.");
        let r = racines(&b.ws, &b.home);
        let entry = importer(&b.store, &r, &src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: deploy\ndescription: Déployer v2.\n---\nÉtape 1 et 2.\n").unwrap();
        std::fs::remove_file(src.join("references/guide.md")).unwrap();
        std::fs::write(src.join("script.sh"), "echo ok").unwrap();
        let liste = lister(&b.store, &r);
        assert_eq!((liste[0].etat, liste[0].id_harnais.as_deref()), (EtatImport::MiseAJour, Some(entry.meta.id.as_str())));
        let maj = mettre_a_jour(&b.store, &entry.meta.id).unwrap();
        assert!(maj.body.contains("Étape 1 et 2.") && maj.body.starts_with("Déployer v2."));
        let paquet = PathBuf::from(maj.package_dir.clone().unwrap());
        assert!(paquet.join("script.sh").is_file() && !paquet.join("references/guide.md").exists(), "fichiers remplacés");
        assert!(paquet.join("__init__.py").is_file());
        assert_eq!(lister(&b.store, &r)[0].etat, EtatImport::Importe);
    }

    #[test]
    fn nom_deja_pris_par_un_skill_du_harnais_est_un_conflit() {
        let b = banc("conflit");
        b.store
            .create(Scope::Global, EntryKind::Skill, NewEntry { title: "qcm".into(), body: "à moi".into(), ..Default::default() })
            .unwrap();
        let src = b.home.join(".agents/skills/qcm");
        skill(&src, "qcm", "Autre qcm.", "x");
        let r = racines(&b.ws, &b.home);
        let liste = lister(&b.store, &r);
        assert_eq!((liste[0].etat, liste[0].id_harnais.as_deref()), (EtatImport::Conflit, Some("qcm")));
        assert!(importer(&b.store, &r, &src).is_err());
    }

    #[test]
    fn dossier_hors_des_racines_ou_trop_gros_refuse() {
        let b = banc("refus");
        let ailleurs = b.home.join("ailleurs/x");
        skill(&ailleurs, "x", "x", "x");
        let r = racines(&b.ws, &b.home);
        assert!(importer(&b.store, &r, &ailleurs).is_err(), "seulement les dossiers connus");
        let gros = b.home.join(".claude/skills/gros");
        skill(&gros, "gros", "g", "g");
        for i in 0..=MAX_FICHIERS {
            std::fs::write(gros.join(format!("f{i}.txt")), "x").unwrap();
        }
        let e = importer(&b.store, &r, &gros).unwrap_err().to_string();
        assert!(e.contains("fichiers"), "{e}");
        assert!(b.store.get("gros").unwrap().is_none(), "rien de créé");
    }
}

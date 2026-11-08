//! Lot palette — moteur de la recherche dans les conversations (Ctrl+K) : liste des
//! conversations de tous les dossiers et recherche d'un mot dans le TEXTE des messages
//! (pas les réflexions, ni le code ou les sorties des outils), sans casse ni accents.
//! Pur (std + rusqlite + serde) : mesurable seul sur un historique réel (test ignoré
//! `mesure_historique_reel`). Les textes sont gardés en mémoire ; une conversation n'est
//! relue que si sa date de mise à jour a changé.

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationListee {
    pub id: String,
    /// Dossier de la conversation (chemin, ou racine des conversations sans dossier).
    pub dossier: String,
    pub titre: String,
    pub maj_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resultat {
    pub conversation_id: String,
    pub dossier: String,
    pub titre: String,
    pub maj_ms: i64,
    /// « user » ou « assistant » : auteur du message de l'extrait.
    pub role: &'static str,
    /// Texte autour du premier mot trouvé (« … » aux coupures, espaces repliés).
    pub extrait: String,
    /// Nombre de messages de la conversation qui contiennent tous les mots.
    pub messages: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recherche {
    pub resultats: Vec<Resultat>,
    /// Conversations parcourues.
    pub conversations: usize,
    /// Conversations relues dans la base (les autres viennent de la mémoire).
    pub relues: usize,
    pub duree_ms: u64,
    /// D'autres conversations correspondent (au-delà de la limite).
    pub tronque: bool,
}

struct Message {
    assistant: bool,
    texte: String,
    plie: String,
}

struct EnMemoire {
    maj_ms: i64,
    messages: Vec<Message>,
}

/// Textes des conversations déjà lus (gardés entre deux recherches).
#[derive(Default)]
pub struct Cache {
    conversations: HashMap<String, EnMemoire>,
}

#[derive(Deserialize)]
struct MessageJson {
    role: String,
    #[serde(default)]
    parts: Vec<PartieJson>,
}

#[derive(Deserialize)]
struct PartieJson {
    #[serde(rename = "type")]
    genre: String,
    #[serde(default)]
    text: Option<String>,
}

/// Une lettre comparable : minuscule sans accent (une lettre donne une lettre).
fn plier_car(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let mut bas = c.to_lowercase();
    let b = match (bas.next(), bas.next()) {
        (Some(x), None) => x,
        _ => c,
    };
    match b {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ź' | 'ż' | 'ž' => 'z',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĺ' | 'ļ' | 'ľ' | 'ł' => 'l',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ţ' | 'ť' => 't',
        '\u{2019}' => '\'',
        '\u{a0}' | '\u{202f}' => ' ',
        autre => autre,
    }
}

/// Forme comparable d'un texte, lettre pour lettre (même nombre de caractères).
pub fn plier(texte: &str) -> String {
    texte.chars().map(plier_car).collect()
}

fn ouvrir(base: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(base, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("historique illisible : {e}"))
}

fn lister_avec(conn: &Connection) -> Result<Vec<ConversationListee>, String> {
    let ligne = |row: &rusqlite::Row<'_>| {
        Ok(ConversationListee { id: row.get(0)?, dossier: row.get(1)?, titre: row.get(2)?, maj_ms: row.get(3)? })
    };
    // Les conversations archivées ne sont pas proposées (colonne absente des très vieilles bases).
    let requete = |filtre: &str| {
        format!("select id, workspace_id, title, updated_at_ms from conversations {filtre} order by updated_at_ms desc")
    };
    let liste = match conn.prepare(&requete("where coalesce(archived, 0) = 0")) {
        Ok(mut st) => st.query_map([], ligne).and_then(|r| r.collect::<rusqlite::Result<Vec<_>>>()),
        Err(_) => {
            let mut st = conn.prepare(&requete("")).map_err(|e| e.to_string())?;
            let r = st.query_map([], ligne).and_then(|r| r.collect::<rusqlite::Result<Vec<_>>>());
            r
        }
    };
    liste.map_err(|e| e.to_string())
}

/// Conversations de tous les dossiers, la plus récente d'abord (archivées exclues).
pub fn lister(base: &Path) -> Result<Vec<ConversationListee>, String> {
    lister_avec(&ouvrir(base)?)
}

/// Textes d'un message (parties « text » seulement) ; None si le message n'en a pas.
fn textes_du_message(json: &str) -> Option<Message> {
    // Repère exact : serde_json écrit `"type":"text"` ; dans une chaîne (sortie d'outil) les
    // guillemets seraient échappés. Les gros messages d'outils ne sont donc jamais analysés.
    if !json.contains(r#""type":"text""#) {
        return None;
    }
    let message: MessageJson = serde_json::from_str(json).ok()?;
    let texte = message
        .parts
        .into_iter()
        .filter(|p| p.genre == "text")
        .filter_map(|p| p.text)
        .collect::<Vec<_>>()
        .join("\n");
    if texte.trim().is_empty() {
        return None;
    }
    let plie = plier(&texte);
    Some(Message { assistant: message.role == "assistant", texte, plie })
}

/// Extrait autour du caractère `debut` (indice en caractères) : 60 avant, 120 après, coupé
/// entre deux mots, espaces repliés, « … » aux coupures.
pub fn extrait(texte: &str, debut: usize, longueur: usize) -> String {
    let car: Vec<char> = texte.chars().collect();
    let fin_mot = (debut + longueur).min(car.len());
    let mut d = debut.saturating_sub(60);
    let mut f = (fin_mot + 120).min(car.len());
    if d > 0 {
        if let Some(p) = car[d..debut].iter().position(|c| c.is_whitespace()) {
            d += p + 1;
        }
    }
    if f < car.len() {
        if let Some(p) = car[fin_mot..f].iter().rposition(|c| c.is_whitespace()) {
            f = fin_mot + p;
        }
    }
    let morceau: String = car[d..f].iter().collect();
    let replie = morceau.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{}{}{}",
        if d > 0 { "… " } else { "" },
        replie,
        if f < car.len() { " …" } else { "" }
    )
}

impl Cache {
    /// Taille de la mémoire : (conversations, messages, octets de texte).
    pub fn taille(&self) -> (usize, usize, usize) {
        let messages = self.conversations.values().map(|c| c.messages.len()).sum();
        let octets = self.conversations.values().flat_map(|c| c.messages.iter()).map(|m| m.texte.len() + m.plie.len()).sum();
        (self.conversations.len(), messages, octets)
    }

    /// Cherche `requete` (mots séparés par des espaces, tous requis dans un même message).
    /// Requête vide : met seulement les textes en mémoire (préchauffage à l'ouverture de Ctrl+K).
    pub fn chercher(&mut self, base: &Path, requete: &str, limite: usize) -> Result<Recherche, String> {
        let depart = Instant::now();
        let conn = ouvrir(base)?;
        let liste = lister_avec(&conn)?;
        let mut relues = 0;
        {
            // Seuls les messages qui ont du texte sortent de la base (les sorties d'outils, souvent
            // grosses, ne sont ni copiées ni analysées).
            let mut lecture = conn
                .prepare(
                    "select message_json from messages where conversation_id = ?1 \
                     and instr(message_json, '\"type\":\"text\"') > 0 order by ordinal",
                )
                .map_err(|e| e.to_string())?;
            for c in &liste {
                if self.conversations.get(&c.id).is_some_and(|m| m.maj_ms == c.maj_ms) {
                    continue;
                }
                let messages = lecture
                    .query_map(params![c.id], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .filter_map(|json| textes_du_message(&json))
                    .collect();
                self.conversations.insert(c.id.clone(), EnMemoire { maj_ms: c.maj_ms, messages });
                relues += 1;
            }
        }
        // Conversations supprimées ou archivées : oubliées.
        if self.conversations.len() > liste.len() {
            let ids: std::collections::HashSet<&str> = liste.iter().map(|c| c.id.as_str()).collect();
            self.conversations.retain(|id, _| ids.contains(id.as_str()));
        }
        let termes: Vec<String> = plier(requete).split_whitespace().map(str::to_string).collect();
        let mut resultats = Vec::new();
        let mut tronque = false;
        if !termes.is_empty() {
            for c in &liste {
                let Some(memoire) = self.conversations.get(&c.id) else { continue };
                let trouves: Vec<&Message> =
                    memoire.messages.iter().filter(|m| termes.iter().all(|t| m.plie.contains(t.as_str()))).collect();
                let Some(dernier) = trouves.last() else { continue };
                if resultats.len() >= limite {
                    tronque = true;
                    break;
                }
                let octet = dernier.plie.find(termes[0].as_str()).unwrap_or(0);
                let debut = dernier.plie[..octet].chars().count();
                resultats.push(Resultat {
                    conversation_id: c.id.clone(),
                    dossier: c.dossier.clone(),
                    titre: c.titre.clone(),
                    maj_ms: c.maj_ms,
                    role: if dernier.assistant { "assistant" } else { "user" },
                    extrait: extrait(&dernier.texte, debut, termes[0].chars().count()),
                    messages: trouves.len(),
                });
            }
        }
        Ok(Recherche {
            resultats,
            conversations: liste.len(),
            relues,
            duree_ms: depart.elapsed().as_millis() as u64,
            tronque,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn base_temporaire(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "axe-recherche-{nom}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        let base = d.join("desktop-state.sqlite3");
        let conn = Connection::open(&base).unwrap();
        conn.execute_batch(
            "create table conversations (id text primary key, workspace_id text not null, title text not null,
               created_at_ms integer not null default 0, updated_at_ms integer not null, archived integer default 0);
             create table messages (conversation_id text not null, ordinal integer not null, message_json text not null,
               primary key (conversation_id, ordinal));",
        )
        .unwrap();
        base
    }

    fn conversation(base: &Path, id: &str, dossier: &str, titre: &str, maj: i64, messages: &[serde_json::Value]) {
        let conn = Connection::open(base).unwrap();
        conn.execute(
            "insert or replace into conversations (id, workspace_id, title, updated_at_ms) values (?1, ?2, ?3, ?4)",
            params![id, dossier, titre, maj],
        )
        .unwrap();
        conn.execute("delete from messages where conversation_id = ?1", params![id]).unwrap();
        for (i, m) in messages.iter().enumerate() {
            conn.execute(
                "insert into messages (conversation_id, ordinal, message_json) values (?1, ?2, ?3)",
                params![id, i as i64, serde_json::to_string(m).unwrap()],
            )
            .unwrap();
        }
    }

    fn texte(role: &str, t: &str) -> serde_json::Value {
        serde_json::json!({"role": role, "parts": [{"type": "text", "text": t}]})
    }

    fn fil_complet() -> Vec<serde_json::Value> {
        vec![
            texte("user", "Peux-tu relancer le banc d'affichage ?"),
            serde_json::json!({"role": "assistant", "parts": [
                {"type": "thinking", "text": "banc secret de réflexion"},
                {"type": "tool_call", "id": "t1", "name": "python", "input": {"code": "banc = 1"}}]}),
            serde_json::json!({"role": "user", "parts": [
                {"type": "tool_result", "tool_call_id": "t1", "is_error": false, "content": "banc dans la sortie \"type\":\"text\""}]}),
            texte("assistant", "J'ai relancé le Banc à 800 px : l'Été est passé sans défaut."),
        ]
    }

    #[test]
    fn plier_garde_une_lettre_par_lettre() {
        let t = "Été, Œuvre’s ÇA\u{a0}!";
        assert_eq!(plier(t).chars().count(), t.chars().count());
        assert_eq!(plier("Été Ça’"), "ete ca'");
    }

    #[test]
    fn extrait_coupe_entre_deux_mots() {
        let long = format!("{} cible {}", "mot ".repeat(40), "suite ".repeat(60));
        let debut = long.find("cible").unwrap();
        let x = extrait(&long, long[..debut].chars().count(), 5);
        assert!(x.starts_with("… mot"), "{x}");
        assert!(x.ends_with("suite …"), "{x}");
        assert!(x.contains(" cible "));
        assert!(!x.contains("  "));
        assert_eq!(extrait("court  texte\n cible", 14, 5), "court texte cible");
    }

    #[test]
    fn cherche_dans_le_texte_des_messages_seulement() {
        let base = base_temporaire("texte");
        conversation(&base, "c1", "C:\\projet", "Banc", 10, &fil_complet());
        let mut cache = Cache::default();
        let r = cache.chercher(&base, "banc", 30).unwrap();
        assert_eq!(r.resultats.len(), 1);
        assert_eq!(r.resultats[0].messages, 2, "question + réponse, pas la réflexion ni la sortie d'outil");
        assert_eq!(r.resultats[0].role, "assistant");
        assert!(r.resultats[0].extrait.contains("relancé le Banc"), "{}", r.resultats[0].extrait);
        for absent in ["secret", "sortie", "banc = 1"] {
            assert!(cache.chercher(&base, absent, 30).unwrap().resultats.is_empty(), "{absent}");
        }
        // sans casse ni accents ; plusieurs mots dans un même message
        assert_eq!(cache.chercher(&base, "ETE", 30).unwrap().resultats.len(), 1);
        assert_eq!(cache.chercher(&base, "800 défaut", 30).unwrap().resultats.len(), 1);
        assert!(cache.chercher(&base, "affichage défaut", 30).unwrap().resultats.is_empty());
        // requête vide : rien cherché, textes mis en mémoire
        let vide = cache.chercher(&base, "  ", 30).unwrap();
        assert!(vide.resultats.is_empty());
        assert_eq!(vide.relues, 0);
    }

    #[test]
    fn archivees_exclues_et_conversation_changee_relue() {
        let base = base_temporaire("cache");
        conversation(&base, "c1", "C:\\a", "Un", 10, &[texte("user", "facture OVH")]);
        conversation(&base, "c2", "C:\\b", "Deux", 20, &[texte("user", "facture Free")]);
        conversation(&base, "c3", "C:\\b", "Trois", 30, &[texte("user", "facture archivée")]);
        Connection::open(&base).unwrap().execute("update conversations set archived = 1 where id = 'c3'", []).unwrap();
        let liste = lister(&base).unwrap();
        assert_eq!(liste.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["c2", "c1"]);
        let mut cache = Cache::default();
        let r = cache.chercher(&base, "facture", 30).unwrap();
        assert_eq!(r.resultats.iter().map(|x| x.conversation_id.as_str()).collect::<Vec<_>>(), vec!["c2", "c1"]);
        assert_eq!(r.relues, 2);
        assert_eq!(cache.chercher(&base, "facture", 30).unwrap().relues, 0, "rien de changé : mémoire");
        conversation(&base, "c1", "C:\\a", "Un", 40, &[texte("user", "facture OVH"), texte("assistant", "rapprochement fait")]);
        let r = cache.chercher(&base, "rapprochement", 30).unwrap();
        assert_eq!(r.relues, 1);
        assert_eq!(r.resultats.len(), 1);
        assert_eq!(r.resultats[0].dossier, "C:\\a");
        let r = cache.chercher(&base, "facture", 1).unwrap();
        assert_eq!(r.resultats.len(), 1);
        assert!(r.tronque);
    }

    /// Mesure sur un vrai historique : AXE_PALETTE_BASE=<desktop-state.sqlite3> cargo test … -- --ignored --nocapture
    #[test]
    #[ignore]
    fn mesure_historique_reel() {
        let base = PathBuf::from(std::env::var("AXE_PALETTE_BASE").expect("AXE_PALETTE_BASE"));
        let t = Instant::now();
        let liste = lister(&base).unwrap();
        println!("liste : {} conversations en {} ms", liste.len(), t.elapsed().as_millis());
        let mut cache = Cache::default();
        let froid = cache.chercher(&base, "", 30).unwrap();
        println!("première lecture (à froid) : {} conversations relues en {} ms", froid.relues, froid.duree_ms);
        let (_, nb, octets) = cache.taille();
        println!("en mémoire : {nb} messages, {} Ko (texte + forme pliée)", octets / 1024);
        for q in ["banc", "facture", "zendesk", "erreur", "ok", "le", "mot-introuvable-xyz", "relance le banc"] {
            let r = cache.chercher(&base, q, 30).unwrap();
            println!("« {q} » : {} conversation(s){}, {} ms", r.resultats.len(), if r.tronque { " (limite)" } else { "" }, r.duree_ms);
            assert!(r.duree_ms < 500, "trop lent : {} ms", r.duree_ms);
        }
    }
}

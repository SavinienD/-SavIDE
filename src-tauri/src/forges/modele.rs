//! Ce que l'interface reçoit des forges, quelle que soit la forge.

use crate::*;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrResume {
    pub(crate) numero: u64,
    pub(crate) titre: String,
    pub(crate) auteur: String,
    /// « ouverte », « fermée » ou « fusionnée ».
    pub(crate) etat: String,
    pub(crate) brouillon: bool,
    pub(crate) branche: String,
    pub(crate) base: String,
    pub(crate) url: String,
    pub(crate) maj: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Check {
    pub(crate) id: String,
    pub(crate) nom: String,
    /// « succes », « echec », « en_cours », « ignore ».
    pub(crate) etat: String,
    pub(crate) detail: Option<String>,
    pub(crate) url: Option<String>,
    /// La fin du journal peut être lue (job GitHub Actions, run Forgejo Actions).
    pub(crate) journal: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Revue {
    pub(crate) id: String,
    pub(crate) auteur: String,
    /// « approuvee », « changements », « commentaire », « attente », « rejetee ».
    pub(crate) etat: String,
    pub(crate) corps: String,
    pub(crate) date: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Commentaire {
    pub(crate) id: String,
    pub(crate) auteur: String,
    pub(crate) corps: String,
    pub(crate) fichier: Option<String>,
    pub(crate) ligne: Option<u64>,
    pub(crate) date: String,
    pub(crate) url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrDetail {
    #[serde(flatten)]
    pub(crate) resume: PrResume,
    pub(crate) description: String,
    pub(crate) sha: String,
    pub(crate) checks: Vec<Check>,
    pub(crate) revues: Vec<Revue>,
    pub(crate) commentaires: Vec<Commentaire>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Issue {
    pub(crate) numero: u64,
    pub(crate) titre: String,
    pub(crate) auteur: String,
    pub(crate) corps: String,
    pub(crate) etiquettes: Vec<String>,
    pub(crate) url: String,
    pub(crate) maj: String,
    pub(crate) commentaires: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrCreee {
    pub(crate) numero: u64,
    pub(crate) url: String,
    pub(crate) message: String,
}

// Lecture tolérante du JSON des API (champ absent = valeur vide).
pub(crate) fn texte(v: &Value, cle: &str) -> String {
    v.get(cle).and_then(Value::as_str).unwrap_or("").to_string()
}
pub(crate) fn texte_opt(v: &Value, cle: &str) -> Option<String> {
    v.get(cle).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}
pub(crate) fn nombre(v: &Value, cle: &str) -> u64 {
    v.get(cle).and_then(Value::as_u64).unwrap_or(0)
}
pub(crate) fn identifiant(v: &Value) -> String {
    match v.get("id") {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}
pub(crate) fn connexion(v: &Value) -> String {
    v.get("user")
        .and_then(|u| u.get("login"))
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string()
}
pub(crate) fn liste(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

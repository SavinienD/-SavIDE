//! Scripts évalués dans la page du navigateur intégré et décodage de leurs réponses.
//!
//! La page ne parle jamais à l'appli : c'est l'appli qui évalue un script (vue web,
//! `evaluate_script_with_callback`) et lit la valeur rendue. Tout ce qui revient de
//! la page est une donnée non fiable : elle est décodée, bornée, puis affichée.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bibliothèque de l'agent (lecture compacte, clic, saisie, touches, attente).
pub(crate) const SCRIPT_AGENT: &str = include_str!("page/agent.js");
/// Design Mode : survol surligné, un clic choisit l'élément, Échap annule.
pub(crate) const SCRIPT_DESIGN: &str = include_str!("page/design.js");

/// Relève (et vide) le choix du Design Mode.
pub(crate) const RELEVE_DESIGN: &str = "JSON.stringify((function(){var d=window.__axecodeDesign;\
if(!d||typeof d.prendre!=='function')return {actif:false,annule:false,choix:null};return d.prendre();})())";

/// Arrête le Design Mode (bouton de l'onglet, onglet fermé).
pub(crate) const ARRET_DESIGN: &str = "JSON.stringify((function(){var d=window.__axecodeDesign;\
if(d&&typeof d.arreter==='function')d.arreter();return {actif:false};})())";

/// Fonctions de la bibliothèque que l'agent peut appeler.
const FONCTIONS: [&str; 6] = ["lire", "cliquer", "remplir", "touche", "trouver", "resume"];

/// Script complet : la bibliothèque (installée une fois par page), puis l'appel.
/// La valeur rendue est toujours une chaîne JSON ; une exception devient `{erreur}`.
pub(crate) fn appel(fonction: &str, arguments: &[Value]) -> Result<String, String> {
    if !FONCTIONS.contains(&fonction) {
        return Err(format!("fonction de page inconnue : {fonction}"));
    }
    let args: Vec<String> = arguments.iter().map(Value::to_string).collect();
    Ok(format!(
        "{SCRIPT_AGENT}\n;JSON.stringify((function(){{try{{return window.__axecodeNavigateur.{fonction}({});}}\
catch(e){{return {{erreur:String(e&&e.message||e)}};}}}})())",
        args.join(",")
    ))
}

/// Script du Design Mode suivi d'un accusé (la vue rend la dernière valeur).
pub(crate) fn activation_design() -> String {
    format!("{SCRIPT_DESIGN}\n;JSON.stringify({{actif:true}})")
}

/// Décode la réponse d'une évaluation : la vue rend la valeur JSON du script (ici une
/// chaîne JSON), on obtient donc une chaîne à décoder deux fois. `{erreur}` → `Err`.
pub(crate) fn decoder(brut: &str) -> Result<Value, String> {
    let brut = brut.trim();
    if brut.is_empty() || brut == "null" || brut == "undefined" {
        return Err("la page n'a rien renvoyé (page en cours de chargement ou script bloqué)".into());
    }
    let interieur: String = match serde_json::from_str::<Value>(brut) {
        Ok(Value::String(texte)) => texte,
        Ok(autre) => autre.to_string(),
        Err(_) => brut.to_string(),
    };
    let valeur: Value =
        serde_json::from_str(&interieur).map_err(|_| "réponse illisible de la page".to_string())?;
    if let Some(erreur) = valeur.get("erreur").and_then(Value::as_str) {
        return Err(borner_texte(erreur, 500));
    }
    Ok(valeur)
}

/// Coupe un texte à `max` caractères (sans casser un caractère).
pub(crate) fn borner_texte(texte: &str, max: usize) -> String {
    if texte.chars().count() <= max {
        return texte.to_string();
    }
    let mut sortie: String = texte.chars().take(max).collect();
    sortie.push('…');
    sortie
}

/// Élément choisi en Design Mode (donnée de la page, bornée avant d'être montrée).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct ElementChoisi {
    pub(crate) url: String,
    pub(crate) titre: String,
    pub(crate) balise: String,
    pub(crate) selecteur: String,
    pub(crate) html: String,
    pub(crate) texte: String,
    pub(crate) largeur: f64,
    pub(crate) hauteur: f64,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) styles: BTreeMap<String, String>,
    pub(crate) attributs: BTreeMap<String, String>,
}

fn nombre(n: f64) -> f64 {
    if n.is_finite() {
        n.clamp(-1_000_000.0, 1_000_000.0)
    } else {
        0.0
    }
}

fn borner_carte(carte: BTreeMap<String, String>, max_entrees: usize) -> BTreeMap<String, String> {
    carte
        .into_iter()
        .filter(|(cle, _)| !cle.is_empty() && cle.len() <= 40 && cle.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .take(max_entrees)
        .map(|(cle, valeur)| (cle, borner_texte(&valeur, 300)))
        .collect()
}

impl ElementChoisi {
    /// Revalide la donnée de la page : longueurs, nombres, clés de styles et d'attributs.
    pub(crate) fn borne(self) -> Self {
        Self {
            url: borner_texte(&self.url, 500),
            titre: borner_texte(&self.titre, 200),
            balise: borner_texte(&self.balise, 40),
            selecteur: borner_texte(&self.selecteur, 400),
            html: borner_texte(&self.html, 3_100),
            texte: borner_texte(&self.texte, 300),
            largeur: nombre(self.largeur),
            hauteur: nombre(self.hauteur),
            x: nombre(self.x),
            y: nombre(self.y),
            styles: borner_carte(self.styles, 30),
            attributs: borner_carte(self.attributs, 20),
        }
    }
}

/// Relevé du Design Mode : encore actif ? annulé (Échap) ? élément choisi ?
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct Releve {
    pub(crate) actif: bool,
    pub(crate) annule: bool,
    pub(crate) choix: Option<ElementChoisi>,
}

pub(crate) fn lire_releve(brut: &str) -> Result<Releve, String> {
    let valeur = decoder(brut)?;
    let mut releve: Releve = serde_json::from_value(valeur).map_err(|_| "relevé du Design Mode illisible".to_string())?;
    releve.choix = releve.choix.map(ElementChoisi::borne);
    Ok(releve)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn appel_connu_seulement() {
        let script = appel("cliquer", &[json!("e3")]).unwrap();
        assert!(script.starts_with("// Bibliothèque injectée"));
        assert!(script.ends_with("window.__axecodeNavigateur.cliquer(\"e3\");}catch(e){return {erreur:String(e&&e.message||e)};}})())"));
        let texte = appel("remplir", &[json!("e2"), json!("a\"); alert(1); (\"")]).unwrap();
        assert!(texte.contains(r#"remplir("e2","a\"); alert(1); (\"")"#), "argument échappé en JSON");
        assert!(appel("eval", &[]).is_err());
    }

    #[test]
    fn decodage_double_et_erreurs() {
        assert_eq!(decoder(r#""{\"ok\":true}""#).unwrap(), json!({"ok": true}));
        assert_eq!(decoder(r#"{"ok":true}"#).unwrap(), json!({"ok": true}), "valeur déjà décodée (repli)");
        assert_eq!(decoder(r#""{\"erreur\":\"élément e9 introuvable\"}""#).unwrap_err(), "élément e9 introuvable");
        assert!(decoder("").is_err());
        assert!(decoder("null").is_err());
        assert!(decoder("\"pas du json\"").is_err());
    }

    #[test]
    fn choix_borne() {
        let long = "x".repeat(10_000);
        let brut = serde_json::to_string(&json!({
            "actif": false, "annule": false,
            "choix": {"balise": "button", "html": long, "largeur": f64::MAX, "x": 12.0,
                      "styles": {"color": "red", "mauvaise clé!": "x", "font-size": long},
                      "attributs": {"href": "https://a.fr/p"}}
        }).to_string()).unwrap();
        let releve = lire_releve(&brut).unwrap();
        let choix = releve.choix.unwrap();
        assert_eq!(choix.balise, "button");
        assert!(choix.html.chars().count() <= 3_101);
        assert_eq!(choix.largeur, 1_000_000.0);
        assert_eq!(choix.styles.get("color").map(String::as_str), Some("red"));
        assert!(!choix.styles.contains_key("mauvaise clé!"));
        assert!(choix.styles["font-size"].chars().count() <= 301);
        assert!(!releve.actif);
    }

    #[test]
    fn scripts_embarques() {
        assert!(SCRIPT_AGENT.contains("__axecodeNavigateur"));
        assert!(SCRIPT_DESIGN.contains("__axecodeDesign"));
        assert!(activation_design().ends_with("JSON.stringify({actif:true})"));
        assert!(RELEVE_DESIGN.contains("prendre()"));
    }
}

//! automatisations — horaires : quand tombe la prochaine exécution.
//!
//! Fonctions pures : aucune horloge n'est lue ici, l'instant de départ est passé
//! en paramètre avec son fuseau. Le service les appelle avec l'heure locale du
//! poste ; les tests, avec une horloge simulée.
//!
//! Tous les horaires se ramènent à une règle de type cron (minutes, heures,
//! jours du mois, mois, jours de la semaine). Changement d'heure : une heure qui
//! n'existe pas (printemps) passe à la première heure qui suit le saut ; une
//! heure qui existe deux fois (automne) ne compte qu'une fois, la première.

use chrono::{DateTime, Datelike, MappedLocalTime, NaiveDate, NaiveDateTime, TimeDelta, TimeZone, Timelike};
use serde::{Deserialize, Serialize};

/// Horaire d'une automatisation. JSON : `{"type": "quotidien", "heure": "08:00"}`,
/// `{"type": "hebdomadaire", "jours": [1, 3], "heure": "08:00"}` (1 = lundi … 7 =
/// dimanche), `{"type": "intervalle", "heures": 2, "minute": 0}`,
/// `{"type": "cron", "expression": "0 8 * * 1-5"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Horaire {
    /// Tous les jours à `heure` (« HH:MM », heure locale).
    #[serde(rename = "quotidien")]
    Quotidien { heure: String },
    /// Les jours cochés (1 = lundi … 7 = dimanche), à `heure`.
    #[serde(rename = "hebdomadaire")]
    Hebdomadaire { jours: Vec<u8>, heure: String },
    /// Toutes les `heures` heures, à la minute `minute` : 0 h, N h, 2N h… de chaque jour.
    #[serde(rename = "intervalle")]
    Intervalle {
        heures: u32,
        #[serde(default)]
        minute: u32,
    },
    /// Expression cron à 5 champs (minute heure jour mois jour-de-semaine), ou @daily…
    #[serde(rename = "cron")]
    Cron { expression: String },
}

/// Règle compilée : valeurs permises de chaque champ, en bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Regle {
    minutes: u64,
    heures: u32,
    jours_mois: u32,
    mois: u16,
    /// Bit 0 = dimanche … bit 6 = samedi.
    jours_semaine: u8,
    jours_mois_libres: bool,
    jours_semaine_libres: bool,
}

/// Recherche bornée : au-delà de 4 ans (un 29 février), l'horaire ne tombe jamais.
const JOURS_MAX: i64 = 366 * 4 + 1;

const NOMS_MOIS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NOMS_JOURS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const JOURS_PLURIEL: [&str; 7] = ["lundis", "mardis", "mercredis", "jeudis", "vendredis", "samedis", "dimanches"];

impl Regle {
    fn chaque_jour(heures: u32, minutes: u64) -> Self {
        Self {
            minutes,
            heures,
            jours_mois: 0xFFFF_FFFE,
            mois: 0x1FFE,
            jours_semaine: 0x7F,
            jours_mois_libres: true,
            jours_semaine_libres: true,
        }
    }

    fn jour_ok(&self, jour: NaiveDate) -> bool {
        if self.mois & (1 << jour.month()) == 0 {
            return false;
        }
        let jm = self.jours_mois & (1 << jour.day()) != 0;
        let js = self.jours_semaine & (1 << jour.weekday().num_days_from_sunday()) != 0;
        match (self.jours_mois_libres, self.jours_semaine_libres) {
            (true, true) => true,
            (true, false) => js,
            (false, true) => jm,
            // Règle de cron : jour du mois OU jour de la semaine quand les deux sont donnés.
            (false, false) => jm || js,
        }
    }
}

/// « 08:00 », « 8:30 », « 8h », « 8 h 30 » → (heure, minute).
pub fn lire_heure(texte: &str) -> Result<(u32, u32), String> {
    let erreur = || format!("Heure invalide « {} » : écrivez HH:MM, par exemple 08:00.", texte.trim());
    let t = texte.trim().to_lowercase();
    let (h, m) = t.split_once(':').or_else(|| t.split_once('h')).unwrap_or((t.as_str(), ""));
    let h: u32 = h.trim().parse().map_err(|_| erreur())?;
    let m: u32 = if m.trim().is_empty() { 0 } else { m.trim().parse().map_err(|_| erreur())? };
    if h > 23 || m > 59 {
        return Err(erreur());
    }
    Ok((h, m))
}

fn heure_fr(h: u32, m: u32) -> String {
    if m == 0 {
        format!("{h} h")
    } else {
        format!("{h} h {m:02}")
    }
}

impl Horaire {
    /// Règle compilée, ou l'erreur à montrer à l'utilisateur.
    pub fn regle(&self) -> Result<Regle, String> {
        match self {
            Horaire::Quotidien { heure } => {
                let (h, m) = lire_heure(heure)?;
                Ok(Regle::chaque_jour(1 << h, 1u64 << m))
            }
            Horaire::Hebdomadaire { jours, heure } => {
                let (h, m) = lire_heure(heure)?;
                if jours.is_empty() {
                    return Err("Cochez au moins un jour.".into());
                }
                let mut bits = 0u8;
                for &j in jours {
                    if !(1..=7).contains(&j) {
                        return Err(format!("Jour invalide : {j} (1 = lundi … 7 = dimanche)."));
                    }
                    bits |= 1 << (j % 7);
                }
                let mut regle = Regle::chaque_jour(1 << h, 1u64 << m);
                regle.jours_semaine = bits;
                regle.jours_semaine_libres = false;
                Ok(regle)
            }
            Horaire::Intervalle { heures, minute } => {
                if !(1..=24).contains(heures) {
                    return Err("L'intervalle va de 1 à 24 heures.".into());
                }
                if *minute > 59 {
                    return Err("La minute va de 0 à 59.".into());
                }
                let mut bits = 0u32;
                let mut h = 0;
                while h < 24 {
                    bits |= 1 << h;
                    h += heures;
                }
                Ok(Regle::chaque_jour(bits, 1u64 << minute))
            }
            Horaire::Cron { expression } => lire_cron(expression),
        }
    }

    /// L'horaire en clair : « Tous les lundis à 8 h ».
    pub fn texte(&self) -> String {
        match self {
            Horaire::Quotidien { heure } => match lire_heure(heure) {
                Ok((h, m)) => format!("Tous les jours à {}", heure_fr(h, m)),
                Err(_) => format!("Tous les jours à {heure}"),
            },
            Horaire::Hebdomadaire { jours, heure } => {
                let a = match lire_heure(heure) {
                    Ok((h, m)) => heure_fr(h, m),
                    Err(_) => heure.clone(),
                };
                let mut j: Vec<u8> = jours.iter().copied().filter(|j| (1..=7).contains(j)).collect();
                j.sort_unstable();
                j.dedup();
                let noms: Vec<&str> = j.iter().map(|&j| JOURS_PLURIEL[usize::from(j) - 1]).collect();
                match j.as_slice() {
                    [] => format!("Aucun jour coché, à {a}"),
                    [1, 2, 3, 4, 5, 6, 7] => format!("Tous les jours à {a}"),
                    [1, 2, 3, 4, 5] => format!("Du lundi au vendredi à {a}"),
                    [_] => format!("Tous les {} à {a}", noms[0]),
                    _ => {
                        let (fin, debut) = noms.split_last().expect("au moins deux jours");
                        format!("Les {} et {fin} à {a}", debut.join(", "))
                    }
                }
            }
            Horaire::Intervalle { heures, minute } => {
                if *heures <= 1 {
                    return if *minute == 0 {
                        "Toutes les heures".into()
                    } else {
                        format!("Toutes les heures, à la minute {minute}")
                    };
                }
                let mut exemples: Vec<String> = (0..24).step_by(*heures as usize).take(3).map(|h| heure_fr(h, *minute)).collect();
                if 24 > heures * 3 {
                    exemples.push("…".into());
                }
                format!("Toutes les {heures} heures ({})", exemples.join(", ").replace(", …", "…"))
            }
            Horaire::Cron { expression } => format!("Cron « {} »", expression.trim()),
        }
    }
}


/// Valeur d'un champ cron : nombre, ou nom anglais à 3 lettres (mois, jours).
fn valeur_cron(texte: &str, min: u32, max: u32, noms: &[&str]) -> Option<u32> {
    let t = texte.trim().to_ascii_lowercase();
    let v = match t.parse::<u32>() {
        Ok(v) => v,
        Err(_) => {
            let i = noms.iter().position(|n| *n == t)? as u32;
            // Mois nommés : jan = 1 ; jours nommés : sun = 0.
            if min == 1 { i + 1 } else { i }
        }
    };
    (min..=max).contains(&v).then_some(v)
}

/// Un champ cron (`*`, `*/n`, `a`, `a-b`, `a-b/n`, `a/n`, listes « , ») → bits.
fn champ_cron(texte: &str, min: u32, max: u32, noms: &[&str], nom: &str) -> Result<u64, String> {
    let mut bits = 0u64;
    for item in texte.split(',') {
        let erreur = || format!("Expression cron : « {item} » n'est pas valable pour les {nom} ({min}-{max}).");
        let (plage, pas) = match item.split_once('/') {
            Some((p, s)) => (p, Some(s.trim().parse::<u32>().ok().filter(|s| *s > 0).ok_or_else(erreur)?)),
            None => (item, None),
        };
        let (debut, fin) = if plage == "*" {
            (min, max)
        } else if let Some((a, b)) = plage.split_once('-') {
            let a = valeur_cron(a, min, max, noms).ok_or_else(erreur)?;
            let b = valeur_cron(b, min, max, noms).ok_or_else(erreur)?;
            (a, b)
        } else {
            let v = valeur_cron(plage, min, max, noms).ok_or_else(erreur)?;
            (v, if pas.is_some() { max } else { v })
        };
        if debut > fin {
            return Err(erreur());
        }
        let mut v = debut;
        while v <= fin {
            bits |= 1u64 << v;
            v += pas.unwrap_or(1);
        }
    }
    Ok(bits)
}

/// Expression cron classique à 5 champs (et les raccourcis @hourly, @daily…).
pub fn lire_cron(expression: &str) -> Result<Regle, String> {
    let brut = expression.trim();
    let developpee = match brut.to_ascii_lowercase().as_str() {
        "@hourly" => "0 * * * *".to_string(),
        "@daily" | "@midnight" => "0 0 * * *".to_string(),
        "@weekly" => "0 0 * * 0".to_string(),
        "@monthly" => "0 0 1 * *".to_string(),
        "@yearly" | "@annually" => "0 0 1 1 *".to_string(),
        _ => brut.to_string(),
    };
    let champs: Vec<&str> = developpee.split_whitespace().collect();
    if champs.len() != 5 {
        return Err("Expression cron : 5 champs attendus (minute heure jour mois jour-de-semaine), par exemple « 0 8 * * 1-5 ».".into());
    }
    let minutes = champ_cron(champs[0], 0, 59, &[], "minutes")?;
    let heures = champ_cron(champs[1], 0, 23, &[], "heures")?;
    let jours_mois = champ_cron(champs[2], 1, 31, &[], "jours du mois")?;
    let mois = champ_cron(champs[3], 1, 12, &NOMS_MOIS, "mois")?;
    let jours = champ_cron(champs[4], 0, 7, &NOMS_JOURS, "jours de la semaine")?;
    // 7 = dimanche, comme 0.
    let jours_semaine = ((jours & 0x7F) | ((jours >> 7) & 1)) as u8;
    Ok(Regle {
        minutes,
        heures: heures as u32,
        jours_mois: jours_mois as u32,
        mois: mois as u16,
        jours_semaine,
        jours_mois_libres: champs[2].starts_with('*'),
        jours_semaine_libres: champs[4].starts_with('*'),
    })
}

/// Instant d'une heure locale : la première si elle existe deux fois (automne) ;
/// une heure qui n'existe pas (printemps) passe à la première minute après le saut.
fn instant_local<Tz: TimeZone>(tz: &Tz, naive: NaiveDateTime) -> Option<DateTime<Tz>> {
    match tz.from_local_datetime(&naive) {
        MappedLocalTime::Single(t) => Some(t),
        MappedLocalTime::Ambiguous(premiere, _) => Some(premiere),
        MappedLocalTime::None => (1..=180).find_map(|k| tz.from_local_datetime(&(naive + TimeDelta::minutes(k))).earliest()),
    }
}

/// Première exécution strictement après `apres` (à la minute), ou `None` si la
/// règle ne tombe jamais dans les 4 ans qui viennent.
pub fn prochaine_apres<Tz: TimeZone>(regle: &Regle, apres: &DateTime<Tz>) -> Option<DateTime<Tz>> {
    let tz = apres.timezone();
    let local = apres.naive_local();
    let premier_jour = local.date();
    let minute_courante = local.hour() * 60 + local.minute();
    for decalage in 0..JOURS_MAX {
        let jour = premier_jour.checked_add_signed(TimeDelta::days(decalage))?;
        if !regle.jour_ok(jour) {
            continue;
        }
        for h in 0..24u32 {
            if regle.heures & (1 << h) == 0 {
                continue;
            }
            for m in 0..60u32 {
                if regle.minutes & (1u64 << m) == 0 || (decalage == 0 && h * 60 + m <= minute_courante) {
                    continue;
                }
                let Some(naive) = jour.and_hms_opt(h, m, 0) else { continue };
                if let Some(t) = instant_local(&tz, naive) {
                    if t > *apres {
                        return Some(t);
                    }
                }
            }
        }
    }
    None
}

/// Nombre d'exécutions prévues dans ]depuis, jusqu'à], `max` au plus.
pub fn compter_entre<Tz: TimeZone>(regle: &Regle, depuis: &DateTime<Tz>, jusqua: &DateTime<Tz>, max: u32) -> u32 {
    let mut n = 0;
    let mut t = depuis.clone();
    while n < max {
        match prochaine_apres(regle, &t) {
            Some(suivante) if suivante <= *jusqua => {
                n += 1;
                t = suivante;
            }
            _ => break,
        }
    }
    n
}

/// Horaire valable et qui tombe un jour (sinon l'erreur à montrer).
pub fn valider<Tz: TimeZone>(horaire: &Horaire, maintenant: &DateTime<Tz>) -> Result<Regle, String> {
    let regle = horaire.regle()?;
    if prochaine_apres(&regle, maintenant).is_none() {
        return Err("Cet horaire ne tombe jamais (par exemple un 31 février).".into());
    }
    Ok(regle)
}


#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn paris() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }
    fn t(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<FixedOffset> {
        paris().with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }
    fn suivante(h: &Horaire, apres: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
        prochaine_apres(&h.regle().unwrap(), &apres)
    }
    fn q(heure: &str) -> Horaire {
        Horaire::Quotidien { heure: heure.into() }
    }
    fn naive(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap()
    }

    #[test]
    fn quotidien_a_l_heure_dite_strictement_apres() {
        assert_eq!(suivante(&q("08:00"), t(2026, 11, 9, 7, 59)), Some(t(2026, 11, 9, 8, 0)));
        assert_eq!(suivante(&q("08:00"), t(2026, 11, 9, 8, 0)), Some(t(2026, 11, 10, 8, 0)));
        let apres_secondes = t(2026, 11, 9, 8, 0) + TimeDelta::seconds(30);
        assert_eq!(suivante(&q("8h"), apres_secondes), Some(t(2026, 11, 10, 8, 0)));
        assert_eq!(suivante(&q("8 h 30"), t(2026, 11, 9, 9, 0)), Some(t(2026, 11, 10, 8, 30)));
    }

    #[test]
    fn hebdomadaire_jours_coches() {
        let lundi = Horaire::Hebdomadaire { jours: vec![1], heure: "08:00".into() };
        // 08/11/2026 = dimanche
        assert_eq!(suivante(&lundi, t(2026, 11, 8, 12, 0)), Some(t(2026, 11, 9, 8, 0)));
        assert_eq!(suivante(&lundi, t(2026, 11, 9, 8, 0)), Some(t(2026, 11, 16, 8, 0)));
        let dimanche = Horaire::Hebdomadaire { jours: vec![7], heure: "10:15".into() };
        assert_eq!(suivante(&dimanche, t(2026, 11, 9, 0, 0)), Some(t(2026, 11, 15, 10, 15)));
    }

    #[test]
    fn intervalle_cale_sur_minuit() {
        let deux = Horaire::Intervalle { heures: 2, minute: 0 };
        assert_eq!(suivante(&deux, t(2026, 11, 9, 13, 23)), Some(t(2026, 11, 9, 14, 0)));
        assert_eq!(suivante(&deux, t(2026, 11, 9, 22, 10)), Some(t(2026, 11, 10, 0, 0)));
        let cinq = Horaire::Intervalle { heures: 5, minute: 15 };
        assert_eq!(suivante(&cinq, t(2026, 11, 9, 20, 16)), Some(t(2026, 11, 10, 0, 15)));
        let toutes = Horaire::Intervalle { heures: 1, minute: 0 };
        assert_eq!(suivante(&toutes, t(2026, 11, 9, 13, 0)), Some(t(2026, 11, 9, 14, 0)));
    }

    #[test]
    fn cron_classique() {
        let c = |e: &str| Horaire::Cron { expression: e.into() };
        // vendredi 13/11/2026 09:00 -> lundi 16/11 08:00
        assert_eq!(suivante(&c("0 8 * * 1-5"), t(2026, 11, 13, 9, 0)), Some(t(2026, 11, 16, 8, 0)));
        assert_eq!(suivante(&c("*/15 * * * *"), t(2026, 11, 9, 10, 7)), Some(t(2026, 11, 9, 10, 15)));
        assert_eq!(suivante(&c("0 0 29 2 *"), t(2026, 11, 9, 0, 0)), Some(t(2028, 2, 29, 0, 0)));
        assert_eq!(suivante(&c("0 0 31 2 *"), t(2026, 11, 9, 0, 0)), None);
        // Jour du mois OU jour de la semaine : le 13 ou un vendredi (20/11/2026).
        assert_eq!(suivante(&c("0 0 13 * fri"), t(2026, 11, 14, 0, 0)), Some(t(2026, 11, 20, 0, 0)));
        assert_eq!(suivante(&c("30 9 * jan-mar sun,7"), t(2026, 11, 9, 0, 0)), Some(t(2027, 1, 3, 9, 30)));
        assert_eq!(suivante(&c("@daily"), t(2026, 11, 9, 0, 0)), Some(t(2026, 11, 10, 0, 0)));
    }

    #[test]
    fn erreurs_en_francais() {
        let c = |e: &str| Horaire::Cron { expression: e.into() }.regle().unwrap_err();
        assert!(c("0 8 * *").contains("5 champs"));
        assert!(c("61 8 * * *").contains("minutes"));
        assert!(c("*/0 * * * *").contains("minutes"));
        assert!(c("0 8 * * lun").contains("jours de la semaine"));
        assert!(c("0 9-8 * * *").contains("heures"));
        assert!(q("25:00").regle().unwrap_err().contains("HH:MM"));
        assert!(Horaire::Hebdomadaire { jours: vec![], heure: "08:00".into() }.regle().is_err());
        assert!(Horaire::Hebdomadaire { jours: vec![8], heure: "08:00".into() }.regle().is_err());
        assert!(Horaire::Intervalle { heures: 0, minute: 0 }.regle().is_err());
        let jamais = valider(&Horaire::Cron { expression: "0 0 31 2 *".into() }, &t(2026, 11, 9, 0, 0));
        assert!(jamais.unwrap_err().contains("jamais"));
    }

    #[test]
    fn compte_des_executions_manquees() {
        let r = q("08:00").regle().unwrap();
        assert_eq!(compter_entre(&r, &t(2026, 11, 9, 8, 0), &t(2026, 11, 12, 9, 0), 1000), 3);
        assert_eq!(compter_entre(&r, &t(2026, 11, 9, 8, 0), &t(2026, 11, 9, 9, 0), 1000), 0);
        let r = Horaire::Cron { expression: "* * * * *".into() }.regle().unwrap();
        assert_eq!(compter_entre(&r, &t(2026, 11, 9, 0, 0), &t(2026, 11, 10, 0, 0), 1000), 1000);
    }

    #[test]
    fn horaire_en_clair() {
        assert_eq!(q("08:00").texte(), "Tous les jours à 8 h");
        assert_eq!(q("8:05").texte(), "Tous les jours à 8 h 05");
        let h = |j: Vec<u8>| Horaire::Hebdomadaire { jours: j, heure: "08:00".into() }.texte();
        assert_eq!(h(vec![1]), "Tous les lundis à 8 h");
        assert_eq!(h(vec![5, 1, 3]), "Les lundis, mercredis et vendredis à 8 h");
        assert_eq!(h(vec![1, 2, 3, 4, 5]), "Du lundi au vendredi à 8 h");
        assert_eq!(h(vec![6, 7]), "Les samedis et dimanches à 8 h");
        assert_eq!(h(vec![7, 6, 5, 4, 3, 2, 1]), "Tous les jours à 8 h");
        assert_eq!(Horaire::Intervalle { heures: 2, minute: 0 }.texte(), "Toutes les 2 heures (0 h, 2 h, 4 h…)");
        assert_eq!(Horaire::Intervalle { heures: 1, minute: 0 }.texte(), "Toutes les heures");
        assert_eq!(Horaire::Intervalle { heures: 12, minute: 30 }.texte(), "Toutes les 12 heures (0 h 30, 12 h 30)");
        assert_eq!(Horaire::Cron { expression: " 0 8 * * 1-5 ".into() }.texte(), "Cron « 0 8 * * 1-5 »");
    }

    #[test]
    fn json_des_horaires() {
        let h: Horaire = serde_json::from_value(serde_json::json!({"type": "hebdomadaire", "jours": [1, 3], "heure": "08:00"})).unwrap();
        assert_eq!(h, Horaire::Hebdomadaire { jours: vec![1, 3], heure: "08:00".into() });
        let i: Horaire = serde_json::from_value(serde_json::json!({"type": "intervalle", "heures": 2})).unwrap();
        assert_eq!(i, Horaire::Intervalle { heures: 2, minute: 0 });
        assert_eq!(serde_json::to_value(q("08:00")).unwrap(), serde_json::json!({"type": "quotidien", "heure": "08:00"}));
    }

    /// Fuseau simulé « Paris 2026 » : +1 h, et +2 h du 29/03 01:00 UTC au 25/10 01:00 UTC.
    #[derive(Clone, Copy, Debug)]
    struct Paris2026;

    impl Paris2026 {
        fn decalage(utc: &NaiveDateTime) -> FixedOffset {
            let ete = *utc >= naive(2026, 3, 29, 1, 0) && *utc < naive(2026, 10, 25, 1, 0);
            FixedOffset::east_opt(if ete { 7200 } else { 3600 }).unwrap()
        }
    }

    impl TimeZone for Paris2026 {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            Paris2026
        }
        fn offset_from_local_date(&self, local: &NaiveDate) -> MappedLocalTime<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(12, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> MappedLocalTime<FixedOffset> {
            let possibles: Vec<FixedOffset> = [7200, 3600]
                .into_iter()
                .map(|s| FixedOffset::east_opt(s).unwrap())
                .filter(|o| Self::decalage(&(*local - TimeDelta::seconds(i64::from(o.local_minus_utc())))) == *o)
                .collect();
            match possibles.as_slice() {
                [] => MappedLocalTime::None,
                [o] => MappedLocalTime::Single(*o),
                // L'heure d'été donne l'instant le plus tôt.
                [ete, hiver] => MappedLocalTime::Ambiguous(*ete, *hiver),
                _ => unreachable!(),
            }
        }
        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            Self::decalage(&utc.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            Self::decalage(utc)
        }
    }

    #[test]
    fn changement_d_heure_simule() {
        let r = q("02:30").regle().unwrap();
        let tz = Paris2026;
        // Printemps : 02:30 n'existe pas le 29/03 -> 03:00 d'été (01:00 UTC), puis 02:30 le lendemain.
        let printemps = prochaine_apres(&r, &tz.with_ymd_and_hms(2026, 3, 28, 12, 0, 0).unwrap()).unwrap();
        assert_eq!(printemps.naive_utc(), naive(2026, 3, 29, 1, 0));
        let lendemain = prochaine_apres(&r, &printemps).unwrap();
        assert_eq!(lendemain.naive_local(), naive(2026, 3, 30, 2, 30));
        // Automne : 02:30 existe deux fois le 25/10 -> une seule exécution, la première (00:30 UTC).
        let automne = prochaine_apres(&r, &tz.with_ymd_and_hms(2026, 10, 24, 12, 0, 0).unwrap()).unwrap();
        assert_eq!(automne.naive_utc(), naive(2026, 10, 25, 0, 30));
        let ensuite = prochaine_apres(&r, &automne).unwrap();
        assert_eq!(ensuite.naive_local(), naive(2026, 10, 26, 2, 30));
        // Pendant l'heure doublée (02:10, seconde fois), 02:30 est déjà passé.
        let seconde = tz.from_utc_datetime(&naive(2026, 10, 25, 1, 10));
        assert_eq!(prochaine_apres(&r, &seconde).unwrap().naive_local(), naive(2026, 10, 26, 2, 30));
    }
}


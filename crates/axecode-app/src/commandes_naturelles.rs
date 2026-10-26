//! axe:cmdnat — analyse en langage naturel des commandes `/heartbeat` et `/goal`
//! (l'utilisateur n'a pas à suivre une syntaxe précise).
//!
//! Pur et testé : français et anglais, fautes de frappe courantes, intervalle
//! n'importe où dans la phrase (« toutes les 5 secondes », « chaque heure »,
//! « every 30s », « 1h30 »…). Quand l'analyse échoue ou reste ambiguë, on rend
//! [`IntentionReveil::Flou`] / [`IntentionObjectif::Flou`] : l'appelant transmet
//! alors la demande telle quelle à l'agent, qui règle lui-même `heartbeat.set` /
//! `goal.set` ou demande une précision. Jamais de « usage invalide ».

/// Ce que veut l'utilisateur avec `/heartbeat …`.
#[derive(Debug, Clone, PartialEq)]
pub enum IntentionReveil {
    /// `/heartbeat` seul, `/heartbeat ?` : montrer le réveil actuel.
    Afficher,
    /// « stop », « arrête », « off », « coupe », « désactive »…
    Arreter,
    /// Réveil à poser (l'intervalle peut être sous le minimum : l'appelant le vérifie).
    Poser { interval_ms: u64, message: String },
    /// Pas compris ou ambigu : à confier à l'agent.
    Flou { raison: String },
}

/// Ce que veut l'utilisateur avec `/goal …`.
#[derive(Debug, Clone, PartialEq)]
pub enum IntentionObjectif {
    Afficher,
    Effacer,
    Pause,
    Reprendre,
    Termine,
    Poser { texte: String, budget: Option<u64> },
    Flou { raison: String },
}

// ---------------------------------------------------------------- outils texte

/// Minuscules, sans accents, apostrophes typographiques unifiées.
pub fn normaliser(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' | 'ã' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' | 'í' | 'ì' => 'i',
            'ô' | 'ö' | 'ó' | 'ò' | 'õ' => 'o',
            'ù' | 'û' | 'ü' | 'ú' => 'u',
            'ç' => 'c',
            'ÿ' => 'y',
            'ñ' => 'n',
            '’' | '‘' | '`' | 'ʼ' => '\'',
            'œ' => 'o',
            c => c,
        })
        .collect()
}

/// Distance d'édition avec transpositions (Damerau, version restreinte).
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for j in 0..=m {
        d[0][j] = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[n][m]
}

/// `w` ressemble à un des `mots` (même première lettre ; tolérance selon la longueur).
fn proche(w: &str, mots: &[&str]) -> bool {
    if mots.contains(&w) {
        return true;
    }
    let n = w.chars().count();
    if n < 4 {
        return false;
    }
    let tol = if n >= 7 { 2 } else { 1 };
    mots.iter().any(|m| {
        m.chars().count() >= 4 && m.chars().next() == w.chars().next() && distance(w, m) <= tol
    })
}

/// Un mot de la phrase d'origine et sa forme normalisée sans ponctuation de bord.
#[derive(Debug, Clone)]
struct Mot {
    orig: String,
    norm: String,
}

fn mots(texte: &str) -> Vec<Mot> {
    texte
        .split_whitespace()
        .map(|w| Mot {
            orig: w.to_string(),
            norm: normaliser(w)
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
                .trim_matches('\'')
                .to_string(),
        })
        .collect()
}

// ---------------------------------------------------------------- intervalles

#[derive(Debug, Clone, PartialEq)]
enum Lex {
    Num(f64),
    Mot(String),
}

/// Lexèmes : chaque mot est coupé aux apostrophes, traits d'union et entre chiffres
/// et lettres (« 5secondes » → 5, secondes ; « 1h30 » → 1, h, 30 ; « d'heure » → d, heure).
fn lexemes(mots: &[Mot]) -> Vec<(Lex, usize)> {
    let mut out = Vec::new();
    for (w, mot) in mots.iter().enumerate() {
        let chars: Vec<char> = mot.norm.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c.is_ascii_digit() {
                let mut s = String::new();
                while i < chars.len() {
                    let c = chars[i];
                    if c.is_ascii_digit() {
                        s.push(c);
                    } else if (c == ',' || c == '.') && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
                        s.push('.');
                    } else {
                        break;
                    }
                    i += 1;
                }
                if let Ok(n) = s.parse() {
                    out.push((Lex::Num(n), w));
                }
            } else if c.is_alphabetic() {
                let mut s = String::new();
                while i < chars.len() && chars[i].is_alphabetic() {
                    s.push(chars[i]);
                    i += 1;
                }
                out.push((nombre_en_lettres(&s).map(Lex::Num).unwrap_or(Lex::Mot(s)), w));
            } else {
                i += 1;
            }
        }
    }
    out
}

fn nombre_en_lettres(w: &str) -> Option<f64> {
    Some(match w {
        "un" | "une" | "one" => 1.0,
        "deux" | "two" => 2.0,
        "trois" | "three" => 3.0,
        "quatre" | "four" => 4.0,
        "cinq" | "five" => 5.0,
        "six" => 6.0,
        "sept" | "seven" => 7.0,
        "huit" | "eight" => 8.0,
        "neuf" | "nine" => 9.0,
        "dix" | "ten" => 10.0,
        "douze" | "twelve" => 12.0,
        "quinze" | "fifteen" => 15.0,
        "vingt" | "twenty" => 20.0,
        "trente" | "thirty" => 30.0,
        "quarante" | "forty" => 40.0,
        "cinquante" | "fifty" => 50.0,
        "soixante" | "sixty" => 60.0,
        _ => return None,
    })
}

const SEC: f64 = 1_000.0;
const MIN: f64 = 60_000.0;
const HEURE: f64 = 3_600_000.0;
const JOUR: f64 = 86_400_000.0;

/// Valeur d'une unité de temps (ms). `seul` : l'unité sans nombre (« chaque heure »),
/// où les abréviations d'une lettre ne comptent pas.
fn unite(w: &str, seul: bool) -> Option<f64> {
    let courtes: &[(&str, f64)] = &[
        ("ms", 1.0), ("s", SEC), ("sec", SEC), ("secs", SEC), ("sc", SEC), ("sg", SEC),
        ("m", MIN), ("mn", MIN), ("mns", MIN), ("min", MIN), ("mins", MIN), ("mm", MIN),
        ("h", HEURE), ("hr", HEURE), ("hrs", HEURE), ("hs", HEURE),
        ("j", JOUR), ("jr", JOUR), ("jrs", JOUR), ("d", JOUR),
        ("sem", 7.0 * JOUR), ("wk", 7.0 * JOUR),
    ];
    if !seul {
        if let Some((_, v)) = courtes.iter().find(|(u, _)| *u == w) {
            return Some(*v);
        }
    } else if matches!(w, "min" | "mn" | "sec" | "hr") {
        return Some(courtes.iter().find(|(u, _)| *u == w).unwrap().1);
    }
    // Ordre : jours/semaines avant heures (« jours » est à une lettre de « hours »
    // mais pas la même initiale, donc sans risque).
    let longues: &[(&[&str], f64)] = &[
        (&["millisecondes", "milliseconde", "milliseconds", "millisecond"], 1.0),
        (&["secondes", "seconde", "seconds", "second"], SEC),
        (&["minutes", "minute", "minuts", "minut"], MIN),
        (&["heures", "heure", "hours", "hour", "heurs", "heur"], HEURE),
        (&["jours", "jour", "days", "day", "journee", "journees"], JOUR),
        (&["semaines", "semaine", "weeks", "week"], 7.0 * JOUR),
    ];
    // Exact d'abord (évite « minute » ↔ « minuit » etc.), puis approché.
    for (formes, v) in longues {
        if formes.contains(&w) {
            return Some(*v);
        }
    }
    for (formes, v) in longues {
        if w.len() >= 5 && proche(w, formes) {
            return Some(*v);
        }
    }
    None
}

fn mot_lex(l: Option<&(Lex, usize)>) -> &str {
    match l {
        Some((Lex::Mot(w), _)) => w.as_str(),
        _ => "",
    }
}

fn est_tous(w: &str) -> bool {
    matches!(w, "tous" | "toutes" | "toute" | "tout" | "touts" | "ttes" | "tts" | "tt" | "tte")
        || (w.starts_with('t') && w.len() >= 4 && (distance(w, "toutes") <= 2 || distance(w, "tous") <= 1))
}

fn est_chaque(w: &str) -> bool {
    matches!(w, "chaque" | "every" | "each" | "per" | "par" | "evry" | "chaqe" | "chauqe" | "chake")
        || (w.len() >= 4 && (distance(w, "chaque") <= 1 || distance(w, "every") <= 1))
}

/// Mots qui font d'un délai un moment unique (« dans 5 min », « pendant 1 h ») :
/// pas un réveil périodique, donc ambigu.
fn est_ponctuel(w: &str) -> bool {
    matches!(
        w,
        "dans" | "in" | "apres" | "after" | "pendant" | "durant" | "during" | "for" | "depuis" | "since"
            | "avant" | "before" | "ago" | "within" | "sous" | "jusqu"
    )
}

/// Un intervalle trouvé : sa valeur et l'étendue de mots (connecteur compris) à retirer.
#[derive(Debug, Clone)]
struct Trouve {
    ms: f64,
    mot_debut: usize,
    mot_fin: usize,
    ponctuel: bool,
    connecteur: bool,
}

/// Quantité de temps qui commence au lexème `i` : `(ms, fin exclusive)`.
fn quantite(l: &[(Lex, usize)], i: usize) -> Option<(f64, usize)> {
    let word = |k: usize| mot_lex(l.get(k));
    // « demi-heure », « half an hour », « half hour »
    if matches!(word(i), "demi" | "demie" | "half") {
        let mut j = i + 1;
        if matches!(word(j), "an" | "a") {
            j += 1;
        }
        if let Some(u) = unite(word(j), true) {
            return Some((u / 2.0, j + 1));
        }
    }
    // « quart d'heure », « quarter of an hour », « quarter hour »
    if matches!(word(i), "quart" | "quarter") {
        let mut j = i + 1;
        while matches!(word(j), "d" | "de" | "of" | "an" | "a") {
            j += 1;
        }
        if unite(word(j), true) == Some(HEURE) {
            return Some((HEURE / 4.0, j + 1));
        }
    }
    let Some((Lex::Num(n), _)) = l.get(i) else { return None };
    let mut u = unite(word(i + 1), false)?;
    let mut ms = n * u;
    let mut j = i + 2;
    loop {
        match l.get(j) {
            // « 1h30min », « 2 min 30 s »
            Some((Lex::Num(n2), _)) => {
                if let Some(u2) = unite(word(j + 1), false).filter(|u2| *u2 < u) {
                    ms += n2 * u2;
                    u = u2;
                    j += 2;
                } else if u == HEURE || u == MIN {
                    // « 1h30 », « 2m30 » : l'unité suivante est sous-entendue
                    let sous = if u == HEURE { MIN } else { SEC };
                    ms += n2 * sous;
                    u = sous;
                    j += 1;
                } else {
                    break;
                }
            }
            // « 1 heure et demie », « an hour and a half », « 2 h et quart »
            Some((Lex::Mot(w), _)) if w == "et" || w == "and" => {
                let mut k = j + 1;
                if word(k) == "a" {
                    k += 1;
                }
                match word(k) {
                    "demi" | "demie" | "half" => {
                        ms += u / 2.0;
                        j = k + 1;
                    }
                    "quart" | "quarter" => {
                        ms += u / 4.0;
                        j = k + 1;
                    }
                    _ => break,
                }
                break;
            }
            _ => break,
        }
    }
    Some((ms, j))
}

fn trouver_intervalles(l: &[(Lex, usize)]) -> Vec<Trouve> {
    let word = |k: usize| mot_lex(l.get(k));
    let mut out = Vec::new();
    let mut i = 0;
    while i < l.len() {
        // Mots-fréquences tout faits.
        let tout_fait = match word(i) {
            "hourly" | "horaire" => Some(HEURE),
            "daily" | "quotidien" | "quotidienne" | "quotidiennement" | "journalier" => Some(JOUR),
            "weekly" | "hebdo" | "hebdomadaire" => Some(7.0 * JOUR),
            _ => None,
        };
        let (ms, fin, avec_nombre) = if let Some(ms) = tout_fait {
            (ms, i + 1, true)
        } else if let Some((ms, fin)) = quantite(l, i) {
            (ms, fin, true)
        } else if let Some(u) = unite(word(i), true) {
            (u, i + 1, false) // unité seule : n'en est une qu'après un connecteur
        } else {
            i += 1;
            continue;
        };
        // Connecteur avant : « toutes les », « chaque », « every », « à chaque »,
        // « une fois par », « N fois par » (fréquence), « once a ».
        let mut debut = i;
        let mut ms = ms;
        let mut connecteur = false;
        let mut ponctuel = false;
        if i >= 1 {
            let p1 = word(i - 1);
            if matches!(p1, "les" | "le" | "lse" | "lees") && i >= 2 && est_tous(word(i - 2)) {
                debut = i - 2;
                connecteur = true;
            } else if est_tous(p1) || matches!(p1, "all") {
                debut = i - 1;
                connecteur = true;
            } else if est_chaque(p1) {
                debut = i - 1;
                connecteur = true;
                // « N fois par heure », « 3 times per hour »
                if matches!(p1, "par" | "per") && i >= 3 && matches!(word(i - 2), "fois" | "times") {
                    if let Some((Lex::Num(k), _)) = l.get(i - 3) {
                        if *k > 0.0 {
                            ms /= k;
                            debut = i - 3;
                        }
                    }
                } else if matches!(p1, "par" | "per") && i >= 3 && matches!(word(i - 2), "fois" | "time") && word(i - 3) == "une" {
                    debut = i - 3;
                }
                if debut >= 1 && matches!(word(debut - 1), "a") {
                    debut -= 1; // « à chaque »
                }
            } else if matches!(p1, "a" | "an") && i >= 2 && matches!(word(i - 2), "once" | "twice") {
                if word(i - 2) == "twice" {
                    ms /= 2.0;
                }
                debut = i - 2;
                connecteur = true;
            } else if est_ponctuel(p1) {
                ponctuel = true;
            }
        }
        // Après : « 3 fois par … » déjà traité ; « par 5 min » non.
        if !avec_nombre && !connecteur {
            i += 1;
            continue;
        }
        out.push(Trouve { ms, mot_debut: l[debut].1, mot_fin: l[fin - 1].1, ponctuel, connecteur });
        i = fin;
    }
    out
}

/// `90 000` → « 1 min 30 s ».
pub fn decrire_duree(ms: u64) -> String {
    if ms < 1_000 {
        return format!("{ms} ms");
    }
    let mut s = ms / 1_000;
    let mut parts = Vec::new();
    for (n, u) in [(86_400, "j"), (3_600, "h"), (60, "min"), (1, "s")] {
        if s >= n {
            parts.push(format!("{} {u}", s / n));
            s %= n;
        }
    }
    parts.join(" ")
}

// ---------------------------------------------------------------- /heartbeat

const MOTS_ARRET: &[&str] = &[
    "stop", "stoppe", "stopper", "stoppes", "arrete", "arreter", "arretes", "arret", "off", "coupe", "couper",
    "coupes", "desactive", "desactiver", "desactives", "clear", "efface", "effacer", "supprime", "supprimer",
    "annule", "annuler", "cancel", "disable", "remove", "delete", "kill", "fin", "termine", "terminer", "halt",
    "enleve", "enlever", "retire", "retirer", "vire", "virer", "non", "no", "plus",
];
const MOTS_REMPLISSAGE_ARRET: &[&str] = &[
    "le", "la", "les", "l", "ce", "cet", "cette", "mon", "ton", "heartbeat", "heartbeats", "reveil", "reveils",
    "ping", "rappel", "rappels", "timer", "minuteur", "un", "the", "it", "this", "ca", "cela", "tout", "stp",
    "svp", "please", "moi", "me", "maintenant", "now", "merci", "et", "de", "du", "des", "any", "more",
    "tu", "peux", "can", "you", "all", "message", "messages",
];
const MOTS_AFFICHER: &[&str] = &["status", "statut", "etat", "show", "voir", "affiche", "quoi", "info", "infos", "liste", "list"];

/// Analyse `/heartbeat <texte libre>` (`texte` = tout ce qui suit la commande).
pub fn analyser_heartbeat(texte: &str) -> IntentionReveil {
    let ws = mots(texte);
    let utiles: Vec<&str> = ws.iter().map(|m| m.norm.as_str()).filter(|w| !w.is_empty()).collect();
    if utiles.is_empty() {
        return if texte.trim().is_empty() || texte.contains('?') {
            IntentionReveil::Afficher
        } else {
            IntentionReveil::Flou { raison: "demande vide".into() }
        };
    }
    if utiles.iter().all(|w| MOTS_AFFICHER.contains(w) || MOTS_REMPLISSAGE_ARRET.contains(w))
        && utiles.iter().any(|w| MOTS_AFFICHER.contains(w))
    {
        return IntentionReveil::Afficher;
    }
    let lx = lexemes(&ws);
    let mut trouves = trouver_intervalles(&lx);
    let premier_arret = utiles
        .iter()
        .find(|w| !MOTS_REMPLISSAGE_ARRET.contains(w))
        .is_some_and(|w| proche(w, MOTS_ARRET));
    // Compatibilité : `/heartbeat 90 message` = 90 secondes.
    if trouves.is_empty() {
        if let Some((Lex::Num(n), 0)) = lx.first() {
            if ws[0].norm.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
                trouves.push(Trouve { ms: n * SEC, mot_debut: 0, mot_fin: 0, ponctuel: false, connecteur: false });
            }
        }
    }
    if trouves.is_empty() {
        if premier_arret {
            return IntentionReveil::Arreter;
        }
        return IntentionReveil::Flou { raison: "aucun intervalle reconnu".into() };
    }
    if premier_arret {
        return IntentionReveil::Flou { raison: "arrêt demandé avec un intervalle".into() };
    }
    // Plusieurs intervalles : on garde celui annoncé par un connecteur s'il est seul.
    if trouves.len() > 1 {
        let avec: Vec<Trouve> = trouves.iter().filter(|t| t.connecteur).cloned().collect();
        if avec.len() == 1 {
            trouves = avec;
        } else {
            return IntentionReveil::Flou { raison: "plusieurs intervalles dans la demande".into() };
        }
    }
    let t = &trouves[0];
    if t.ponctuel {
        return IntentionReveil::Flou { raison: "délai unique (« dans … », « pendant … »), pas un intervalle répété".into() };
    }
    let reste: Vec<Mot> = ws
        .iter()
        .enumerate()
        .filter(|(k, _)| *k < t.mot_debut || *k > t.mot_fin)
        .map(|(_, m)| m.clone())
        .collect();
    let message = nettoyer_message(reste);
    if message.is_empty() {
        return IntentionReveil::Flou { raison: "intervalle compris mais aucun message".into() };
    }
    IntentionReveil::Poser { interval_ms: t.ms.round() as u64, message }
}

fn est_ponctuation(m: &Mot) -> bool {
    m.norm.is_empty()
}

/// Retire les tournures d'introduction (« dis », « écris », « print », « mets un
/// réveil qui dit », « peux-tu », « stp »…), la ponctuation et les guillemets de bord.
fn nettoyer_message(mut ws: Vec<Mot>) -> String {
    const POLITESSE: &[&str] = &["stp", "svp", "please", "pls", "plz", "merci", "thanks", "peux-tu", "pourrais-tu", "veux-tu", "tu", "peux", "pourrais", "can", "could", "you", "would", "will", "s'il", "te", "plait", "plaît", "vous", "plait,"];
    const DECLENCHEURS: &[&str] = &["mets", "met", "mettre", "lance", "lancer", "installe", "installer", "programme", "programmer", "cree", "creer", "ajoute", "ajouter", "fais", "fait", "set", "start", "add", "create", "make", "configure", "pose", "poser", "active", "activer"];
    const ARTICLES: &[&str] = &["un", "une", "le", "la", "a", "an", "the", "mon", "my"];
    const OBJETS: &[&str] = &["reveil", "heartbeat", "rappel", "ping", "timer", "minuteur", "alarme", "alarm", "reminder"];
    const LIENS: &[&str] = &["qui", "pour", "to", "that", "de", "d", "avec", "with", "afin", "and", "et", "en", "disant", "saying", "message", "le", "texte", "text", "que", "me", "moi", "m"];
    const DIRE: &[&str] = &[
        "dis", "dit", "dire", "dis-moi", "dit-moi", "di", "dits", "ecris", "ecrit", "ecrire", "ecris-moi", "print", "prints",
        "printe", "say", "says", "affiche", "afficher", "affiches", "envoie", "envoyer", "envoies", "envoie-moi", "send",
        "sends", "echo", "write", "writes", "repete", "repeter", "tape", "taper", "type", "log", "crie", "rappelle-moi",
        "rappelle", "previens-moi", "previens",
    ];
    let norm = |m: &Mot| m.norm.clone();
    let enlever_bord = |ws: &mut Vec<Mot>, set: &[&str]| {
        let mut fait = false;
        while ws.first().is_some_and(|m| est_ponctuation(m) || set.contains(&m.norm.as_str())) {
            ws.remove(0);
            fait = true;
        }
        fait
    };
    loop {
        let avant = ws.len();
        enlever_bord(&mut ws, POLITESSE);
        // « mets un réveil (qui dit) … »
        if ws.first().is_some_and(|m| DECLENCHEURS.contains(&norm(m).as_str())) {
            let mut k = 1;
            while ws.get(k).is_some_and(|m| ARTICLES.contains(&m.norm.as_str())) {
                k += 1;
            }
            if ws.get(k).is_some_and(|m| OBJETS.contains(&m.norm.as_str())) {
                ws.drain(..=k);
                enlever_bord(&mut ws, LIENS);
            }
        } else if ws.first().is_some_and(|m| ARTICLES.contains(&m.norm.as_str()))
            && ws.get(1).is_some_and(|m| OBJETS.contains(&m.norm.as_str()))
        {
            ws.drain(..=1);
            enlever_bord(&mut ws, LIENS);
        }
        if ws.first().is_some_and(|m| DIRE.contains(&m.norm.as_str())) && ws.len() > 1 {
            ws.remove(0);
            enlever_bord(&mut ws, &["moi", "me", "m", "nous", "us", "le", "message", "texte", "text", "que", "that", "juste", "just", "simplement", "simply", "the", ":", "-"]);
        }
        if ws.len() == avant {
            break;
        }
    }
    // Fin : politesse et ponctuation de liaison.
    while ws.last().is_some_and(|m| est_ponctuation(m) && !m.orig.contains(['?', '!', '.']) || POLITESSE.contains(&m.norm.as_str()) || matches!(m.norm.as_str(), "et" | "and" | "s'il")) {
        ws.pop();
    }
    let mut s = ws.iter().map(|m| m.orig.as_str()).collect::<Vec<_>>().join(" ");
    s = s.trim().trim_end_matches([',', ';', ':', '-', '—']).trim().to_string();
    s = s.trim_start_matches([',', ';', ':', '-', '—']).trim().to_string();
    // Guillemets de bord.
    for (a, b) in [("«", "»"), ("\"", "\""), ("'", "'"), ("“", "”"), ("‘", "’")] {
        if s.len() >= 2 && s.starts_with(a) && s.ends_with(b) {
            s = s[a.len()..s.len() - b.len()].trim().to_string();
        }
    }
    s
}

// ---------------------------------------------------------------- /goal

const OBJ_EFFACER: &[&str] = &["clear", "off", "stop", "efface", "effacer", "effaces", "supprime", "supprimer", "annule", "annuler", "delete", "remove", "reset", "vide", "vider", "enleve", "enlever", "retire", "retirer", "oublie", "oublier", "cancel", "arrete", "arreter", "abandonne", "abandonner", "drop"];
const OBJ_PAUSE: &[&str] = &["pause", "suspend", "suspends", "suspendre", "hold", "attends", "attendre", "attente", "pauser"];
const OBJ_REPRENDRE: &[&str] = &["resume", "reprends", "reprend", "reprendre", "continue", "continuer", "continues", "relance", "relancer", "reactive", "reactiver", "unpause", "restart", "redemarre", "repart", "repars"];
const OBJ_TERMINE: &[&str] = &["done", "complete", "completed", "fini", "finie", "finished", "termine", "terminee", "terminer", "atteint", "atteinte", "reached", "accompli", "acheve", "achevee", "fait", "faite", "bon", "ok", "reussi", "success"];
const OBJ_REMPLISSAGE: &[&str] = &["le", "la", "l", "mon", "ton", "notre", "the", "my", "our", "objectif", "goal", "but", "est", "c", "c'est", "cest", "is", "it", "its", "it's", "en", "mets", "met", "mettre", "put", "on", "stp", "svp", "please", "merci", "maintenant", "now", "tout", "a", "ete", "been", "has", "as", "ca", "cela", "this", "that", "marque", "marquer", "mark", "comme", "travail", "boulot", "work", "tache", "task", "de", "du", "vas-y", "go", "y", "on", "peux", "tu", "can", "you", "bien", "deja", "already", "et", "and", "voila", "the"];

fn categorie_objectif(w: &str, approche: bool) -> Option<u8> {
    let w = w.trim_matches('\'');
    for (k, set) in [(1u8, OBJ_EFFACER), (2, OBJ_PAUSE), (3, OBJ_REPRENDRE), (4, OBJ_TERMINE)] {
        if set.contains(&w) {
            return Some(k);
        }
    }
    for (k, set) in [(1u8, OBJ_EFFACER), (2, OBJ_PAUSE), (3, OBJ_REPRENDRE), (4, OBJ_TERMINE)] {
        if approche && w.len() >= 5 && proche(w, set) {
            return Some(k);
        }
    }
    None
}

/// `200k`, `1,5M`, `200_000`, `200000` → nombre de jetons.
fn nombre_jetons(w: &str) -> Option<u64> {
    let w = normaliser(w).replace(['_', '\u{a0}', '\u{202f}'], "");
    let w = w.trim_matches(|c: char| !c.is_alphanumeric());
    let (num, mult) = if let Some(n) = w.strip_suffix('k') {
        (n, 1_000.0)
    } else if let Some(n) = w.strip_suffix('m') {
        (n, 1_000_000.0)
    } else {
        (w, 1.0)
    };
    let n: f64 = num.replace(',', ".").parse().ok()?;
    (n > 0.0).then(|| (n * mult) as u64)
}

/// Retire le budget de la phrase : `--budget N`, « budget 200k », « avec un budget de
/// 200 000 jetons », « max 50k tokens », « 1M de jetons ».
fn extraire_budget(ws: &mut Vec<Mot>) -> Option<u64> {
    let mut i = 0;
    while i < ws.len() {
        let w = ws[i].norm.as_str();
        let cle = matches!(w, "budget" | "-budget" | "--budget" | "max" | "maximum" | "limite" | "limit") || ws[i].orig == "--budget";
        let mut j = i + if cle { 1 } else { 0 };
        if cle {
            while ws.get(j).is_some_and(|m| matches!(m.norm.as_str(), "de" | "of" | "a" | "" | "=" | "en")) {
                j += 1;
            }
        }
        if let Some(mut n) = ws.get(j).and_then(|m| nombre_jetons(&m.orig)) {
            let mut fin = j;
            // « 200 000 »
            while ws.get(fin + 1).is_some_and(|m| m.norm.len() == 3 && m.norm.chars().all(|c| c.is_ascii_digit())) {
                n = n * 1_000 + ws[fin + 1].norm.parse::<u64>().unwrap_or(0);
                fin += 1;
            }
            let mut k = fin + 1;
            if ws.get(k).is_some_and(|m| matches!(m.norm.as_str(), "de" | "d")) {
                k += 1;
            }
            let unite_jetons = ws.get(k).is_some_and(|m| matches!(m.norm.as_str(), "jetons" | "jeton" | "tokens" | "token" | "tok" | "toks"));
            if cle || unite_jetons {
                let fin = if unite_jetons { k } else { fin };
                let mut debut = i;
                // « avec un budget de », « with a budget of », virgule avant
                while debut > 0 && matches!(ws[debut - 1].norm.as_str(), "avec" | "with" | "un" | "a" | "et" | "and" | "") {
                    debut -= 1;
                }
                ws.drain(debut..=fin);
                return Some(n);
            }
        }
        i += 1;
    }
    None
}

/// Analyse `/goal <texte libre>`.
pub fn analyser_goal(texte: &str) -> IntentionObjectif {
    let mut ws = mots(texte);
    let budget = extraire_budget(&mut ws);
    let utiles: Vec<String> = ws
        .iter()
        .flat_map(|m| m.norm.split(['\'', '-']).map(str::to_string).collect::<Vec<_>>())
        .filter(|w| !w.is_empty())
        .collect();
    let sans_remplissage: Vec<&String> = utiles.iter().filter(|w| !OBJ_REMPLISSAGE.contains(&w.as_str())).collect();
    if sans_remplissage.is_empty() {
        if budget.is_some() {
            return IntentionObjectif::Flou { raison: "budget sans texte d'objectif".into() };
        }
        // « c'est bon », « ok » : seuls des mots de remplissage qui sont aussi des mots de fin.
        if utiles.iter().any(|w| w == "bon") {
            return IntentionObjectif::Termine;
        }
        return IntentionObjectif::Afficher;
    }
    if sans_remplissage.iter().all(|w| MOTS_AFFICHER.contains(&w.as_str())) {
        return IntentionObjectif::Afficher;
    }
    let cats: Vec<Option<u8>> = sans_remplissage.iter().map(|w| categorie_objectif(w, true)).collect();
    if cats.iter().all(Option::is_some) {
        let mut distinctes: Vec<u8> = cats.iter().flatten().copied().collect();
        distinctes.sort();
        distinctes.dedup();
        // « fini » + « arrête » etc. : deux intentions contradictoires.
        if distinctes.len() == 1 {
            return match distinctes[0] {
                1 => IntentionObjectif::Effacer,
                2 => IntentionObjectif::Pause,
                3 => IntentionObjectif::Reprendre,
                _ => IntentionObjectif::Termine,
            };
        }
        return IntentionObjectif::Flou { raison: "plusieurs actions contradictoires".into() };
    }
    // Commence par un mot de commande et reste court : « termine la migration »,
    // « pause de 10 min » → ambigu (nouvel objectif ou action ?).
    let infinitif = |w: &str| w.ends_with("er") || w.ends_with("ir") || w.ends_with("dre");
    if categorie_objectif(sans_remplissage[0], false).is_some() && (sans_remplissage.len() <= 2 || (!infinitif(sans_remplissage[0]) && sans_remplissage.len() <= 4)) {
        return IntentionObjectif::Flou { raison: "action ou nouvel objectif ?".into() };
    }
    // Préfixes « objectif : », « nouvel objectif », « goal: ».
    while ws.first().is_some_and(|m| {
        matches!(m.norm.as_str(), "objectif" | "goal" | "nouvel" | "nouveau" | "new" | "le" | "mon" | "l'objectif" | "" | "set" | "mets" | "fixe")
    }) && ws.len() > 1
    {
        ws.remove(0);
    }
    let texte = ws.iter().map(|m| m.orig.as_str()).collect::<Vec<_>>().join(" ");
    let texte = texte.trim().trim_start_matches([':', '-', ',']).trim().trim_end_matches([',', ';']).trim().to_string();
    if texte.is_empty() {
        return IntentionObjectif::Flou { raison: "objectif vide".into() };
    }
    IntentionObjectif::Poser { texte, budget }
}


#[cfg(test)]
mod tests {
    use super::*;
    use IntentionObjectif as O;
    use IntentionReveil as R;

    fn pose(t: &str) -> (u64, String) {
        match analyser_heartbeat(t) {
            R::Poser { interval_ms, message } => (interval_ms, message),
            autre => panic!("« {t} » : {autre:?}"),
        }
    }

    #[test]
    fn heartbeat_exemples_reels_et_variantes() {
        let cas: &[(&str, u64, &str)] = &[
            // exemples refusés par la 0.1.62
            ("dis coucou touets les 5secondes", 5_000, "coucou"),
            ("print coucou toutes les 5s", 5_000, "coucou"),
            // format historique
            ("1m coucou", 60_000, "coucou"),
            ("10m check CI", 600_000, "check CI"),
            ("90 vérifie", 90_000, "vérifie"),
            // variantes
            ("toutes les 5 secondes dis coucou", 5_000, "coucou"),
            ("tous les 2 min vérifie la CI", 120_000, "vérifie la CI"),
            ("chaque heure : relis les tickets", 3_600_000, "relis les tickets"),
            ("every 30s say hello", 30_000, "hello"),
            ("écris bonjour 5 sec", 5_000, "bonjour"),
            ("coucou 1h30", 5_400_000, "coucou"),
            ("dis-moi coucou toutes les 10 minutes stp", 600_000, "coucou"),
            ("mets un réveil toutes les 15 min qui dit « pense à boire »", 900_000, "pense à boire"),
            ("toutes les heures, regarde Zendesk", 3_600_000, "regarde Zendesk"),
            ("tous les jours fais le point", 86_400_000, "fais le point"),
            ("check the build every 5 minutes", 300_000, "check the build"),
            ("print \"ping\" every 2 mins", 120_000, "ping"),
            ("toute les 3 minuts dis salut", 180_000, "salut"),
            ("dis coucou toutes les 1 h et demie", 5_400_000, "coucou"),
            ("toutes les demi-heures vérifie la file", 1_800_000, "vérifie la file"),
            ("dis coucou chaque quart d'heure", 900_000, "coucou"),
            ("coucou 2 fois par heure", 1_800_000, "coucou"),
            ("à chaque minute, dis tic", 60_000, "tic"),
            ("hourly: résume les mails", 3_600_000, "résume les mails"),
            ("tous les 2 jours relance les factures", 172_800_000, "relance les factures"),
            ("print coucou toutes les 5 secondse", 5_000, "coucou"),
            ("dis coucou ttes les 30 s", 30_000, "coucou"),
            ("toutes les cinq minutes dis coucou", 300_000, "coucou"),
            ("say hi once an hour", 3_600_000, "hi"),
        ];
        for (t, ms, msg) in cas {
            assert_eq!(pose(t), (*ms, msg.to_string()), "« {t} »");
        }
    }

    #[test]
    fn heartbeat_arret_affichage_flou() {
        for t in ["stop", "off", "arrête", "arrete le réveil", "coupe", "désactive", "désactive le heartbeat stp", "plus de réveil", "arrête de dire coucou", "clear", "cancel it", "arête"] {
            assert_eq!(analyser_heartbeat(t), R::Arreter, "« {t} »");
        }
        for t in ["", "?", "statut", "show"] {
            assert_eq!(analyser_heartbeat(t), R::Afficher, "« {t} »");
        }
        for t in ["dis coucou", "vérifie la CI", "toutes les 5 minutes", "dis coucou dans 5 minutes", "arrête dans 10 min", "toutes les 5 min et toutes les 10 min dis x"] {
            assert!(matches!(analyser_heartbeat(t), R::Flou { .. }), "« {t} » : {:?}", analyser_heartbeat(t));
        }
        // Sous le minimum : rendu tel quel, l'appelant prévient l'utilisateur.
        assert_eq!(pose("dis coucou toutes les 2 secondes").0, 2_000);
    }

    #[test]
    fn goal_langage_naturel() {
        let cas: &[(&str, O)] = &[
            ("", O::Afficher),
            ("pause", O::Pause),
            ("mets en pause", O::Pause),
            ("mets l'objectif en pause stp", O::Pause),
            ("reprends", O::Reprendre),
            ("resume", O::Reprendre),
            ("reprend le travail", O::Reprendre),
            ("c'est fini", O::Termine),
            ("termine", O::Termine),
            ("terminé !", O::Termine),
            ("done", O::Termine),
            ("c'est bon", O::Termine),
            ("objectif atteint", O::Termine),
            ("efface", O::Effacer),
            ("efface l'objectif", O::Effacer),
            ("clear", O::Effacer),
            ("supprime tout", O::Effacer),
            ("stop", O::Effacer),
        ];
        for (t, attendu) in cas {
            assert_eq!(&analyser_goal(t), attendu, "« {t} »");
        }
        assert_eq!(analyser_goal("finir le lot 3"), O::Poser { texte: "finir le lot 3".into(), budget: None });
        assert_eq!(analyser_goal("supprimer les doublons du CRM"), O::Poser { texte: "supprimer les doublons du CRM".into(), budget: None });
        assert_eq!(analyser_goal("--budget 50000 relire le module"), O::Poser { texte: "relire le module".into(), budget: Some(50_000) });
        assert_eq!(analyser_goal("migrer la base avec un budget de 200k jetons"), O::Poser { texte: "migrer la base".into(), budget: Some(200_000) });
        assert_eq!(analyser_goal("objectif : corriger les tests, max 1,5M tokens"), O::Poser { texte: "corriger les tests".into(), budget: Some(1_500_000) });
        assert_eq!(analyser_goal("ranger le dépôt 200 000 jetons"), O::Poser { texte: "ranger le dépôt".into(), budget: Some(200_000) });
        for t in ["termine la migration", "pause et reprends", "fini, efface", "pause de 10 min", "budget 10k"] {
            assert!(matches!(analyser_goal(t), O::Flou { .. }), "« {t} » : {:?}", analyser_goal(t));
        }
    }

    #[test]
    fn durees() {
        assert_eq!(decrire_duree(5_000), "5 s");
        assert_eq!(decrire_duree(5_400_000), "1 h 30 min");
        assert_eq!(decrire_duree(86_400_000), "1 j");
    }
}

// ---------------------------------------------------------------- /guet (axe:guet)

/// Ce que veut l'utilisateur avec `/guet …`.
#[derive(Debug, Clone, PartialEq)]
pub enum IntentionGuet {
    /// `/guet`, `/guet ?`, `/guet liste` : montrer les guets en cours.
    Afficher,
    /// « annule », « stop », « arrête g1a2b3c » (`None` = tous).
    Annuler { id: Option<String> },
    /// Commande explicite entre accents graves : à lancer (`condition` = relancer
    /// jusqu'à ce qu'elle réussisse).
    Commande { cmd: String, condition: bool },
    /// Phrase libre (« quand la construction github est finie ») : à confier à l'agent.
    Flou { raison: String },
}

const MOTS_ANNULER_GUET: &[&str] = &[
    "annule", "annuler", "annules", "annulez", "anule", "anuler", "anulle", "anuller", "cancel", "stop", "stoppe", "arrete", "arreter", "arretes",
    "off", "coupe", "couper", "supprime", "supprimer", "enleve", "retire", "efface", "vide",
];
const MOTS_CONDITION_GUET: &[&str] = &[
    "reussit", "reussisse", "reussi", "passe", "passent", "marche", "fonctionne", "repond", "reponde",
    "vrai", "ok", "disponible", "dispo", "succeeds", "passes", "works", "responds", "true", "jusqu'a",
    "until", "existe",
];

fn id_guet(w: &str) -> bool {
    w.len() == 7 && w.starts_with('g') && w[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Analyse `/guet <texte libre>`.
pub fn analyser_guet(texte: &str) -> IntentionGuet {
    let brut = texte.trim();
    let norm = normaliser(brut);
    let mots: Vec<String> = norm
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '!' | '.' | '?' | ':' | '«' | '»' | '"'))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    if mots.is_empty() || mots.iter().all(|w| MOTS_AFFICHER.contains(&w.as_str()) || ["les", "guets", "guet", "en", "cours", "mes"].contains(&w.as_str())) {
        return IntentionGuet::Afficher;
    }
    // Commande explicite : `…` (le seul endroit où l'on ne devine pas).
    let commande = brut.split('`').nth(1).map(str::trim).filter(|c| !c.is_empty() && brut.matches('`').count() >= 2);
    let premier = mots.iter().find(|w| !["le", "la", "les", "ce", "mon", "tous", "tout", "guet", "guets", "s'il", "te", "plait", "stp"].contains(&w.as_str()));
    if commande.is_none() && premier.is_some_and(|w| proche(w, MOTS_ANNULER_GUET)) {
        let id = mots.iter().find(|w| id_guet(w)).cloned();
        return IntentionGuet::Annuler { id };
    }
    if let Some(cmd) = commande {
        let hors: String = brut.split('`').enumerate().filter(|(i, _)| i % 2 == 0).map(|(_, s)| s).collect::<Vec<_>>().join(" ");
        let condition = normaliser(&hors)
            .split(|c: char| !(c.is_alphanumeric() || c == '\''))
            .any(|w| MOTS_CONDITION_GUET.contains(&w));
        return IntentionGuet::Commande { cmd: cmd.to_string(), condition };
    }
    IntentionGuet::Flou { raison: "pas de commande explicite entre accents graves".into() }
}

#[cfg(test)]
mod tests_guet {
    use super::*;
    use IntentionGuet as G;

    #[test]
    fn guet_en_langage_courant() {
        assert_eq!(analyser_guet(""), G::Afficher);
        assert_eq!(analyser_guet("liste"), G::Afficher);
        assert_eq!(analyser_guet("annule"), G::Annuler { id: None });
        assert_eq!(analyser_guet("anulle tout"), G::Annuler { id: None });
        assert_eq!(analyser_guet("arrête le guet g1a2b3c"), G::Annuler { id: Some("g1a2b3c".into()) });
        assert_eq!(analyser_guet("stop"), G::Annuler { id: None });
        assert_eq!(analyser_guet("quand `cargo build` est fini"), G::Commande { cmd: "cargo build".into(), condition: false });
        assert_eq!(analyser_guet("dès que `curl -f http://x` répond"), G::Commande { cmd: "curl -f http://x".into(), condition: true });
        assert!(matches!(analyser_guet("quand la construction github est finie"), G::Flou { .. }));
    }
}

//! System prompt for the single-tool REPL agent.

use serde_json::{json, Value};
use axecode_core::ToolDescriptor;

pub const PYTHON_TOOL: &str = "python";

pub const BASE_PROMPT: &str = r#"Tu es SavIDE, un agent de développement qui travaille au moyen d'un REPL Python persistant.

# L'outil python
Tu as un seul outil : `python(code)`. Il exécute `code` dans un noyau IPython persistant, propre à cette session :
- L'état persiste entre les appels (variables, imports, fonctions, sessions ouvertes). Appuie-toi dessus au lieu de tout recalculer.
- Le répertoire de travail du noyau est la racine de l'espace. Les chemins sont relatifs à elle, sauf s'ils sont absolus.
- Le résultat montre stdout, stderr, la valeur de la dernière expression et les erreurs, tronqués avec des compteurs quand ils sont longs. N'affiche que l'utile ; garde les gros volumes dans des variables et inspecte-en des extraits.
- Module `cua` (préchargé) : pilote le bureau de ce PC (snapshot, click, type_text, fenêtres) via le cua-driver fourni. Ne l'utilise QUE si l'utilisateur le demande explicitement.
- Les commandes magiques IPython et `!cmd` marchent, mais préfère le module `shell` pour les commandes (sessions persistantes, délais, sortie propre).
- Il n'y a pas de console : n'appelle jamais `input()` et ne lance aucun programme qui attend le clavier. Si tu appelles `subprocess` directement, passe `stdin=subprocess.DEVNULL` et un `timeout`.
- Préfère une cellule bien construite à beaucoup de petites ; regroupe les lectures et modifications liées dans un seul appel.
- N'affiche jamais de secret. Le code tourne avec les droits de l'utilisateur : ce n'est pas un bac à sable, sois prudent avec les opérations destructrices.

# Façon de travailler
- Examine avant de modifier : lis le code concerné, puis agis. Vérifie tes changements (construction, tests) quand c'est important.
- Modifie les fichiers avec `files.edit` (remplacements exacts, dans l'ordre) ou `files.write` ; les deux refusent d'écraser un fichier modifié depuis ta dernière lecture.
- `files.read` rend aussi le texte des fichiers xlsx, docx, pdf, pptx, odt/ods/odp et epub (lecture seule : crée les nouveaux documents avec des bibliothèques Python).
- Suis le travail en plusieurs étapes avec `todo` ; ne pose une question à l'utilisateur avec `question` que si la décision lui revient vraiment.
- Tiens l'utilisateur informé par des messages courts et précis. Réponds dans la langue de l'utilisateur.
- Quand le travail est fini, réponds par un message final concis (ce qui a changé, ce qui a été vérifié, ce qui reste). N'annonce jamais un succès que tu n'as pas vérifié.

# Contexte de la session
Chaque tour peut porter des blocs de rappel après ce prompt : la couche du harnais (notes de prompt puis mémoires, globales puis du projet, chacune avec son id), puis une partie « État actuel de la session » avec la liste de tâches, les messages des pairs en attente, l'état automatique de vos sous-agents en cours (rafraîchi toutes les quelques minutes), l'objectif actif et son budget, les messages du heartbeat (qui peuvent arriver à la fin du dernier message de l'utilisateur) et les réveils des guets (message <guet> : la tâche guettée est finie). Traite-les comme l'état actuel, pas comme des demandes de l'utilisateur, sauf s'ils disent le contraire.

# Harnais continu
Ce prompt de base est immuable ; ce que tu apprends vit dans le harnais (module `harness`, quand il est activé) : notes de prompt, mémoires, skills (Markdown + paquet Python importable dans le noyau) et profils de sous-agents, de portée globale ou projet. Enregistre les leçons durables et étayées (corrections de l'utilisateur, faits récurrents du projet, procédures réutilisables) par le plus petit changement utile ; mets à jour ou supprime les entrées périmées plutôt que d'en empiler de nouvelles. N'enregistre jamais de secret.

# Sous-agents et messages
Quand il est activé, `rlm(prompt, name=..., profile=...)` lance une session enfant persistante et rend la main tout de suite ; son résultat arrive sous forme de message. Utilise des enfants pour un travail indépendant, parallélisable ou lourd en contexte, pas pour des étapes triviales. `messages.send` ne parle qu'à ton parent, tes enfants ou tes frères et sœurs. Avant de lancer beaucoup d'enfants, regarde l'avertissement de quota s'il y en a un.

# Contexte
La conversation peut être compactée ; `context` donne accès à tout l'historique, parties compactées comprises. Garde les gros résultats intermédiaires dans des variables du noyau plutôt que dans la conversation.

# Modules préchargés
Les modules ci-dessous sont déjà importés dans l'espace de noms du noyau. Appelle `help(module.fonction)` pour le détail.
"#;

/// axe:freechat — reminder of free conversations (no project folder).
pub const SCRATCH_REMINDER: &str = "<free_conversation>\nCeci est une conversation libre : l'utilisateur n'a pas ouvert de dossier de projet. \
Le répertoire de travail est un dossier privé de cette conversation ; enregistre-y les fichiers produits \
(images, exports, scripts) et donne leur chemin. Il n'y a pas de harnais de projet : les entrées du \
harnais sont globales. Ne cherche pas de code source sauf si l'utilisateur donne un chemin.\n</free_conversation>";

/// Descriptor of the single tool exposed to the model.
pub fn python_tool() -> ToolDescriptor {
    ToolDescriptor {
        name: PYTHON_TOOL.into(),
        description: "Exécute du code Python dans le noyau IPython persistant de la session. \
            L'état persiste entre les appels. Rend stdout, stderr, la valeur de la dernière expression \
            et les erreurs (tronqués quand ils sont longs). Les modules préchargés sont décrits dans le prompt système."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Code Python à exécuter (syntaxe IPython permise)."}
            },
            "required": ["code"],
            "additionalProperties": false
        }),
    }
}

/// Renders the module catalog returned by the kernel (enabled entries only).
pub fn render_catalog(catalog: &Value) -> String {
    let mut out = String::new();
    for module in catalog.as_array().into_iter().flatten() {
        if module.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let name = module.get("name").and_then(Value::as_str).unwrap_or("");
        let doc = module.get("doc").and_then(Value::as_str).unwrap_or("");
        let summary = doc.split("\n\n").next().unwrap_or("").replace('\n', " ");
        out.push_str(&format!("\n## {name}\n{}\n", summary.trim()));
        for function in module
            .get("functions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if function.get("enabled") == Some(&Value::Bool(false)) {
                continue;
            }
            let signature = function.get("signature").and_then(Value::as_str).unwrap_or("");
            let doc = function.get("doc").and_then(Value::as_str).unwrap_or("");
            let first = doc.lines().next().unwrap_or("").trim();
            if first.is_empty() {
                out.push_str(&format!("- `{name}.{signature}`\n"));
            } else {
                out.push_str(&format!("- `{name}.{signature}` — {first}\n"));
            }
        }
    }
    out
}

/// Full system prompt: base + catalog + per-turn reminder blocks.
#[allow(dead_code)]
pub fn system_prompt(catalog: &str, extra: Option<&str>, reminders: &[String]) -> String {
    system_prompt_split(catalog, extra, reminders, &[]).0
}

/// axe:cache — heading of the per-request state at the end of the system
/// prompt. Anthropic-style providers send it after the cached prefix.
pub const VOLATILE_HEADING: &str = "# État actuel de la session (change d'une requête à l'autre)";

/// axe:cache — system prompt + byte offset of its volatile tail.
///
/// `stable` blocks (harness layer, free-conversation reminder) change at most
/// a few times per session: they stay in the cached prefix. `volatile` blocks
/// (todo list, goal budget, autonomous counters, notices, peer messages) may
/// change at every request: they go last, after [`VOLATILE_HEADING`], so that a
/// change never invalidates the cached conversation. The offset is `None` when
/// there is no volatile block.
pub fn system_prompt_split(
    catalog: &str,
    extra: Option<&str>,
    stable: &[String],
    volatile: &[String],
) -> (String, Option<usize>) {
    let mut prompt = String::from(BASE_PROMPT);
    prompt.push_str(catalog);
    if let Some(extra) = extra.filter(|e| !e.trim().is_empty()) {
        prompt.push_str("\n# Consignes de la session\n");
        prompt.push_str(extra.trim());
        prompt.push('\n');
    }
    for block in stable.iter().filter(|b| !b.trim().is_empty()) {
        prompt.push('\n');
        prompt.push_str(block.trim());
        prompt.push('\n');
    }
    let volatile: Vec<&String> = volatile.iter().filter(|b| !b.trim().is_empty()).collect();
    if volatile.is_empty() {
        return (prompt, None);
    }
    let offset = prompt.len();
    prompt.push('\n');
    prompt.push_str(VOLATILE_HEADING);
    prompt.push('\n');
    for block in volatile {
        prompt.push('\n');
        prompt.push_str(block.trim());
        prompt.push('\n');
    }
    (prompt, Some(offset))
}

#[cfg(test)]
mod split_tests {
    use super::*;

    #[test]
    fn volatile_blocks_come_after_the_stable_prefix() {
        let stable = vec!["## Global memories\n- [mem_1] fact".to_string()];
        let todo = |s: &str| vec![format!("<todo_list_state>\n- 1 [{s}] x\n</todo_list_state>")];
        let (a, at) = system_prompt_split("\n## files\n", None, &stable, &todo("pending"));
        let (b, bt) = system_prompt_split("\n## files\n", None, &stable, &todo("done"));
        let (at, bt) = (at.unwrap(), bt.unwrap());
        assert_eq!(&a[..at], &b[..bt], "the cached prefix must not depend on the todo list");
        assert!(a[..at].contains("mem_1"));
        assert!(a[at..].contains(VOLATILE_HEADING) && a[at..].contains("[pending]"));
        let (c, ct) = system_prompt_split("\n## files\n", None, &stable, &[]);
        assert_eq!(ct, None);
        assert_eq!(c.as_str(), &a[..at]);
        assert_eq!(system_prompt("\n## files\n", None, &stable), c);
    }
}

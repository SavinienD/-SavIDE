# Francisation de l'interface d'Axecode (0.1.57)

Demande de l'utilisateur (22/10/2026, 11 h 23) : « oui mets tout en français ». Toute l'interface passe en
français, sans système de traduction : les textes sont remplacés sur place, le français est la seule langue.

## Résultat (branche night-ui-fr)

- Inventaire des textes visibles en anglais : **929 avant** (e675c11 : src 643, web/src 1, Rust 285) ;
  **0 après** (src 0, web/src 0, Rust 0). **176 textes gardés en anglais exprès**, chacun avec sa raison.
  Le premier passage (b3a9ebe) annonçait 1172 textes : le détecteur, affiné ensuite, comptait alors des
  faux positifs (classes CSS, mots identiques dans les deux langues, chemins, tests Rust).
- Typographie : espace insécable avant « : ; ? ! » et « % », guillemets « », « … » au lieu de « ... »
  (246 textes corrigés par script). Nombres et unités : 12,5 s, 3,2 Mo, 1 234 jetons, dates `fr-FR`.
- Menus natifs (Fichier, Édition, Affichage, Fenêtre, Aide, Terminal) et installeur NSIS (`languages: ["French"]`).
- Banc d'affichage : 0 défaut, comme night-ui-audit au même moment (détail plus bas).

## Périmètre

- On traduit **seulement le texte visible** : contenu JSX, `title`, `aria-label`, `placeholder`, `alt`,
  `confirm`/`alert`, notifications, erreurs affichées, menus, titres de fenêtre (front `src/`, client web
  `web/src`, et ce que `src-tauri/src` montre : menus, erreurs, pages de connexion OAuth, notification du téléphone).
- On ne touche **jamais** : identifiants, clés, noms de commandes `invoke`, événements, classes CSS, `data-*`,
  valeurs comparées par le code, chemins, variables d'environnement, ni les **textes envoyés au modèle**
  (consignes système, descriptions d'outils, messages de reprise, plans).
- Noms gardés tels quels : Axecode, Axe Cloud, Claude, Opus, Sonnet, OpenAI, OpenRouter, Gemini, Kimi, Git,
  GitHub, MCP, skill(s), pull request (PR), diff, HEAD, PATH, et les autres noms de produits.

## Règles pour ne rien casser (textes comparés par le code)

- Un texte produit par le Rust, le service des espaces ou le noyau Python **et reconnu par le front**
  (`includes`, `startsWith`, `===`, regex) garde l'anglais côté producteur ; le front le traduit **après**
  l'avoir reconnu. Exemples : « a turn is already running for this conversation », « provider `x` is not
  configured », « New conversation » (titre par défaut : `src/lib/titres.ts`), résumés d'outils du moteur
  (`src/components/chat/resumesOutils.ts`, appliqué à `tool_ready`), erreurs du moteur « stream error: … »,
  « rate limited: … » (`src/lib/erreursMoteur.ts`, appliqué à l'affichage seulement : l'état garde le texte brut).
- Si un texte change des deux côtés, le front accepte **l'ancien et le nouveau** (la 0.1.57 du PC parle à
  des espaces encore en 0.1.56) : « Sub-agent » et « Sous-agent », « blocked by » et « bloquée par ».
- Avant chaque commit : `python3 ~/axe-cloud/coherence-textes.py e675c11 .` (0 CASSÉ, 0 SANS PRODUCTEUR).

## Outils

- `node scripts/francisation/inventaire.mjs` : total et nombre par fichier (`--detail`, `--blanche` : textes
  gardés et raison, `--md`, `--json <fichier>`, `--fichier <préfixe>`, `--sans-rust`). `FR_RACINE=<dossier>`
  pour inventorier un autre arbre (ex. `git archive e675c11`).
- `scripts/francisation/detecteur.cjs` : analyse l'arbre TypeScript (texte JSX, attributs, chaînes hors
  contextes muets : imports, comparaisons, `case`, types, clés, `console.*`, `invoke`/`listen`…) ; Rust :
  chaînes hors macros de journal et hors éléments `#[cfg(test)]`.
- `scripts/francisation/mots-anglais.txt` : mots anglais absents du dictionnaire français (faux amis ajoutés).
- `scripts/francisation/liste-blanche.json` : textes gardés en anglais (`texte` exact, `motif` = phrase
  entière, `terme` = mot gardé dans une phrase française, ex. « pull request »), chacun avec sa `raison`.
- `node scripts/francisation/typographie.cjs [--corriger | --accents]` : espaces insécables, guillemets,
  « … » ; `--accents` liste les mots écrits sans accent (deja → déjà). À relancer avec `--corriger` après
  une fusion qui apporte des textes.
- Garde-fous : `tests/francais.test.cjs` (aucun texte visible anglais dans `src/` et `web/src`,
  typographie à jour, liste blanche justifiée), `tests/resumesOutils.test.cjs`, `tests/titres.test.cjs`, `tests/erreursMoteur.test.cjs`.

## Lexique (une seule traduction par terme)

| Anglais | Français |
|---|---|
| Send / Settings / Provider | Envoyer / Réglages / Fournisseur |
| Connect a provider | Connecter un fournisseur |
| Model / Thinking (niveau) | Modèle / Réflexion (Désactivée, Minimale, Faible, Moyenne, Élevée, Très élevée, Maximale) |
| Message the agent… | Écrire à l'agent… |
| Thought for 12s / Worked for 2m | Réflexion : 12 s / Travail : 2 min |
| Queue / queued prompt | File d'attente / message en attente |
| Steer / Detach / Background | Orienter / Détacher / Arrière-plan |
| Compact / compaction | Compacter / compactage |
| Stop / Retry / Cancel / Close | Arrêter / Réessayer / Annuler / Fermer |
| Loading… / Untitled / New conversation | Chargement… / Sans titre / Nouvelle conversation |
| Explorer / Tools / tool call | Explorateur / Outils / appel d'outil |
| Approve / Deny | Autoriser / Refuser |
| commit / push / pull | Valider (commit) / Pousser / Récupérer |
| branch / upstream / checked out | branche / branche amont / extraite |
| worktree / repository / detached HEAD | arbre de travail / dépôt / HEAD détachée |
| Delete / Remove / Rename | Supprimer / Retirer / Renommer |
| Edit / Save / Copy / Paste / Cut | Modifier / Enregistrer / Copier / Coller / Couper |
| Refresh / Reload / Restart | Actualiser / Recharger / Redémarrer |
| Dismiss / Search / Preview / Raw | Ignorer / Rechercher / Aperçu / Source |
| Install / Update / Download | Installer / Mettre à jour (mise à jour) / Télécharger |
| Attach / attachment | Joindre / pièce jointe |
| Workspace / folder / file | Espace de travail / dossier / fichier |
| Remote (panneau) / pairing | Accès à distance / appairage |
| Sub-agent / teammate / team / swarm | Sous-agent / équipier / équipe / essaim d'agents |
| Harness / refinement / fork | Harnais / affinage / bifurquer (bifurcation) |
| Context / tokens / input / output | Contexte / jetons / entrée / sortie |
| Cache read / write · % Full | Cache lu / écrit · % utilisés |
| Rollback / rewind / checkpoint | Retour en arrière / point de reprise |
| Fast | Mode rapide |
| Todo list / task / goal | Liste de tâches / tâche / objectif |
| Reveal in Finder / Explorer | Afficher dans le Finder / dans l'Explorateur |
| Minimize / Maximize / Restore | Réduire / Agrandir / Restaurer |
| Unable to… / … failed | Impossible de… / Échec de… |
| Enter / Shift / Esc / Backspace | Entrée / Maj / Échap / Retour arrière |

## Inventaire avant (e675c11, détecteur final)

Sortie de `FR_RACINE=<e675c11> node scripts/francisation/inventaire.mjs --md` : 929 textes (15 premiers fichiers).

| Fichier | Textes anglais |
|---|---:|
| src/components/GitPanel.tsx | 124 |
| src/components/chat/ChatPane.tsx | 103 |
| src/components/SettingsPane.tsx | 97 |
| src/components/chat/stream.ts | 70 |
| src-tauri/src/providers.rs | 56 |
| src-tauri/src/git.rs | 51 |
| src-tauri/src/platform.rs | 41 |
| src/components/chat/ToolCard.tsx | 40 |
| src-tauri/src/turns.rs | 32 |
| src-tauri/src/remote.rs | 31 |
| src/components/FileTree.tsx | 20 |
| src/components/chat/TodoStrip.tsx | 19 |
| src/components/UpdaterLockScreen.tsx | 19 |
| src-tauri/src/conversations.rs | 16 |
| src/components/UpdateBadge.tsx | 15 |
| … (autres fichiers) | |
| **Total** | **929** |

Après : `Textes visibles en anglais : 0 (src : 0, web/src : 0, Rust : 0) ; gardés exprès (liste blanche) : 176`.

## Textes gardés en anglais (176, raisons principales)

| Nombre | Raison |
|---:|---|
| 38 | motifs d'erreurs anglaises du service reconnus par le code (comparaisons), et message déjà en français |
| 19 | texte envoyé au modèle (consignes, pièces jointes) |
| 14 | raison HTTP de la ligne d'état (norme du protocole, en anglais) |
| 11 | consigne envoyée au modèle |
| 9 | méthode HTTP (valeur technique) |
| 8 | reconnu par le front (Workspace.tsx, isConversationBusyError) : gardé en anglais |
| 5 | noms de modèles |
| 5 | message de panique interne (expect), jamais affiché |
| 4 | commande d'installation du serveur MCP ou nom du serveur |
| 4 | nom de l'ancien kit et de son dossier brain/ (et de son rituel « Setup-Brain ») |
| 4 | requête SQL ; titre par défaut du service, comparé par le code |
| 4 | variable d'environnement, commande ou accélérateur clavier (syntaxe Tauri) |
| 3 | aperçu de code dans l'exemple de thème (du code, pas de l'interface) |
| 3 | variable d'environnement et commande Git |

Liste complète : `node scripts/francisation/inventaire.mjs --blanche`.

## Banc d'affichage (432 rendus, puis 648 avec les libellés +30 %)

| Moment | night-ui-audit | night-ui-fr |
|---|---|---|
| 13 h 50 (e675c11 / d139d2e) | 0 défaut | 78 défauts, 1 distinct : « Aucun fichier ouvert » sur 2 lignes à 800 et 1024 px |
| après « Rien d'ouvert » (390dab5) | — | 0 défaut |
| 14 h 45 (f738a22 / 4d40921) | 0 | 0 |
| 15 h 30 (41531e4 / 199be69) | 0 | 0 |
| 15 h 50, réglages de 49df5d4 (b693661) | 0 sur 648 | 0 sur 648 |

## Restant, hors périmètre, non vérifié

- Non vérifié : rendu réel sous Windows (WebView2), menus natifs et blocs Rust `#[cfg(windows)]` /
  `#[cfg(target_os = "macos")]` (cargo check sous Linux seulement, syntaxe vérifiée par rustfmt), installeur
  NSIS français (aucun exe construit). L'installeur MSI (WiX) reste en anglais.
- Hors périmètre : le client du téléphone (`remote/public/app.js`, environ 70 textes anglais) et les
  messages des crates (`crates/*/src`) : le type d'erreur du moteur s'affiche en français (« Réponse
  interrompue : … »), mais le détail technique (fournisseur, réseau) reste en anglais.

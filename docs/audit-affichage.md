# Banc d'affichage d'Axecode (test de régression)

Le banc rend la **vraie interface de bureau** (`src/`, React) dans un Chromium sans écran
(l'appli Windows utilise WebView2, qui est un Chromium), avec le backend Tauri simulé
(`@tauri-apps/api/mocks` : commandes, fenêtres, événements). Il rejoue des scènes fidèles à
l'usage réel et contrôle automatiquement chaque rendu. Il ne remplace pas un essai sur le PC :
ce n'est pas la WebView2 de Windows.

## Commandes

```bash
# Test de régression : échoue (code 1) au premier défaut, avec la capture annotée
node scripts/audit-affichage/lancer.mjs --strict

# Audit complet : toutes les situations, captures PNG + rapport JSON (code 0)
npm run audit:affichage

# Planche avant / après pour L'utilisateur (page HTML autonome, < 15 Mo, ~10 min) :
# avant = c066912 (0.1.56), après = la branche courante
node scripts/audit-affichage/planche.mjs
```

Au premier lancement, le banc installe ses paquets (`scripts/audit-affichage/package.json` :
puppeteer-core, polices Geist) et, s'il manque, le navigateur de test `chrome-headless-shell`
(dossier `~/.cache/axecode-audit-affichage`, ou `AXECODE_AUDIT_NAVIGATEURS` ;
`AXECODE_AUDIT_CHROME` désigne un exécutable précis). Rien n'est installé dans le système.
Durée : ~1 min de construction (vite) + ~3 min 20 pour 684 rendus (19 scènes × 36 situations,
4 travailleurs).

Options utiles : `--situations 800x600,1366x768`, `--echelles 1,1.5`, `--texte 1,1.1,1.1/1.3`,
`--scenes c3,reglages`, `--sans-build` (réutilise la construction précédente),
`--travailleurs 4`, `--sortie <dossier>`, `--contour "<sélecteur CSS>"` (géométrie des
éléments, pour enquêter), `--source <révision>` (rend l'interface d'une autre version, extraite
par `git archive` dans `sortie/`, sans toucher au dépôt), `--zones <fichier.json>` (rectangles
d'éléments notés dans le rapport, pour la planche).

## Ce qui est rendu

- **Situations** (36) : fenêtre 800×600, 1024×768, 1366×768, 1920×1080 ; mise à l'échelle
  Windows 100 %, 125 %, 150 % (`deviceScaleFactor`) ; trois variantes du texte : normal,
  **agrandi de 10 %** (chaque élément reçoit sa taille de police × 1,1 : marge pour les polices
  de Windows, plus larges), et agrandi de 10 % **avec les libellés allongés de 30 %** (texte des
  boutons, onglets et titres : marge pour la traduction ; contenu, noms et identifiants non
  touchés). Option `--texte` : `a` = texte × a, `a/b` = texte × a et libellés × b.
- **Scènes** (19, `scenes.mjs`) : accueil (compte Axe Cloud connecté) ; 1, 2 et 3 colonnes de
  conversation ; colonne réduite au minimum par la poignée ; 9 onglets ; terminal ouvert ;
  explorateur détaché ; sans fournisseur (« Connect a provider ») ; tour en cours avec file
  d'attente et sous-agents (« N agent(s) au travail », Stop, Arrière-plan) ; « Arrêt forcé… » ;
  erreur de flux (« stream error: … ») et compaction ; conversation illisible dans une colonne ;
  tour de continuation enchaîné puis coupé (le texte du tour précédent doit rester visible) ;
  vue Agents ; réglages.
- **Données** (`banc/donnees.ts`) : longue conversation (réflexions « Thought for 251.2s »,
  cartes d'outils, erreurs), titre de conversation très long, barre de titre réelle (quota,
  compte, « VM ✓ »).
- Chaque scène vérifie ses **témoins** (éléments visibles repérés par sélecteur CSS, jamais par
  un libellé, que la traduction change) et le chargement des polices Geist : une scène non
  atteinte est un défaut (`scene-incomplete`). Les gestes passent aussi par des sélecteurs, des
  événements ou des raccourcis de l'appli (terminal, Ctrl + , pour les réglages, Stop).

## Contrôles (dans la page, après rendu et polices)

| Règle | Défaut |
|---|---|
| `texte-coupe` | texte rogné par un conteneur qui ne défile pas, sans « … » voulu |
| `texte-deborde` | texte qui sort de son bouton ou onglet |
| `texte-illisible` | « … » qui ne laisse pas lire 2 à 3 caractères |
| `chevauchement` | deux éléments interactifs visibles qui se recouvrent |
| `hors-ecran` / `hors-conteneur` | élément interactif en partie hors de la fenêtre, rogné / poussé hors de sa barre, ou placé au-dessus d'une zone qui défile (là où le défilement ne mène jamais) |
| `libelle-2-lignes` | libellé court de bouton, onglet ou titre sur deux lignes |
| `cible-petite` | cible cliquable de moins de 20 px (zone de clic élargie comprise) |
| `defilement-horizontal` | barre de défilement horizontale (visible) inattendue |
| `chargement-bloque` | « Ouverture de la conversation… » ou « Chargement… » encore affiché |
| `plantage` | l'écran d'erreur de l'appli s'affiche |
| `texte-disparu` | un texte de la conversation (`attendus` de la scène) n'est plus visible à l'écran |

## Exceptions

`scripts/audit-affichage/exceptions.json` : chaque exception donne la règle, un sélecteur CSS
(l'élément ou un de ses ancêtres), une `situation` facultative (expression régulière sur
`taille@échelle/scène`) et **sa raison**. Aucun défaut n'est masqué sans raison écrite.

## Sorties (ignorées par git)

- `scripts/audit-affichage/sortie/rapport.json` : défauts par rendu, par situation, par règle,
  défauts distincts avec leurs situations et une capture d'exemple.
- `scripts/audit-affichage/sortie/captures/<situation>/<scène>.png` (+ `.annote.png` : cadres
  rouges numérotés quand il y a des défauts).

## Ajouter une scène

Dans `scenes.mjs` : `stockage` (état local de l'appli : colonnes, onglets, file d'attente,
volets), `sim` (options de la simulation : fournisseur, tour, sous-agents…), gestes
(`terminal`, `elargirChat`, `reduireColonne`, `agents`, `reglages`, `arretForce`),
`evenements` (événements du moteur rejoués tels quels), `temoins` (sélecteurs) et `attendus`. Une commande Tauri non simulée renvoie `null` et apparaît dans
`commandesNonSimulees` du rapport : la simuler dans `banc/simulation.ts`.

## Planche avant / après

`node scripts/audit-affichage/planche.mjs` (ou `npm run planche` dans `scripts/audit-affichage`) :

1. rend toutes les scènes deux fois avec le banc d'aujourd'hui : l'interface **avant**
   (`--avant <révision>`, par défaut `c066912` = 0.1.56) puis celle de la **branche courante** ;
2. pour chaque correction (liste `CAS` de `planche.mjs` : scène, taille de fenêtre, zone repérée
   par sélecteur, une ligne d'explication en français simple), découpe la même zone dans les
   deux rendus, en JPEG, à 125 % ;
3. écrit `scripts/audit-affichage/sortie/planche/Axecode-affichage-avant-apres.html` : page
   autonome, images intégrées, moins de 15 Mo (la qualité JPEG baisse si besoin), avec le
   nombre de défauts avant / après par taille de fenêtre.

Après l'intégration d'autres branches (textes en français…), relancer la même commande : zones
et témoins ne dépendent pas des libellés ; une zone introuvable est signalée et la fenêtre
entière est montrée. Options : `--rapide` (seulement les situations illustrées, ~3 min),
`--sans-captures` (refait la page sans refaire les rendus), `--qualite 0.8`, `--travailleurs 4`.
Copie sur le PC, depuis Windows :
`scp <vm>:<dépôt>/scripts/audit-affichage/sortie/planche/Axecode-affichage-avant-apres.html "$env:USERPROFILE\Downloads\"`.

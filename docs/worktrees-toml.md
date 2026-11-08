# worktrees.toml — réglages des worktrees d'un dépôt

Un fichier `worktrees.toml` à la racine du dépôt (à valider dans git avec le reste) dit ce
qu'il faut faire quand on crée ou supprime un worktree depuis « Nouveau worktree » ou la liste
« Worktrees ». Sans ce fichier, rien n'est partagé ni lancé. Le dialogue « Nouveau worktree »
propose de le créer (il partage alors `node_modules` et `.env` s'ils existent).

```toml
# Branche de départ des nouveaux worktrees (sinon : réglage du dépôt, puis branche principale).
base = "main"

[scripts]
# Lancé dans le nouveau worktree, une commande par ligne ; arrêt à la première erreur.
creation = """
npm install
npm run build
"""
# Lancé avant la suppression ou l'archivage d'un worktree.
suppression = "npm run clean"

[partage]
# Partagés avec le dépôt principal par un lien (jonction sous Windows pour un dossier).
liens = ["node_modules"]
# Copiés dans chaque nouveau worktree (copie privée, modifiable sans toucher au dépôt).
copies = [".env"]

# Terminaux ouverts avec le worktree.
[[terminaux]]
nom = "Serveur"
commande = "npm run dev"
```

## Règles

- **Scripts** : chaîne sur plusieurs lignes ou liste (`creation = ["npm ci", "npm run build"]`).
  Ils tournent dans un terminal visible (carte de la tâche) : PowerShell sous Windows, le shell
  de connexion ailleurs (`$SHELL -l`). Un échec s'affiche avec « Relancer ». Variables :
  `WORKTREE_PATH` (le worktree), `WORKTREE_ROOT_PATH` (dépôt principal), `WORKTREE_BRANCH`.
- **Accord** : les commandes du fichier (scripts et terminaux) sont montrées avant de servir ;
  elles ne se lancent qu'après accord, et tout changement du fichier redemande l'accord.
- **Partage** : chemins relatifs au dépôt, sans `..` ni motif `*`. Un lien n'est créé que pour
  un chemin ignoré par git (sinon il apparaîtrait comme modifié) ; s'il est impossible, il est
  remplacé par une copie (2 Go et 50 000 fichiers au plus). Les liens sont retirés, sans jamais
  toucher leur cible, avant la suppression du worktree.
- **Terminaux** : 10 au plus ; `commande` facultative. Ils s'ouvrent la première fois qu'on
  ouvre le worktree.
- **Fichier invalide** (TOML incorrect, clé inconnue) : ignoré en entier, l'erreur s'affiche
  dans le dialogue. 256 Ko au plus.
- Noms anglais acceptés : `setup` / `archive`, `[shared]` avec `links` / `copy`,
  `[[terminals]]` avec `name` / `command`.

## orca.yaml

S'il existe, les scripts `scripts.setup` et `scripts.archive` d'un `orca.yaml` servent de
scripts de création et de suppression quand `worktrees.toml` n'en donne pas. Seules ces deux
clés sont lues ; les variables `ORCA_ROOT_PATH` et `ORCA_WORKTREE_PATH` sont alors fournies.

## Où vont les worktrees

`<dossier parent du dépôt>/<nom du dépôt>-worktrees/<branche>` (suffixe `-2`, `-3`… si le nom
est pris). La branche proposée vient du titre de la tâche (minuscules, sans accents, tirets).

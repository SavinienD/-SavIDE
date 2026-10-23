# Construire et publier l'installeur Axecode

## 1. À quoi sert ce guide

Ce guide explique comment fabriquer l'installeur de l'appli **Axecode** (une appli Tauri 2 : un cœur Rust et une interface React/TypeScript) sur Windows et sur un Mac. Il explique ensuite comment publier l'installeur sur le serveur et comment l'installer chez un utilisateur. Si vous n'avez jamais fait de build, suivez les étapes dans l'ordre.

## 2. Ce qu'il faut sur la machine

| Outil | Windows | Mac |
|---|---|---|
| Système | Windows 11 | macOS récent |
| Compilateur C++ | Visual Studio Build Tools 2022 (charge de travail C++) | Xcode Command Line Tools (`xcode-select --install`) |
| Rust | Rust (chaîne MSVC) via `rustup` | Rust via `rustup` |
| Node.js | Node.js 20 ou plus | Node.js 20 ou plus |
| Git | Git | Git |
| Navigateur intégré | WebView2 (déjà présent sur Windows 11) | inclus dans macOS |

Prévoyez de la place sur le disque et une connexion Internet : le build télécharge un Python embarqué (environ 340 Mo décompressé) et ripgrep depuis GitHub.

## 3. Construire sous Windows

Ouvrez **PowerShell**. Toutes les commandes sont à lancer dans ce terminal.

### Étape 1 — Créer le dossier de travail

```powershell
mkdir C:\Users\<moi>\axecode-build
cd C:\Users\<moi>\axecode-build
```

Remplacez `<moi>` par votre nom d'utilisateur Windows.

### Étape 2 — Apporter le code

Apportez le code depuis une **archive git de la branche**, sans `node_modules` ni `target` (ces dossiers se régénèrent). L'archive doit être décompressée dans `axecode-build`.

Sur la machine qui a le dépôt (le serveur de développement) :

```bash
git archive --format=zip -o appli.zip cloud/etape-1-appli
```

Copiez `appli.zip` dans le dossier de travail, vérifiez qu'il a la même empreinte des deux côtés (`Get-FileHash`), puis :

```powershell
Expand-Archive -LiteralPath .\appli.zip -DestinationPath .\src
cd .\src
```

### Étape 3 — Installer les dépendances JavaScript

```powershell
npm ci
```

`npm ci` installe exactement les versions listées dans le fichier de verrouillage.

### Étape 4 — Désactiver les artefacts de l'updater

Aucune clé privée de signature n'est disponible sur les machines de build. Sans elle, le build s'arrête sur une erreur de clé. On ne touche pas à `src-tauri/tauri.conf.json` : le dépôt contient déjà un fichier de surcharge, `src-tauri/tauri.build-local.json`, utilisé seulement pour ce build :

```json
{"bundle":{"createUpdaterArtifacts":false}}
```

L'extension `updater` reste active dans l'appli (l'appli s'en sert au démarrage) : elle cherche simplement une mise à jour qui n'existe pas encore, sans bloquer.

### Étape 5 — Lancer le build

```powershell
npx tauri build --bundles nsis,msi --config src-tauri/tauri.sidecars.conf.json --config src-tauri/tauri.build-local.json
```

On limite aux cibles `nsis` et `msi` (les installeurs Windows). Le premier `--config` ajoute ripgrep et le Python embarqué à l'installeur (comme la publication officielle) ; le second désactive les artefacts de l'updater. Comptez 20 à 40 minutes la première fois.

Sur le PC de build de l'équipe, tout cela est automatisé par `build.ps1` (extraction, `npm ci`, build, empreintes), lancé en tâche de fond : suivre `build.log`, résultat dans `build.etat`.

### Étape 6 — Récupérer les installeurs

Les fichiers sortent dans :

- `target\release\bundle\nsis\*.exe`
- `target\release\bundle\msi\*.msi`

Le dossier `target` est à la racine du dépôt (c'est un *workspace* Cargo : un espace de travail qui regroupe les paquets Rust), sauf si la variable `CARGO_TARGET_DIR` le déplace.

## 4. Construire sur un Mac

Ouvrez le **Terminal** (shell `zsh`).

### Étape 1 — Créer le dossier de travail

```zsh
mkdir -p ~/axecode-build
cd ~/axecode-build
```

### Étape 2 — Apporter le code

Comme sur Windows, apportez le code par une archive git de la branche, sans `node_modules` ni `target` :

```zsh
unzip appli.zip -d src && cd src
```

### Étape 3 — Installer les dépendances JavaScript

```zsh
npm ci
```

### Étape 4 — Artefacts de l'updater

Le fichier `src-tauri/tauri.build-local.json` du dépôt sert aussi sur Mac (même raison : pas de clé privée).

### Étape 5 — Choisir la cible (puce)

- Mac à **puce Apple** : cible `aarch64-apple-darwin` (par défaut).
- Mac **Intel** : cible `x86_64-apple-darwin`.

Le Python embarqué n'est téléchargé que pour l'architecture de la machine de build. Construisez donc sur le même type de Mac que vos utilisateurs. Ne fabriquez pas de binaire « universal ».

### Étape 6 — Lancer le build

```zsh
npx tauri build --bundles app,dmg --config src-tauri/tauri.sidecars.conf.json --config src-tauri/tauri.build-local.json
```

Non essayé pour l'instant (aucun Mac disponible) : à vérifier au premier build.

### Étape 7 — Récupérer l'installeur

Le fichier sort dans : `target/release/bundle/dmg/*.dmg`.

## 5. Publier sur le serveur

### Étape 1 — Copier les installeurs

Copiez les installeurs sur le serveur dans `/srv/axe/telechargements/`. Ce dossier est servi en HTTPS sous `/telechargements/`, derrière la connexion Google.

Depuis le PC de build : `scp` vers le compte d'exploitation du serveur, puis déplacement dans `/srv/axe/telechargements/` par l'administrateur (droits du dossier).

### Étape 2 — Renommer les fichiers

Renommez chaque fichier ainsi, en remplaçant `<version>` par la version du build (par exemple `0.1.51`) :

- `Axecode_<version>_x64-setup.exe`
- `Axecode_<version>_x64.msi`
- `Axecode_<version>_aarch64.dmg`

### Étape 3 — Calculer les empreintes

Une empreinte (SHA256) est une suite de caractères qui identifie le contenu d'un fichier. On l'écrit dans `SHA256SUMS.txt`, à côté des installeurs, avec une ligne par fichier au format `<empreinte>  <fichier>` (deux espaces entre les deux).

Windows (PowerShell), fichier par fichier :

```powershell
Get-FileHash -Algorithm SHA256 ".\Axecode_<version>_x64-setup.exe"
```

Mac / Linux :

```zsh
shasum -a 256 Axecode_<version>_x64-setup.exe
```

Recopiez le résultat dans `SHA256SUMS.txt`.

### Étape 4 — Vérifier le téléchargement

Après publication, téléchargez un installeur depuis l'adresse HTTPS et recalculez son empreinte (`Get-FileHash` ou `shasum -a 256`). Elle doit être identique à celle de `SHA256SUMS.txt`.

## 6. Installer chez un utilisateur

### Windows

Lancez le fichier `Axecode_<version>_x64-setup.exe` (ou le `.msi`). L'installeur n'est pas signé : **SmartScreen** affichera « éditeur inconnu ». C'est normal. Cliquez sur « Informations complémentaires » puis « Exécuter quand même ».

### Mac

Ouvrez le `.dmg` et glissez l'appli dans `/Applications`. L'appli n'est pas signée : **Gatekeeper** bloquera le premier lancement. Faites un **clic droit > Ouvrir**, ou lancez une fois :

```zsh
xattr -dr com.apple.quarantine "/Applications/Axecode.app"
```

`xattr` retire l'attribut de mise en quarantaine posé par macOS sur les fichiers téléchargés.

### Premier lancement

L'appli affiche « Se connecter avec Google ». Le navigateur s'ouvre : choisissez votre compte `@exemple.invalid`, puis revenez dans l'appli. Un lien discret « Mode local » permet de travailler hors ligne.

## 7. Problèmes fréquents

1. **Manque de place sur le disque.** Le build télécharge un Python embarqué (environ 340 Mo décompressé) et compile aussi les paquets Rust (plusieurs Go dans `target`). Libérez de la place, ou changez de disque, avant de recommencer.
2. **Téléchargement GitHub bloqué.** Le build télécharge ripgrep et le Python embarqué depuis GitHub. Vérifiez la connexion Internet, puis relancez le build.
3. **`link.exe` introuvable.** Ce message veut dire qu'il manque le compilateur C++. Installez Visual Studio Build Tools 2022 avec la charge de travail C++, puis relancez le build.
4. **WebView2 absent.** Sur Windows 11, WebView2 est déjà présent. S'il manque, installez le composant WebView2, puis relancez l'appli ou le build.
5. **`npm ci` en échec.** Vérifiez que Node.js 20 ou plus est installé et que l'archive du code contient bien le fichier de verrouillage. Supprimez `node_modules` s'il existe, puis relancez `npm ci`.
6. **Erreur « A public key has been found, but no private key ».** Le build tente de signer les artefacts de l'updater, mais la clé privée n'est pas disponible. Vérifiez que `src-tauri/tauri.build-local.json` existe et qu'il est bien passé à la commande (`--config src-tauri/tauri.build-local.json`).
7. **Le navigateur ne revient pas dans l'appli après la connexion Google.** L'appli attend sur un port local libre choisi au hasard (`127.0.0.1`), pendant 5 minutes. Un pare-feu ou un antivirus qui bloque les connexions locales empêche le retour : autorisez Axecode, puis cliquez sur « Se connecter avec Google » à nouveau.

## 8. Ce qui reste à faire plus tard

- **Signature de code Windows et macOS** : cela supprimerait les avertissements SmartScreen et Gatekeeper. Il faut un certificat de signature.
- **Mises à jour automatiques** : réactiver l'extension `updater` avec une vraie clé privée, et publier au bon endroit les fichiers de mise à jour.
- **Build Mac** : aujourd'hui le build Mac reste à faire (il doit être lancé sur un Mac, avec la même architecture que les utilisateurs). À réaliser et à vérifier.

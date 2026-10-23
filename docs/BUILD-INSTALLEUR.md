# Construire l'installeur SavIDE (Windows)

La publication officielle est automatique (voir [publier.md](publier.md)). Ce guide sert à construire un installeur à la main, sur Windows x64, pour tester.

## Prérequis

- Windows 10/11 x64, WebView2 (présent sur Windows 11).
- Visual Studio Build Tools 2022 (charge de travail C++), Rust stable (chaîne MSVC, `rustup`), Node.js 20 ou plus, Git.
- Connexion Internet : le build télécharge ripgrep et un Python embarqué (environ 340 Mo décompressé) depuis GitHub.

## Étapes (PowerShell)

```powershell
git clone https://github.com/SavinienD/-SavIDE.git savide
cd savide
npm ci
npx tauri build --bundles nsis --config src-tauri/tauri.sidecars.conf.json --config src-tauri/tauri.build-local.json
```

- `tauri.sidecars.conf.json` ajoute ripgrep, le Python embarqué et cua-driver à l'installeur.
- `tauri.build-local.json` laisse `createUpdaterArtifacts` à `true` : il faut alors la clé privée dans `TAURI_SIGNING_PRIVATE_KEY` (et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` vide). Sans clé, retirez ce `--config` et passez `--config '{"bundle":{"createUpdaterArtifacts":false}}'`.
- cua-driver : posez d'abord les `.exe` de `cua-driver-rs-0.38.0-windows-x86_64-binary.zip` (release officielle trycua/cua, SHA256 `5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5`) dans `src-tauri/binaries/cua-driver/`, comme le fait le workflow.

L'installeur sort dans `target\release\bundle\nsis\` (dossier `target` à la racine du workspace Cargo, sauf `CARGO_TARGET_DIR`).

## Installer

Lancez le `.exe`. Il n'est pas signé : SmartScreen affiche « éditeur inconnu » ; « Informations complémentaires » puis « Exécuter quand même ».

## Problèmes fréquents

1. **`link.exe` introuvable** : installer Build Tools 2022 (C++).
2. **« A public key has been found, but no private key »** : clé de signature absente ; voir ci-dessus.
3. **`npm ci` en échec** : Node 20+, supprimer `node_modules`, relancer.
4. **Téléchargement GitHub bloqué** : vérifier la connexion, relancer.

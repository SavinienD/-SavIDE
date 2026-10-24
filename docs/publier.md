# Publier SavIDE

La publication est automatique (GitHub Actions, `.github/workflows/release.yml`) dès qu'un tag `v*` est poussé.

1. Poser la version (même numéro partout) : `package.json`, `src-tauri/tauri.conf.json` et `Cargo.toml` (racine, version du workspace) (puis `npm install --package-lock-only` et `cargo update -p <crate> --offline` si besoin).
2. Commit : `git commit -am "SavIDE X.Y.Z"` puis `git push`.
3. Tag : `git tag vX.Y.Z && git push origin vX.Y.Z`.

Le workflow vérifie sur chaque système que le tag = version de `tauri.conf.json` et construit : Windows (windows-latest : NSIS signé), Linux (ubuntu-22.04 : .deb + AppImage signé), macOS (macos-latest, universal-apple-darwin : .dmg + .app.tar.gz signé ; Python embarqué rendu universel par `scripts/ci/python-universal-macos.sh`). cua-driver vient des releases officielles trycua/cua (SHA256 vérifié) pour les trois. Le job final `publier` fusionne les artefacts, écrit `latest.json` (windows-x86_64, linux-x86_64, darwin-x86_64, darwin-aarch64 ; les deux macOS pointent vers la même archive universelle) et crée la release. Les applis installées voient la mise à jour via `releases/latest/download/latest.json`.

Prérequis : secrets du dépôt `TAURI_SIGNING_PRIVATE_KEY` (contenu de la clé updater) et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (vide). Dépôt public pour que la mise à jour soit lisible.
Échec : corriger, supprimer le tag (`git push origin :vX.Y.Z`, `git tag -d vX.Y.Z`) et la release brouillon éventuelle, puis reposer le tag.

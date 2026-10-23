<p align="center">
  <img src="src-tauri/icons/axe-logo.svg" alt="Axe International" width="320" />
</p>

<h1 align="center">Axecode</h1>

<p align="center">
  <b>Le cerveau de Prime Agent dans l'IDE Axecode.</b><br/>
  Éditeur, terminal, chat et rollback d’Axecode ; REPL Python persistant, harness auto-évolutif<br/>
  et sessions qui survivent à la fermeture de l'IDE, inspirés de Prime Agent.
</p>

<p align="center">
  <code>tauri 2</code> · <code>react</code> · <code>rust</code> · <code>python / ipython</code> · <code>monaco</code> · <code>xterm</code> · <code>mcp</code>
</p>

---

> Axecode est un **fork figé** d'un IDE open source sous licence MIT (voir [Licence](#licence)). Le cordon est coupé : plus aucune
> synchronisation avec l'amont. La boucle d'agent, les outils, les modes et les providers sont désormais maintenus ici.

## Sommaire

- [Ce que fait Axecode](#ce-que-fait-axecode)
- [Architecture](#architecture)
- [Commandes de session](#commandes-de-session)
- [Providers](#providers)
- [Thème](#thème)
- [Installation](#installation)
- [Service distant](#service-distant)
- [Mises à jour et releases](#mises-à-jour-et-releases)
- [Compiler depuis les sources](#compiler-depuis-les-sources)
- [Identifiants OAuth](#identifiants-oauth)
- [Licence](#licence)

---

## Ce que fait Axecode

| Sujet | Décision |
|---|---|
| Cerveau | Prime Agent pur : le modèle n'a qu'un outil, exécuter du code dans un kernel IPython persistant. Fichiers, shell, web, images, contexte, sous-agents, harness, MCP et skills sont des modules Python préchargés. |
| Python | Embarqué dans l'installeur (sidecar) avec IPython préinstallé. |
| Sessions | Un service d'arrière-plan lancé par l'IDE possède les sessions et leurs kernels. Fermer la fenêtre ne tue rien ; rouvrir l'IDE retrouve les sessions en cours, inactives ou archivées. |
| Journal | Append-only : chaque message, appel REPL, résultat, changement de modèle et compaction est écrit au moment où il se produit. Branches et forks déplacent un pointeur ; `/tree` montre tout. |
| Harness | Notes de prompt, mémoires, skills (paquets Python importables) et spécifications de sous-agents, en portée **globale** et **projet**, stockés en Markdown éditable à la main. `/refine` relit la trajectoire courante, applique la plus petite modification utile, la journalise avec sa preuve et permet le rollback par identifiant. |
| Sous-agents | Persistants, créés depuis le REPL, messagerie limitée à la famille nucléaire. La vue Agents remplace le panneau swarm. |
| Settings > Outils | Chaque module et chaque fonction exposés dans le REPL ont un interrupteur et une description éditable. Ce qui est désactivé n'existe ni dans le kernel ni dans le prompt. |

---

## Architecture

```mermaid
flowchart LR
    subgraph IDE["Axecode (fenêtre)"]
        UI[Éditeur · Terminal · Chat · Settings]
        AV[Vue Agents]
    end
    subgraph SVC["Service d'arrière-plan"]
        S1[Session racine]
        S2[Sous-agent]
        K1[(Kernel Python)]
        K2[(Kernel Python)]
        J[(Journal append-only)]
        H[(Harness global + projet)]
    end
    UI <--> S1
    AV <--> S1
    AV <--> S2
    S1 --- K1
    S2 --- K2
    S1 <-->|messages| S2
    S1 --> J
    S1 --> H
    S1 --> P[Providers LLM]
```

- **`src/`** — UI React (Monaco, xterm, chat, settings, arbre de fichiers). `src/axe/` porte l'identité et le thème Axe.
- **`src-tauri/`** — coque Tauri 2, commandes IPC, I/O workspace, attachement au service.
- **`crates/axecode-core`** — types indépendants du provider : messages, outils, flux, modèles.
- **`crates/axecode-app`** — boucle d'agent REPL, compaction, rollback, MCP.
- **`crates/axecode-daemon`** — service d'arrière-plan, journal, cycle de vie des sessions et kernels.
- **`crates/axecode-harness`** — harness continual (notes, mémoires, skills, sous-agents) et `/refine`.
- **`crates/axecode-{anthropic,openai,google,kimi,openrouter,…}`** — adaptateurs providers.

---

## Commandes de session

| Commande | Effet |
|---|---|
| `/goal` | Objectif persistant re-présenté à chaque tour avec sa progression, budget de jetons optionnel. |
| `/autonomous` | Continuation automatique vers l'objectif, bornée par tours / jetons / durée, avec gate de qualité optionnelle. Atteindre une limite n'est jamais présenté comme un succès. |
| `/heartbeat` | Message périodique injecté dans la session. |
| `/compact` | Compaction manuelle avec directive optionnelle. |
| `/refine` | Refinement du harness à partir de la trajectoire courante. |
| `/tree` | Historique complet du journal, retour à n'importe quel point. |
| `/login`, `/settings` | Connexion provider, ouverture des réglages. |

---

## Providers

Les cinq providers d'origine et leurs flux OAuth (Anthropic, OpenAI, Google via Antigravity, Kimi, OpenRouter), plus :

- **OpenAI-compatible** et **Anthropic-compatible** personnalisés, autant d'instances qu'on veut (Ollama, LM Studio, vLLM, Together, Azure, proxies…).
- Adaptateurs natifs **Mistral**, **DeepSeek**, **xAI**, **Groq**, **Prime Inference**.
- Détection automatique d'**Ollama** et **LM Studio** locaux.
- Surcharge de fenêtre de contexte par modèle ; changement de modèle en cours de session ; indicateur de quota d'abonnement dans la barre d'état.

---

## Thème

Settings > Apparence propose un sélecteur de couleur de fond libre. Les teintes secondaires (panneaux, bordures, texte)
sont dérivées automatiquement de la luminance choisie pour rester lisibles ; l'orange Axe `#fc610b` reste la couleur
d'accent. Un bouton « Revenir au défaut Axe » restaure le thème d'origine. Le choix survit au redémarrage.

---

## Installation

Récupérez la dernière build pour votre OS sur la page des releases :
`https://github.com/AxeInternational/axecode/releases/latest`

- **macOS** — `.dmg` (universel)
- **Windows** — `.msi` / `.exe`
- **Linux** — `.AppImage` / `.deb`

L'application se met à jour seule depuis ces releases.

---

## Service distant

Le service d'arrière-plan peut tourner sur une autre machine (serveur Linux, poste fixe) ; l'IDE s'y connecte depuis **Settings > Connexions** et le **sélecteur de connexion** de la barre latérale. Conversations, vue Agents et Settings > Service s'appliquent alors à la connexion active ; la vue Agents peut afficher toutes les machines groupées. Les sessions continuent de tourner sur la machine distante quand l'IDE est fermé.

L'écoute réseau est **fermée par défaut** : seul le pipe local est actif. `--listen` expose le même protocole en WebSocket (`/ws`, plus `/healthz`). Hors loopback, le service **refuse de démarrer sans identifiants** ; l'en-tête `Host` est vérifié (anti DNS-rebinding) et toute requête relayée (`X-Forwarded-For`) exige une authentification.

```bash
# 1. identifiants (stockés hachés : argon2 pour les mots de passe, SHA-256 pour les jetons)
axecode --daemon set-password --user axe        # mot de passe lu sur stdin (ou AXECODE_PASSWORD)
axecode --daemon token --label laptop           # affiche un jeton axs_… une seule fois
axecode --daemon token list | token revoke <id> | auth

# 2. écoute (n'arrête plus seule ; --allow-host pour le nom public servi par le proxy)
axecode --daemon serve --listen 0.0.0.0:9119 --allow-host axe.example.com
```

**systemd** (`~/.config/systemd/user/axecode.service`, puis `systemctl --user enable --now axecode` et `loginctl enable-linger $USER`) :

```ini
[Unit]
Description=Axecode service
After=network-online.target

[Service]
ExecStart=/usr/bin/axecode --daemon serve --listen 127.0.0.1:9119 --allow-host axe.example.com
Restart=on-failure

[Install]
WantedBy=default.target
```

**TLS** : exposez le service derrière un reverse proxy HTTPS et laissez-le n'écouter que sur `127.0.0.1`. Exemple Caddy :

```
axe.example.com {
    reverse_proxy 127.0.0.1:9119
}
```

Dans l'IDE : connexion **Distante**, URL `https://axe.example.com` (convertie en `wss://…/ws`), identifiant + mot de passe ou jeton. Les secrets restent dans `connection-secrets.json` du dossier data de l'IDE et ne sont jamais réaffichés.

**Sans exposition réseau** : connexion **SSH** (`user@host:port`). L'IDE ouvre un tunnel avec votre client `ssh` et vos clés (agent, `~/.ssh/config` ou clé choisie), et peut lancer `axecode --daemon serve --listen 127.0.0.1:9119` sur la machine distante s'il ne répond pas. Une écoute loopback sans identifiants est acceptée ; ajoutez-en si d'autres utilisateurs ont accès à la machine.

---

## Mises à jour et releases

L'updater Tauri vérifie `https://github.com/AxeInternational/axecode/releases/latest/download/latest.json`
(voir `plugins.updater.endpoints` dans `src-tauri/tauri.conf.json` — adaptez l'organisation/dépôt si vous publiez ailleurs)
et n'accepte que des artefacts signés avec la clé publique embarquée dans ce même fichier (`plugins.updater.pubkey`).

### Clé de signature

La paire de clés a été générée avec :

```powershell
npx tauri signer generate -w src-tauri/savide-updater.key
```

- `src-tauri/savide-updater.key.pub` — clé **publique**, copiée dans `tauri.conf.json`. Elle peut être commitée.
- `src-tauri/savide-updater.key` — clé **privée**, ignorée par git (`*.key` dans `.gitignore`). **Ne la commitez jamais.**
  Conservez-la dans un gestionnaire de secrets : si elle est perdue, les postes déjà installés ne pourront plus
  accepter de mise à jour et devront réinstaller.

### Secrets GitHub à configurer

Dans *Settings → Secrets and variables → Actions* du dépôt :

| Secret | Contenu |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contenu intégral du fichier `src-tauri/savide-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | mot de passe de la clé (chaîne vide si générée sans) |

Optionnels pour la notarisation macOS : `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

### Publier une release

```powershell
# 1. bump de version (package.json, Cargo.toml [workspace.package], src-tauri/tauri.conf.json)
# 2. tag semver
git tag v0.2.0
git push --tags
```

Le workflow `.github/workflows/release.yml` construit Windows x64, macOS universel et Linux x64, signe les artefacts
d'updater, génère `latest.json`, publie le tout dans une release *draft* puis la bascule automatiquement en
*published* + *latest* une fois les trois plateformes terminées. Dès lors, les postes équipés se mettent à jour seuls.
Le workflow échoue tôt si le secret `TAURI_SIGNING_PRIVATE_KEY` n'est pas défini.

---

## Compiler depuis les sources

```powershell
# Rust 1.80+ et Node 20+ ; dépendances plateforme : https://tauri.app/start/prerequisites/
npm install
npm run tauri dev      # développement
npm run tauri build    # bundle release
```

Vérifications rapides :

```powershell
cargo check --workspace
npm run build          # tsc --noEmit && vite build
```

Régénérer le jeu d'icônes depuis le logo :

```powershell
node scripts/generate-savide-icon.mjs
npx tauri icon src-tauri/icons/savide-icon-1024.png
```

Le dépôt est un workspace Cargo (`crates/*` + `src-tauri/`) plus un frontend Vite + React (`src/`).

---

## Identifiants OAuth

Les client IDs OAuth des providers (et le client secret Google) sont embarqués dans les sources, comme le font les
« installed applications » (`gcloud`, etc.). Ils ne sont pas considérés comme secrets dans ce contexte. Le fork ne se
synchronisant plus avec l'amont, c'est à nous de suivre les évolutions des clients officiels Anthropic / OpenAI / Google.

---

## Licence

[MIT](./LICENSE) — Axecode est dérivé d’un projet libre sous licence MIT ; la notice de copyright d’origine est conservée telle quelle dans [LICENSE](./LICENSE).

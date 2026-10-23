Code map:
- L'agent doit garder à jour cette carte simple des fichiers à chaque création, suppression, renommage, déplacement ou modification.
- Version de l'application : 0.1.53 (Cargo.toml, Cargo.lock, package.json, package-lock.json et src-tauri/tauri.conf.json).

.
├── .gitignore
├── AGENTS.md
├── Cargo.lock
├── Cargo.toml
├── EDIT_FILE_HARNESS_COMPARISON.md
├── EDIT_TOOL_COMPARISON.md
├── FEATURES.md
├── GLOB_HARNESS_COMPARISON.md
├── GREP_HARNESS_COMPARISON.md
├── index.html
├── LICENSE
├── package-lock.json
├── package.json
├── RAPPORT-AXECODE.md # état du projet au point d'arrêt (15/10/2026) : fait, reste à faire, tests, actions
├── RETOURS-AXECODE.md # retours utilisateur (16/10) : correctifs et vérifications à traiter par Prime
├── README.md
├── remote # axe:cleanup — relais auto-hébergé (Docker derrière reverse proxy TLS)
│   ├── .dockerignore
│   ├── Dockerfile # node:20-alpine, port 8787, healthcheck /healthz
│   ├── docker-compose.yml # 127.0.0.1:8787, variables VAPID via .env
│   ├── README.md
│   ├── server.mjs
│   ├── package.json
│   └── public
│       ├── app.js
│       ├── index.html
│       ├── manifest.webmanifest
│       ├── styles.css
│       ├── sw.js
│       └── icons
│           └── icon.svg
├── refero-heroes
│   ├── errors.json
│   ├── metadata.json
│   └── screenshots
│       ├── 001-auros.png
│       ├── 002-gsap.png
│       ├── 003-your-workplace-has-the-answer-just-ask-dala-for-it.png
│       ├── 004-structured.png
│       ├── 005-jeton.png
│       ├── 006-air.png
│       ├── 007-reflect-notes.png
│       ├── 008-ditto.png
│       ├── 009-linear.png
│       └── 010-apple.png
├── test-stop.md
├── scripts
│   ├── capture-refero-heroes.mjs
│   ├── prepare-python.mjs # axe:repl — python-build-standalone 3.12 + IPython/dill + openpyxl/python-docx/pypdf (axe:viewers) -> src-tauri/binaries/python-runtime
│   └── prepare-sidecars.mjs
├── python # axe:repl — kernel IPython du REPL (python -m axecode_kernel)
│   ├── axecode_kernel
│   │   ├── __init__.py
│   │   ├── __main__.py # boucle JSON-lines stdin/stdout, exec, catalog, snapshot/restore dill, gc
│   │   ├── bridge.py # RPC kernel→Rust bridge.call(method, params), images, file changes
│   │   ├── files.py / shell.py / web.py / images.py / context.py / question.py / todo.py / skills.py / mcp.py / compact.py # modules préchargés
│   │   ├── _documents.py # axe:viewers — texte des xlsx/docx/pdf/pptx/odt/epub pour files.read (privé, non préchargé)
│   │   └── rlm.py / messages.py / harness.py / refine.py / goal.py / heartbeat.py # modules E/D/F (brain)
│   └── tests # pytest files + shell + documents
├── web # axe:webui — app web des conversations (Vite + React, npm run build:web -> web/dist, embarquée dans le service)
│   ├── index.html / vite.config.ts / tsconfig.json
│   ├── public # manifest.webmanifest, icon.svg, sw.js (PWA)
│   └── src
│       ├── api.ts # login HTTP + client WebSocket /ws (protocole JSON-lines du service)
│       ├── App.tsx # garde de connexion, coquille liste/conversation (responsive), route #/new (axe:freechat)
│       ├── ConversationList.tsx # recherche, filtre projet, archivées, section « Conversations libres » (axe:freechat)
│       ├── NewConversation.tsx # axe:freechat — démarrer une conversation libre (sessions.create sans dossier)
│       ├── Conversation.tsx # journal live (entry/stream), streaming
│       ├── Transcript.tsx # messages, cartes Python dépliables, réflexion repliée
│       ├── items.ts # journal -> éléments affichables
│       ├── Login.tsx / Markdown.tsx / main.tsx / styles.css
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts # axe:viewers — plugin pdfjsAssets (cmaps/polices/wasm de pdf.js servis sous /pdfjs/)
├── .github
│   ├── assets
│   │   ├── architecture.png
│   │   ├── harness.png
│   │   ├── hero.png
│   │   ├── modes.png
│   │   ├── screenshot.png
│   │   └── swarm.png
│   └── workflows
│       └── release.yml
├── crates
│   ├── axecode-anthropic
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── cli_version.rs # version Claude Code annoncée (npm registry + auto-réparation sur erreur serveur)
│   │       ├── client.rs # requêtes HTTP Anthropic, user-agent claude-cli dynamique
│   │       ├── compat.rs # axe:providers — découverte de modèles Anthropic-compatibles, usage OAuth
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── stream.rs
│   │       └── wire.rs
│   ├── axecode-app
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── agent.rs
│   │       ├── agent
│   │       │   ├── assistant_message.rs
│   │       │   ├── cancel.rs
│   │       │   ├── clean_context.rs
│   │       │   ├── compaction.rs
│   │       │   ├── context.rs
│   │       │   ├── events.rs
│   │       │   ├── history.rs
│   │       │   ├── mode.rs
│   │       │   ├── tests.rs
│   │       │   ├── tool_dispatch.rs
│   │       │   ├── tool_preflight.rs
│   │       │   ├── tool_summary.rs
│   │       │   └── turn.rs
│   │       ├── bash.rs
│   │       ├── compact.rs
│   │       ├── edit.rs
│   │       ├── glob.rs
│   │       ├── grep.rs
│   │       ├── image.rs
│   │       ├── lib.rs
│   │       ├── mcp.rs
│   │       ├── powershell.rs
│   │       ├── question.rs
│   │       ├── read.rs
│   │       ├── repl # axe:repl — agent à outil unique python(code)
│   │       │   ├── mod.rs # ReplDeps, ProviderResolver, TurnHook
│   │       │   ├── runtime.rs # ReplRuntime/ReplFactory (SessionRuntime), kernel, routage host calls
│   │       │   ├── turn.rs # boucle de tour, streaming, exécution python
│   │       │   ├── host.rs # host calls built-in (todo, context, compact, web, images, question, skills, mcp)
│   │       │   ├── prompt.rs # prompt de base REPL + catalogue des modules actifs
│   │       │   ├── output.rs # troncature des sorties + résumé
│   │       │   ├── compaction.rs # compaction (résumé ; variables du kernel gardées)
│   │       │   └── settings.rs # repl-settings.json (modules, seuil, max_tokens, plafond)
│   │       ├── rlm.rs # axe:rlm — sous-agents persistants rlm.* + messagerie famille nucléaire messages.* (FamilyHost), garde-fou quota
│   │       ├── session_commands.rs # axe:goal — TurnHook /goal /autonomous (budgets + gate) /heartbeat /refine /compact
│   │       ├── skill.rs
│   │       ├── store.rs
│   │       ├── subagent.rs
│   │       ├── team.rs
│   │       ├── team
│   │       │   ├── agent_turns.rs
│   │       │   ├── context.rs
│   │       │   ├── descriptors.rs
│   │       │   ├── launch.rs
│   │       │   ├── live.rs
│   │       │   ├── messaging.rs
│   │       │   ├── model.rs
│   │       │   ├── render.rs
│   │       │   ├── session.rs
│   │       │   ├── status_stop.rs
│   │       │   ├── task_board.rs
│   │       │   └── tests.rs
│   │       ├── text.rs
│   │       ├── todo.rs
│   │       ├── tool_names.rs
│   │       ├── tool_run.rs
│   │       ├── web.rs
│   │       ├── write.rs
│   │       └── workspace.rs
│   ├── axecode-core
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── error.rs
│   │       ├── lib.rs
│   │       ├── message.rs
│   │       ├── model.rs
│   │       ├── provider.rs
│   │       ├── stream.rs
│   │       ├── session.rs # axe:daemon — traits SessionRuntime/KernelSnapshot/TurnSink/SessionHost, journal
│   │       └── tool.rs
│   ├── axecode-daemon # axe:daemon — service d'arrière-plan
│   │   ├── Cargo.toml
│   │   ├── build.rs # axe:webui — ré-embarque web/dist quand il change
│   │   ├── src
│   │   │   ├── auth.rs # axe:remote — remote-auth.json : mots de passe argon2, jetons SHA-256, CLI set-password/token/auth
│   │   │   ├── cli.rs # serve [--listen host:port --allow-host h]/status/shutdown/set-password/token partagés
│   │   │   ├── client.rs # DaemonClient (pipe + connect_ws distant), ensure_daemon, lancement détaché
│   │   │   ├── brain_rpc.rs # v2-l2.4 — RPC skills.*/harness.* : cerveau commun (skills + harnais) de l'espace du service, réglages skill-settings.json
│   │   │   ├── daemon.rs # état, clients, broadcast
│   │   │   ├── journal.rs # JSONL append-only + arbre + fork
│   │   │   ├── share_rpc.rs # v2-l4 — RPC share.* : espace commun (Git), publication/suppression
│   │   │   ├── term_rpc.rs # v2-l3 — RPC term.* : terminaux PTY du service
│   │   │   ├── workspace_rpc.rs # v2-l2/l2.4 — RPC fs.* (dont index « ouvrir vite », corbeille trash/trash_list/restore) et git.* (status/commit/repos + branches/checkout/push/pull/worktrees), confinés à la racine
│   │   │   ├── lib.rs
│   │   │   ├── listen.rs # axe:remote — écoute WebSocket /ws authentifiée, contrôle Host/Origin, /healthz, HttpFallback (web UI)
│   │   │   ├── main.rs # binaire de dev (runtime echo)
│   │   │   ├── migrate.rs # import SQLite -> JSONL
│   │   │   ├── protocol.rs # JSON-lines, lock daemon.json, méthodes
│   │   │   ├── scratch.rs # axe:freechat — dossiers privés des conversations libres (<data>/scratch/<id>), détection is_scratch
│   │   │   ├── server.rs # socket, dispatch, arrêt auto, SessionHost
│   │   │   ├── sessions.rs # create/ensure/fork/set_model/send/stop, relocate (axe:freechat)
│   │   │   ├── stub.rs # EchoRuntime
│   │   │   ├── transport.rs # named pipe / unix socket
│   │   │   ├── util.rs
│   │   │   ├── webui # axe:webui — interface web servie sur --listen (HttpFallback)
│   │   │   │   ├── mod.rs # assets embarqués (rust-embed web/dist), login cookie, CSP, CSRF, /api/*, méthodes webui.sessions/revoke
│   │   │   │   └── session.rs # sessions navigateur (web-sessions.json, SHA-256), limitation des tentatives
│   │   │   └── worker.rs # workers supervisés, snapshots (le kernel REPL les restaure lui-même), relance
│   │   └── tests/daemon.rs + tests/remote.rs
│   ├── axecode-repl # axe:repl — process kernel, exec, RPC inverse, KernelSnapshot
│   │   ├── Cargo.toml
│   │   ├── src
│   │   │   ├── lib.rs
│   │   │   ├── process.rs
│   │   │   └── python.rs # découverte python + paquet axecode_kernel
│   │   └── tests/kernel.rs
│   ├── axecode-harness # axe:harness — Continual Harness
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── host.rs # host calls harness.* / refine.history|rollback, archivage des plans
│   │       ├── import.rs # import du kit brain
│   │       ├── inject.rs # couche injectée par tour (notes, mémoires, skills, sous-agents, plans)
│   │       ├── lib.rs
│   │       ├── model.rs # types, portées, frontmatter YAML
│   │       ├── refine.rs # /refine : planification, application, journal, rollback
│   │       └── store.rs # CRUD fichiers + index.json (global ~/.axecode/harness, projet .axecode/harness)
│   ├── axecode-google
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── client.rs
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── stream.rs
│   │       └── wire.rs
│   ├── axecode-kimi
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── client.rs
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── stream.rs
│   │       └── wire.rs
│   ├── axecode-openai
│   │   ├── Cargo.toml
│   │   └── src
│   │       ├── auth.rs
│   │       ├── client.rs
│   │       ├── lib.rs
│   │       ├── model_info.rs
│   │       ├── responses_stream.rs
│   │       ├── stream.rs
│   │       ├── websocket.rs
│   │       └── wire.rs
│   └── axecode-openrouter
│       ├── Cargo.toml
│       └── src
│           ├── auth.rs
│           ├── client.rs
│           ├── lib.rs
│           ├── model_info.rs
│           ├── stream.rs
│           └── wire.rs
├── src-tauri
│   ├── Cargo.toml
│   ├── binaries
│   │   └── .gitkeep
│   ├── build.rs
│   ├── tauri.sidecars.conf.json
│   ├── tauri.conf.json
│   ├── tauri.windows.conf.json
│   ├── capabilities
│   │   └── default.json
│   ├── gen
│   │   └── schemas
│   │       ├── acl-manifests.json
│   │       ├── capabilities.json
│   │       ├── desktop-schema.json
│   │       └── macOS-schema.json
│   ├── icons
│   │   ├── 128x128.png
│   │   ├── 128x128@2x.png
│   │   ├── 32x32.png
│   │   ├── 64x64.png
│   │   ├── Square107x107Logo.png
│   │   ├── Square142x142Logo.png
│   │   ├── Square150x150Logo.png
│   │   ├── Square284x284Logo.png
│   │   ├── Square30x30Logo.png
│   │   ├── Square310x310Logo.png
│   │   ├── Square44x44Logo.png
│   │   ├── Square71x71Logo.png
│   │   ├── Square89x89Logo.png
│   │   ├── StoreLogo.png
│   │   ├── icon.icns
│   │   ├── icon.ico
│   │   ├── icon.png
│   │   ├── nsis-sidebar.bmp
│   │   ├── source.svg
│   │   ├── android
│   │   │   ├── mipmap-anydpi-v26
│   │   │   │   └── ic_launcher.xml
│   │   │   ├── mipmap-hdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-mdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-xhdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-xxhdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   ├── mipmap-xxxhdpi
│   │   │   │   ├── ic_launcher.png
│   │   │   │   ├── ic_launcher_foreground.png
│   │   │   │   └── ic_launcher_round.png
│   │   │   └── values
│   │   │       └── ic_launcher_background.xml
│   │   └── ios
│   │       ├── AppIcon-20x20@1x.png
│   │       ├── AppIcon-20x20@2x-1.png
│   │       ├── AppIcon-20x20@2x.png
│   │       ├── AppIcon-20x20@3x.png
│   │       ├── AppIcon-29x29@1x.png
│   │       ├── AppIcon-29x29@2x-1.png
│   │       ├── AppIcon-29x29@2x.png
│   │       ├── AppIcon-29x29@3x.png
│   │       ├── AppIcon-40x40@1x.png
│   │       ├── AppIcon-40x40@2x-1.png
│   │       ├── AppIcon-40x40@2x.png
│   │       ├── AppIcon-40x40@3x.png
│   │       ├── AppIcon-512@2x.png
│   │       ├── AppIcon-60x60@2x.png
│   │       ├── AppIcon-60x60@3x.png
│   │       ├── AppIcon-76x76@1x.png
│   │       ├── AppIcon-76x76@2x.png
│   │       └── AppIcon-83.5x83.5@2x.png
│   └── src
│       ├── context.rs
│       ├── cloud.rs # axe:cloud — connexion Axe Cloud (boucle locale + PKCE S256, /app/jeton), jeton dans connection-secrets.json, IPC cloud_login/state/logout/api/open_web, connexion « Axe Cloud » (wss /ws, Bearer)
│       ├── cloud_tests.rs # tests du mode cloud (boucle locale 127.0.0.1) + cloud_e2e ignoré (contre la porte déployée)
│       ├── connections.rs # axe:remote — registre Local/Distante/SSH (connections.json + connection-secrets.json), tunnels ssh, IPC connections_*, call_on(connexion)
│       ├── conversations.rs
│       ├── daemon_client.rs # axe:daemon — mode --daemon (service + REPL), attache IDE, IPC daemon_* (param connection), bridge chat -> sessions ; axe:v2-l2.4c — cloud_connection_id/cloud_service_workspace (espace cloud -> chemin réel du service)
│       ├── freechat.rs # axe:freechat — conversations libres : espace partagé <data>/scratch côté IDE, IPC freechat_index/open/relocate, synchro service -> store (conversations libres créées sur le web / la Vue Agents), renommage/suppression répercutés
│       ├── custom_providers.rs # axe:providers — instances configurables (providers.json + provider-keys.json), IPC provider_*, modelOverrides, détection Ollama/LM Studio
│       ├── git.rs
│       ├── harness.rs # axe:harness — IPC harness_* (CRUD, promote/demote, refinements, rollback, import brain, refine start/status), couche harness par tour
│       ├── harness_backup.rs # axe:cleanup — sauvegarde périodique du harness (config harness-backup.json, IPC harness_backup_*)
│       ├── lib.rs
│       ├── main.rs
│       ├── models.rs
│       ├── offline.rs # axe:v2-l6 — mode désynchronisé : miroir local + journal (<data>/offline/<connexion>) et IPC offline_* (prepare, list, read, write, create, delete, rename, journal, sync, resolve, forget)
│       ├── platform.rs
│       ├── providers.rs
│       ├── quota.rs # axe:providers — IPC provider_quota (usage OAuth Anthropic + historique d'épuisement)
│       ├── remote.rs
│       ├── repl_settings.rs # axe:repl — IPC repl_settings_get/save, repl_catalog
│       ├── state.rs
│       ├── terminal.rs # PTY multi-onglets ; sélection PowerShell/WSL bash
│       ├── tests.rs
│       ├── turns.rs # axe:v2-l2.4c — send_message force le pont REPL en cloud (agent sur le service)
│       ├── updater.rs
│       ├── viewers.rs # axe:viewers — viewer_read_bytes (plages, ArrayBuffer brut), viewer_zip_list/read/extract, viewer_sqlite_tables/rows (lecture seule, query_only)
│       ├── workflow.rs
│       └── workspace.rs
└── src
    ├── App.tsx
    ├── main.tsx
    ├── styles.css
    ├── types.ts
    ├── vite-env.d.ts
    ├── axe
    │   ├── AppearanceSection.tsx # Settings > Apparence (color picker de fond)
    │   ├── CustomProvidersPanel.tsx # Settings > Providers : instances configurables
    │   ├── HarnessBackupSection.tsx # Settings > Harness : sauvegarde périodique
    │   ├── QuotaIndicator.tsx # quota d'abonnement dans la barre de titre
    │   ├── providers.ts # types + IPC provider_*, entrées du sélecteur de modèles
    │   ├── theme.css # accent orange Axe + styles des composants axe
    │   └── theme.ts # tons dérivés de --axe-bg par luminance, persistance
    ├── components
    │   ├── agents # axe:agents
    │   │   ├── AgentsView.tsx # Vue Agents : arbre des sessions running/idle/inactive, connexion active ou toutes les machines groupées, conversations libres (axe:freechat), ouvrir, message, arrêt
    │   │   ├── ExternalAgents.tsx # axe:agents — agents externes du service (agents.*) : liste 2 s, lancement (brief/libellé/modèle/commande), journal en direct, arrêt, résultat ; lecture seule hors ligne, inerte en local
    │   │   ├── ConnectionSelector.tsx # axe:remote — sélecteur de connexion de la barre latérale (masqué s'il n'y a que Local)
    │   │   ├── RemoteConversations.tsx # axe:remote — sessions d'une connexion distante : liste, création (modèles Axe Cloud proposés), fil depuis sessions.tree (erreurs de tour visibles), changement de modèle, envoi, arrêt
    │   │   ├── SessionTree.tsx # /tree : arbre du journal, revenir à un point, fork (par connexion)
    │   │   ├── agents.css
    │   │   ├── agentsApi.ts # wrappers daemon_call / daemon_sessions / axe://daemon, routage par connexion ; serviceAgentsApi (agents.list/spawn/status/stop/result en cloud)
    │   │   └── remoteItems.ts # axe:remote — modèles proposés pour une session distante (axe-cloud d'abord, mémorisés par connexion), fil affichable (messages + erreurs), explications lisibles des erreurs
    │   ├── cloud # axe:cloud — mode Axe Cloud (connexion Google, onglets Prime Agent / Atelier / Terminal)
    │   │   ├── CloudLogin.tsx # écran « Se connecter avec Google » (attente, refus, Mode local)
    │   │   ├── CloudShell.tsx # barre + onglets Prime Agent / Atelier (RemoteConversations sur la connexion axe-cloud) / Terminal + menu compte
    │   │   ├── PrimeAgentTab.tsx # chat avec Prime (tâche + relecture), tickets, liens rapides
    │   │   ├── TerminalTab.tsx # Prime / OpenCode / bash : lien unique /app/code-web ouvert dans le navigateur système
    │   │   ├── cloud.css # classes axc-*
    │   │   └── cloudApi.ts # IPC cloud_* + API JSON /prime/api/* et /app/*
    │   ├── settings # axe:harness (fichiers harness)
    │   │   ├── BrainImportWizard.tsx # import unique du kit brain dans le harness
    │   │   ├── HarnessPane.tsx # Settings > Harness
│   │   ├── harness.css
│   │   ├── harnessApi.ts # wrappers IPC harness_* ; RPC harness.* en cloud (axe:v2-l2.4)
│   │   ├── ApiKeyField.tsx # axe:cleanup — champ de clé API masqué
│   │   ├── ConnectionsPane.tsx # axe:remote — Settings > Connexions (ajout, test, état, connexion active)
│   │   ├── connectionsApi.ts # axe:remote — IPC connections_*, connexion active partagée (useActiveConnection)
│   │   ├── PythonSkillPreview.tsx # axe:cleanup — Settings > Skills : aperçu d'un skill Python du harness
│   │   ├── ReplServicesSection.tsx # axe:cleanup — Outils REPL : fournisseurs recherche web / images + clés
│   │   ├── ReplToolsPane.tsx # axe:repl — Settings > Outils REPL
│   │   ├── ServicePane.tsx # axe:daemon — Settings > Service
│   │   └── repl.css
    │   ├── NouvelleConversation.tsx # axe:e13 — champ de création d'une conversation (le nom est exigé)
    │   ├── ConversationList.tsx
    │   ├── EditorPane.tsx
    │   ├── FileTree.tsx
    │   ├── TerminalPanel.tsx # multi-onglets PTY : Ctrl+Tab, renommage, PowerShell/WSL et scrollback texte local
    │   ├── GitPanel.tsx
    │   ├── RemotePanel.tsx
    │   ├── SearchPane.tsx
    │   ├── SettingsPane.tsx
    │   ├── AxecodeMark.tsx
    │   ├── Splitter.tsx
    │   ├── UpdateBadge.tsx
    │   ├── UpdaterLockScreen.tsx
    │   ├── viewers # axe:viewers — visionneuses multiformat de l'éditeur, chargées à la demande
    │   │   ├── registry.ts # extension -> visionneuse (overlay sur Monaco ou remplacement)
    │   │   ├── ViewerHost.tsx # point d'entrée (React.lazy par famille), usesFileViewer, message .doc/.ppt
    │   │   ├── bytes.ts # readBytes/readAllBytes par morceaux, entrées zip (readZipEntry/listZip), assetDirUrl
    │   │   ├── common.tsx # OpenWithDefaultApp, ViewerLoading, ViewerError
    │   │   ├── SpreadsheetViewer.tsx # xlsx/xls/ods/csv/tsv (SheetJS), onglets de feuilles, recherche
    │   │   ├── SheetGrid.tsx # grille virtualisée, en-têtes figés, 1re ligne figée (aussi pour SQLite)
    │   │   ├── HtmlPreview.tsx # iframe sandbox, scripts sur autorisation, <base> du dossier
    │   │   ├── SafeFrame.tsx # HTML non fiable : sanitizer + iframe sans scripts + CSP, liens -> navigateur
    │   │   ├── DocumentFrame.tsx # barre de recherche + panneau latéral autour de SafeFrame
    │   │   ├── DocxViewer.tsx # Word .docx (mammoth -> HTML)
    │   │   ├── pptx.ts / PptxViewer.tsx # PowerPoint .pptx : diapositives approximatives (texte, images, tableaux) + mode Texte
    │   │   ├── EpubViewer.tsx # epub : chapitres du spine, images intégrées
    │   │   ├── MediaViewer.tsx # audio/vidéo natifs (protocole asset, lecture par plages)
    │   │   ├── ImageZoom.tsx / SvgViewer.tsx # images zoomables (ajuster, 1:1, Ctrl+molette), SVG aperçu + code
    │   │   ├── JsonViewer.tsx / NotebookViewer.tsx # arbre JSON repliable, rendu ipynb (cellules + sorties)
    │   │   ├── SqliteViewer.tsx / ZipViewer.tsx / FontViewer.tsx # tables SQLite, contenu zip + extraction, aperçu de police
    │   │   ├── FallbackViewer.tsx / HexViewer.tsx # repli : texte paginé (gros fichiers) ou vue hexadécimale virtualisée, lecture par plages
    │   │   ├── pdf # pdfDoc.ts (worker + transport par plages), PdfViewer.tsx (pages virtualisées, zoom, recherche, miniatures), PdfPage.tsx
    │   │   └── viewers.css
    │   ├── Welcome.tsx # axe:freechat — écran d'accueil : « Nouvelle conversation » / « Ouvrir un dossier », conversations libres et dossiers récents
    │   ├── WindowControls.tsx
    │   ├── Workspace.tsx # dispositions « ide » et « chat » (axe:freechat : même ChatPane, FreechatView)
    │   ├── freechat # axe:freechat — mode conversation libre
    │   │   ├── FreechatView.tsx # vue plein écran : barre latérale (libres + par projet, recherche), chat centré, ouvrir un dossier pour la conversation
    │   │   ├── freechatApi.ts # IPC freechat_*, utilitaires (titres, chemins, dates relatives)
    │   │   └── freechat.css
    │   └── chat
    │       ├── AIThinkingBlock.tsx
    │       ├── ChatPane.tsx
    │       ├── actionsConversation.ts # axe:e17a — callbacks du chat liés explicitement à un fil
    │       ├── DotmSquare2.tsx
    │       ├── DotmSquare5.tsx
    │       ├── FileChangeBlock.tsx
    │       ├── Markdown.tsx
    │       ├── MermaidDiagram.tsx
    │       ├── PlanningNextMoveBlock.tsx
    │       ├── Questionnaire.tsx
    │       ├── ReplCard.tsx # axe:repl — carte condensée d'une exécution python
    │       ├── SlashCommands.tsx # axe:slash — parseur + autocomplétion /goal /autonomous /heartbeat /compact /refine /tree /login /settings
    │       ├── TodoStrip.tsx
    │       ├── ToolCard.tsx
    │       ├── dotmatrix-core.tsx
    │       ├── dotmatrix-hooks.ts
    │       ├── slash.css
    │       └── stream.ts
    ├── lib
    │   ├── cloudOnline.ts # axe:v2-l6 — état de joignabilité du service cloud, sondes 15→60 s, garde d'écriture hors ligne
    │   ├── cloudOffline.ts # axe:v2-l6 (tranche 2) — copie locale (miroir) hors ligne : offline_* , état en attente, sync/conflits
    │   ├── fileIcon.ts
    │   ├── ipc.ts # IPC local + remote_* ; cloudRpc et routage skills.* en cloud (axe:v2-l2.4) ; lectures/écritures via le miroir hors ligne ; conversations (list/load/rename) routées vers le service en cloud (axe:v2-l7)
    │   ├── language.ts
    │   ├── models.ts
    │   ├── recents.ts
    │   └── tools.ts

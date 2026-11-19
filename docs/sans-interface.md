# SavIDE sans interface : `-p`, `--mode json`, `--mode acp`

L'exécutable de l'appli sert aussi en ligne de commande, sans fenêtre et sans affichage
(serveur, CI, scripts, `DISPLAY` absent). Le travail se fait dans le **service de l'appli**
(`SavIDE --daemon serve`, lancé au besoin) : mêmes données, mêmes conversations. Une
conversation commencée en ligne de commande apparaît ensuite dans l'appli, dans le dossier
où elle a été lancée, et s'y continue.

## Un tour : `-p`

```bash
SavIDE -p "Calcule 2**100 dans le noyau"        # réponse finale sur la sortie standard
echo "Résume ce fichier" | SavIDE -p             # le texte peut venir de l'entrée standard
SavIDE -c -p "Et ensuite ?"                      # continue la dernière conversation du dossier
SavIDE -r 8b19 -p "On reprend"                   # reprend une conversation (identifiant ou début)
SavIDE --model anthropic/claude-opus-4-5 --thinking high -p "…"
SavIDE --cwd ~/projet -p "…"                     # dossier de travail (sinon le dossier courant)
```

- Sortie texte : la réponse finale de chaque tour (le texte écrit après le dernier appel du
  noyau). Les erreurs vont sur la sortie d'erreur.
- Codes de sortie : `0` réussi ; `1` erreur du tour (sans réponse), ou mode autonome arrêté
  sans réussir ; `2` arguments invalides ou conversation introuvable ; `3` service injoignable ;
  `130` interrompu (Ctrl+C : le tour est arrêté).
- Modèle par défaut : le modèle « Agir » choisi dans l'appli.
- Windows : lancé depuis un terminal, l'exécutable s'y rattache pour écrire ses sorties.

## Flux JSON : `--mode json`

Un événement JSON par ligne, pour les scripts et les bancs d'essai :

| `type` | Contenu |
|---|---|
| `session` | `sessionId`, `workspace`, `model`, `name` |
| `user_message` | message envoyé, ou message d'un réveil (guet, heartbeat, relance d'objectif) |
| `turn_start` / `turn_end` | numéro du tour ; `turn_end` porte la réponse finale (`text`) |
| `text_delta` / `thinking_delta` | morceaux de texte et de réflexion |
| `kernel_call` / `kernel_output` / `kernel_result` | code envoyé au noyau, sortie en direct, résultat (`stdout`, `stderr`, `isError`, `durationMs`) |
| `compaction_start` / `compaction_done` / `compaction` | compaction du contexte (et son résumé) |
| `goal_update` / `autonomous_update` / `guet_update` / `heartbeat_update` | changements d'état des commandes de session |
| `waiting` | réveils attendus avant de sortir (`for`) |
| `error` | erreur lisible (`message`) |
| `end` | `exitCode`, `turns`, état final de l'objectif et du mode autonome, `durationMs` |

Les autres événements du service passent tels quels (`stream_retry`, `question`, `contexte`…).

## Objectif et mode autonome

```bash
SavIDE -p --goal "Porter la suite de tests sur pytest" --goal-budget 2000000
SavIDE -p "Corrige le parseur" --autonomous --gate "cargo test" --gate "cargo clippy -- -D warnings" \
        --max-turns 12 --max-tokens 80000 --timeout-ms 1800000
```

Ce sont les commandes `/goal` et `/autonomous` du service : l'objectif relance l'agent tant
qu'il n'a pas appelé `goal.complete()` ; le mode autonome finit quand l'objectif est atteint et
que le contrôle passe (plusieurs `--gate` sont enchaînés par `&&`). Sans `--goal`, le mode
autonome prend le texte du message comme objectif. Une limite atteinte donne le code `1`.

## Attente des réveils

Avant de sortir, `-p` attend ce qui réveillera encore la conversation : guets en cours,
relance planifiée de l'objectif, mode autonome ou sans fin, sous-agents au travail. Les tours
de réveil sont affichés comme les autres. Les heartbeats, récurrents, ne sont pas attendus.

- `--wait-max <ms>` : attente maximale de chaque réveil (600000 par défaut) ; `0` = sortir à
  la fin du tour. Ce qui reste continue dans le service (et se voit dans l'appli).

## ACP : `--mode acp`

`SavIDE --mode acp` parle l'[Agent Client Protocol](https://agentclientprotocol.com) en
JSON-RPC 2.0, une ligne par message sur stdin/stdout : tout client ACP (Zed…) peut le piloter.

- `initialize` (version 1, `loadSession`, contexte embarqué), `authenticate` (rien à faire),
  `session/new`, `session/load` (relit l'historique en `session/update`), `session/prompt`
  (réponse à la fin du tour : `end_turn` ou `cancelled`), `session/cancel` (notification),
  `session/set_config_option`.
- `session/update` : `agent_message_chunk`, `agent_thought_chunk`, `tool_call` /
  `tool_call_update` (appels du noyau, `kind: execute`, sortie en direct puis
  `completed`/`failed`), `user_message_chunk` (relecture, message d'un réveil).
- Tours de réveil (guet, heartbeat, relance) : diffusés comme les autres, encadrés par
  `session_info_update` avec `_meta.savide.wakeTurn` = `start` puis `end`.
- Options de configuration : `model` (`fournisseur/modèle`) et `thought_level`
  (`default`, `none` … `max`).
- Un `session/prompt` envoyé pendant un tour attend la fin de celui-ci (file du service).
- Les serveurs MCP proposés par le client ne sont pas branchés : les MCP vivent dans le
  noyau (module `mcp`).

## Essais sans vraie API

Le fournisseur `faux` répond à partir d'un script (`AXECODE_FAUX_SCRIPT`, JSON en ligne ou
`@chemin`) : texte, réflexion, code pour le noyau, erreur, délai. Voir
`crates/axecode-app/src/fournisseur_faux.rs`.

```bash
scripts/essai-sans-interface.sh [exécutable]   # -p, json, -c, -r, erreur, objectif, autonome, guet, attente
python3 scripts/essai-acp.py [exécutable]      # ACP : session, appel du noyau, annulation, réveil, reprise
```

Les deux scripts isolent les données (`HOME`, `XDG_DATA_HOME` temporaires) et tournent sans
`DISPLAY` ; il faut `AXECODE_PYTHON` (Python avec IPython et dill).

Comportements inspirés d'Unharnessed (licence MIT) : mode print, flux JSON, ACP, fournisseur scripté.

# Unharnessed (idées et adaptations)
Source : https://github.com/unharnessed-agent/Unharnessed (révision 157dcdc1d9452cae6fdd0fc74c182617d4033ee2).
Licence : MIT (texte ci-dessous). Rien n'est copié mot pour mot ; les fichiers suivants de SavIDE sont adaptés de près :

- `crates/axecode-repl/src/etat.rs` : forme de l'avis `[python-state]` (d'après `crates/uh-core/src/session_engine/ipython_state.rs`).
- `python/axecode_kernel/_winjob.py` : Job Object Windows, « créer suspendu, rattacher, relancer » (d'après `unharnessed-runtime/src/rlm/_winjob.py`).
- `crates/axecode-app/src/fournisseur_faux.rs` : format du script du fournisseur de test (d'après `crates/uh-ai/src/providers/faux/script.rs`).
- `src-tauri/src/sans_interface/acp_maj.rs` : options de configuration modèle / réflexion de l'ACP (d'après `crates/uh-daemon/src/acp/config_options.rs`, `types.rs`).
- `scripts/essai-acp.py` : structure du pilote de test ACP (d'après `crates/uh-cli/tests/acp_mode_e2e.rs`).

Idées seulement (réécrites) : bascule de fournisseur (`provider_failover.rs`), noyau asynchrone et poignée de commande (`repl.py`, `bash.py`, `repl.md`), mode `-p` / `--mode json` (`crates/uh-cli`).

```
MIT License

Copyright (c) 2026 Unharnessed
Copyright (c) 2025-2026 Prime Intellect Ltd.
Portions Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#!/bin/bash
# Erreurs du compteur Axe Cloud (401, 429, 503…) avec un VRAI démon Axecode et le faux compteur.
# Aucune vraie clé, aucun appel à Anthropic : le fournisseur « axe-cloud » d'un espace jetable
# pointe sur le faux compteur local (faux-compteur.mjs), qui répond comme le vrai
# (~/compteur-axe/app.py, erreur_anthropic). Chaque essai : nouvelle session (modèle
# axe-cloud/claude-haiku-5-5), « bonjour », puis l'erreur de tour telle que l'appli la reçoit.
# Usage : bash scripts/faux-compteur/demo.sh <binaire axecode> <python3 avec IPython> [statut…]
#   ex. bash scripts/faux-compteur/demo.sh "$CARGO_TARGET_DIR/debug/axecode" \
#         /opt/axecode/lib/axecode/python-runtime/bin/python3 503 401 429
set -u
ICI=$(cd "$(dirname "$0")" && pwd)
DEPOT=$(cd "$ICI/../.." && pwd)
BIN=${1:?binaire axecode}
PY=${2:?python3 avec IPython}
shift 2
STATUTS=("$@")
[ ${#STATUTS[@]} -eq 0 ] && STATUTS=(503 401 429)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

essai() {
  local statut=$1 port=$((18000 + $1)) h="$TMP/$1"
  local data="$h/home/.local/share/axecode"
  mkdir -p "$data" "$h/work"
  printf '{"providers":[{"id":"axe-cloud","name":"Axe Cloud (faux compteur)","kind":"anthropic_compatible","baseUrl":"http://127.0.0.1:%s","enabled":true,"models":[{"id":"claude-haiku-5-5","label":"Claude Haiku 5.5","contextWindow":200000,"maxOutputTokens":16000,"supportsTools":true,"supportsReasoning":false,"supportsVision":true}]}],"modelOverrides":{}}' "$port" > "$data/providers.json"
  # Fausse clé construite à l'exécution (aucune clé dans les sources).
  printf '{"axe-cloud":"%s"}' "axk_$(printf essai)" > "$data/provider-keys.json"
  chmod 600 "$data"/*.json
  node "$ICI/faux-compteur.mjs" "$port" "$statut" > "$h/compteur.log" 2>&1 &
  local cpid=$!
  env -i HOME="$h/home" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 XDG_DATA_HOME="$h/home/.local/share" \
    AXECODE_KERNEL_DIR="$DEPOT/python" AXECODE_PYTHON="$PY" "$BIN" --daemon serve --data-dir "$data" > "$h/demon.log" 2>&1 &
  local dpid=$!
  for _ in $(seq 1 40); do [ -S "$data/daemon.sock" ] && break; sleep 0.5; done
  local debut
  debut=$(date +%s)
  timeout 175 node "$ICI/essai-demon.mjs" "$data/daemon.sock" "$h/work" > "$h/essai.log" 2>&1
  echo "durée du tour : $(( $(date +%s) - debut )) s" >> "$h/essai.log"
  kill "$dpid" "$cpid" 2>/dev/null
  sleep 1
  kill -9 "$dpid" 2>/dev/null
}

for s in "${STATUTS[@]}"; do essai "$s" & done
wait
for s in "${STATUTS[@]}"; do
  echo "===== compteur répondant $s"
  cat "$TMP/$s/compteur.log" "$TMP/$s/essai.log"
done

#!/bin/bash
# Essais du mode sans interface avec le fournisseur faux (données isolées, sans DISPLAY).
set -u
# Usage : scripts/essai-sans-interface.sh [exécutable]
# Variables : AXECODE_PYTHON (Python avec IPython/dill), AXECODE_KERNEL_DIR (dossier python/ du dépôt par défaut).
RACINE=$(cd "$(dirname "$0")/.." && pwd)
BIN=${1:-$HOME/tgt-189-sav/debug/axecode}
export AXECODE_KERNEL_DIR=${AXECODE_KERNEL_DIR:-$RACINE/python}
pkill -f "axecode --daemon serve --data-dir /tmp/uhcli-t" ; sleep 0.5
T=/tmp/uhcli-t; rm -rf $T; mkdir -p $T/home $T/projet
export HOME=$T/home XDG_DATA_HOME=$T/home/.local/share
unset DISPLAY WAYLAND_DISPLAY
cd $T/projet
# Chaque essai a son script : le service est relancé pour le relire.
faux() {
  $BIN --daemon shutdown --force >/dev/null 2>&1
  # attendre la vraie fin de l'ancien service (sinon le client suivant s'y rattache, avec l'ancien script)
  for i in $(seq 1 60); do pgrep -f "daemon serve --data-dir $XDG_DATA_HOME" >/dev/null || break; sleep 0.5; done
  # les guets laissés par l'essai précédent seraient relancés au démarrage du service
  # (tour de réveil qui consommerait le script de l'essai suivant)
  rm -rf "$XDG_DATA_HOME"/*/session_state
  export AXECODE_FAUX_SCRIPT="$1"
}
ok() { echo "  OK : $*"; }
ko() { echo "  ÉCHEC : $*"; ECHECS=$((ECHECS+1)); }
ECHECS=0

echo "== 1. -p texte (appel du noyau puis réponse)"
faux '{"responses":[{"text":"Je calcule.","code":"print(6*7)"},"La réponse est 42."]}'
OUT=$($BIN -p "combien font 6*7 ?" 2>$T/err1); C=$?
echo "  stdout=[$OUT] code=$C stderr=[$(cat $T/err1)]"
[ "$OUT" = "La réponse est 42." ] && [ $C = 0 ] && ok "réponse sur stdout, code 0" || ko "1"

echo "== 2. --mode json"
faux '{"responses":[{"content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"Calcul."},{"type":"python","code":"x = 6*7\nprint(x)"}]},"Fini : 42."]}'
$BIN --mode json -p "calcule" > $T/j2 2>$T/err2; C=$?
python3 - "$T/j2" <<'EOF'
import json,sys
ev=[json.loads(l) for l in open(sys.argv[1])]
types=[e["type"] for e in ev]
print("  types :", " ".join(dict.fromkeys(types)))
res=[e for e in ev if e["type"]=="kernel_result"]
print("  kernel_result.stdout :", repr(res[0]["stdout"]) if res else None)
print("  end :", json.dumps(ev[-1], ensure_ascii=False)[:200])
open(sys.argv[1]+".id","w").write(ev[0]["sessionId"])
EOF
SID=$(cat $T/j2.id)
grep -q '"type":"kernel_call"' $T/j2 && grep -q '"stdout":"42\\n"' $T/j2 && grep -q '"type":"end"' $T/j2 && [ $C = 0 ] && ok "json : appel, résultat, fin" || ko "2 (code $C)"

echo "== 3. -c continue la dernière conversation du dossier"
faux '{"responses":["Suite de la conversation."]}'
$BIN -c --mode json -p "et ensuite ?" > $T/j3 2>&1; C=$?
grep -q "\"sessionId\":\"$SID\"" $T/j3 && grep -q 'Suite de la conversation' $T/j3 && ok "même session $SID" || ko "3 ($(head -c 300 $T/j3))"

echo "== 4. -r <début d'id>"
faux '{"responses":["Reprise."]}'
OUT=$($BIN -r ${SID:0:8} -p "reprends" 2>&1); C=$?
[ "$OUT" = "Reprise." ] && [ $C = 0 ] && ok "reprise par ${SID:0:8}" || ko "4 [$OUT] $C"
OUT=$($BIN -r zzzzzz -p "x" 2>&1); C=$?
[ $C = 2 ] && ok "id inconnu -> code 2 : $OUT" || ko "4b $C $OUT"

echo "== 5. erreur du fournisseur -> stderr et code != 0"
faux '{"responses":[{"error":"panne simulée"}],"repeatLast":true}'
OUT=$($BIN -p "x" 2>$T/err5); C=$?
echo "  stdout=[$OUT] code=$C stderr=[$(head -c 300 $T/err5)]"
[ $C != 0 ] && grep -q 'panne simulée' $T/err5 && ok "erreur lisible, code $C" || ko "5"

echo "== 6. --goal + budget : relance automatique jusqu'à goal.complete"
faux '{"responses":["Je commence.",{"code":"goal.progress(\"moitié\")\ngoal.complete(\"fini\")"},"Objectif atteint."]}'
$BIN --mode json -p "go" --goal "écrire le rapport" --goal-budget 100000 > $T/j6 2>$T/err6; C=$?
grep -o '"type":"[a-z_]*"' $T/j6 | sort | uniq -c | tr '\n' ' '; echo
tail -1 $T/j6 | head -c 400; echo
grep -q '"turns":2' $T/j6 && grep -q '"status":"complete"' $T/j6 && [ $C = 0 ] && ok "2 tours (relance), objectif complete" || ko "6 code $C $(cat $T/err6)"

echo "== 7. --autonomous --gate"
rm -f ok.txt
faux '{"responses":[{"code":"open(\"ok.txt\",\"w\").write(\"1\")\ngoal.complete(\"fait\")"},"Fait."]}'
OUT=$($BIN -p "crée ok.txt" --autonomous --gate "test -f ok.txt" --max-turns 4 2>$T/err7); C=$?
echo "  stdout=[$OUT] code=$C stderr=[$(cat $T/err7)]"
[ $C = 0 ] && [ -f ok.txt ] && ok "contrôle passé, code 0" || ko "7"
faux '{"responses":["Je ne fais rien."],"repeatLast":true}'
OUT=$($BIN -p "rien" --autonomous --gate "test -f absent.txt" --max-turns 2 2>$T/err7b); C=$?
echo "  stdout=[$OUT] code=$C stderr=[$(cat $T/err7b)]"
[ $C = 1 ] && ok "limite atteinte -> code 1" || ko "7b"

echo "== 8. guet : attendre le réveil avant de sortir"
faux '{"responses":[{"code":"guet.commande(\"sleep 3; echo fini-du-guet\")"},"J attends le guet.","Le guet est fini."]}'
D=$(date +%s); OUT=$($BIN -p "lance et attends" 2>$T/err8); C=$?; D=$(( $(date +%s) - D ))
echo "  stdout=[$OUT] code=$C durée=${D}s stderr=[$(cat $T/err8)]"
echo "$OUT" | grep -q 'Le guet est fini.' && [ $D -ge 3 ] && ok "réveil attendu et affiché" || ko "8"

echo "== 9. --wait-max 0 : sortie sans attendre"
faux '{"responses":[{"code":"guet.commande(\"sleep 20\")"},"J attends."]}'
D=$(date +%s); OUT=$($BIN -p "lance" --wait-max 0 2>$T/err9); C=$?; D=$(( $(date +%s) - D ))
echo "  stdout=[$OUT] code=$C durée=${D}s stderr=[$(cat $T/err9)]"
[ $D -lt 15 ] && grep -q guet $T/err9 && ok "sortie immédiate, guet signalé" || ko "9"
echo "== 9b. attente maximale dépassée"
faux '{"responses":[{"code":"guet.commande(\"sleep 30\")"},"J attends."]}'
D=$(date +%s); OUT=$($BIN -p "lance" --wait-max 2000 2>$T/err9b); C=$?; D=$(( $(date +%s) - D ))
echo "  stdout=[$OUT] code=$C durée=${D}s stderr=[$(cat $T/err9b)]"
[ $D -lt 15 ] && grep -q 'attente maximale' $T/err9b && ok "délai respecté" || ko "9b"

echo "== 10. même stockage que l'appli"
python3 - "$XDG_DATA_HOME/savide/desktop-state.sqlite3" "$SID" "$(realpath $T/projet)" <<'EOF'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
r=c.execute("select workspace_id,title from conversations where id=?",(sys.argv[2],)).fetchone()
n=c.execute("select count(*) from messages where conversation_id=?",(sys.argv[2],)).fetchone()[0]
print("  ligne appli :", r, "messages :", n)
print("  OK : conversation dans le stockage de l'appli" if r and r[0]==sys.argv[3] and n>=4 else "  ÉCHEC : 10")
EOF
$BIN --daemon shutdown --force >/dev/null 2>&1
echo "ECHECS=$ECHECS"
[ $ECHECS = 0 ]

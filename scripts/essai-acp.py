#!/usr/bin/env python3
"""Essai de bout en bout de `SavIDE --mode acp` (Agent Client Protocol) avec le
fournisseur faux : nouvelle session, options de configuration, un tour avec appel du
noyau, annulation, tour de réveil (guet), puis reprise (`session/load`) après l'arrêt
du service, avec les variables du noyau retrouvées.

Usage : python3 scripts/essai-acp.py [chemin de l'exécutable]
Variables : AXECODE_PYTHON (Python avec IPython/dill), AXECODE_KERNEL_DIR (dossier python/).
Données isolées dans un dossier temporaire (HOME et XDG_DATA_HOME), sans DISPLAY.
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/tgt-189-sav/debug/axecode")
ECHECS = []


def verifier(cond, quoi):
    print(("  OK : " if cond else "  ÉCHEC : ") + quoi, flush=True)
    if not cond:
        ECHECS.append(quoi)


class Agent:
    def __init__(self, env, cwd):
        self.p = subprocess.Popen([BIN, "--mode", "acp"], env=env, cwd=cwd, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.lignes = queue.Queue()
        self.n = 0
        threading.Thread(target=self._lire, daemon=True).start()
        threading.Thread(target=self._erreurs, daemon=True).start()
        self.stderr = []

    def _lire(self):
        for l in self.p.stdout:
            self.lignes.put(l)
        self.lignes.put(None)

    def _erreurs(self):
        for l in self.p.stderr:
            self.stderr.append(l)

    def envoyer(self, v):
        self.p.stdin.write(json.dumps(v) + "\n")
        self.p.stdin.flush()

    def requete(self, methode, params):
        self.n += 1
        self.envoyer({"jsonrpc": "2.0", "id": self.n, "method": methode, "params": params})
        return self.n

    def notifier(self, methode, params):
        self.envoyer({"jsonrpc": "2.0", "method": methode, "params": params})

    def attendre(self, id_, delai=60, notes=None):
        """Lit jusqu'à la réponse `id_` ; rend (réponse, notifications vues avant)."""
        notes = [] if notes is None else notes
        fin = time.time() + delai
        while True:
            reste = fin - time.time()
            if reste <= 0:
                raise TimeoutError(f"pas de réponse {id_} ; stderr : {''.join(self.stderr)[-800:]}")
            try:
                l = self.lignes.get(timeout=reste)
            except queue.Empty:
                continue
            if l is None:
                raise RuntimeError("l'agent s'est arrêté ; stderr : " + "".join(self.stderr)[-800:])
            v = json.loads(l)
            assert v.get("jsonrpc") == "2.0", v
            if v.get("id") == id_ and ("result" in v or "error" in v):
                return v, notes
            notes.append(v)

    def notes_jusqu_a(self, cond, delai=60):
        """Lit des notifications jusqu'à ce que `cond(v)` soit vrai."""
        vues, fin = [], time.time() + delai
        while time.time() < fin:
            try:
                l = self.lignes.get(timeout=max(0.1, fin - time.time()))
            except queue.Empty:
                continue
            if l is None:
                break
            v = json.loads(l)
            vues.append(v)
            if cond(v):
                return vues
        raise TimeoutError("notification attendue absente : " + json.dumps(vues)[-600:])

    def fermer(self):
        self.p.stdin.close()
        try:
            return self.p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.p.kill()
            return -9


def maj(notes, genre):
    return [n["params"]["update"] for n in notes
            if n.get("method") == "session/update" and n["params"]["update"].get("sessionUpdate") == genre]


def texte(notes, genre="agent_message_chunk"):
    return "".join(u["content"]["text"] for u in maj(notes, genre))


def service(env, quoi):
    subprocess.run([BIN, "--daemon", quoi, "--force"], env=env, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)


def main():
    base = tempfile.mkdtemp(prefix="axecode-acp-")
    projet = os.path.join(base, "projet")
    os.makedirs(projet)
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    env.update(HOME=os.path.join(base, "home"), XDG_DATA_HOME=os.path.join(base, "home", ".local", "share"))
    env.setdefault("AXECODE_KERNEL_DIR", os.path.join(RACINE, "python"))
    env["AXECODE_FAUX_SCRIPT"] = json.dumps({"responses": [
        {"content": [{"type": "text", "text": "Je calcule."}, {"type": "python", "code": "x = 6*7\nprint(x)"}]},
        "Résultat : 42.",
        {"content": [{"type": "text", "text": "Longue attente."}, {"type": "python", "code": "import time\ntime.sleep(60)"}]},
        {"content": [{"type": "text", "text": "Je pose un guet."}, {"type": "python", "code": "guet.commande('sleep 2; echo guet-fini')"}]},
        "J'attends le guet.",
        "Guet reçu : la commande est finie.",
    ]})
    print("== 1. initialize, session/new, options", flush=True)
    a = Agent(env, projet)
    r, _ = a.attendre(a.requete("initialize", {"protocolVersion": 1, "clientCapabilities": {}}))
    res = r["result"]
    verifier(res["protocolVersion"] == 1 and res["agentCapabilities"]["loadSession"] is True, "initialize : version 1, loadSession")
    r, _ = a.attendre(a.requete("session/new", {"cwd": projet, "mcpServers": []}), 90)
    sid = r["result"]["sessionId"]
    opts = {o["id"]: o for o in r["result"]["configOptions"]}
    verifier(opts["model"]["currentValue"] == "faux/faux-1" and opts["thought_level"]["category"] == "thought_level",
             f"session/new {sid[:8]} : options modèle ({opts['model']['currentValue']}) et réflexion")
    r, _ = a.attendre(a.requete("session/set_config_option", {"sessionId": sid, "configId": "thought_level", "value": "high"}))
    lvl = {o["id"]: o for o in r["result"]["configOptions"]}["thought_level"]["currentValue"]
    verifier(lvl == "high", "set_config_option thought_level=high")
    r, _ = a.attendre(a.requete("session/set_config_option", {"sessionId": sid, "configId": "model", "value": "pas-de-barre"}))
    verifier("error" in r, "valeur de modèle invalide refusée : " + r.get("error", {}).get("message", ""))

    print("== 2. session/prompt avec appel du noyau", flush=True)
    r, notes = a.attendre(a.requete("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "combien font 6*7 ?"}]}), 120)
    appels = maj(notes, "tool_call")
    fins = maj(notes, "tool_call_update")
    fin = [u for u in fins if u.get("status") == "completed"]
    verifier(r.get("result", {}).get("stopReason") == "end_turn", "stopReason end_turn")
    verifier(appels and appels[0]["kind"] == "execute" and "6*7" in appels[0]["rawInput"]["code"], "tool_call (execute) avec le code")
    verifier(fin and fin[0]["rawOutput"]["stdout"] == "42\n", "tool_call_update completed, stdout 42")
    verifier(texte(notes).endswith("Résultat : 42."), "agent_message_chunk : " + texte(notes))

    print("== 3. annulation pendant un appel du noyau", flush=True)
    t0 = time.time()
    rid = a.requete("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "attends longtemps"}]})
    a.notes_jusqu_a(lambda v: v.get("method") == "session/update" and v["params"]["update"].get("sessionUpdate") == "tool_call", 60)
    time.sleep(1)
    a.notifier("session/cancel", {"sessionId": sid})
    r, notes = a.attendre(rid, 60)
    verifier(r.get("result", {}).get("stopReason") == "cancelled" and time.time() - t0 < 45,
             f"stopReason cancelled en {time.time() - t0:.1f} s")

    print("== 4. tour de réveil (guet) diffusé en session/update", flush=True)
    r, notes = a.attendre(a.requete("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "pose un guet"}]}), 120)
    verifier(r.get("result", {}).get("stopReason") == "end_turn", "tour du guet fini")
    vues = a.notes_jusqu_a(lambda v: v.get("method") == "session/update"
                           and v["params"]["update"].get("_meta", {}).get("savide", {}).get("wakeTurn") == "end", 90)
    reveil = [v["params"]["update"]["_meta"]["savide"]["wakeTurn"] for v in vues
              if v["params"]["update"].get("sessionUpdate") == "session_info_update"]
    verifier(reveil == ["start", "end"], f"début et fin du tour de réveil : {reveil}")
    verifier("guet" in texte(vues, "user_message_chunk"), "message du réveil : " + texte(vues, "user_message_chunk")[:80].replace("\n", " "))
    verifier(texte(vues) == "Guet reçu : la commande est finie.", "réponse du réveil : " + texte(vues))
    verifier(a.fermer() == 0, "fin propre à la fermeture de stdin")

    print("== 5. reprise après l'arrêt du service (session/load)", flush=True)
    service(env, "shutdown")
    time.sleep(2)
    env["AXECODE_FAUX_SCRIPT"] = json.dumps({"responses": [
        {"code": "print(x)"}, "Reprise : x vaut toujours 42."]})
    b = Agent(env, projet)
    b.attendre(b.requete("initialize", {"protocolVersion": 1, "clientCapabilities": {}}))
    r, notes = b.attendre(b.requete("session/load", {"sessionId": sid, "cwd": projet, "mcpServers": []}), 90)
    verifier("result" in r and "Résultat : 42." in texte(notes) and maj(notes, "tool_call"),
             f"relecture : {len(notes)} mises à jour (messages, appels)")
    r, notes = b.attendre(b.requete("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "x existe encore ?"}]}), 120)
    fin = [u for u in maj(notes, "tool_call_update") if u.get("status") == "completed"]
    verifier(r.get("result", {}).get("stopReason") == "end_turn" and fin and fin[0]["rawOutput"]["stdout"] == "42\n",
             "noyau restauré : print(x) -> 42")
    verifier(texte(notes) == "Reprise : x vaut toujours 42.", "réponse après reprise")
    b.fermer()
    service(env, "shutdown")

    import sqlite3
    c = sqlite3.connect(os.path.join(env["XDG_DATA_HOME"], "savide", "desktop-state.sqlite3"))
    ligne = c.execute("select workspace_id, title from conversations where id=?", (sid,)).fetchone()
    n = c.execute("select count(*) from messages where conversation_id=?", (sid,)).fetchone()[0]
    verifier(ligne is not None and ligne[0] == os.path.realpath(projet) and n >= 6,
             f"conversation dans le stockage de l'appli : {ligne}, {n} messages")
    if not ECHECS:
        shutil.rmtree(base, ignore_errors=True)
    print(f"ÉCHECS={len(ECHECS)}" + (f" (données gardées : {base})" if ECHECS else ""))
    return 1 if ECHECS else 0


if __name__ == "__main__":
    sys.exit(main())

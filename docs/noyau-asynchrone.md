# Noyau asynchrone (lot D2, reprise Unharnessed)

Réglage : `kernelAsync` dans `repl-settings.json` (dossier de données), **éteint par défaut**.
La variable d'environnement `AXECODE_KERNEL_ASYNC=1` l'allume aussi (tests, essais).
Il est lu au démarrage du noyau : il vaut pour le prochain noyau (nouvelle conversation,
redémarrage ou reprise).

## Ce qui change quand il est allumé

- **Boucle asyncio permanente.** Le fil principal du noyau fait tourner une seule boucle
  d'événements ; chaque cellule est une tâche de cette boucle. `await` marche au premier
  niveau (c'était déjà le cas avec IPython, mais la boucle s'arrêtait à la fin de la
  cellule). Les tâches lancées par une cellule (`asyncio.create_task(...)`) **continuent
  entre deux cellules et entre deux tours**.
- **Sortie rendue à sa cellule.** `print` d'une tâche de fond est marqué avec l'id de la
  cellule qui l'a lancée (l'IDE l'affiche sous cette cellule). Si cette cellule est déjà
  finie, le modèle reçoit cette sortie en tête du résultat de sa prochaine cellule
  (`[sortie de fond de la cellule …]`). Les fils (`threading`) sans contexte écrivent dans
  la cellule en cours.
- **Interruption** (Stop) : si la cellule exécute du code, `KeyboardInterrupt` comme avant ;
  si elle attend un `await`, sa tâche est annulée et le résultat dit « exécution
  interrompue ». Sous Linux/macOS le signal est un vrai SIGINT : il réveille aussi un
  `time.sleep`. Une tâche de fond bloquée dans du code synchrone reçoit l'interruption.
- **`shell.start(cmd)`** rend une poignée `shell.Commande` (sous-classe de `shell.Session`,
  donc `shell.poll(h)` et `shell.stop(h)` marchent toujours) : `h.tail(n)`, `h.poll()`
  (`alive`, `exit_code`, sortie nouvelle), `h.output()`, `h.kill()`, `h.wait(timeout)`,
  `await h`. La commande est lancée directement (`bash -c` / PowerShell `-Command`) et
  non plus tapée dans un shell interactif : elle « finit » vraiment.
- **Réveil à la fin.** Une commande de fond est inscrite comme guet de genre `fond`
  (visible dans `guet.liste()` et le bloc « Guets en cours ») ; à sa fin, la session est
  réveillée par un message `<guet …>` comme pour `guet.commande`, sauf si l'agent a déjà
  lu le résultat (`wait`, `await`, `poll` après la fin) ou l'a tuée (`kill`). Si le noyau
  redémarre, ses guets de fond sont livrés « interrompu ».
- **Windows : arbre de processus.** Chaque commande de fond est créée suspendue, placée
  dans son propre Job Object « tuer à la fermeture », puis relancée : `kill()` arrête tout
  l'arbre, même les petits-enfants orphelins. Le noyau se place lui-même dans un Job
  Object : quand Axecode le tue, tout ce qu'il a lancé meurt avec lui (avant :
  `taskkill /T`, qui rate les orphelins). Ailleurs : arbre tué avec psutil, et le groupe
  de processus du noyau comme avant.

`shell.run`, `shell.session`, `shell.Session`, `shell.poll`, `shell.stop` et tout `guet`
gardent leurs signatures et leur comportement.

## Ce qui peut casser

- `asyncio.run(...)` et `loop.run_until_complete(...)` dans une cellule lèvent
  « cannot be called from a running event loop » : il faut écrire `await …`. Les
  bibliothèques qui appellent `asyncio.run` en interne ont le même problème.
- Du code synchrone long dans une cellule (ou un appel d'outil comme `rlm.wait`) bloque
  aussi les tâches de fond pendant ce temps : il n'y a qu'un fil.
- Une tâche de fond qui modifie une variable pendant l'instantané de fin de tour : la
  valeur sauvegardée est celle du moment de l'instantané. Les tâches elles-mêmes ne sont
  pas sauvegardées (ressource vivante) : après un redémarrage du noyau, elles sont
  perdues (l'avis de reprise du lot D1 le dit).
- Les images et changements de fichiers produits par une tâche de fond sont joints à la
  cellule qui se termine ensuite.
- Windows : une fois le noyau dans son Job Object, un programme qu'il lance pour qu'il
  survive au noyau doit être créé avec `CREATE_BREAKAWAY_FROM_JOB` (autorisé) ; sinon
  il est arrêté à la fermeture du noyau, y compris à une fermeture normale d'Axecode.
- `shell.start` ne garde plus le shell interactif ouvert après la commande : `h.send()`
  n'existe pas sur une `Commande` (utiliser `shell.session()`).
- `guet.annuler(id)` d'un guet de fond retire seulement le réveil ; pour arrêter la
  commande : `h.kill()`.
- Au plus 20 guets actifs par session : au-delà, la commande tourne sans réveil (un
  avertissement est écrit sur stderr).

## Retour en arrière

Éteindre `kernelAsync` (ou ne pas l'allumer) : le noyau reprend exactement le chemin
synchrone d'avant (`Kernel.execute`, `shell.start` = `Session`).

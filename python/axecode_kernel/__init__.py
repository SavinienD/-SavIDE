"""axecode_kernel — le REPL Python persistant qui fait tourner l'agent d'Axecode.

Le paquet est lancé en ``python -m axecode_kernel`` par le processus Rust
(``crates/axecode-repl``). Il héberge un ``InteractiveShell`` IPython piloté
par un protocole JSON (une ligne par message) sur stdin/stdout :

* Rust → noyau : ``init``, ``exec``, ``interrupt``, ``snapshot``, ``restore``,
  ``catalog``, ``configure``, ``gc``, ``shutdown`` et ``host_result`` ;
* noyau → Rust : ``ready``, ``stream``, ``file_change``, ``image``, ``done``,
  ``host_call`` et les réponses ``*_result``.

Chaque module public de ce paquet (``files``, ``shell``, ``web``…) est un
outil exposé au modèle dans l'espace de noms du noyau. Leurs docstrings sont
la documentation montrée au modèle : gardez-les courtes et précises.
"""

__version__ = "0.1.0"

"""Garde-fou : aucun texte anglais visible dans le noyau Python.

Le modèle et l'utilisateur voient les docstrings (prompt système, ``help()``,
réglages des outils) et les messages (erreurs, retours des fonctions, sorties
du noyau). Ce test lit toutes les chaînes du paquet ``axecode_kernel`` (AST :
docstrings, littéraux, morceaux de f-strings) et échoue s'il y reste des mots
anglais. Les extraits de code (``...``, `...`, {champ}) ne sont pas lus.
"""

import ast
import inspect
import os
import re

KERNEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "axecode_kernel")

# Mots anglais courants qui n'existent pas en français (les mots communs aux
# deux langues, comme session, message, page ou plan, n'y sont pas).
ENGLISH = {
    "the", "and", "of", "is", "are", "was", "were", "not", "with", "from", "this",
    "that", "these", "those", "its", "be", "been", "being", "by", "has", "have",
    "had", "must", "should", "cannot", "can", "will", "would", "when", "which",
    "returns", "return", "only", "into", "than", "then", "use", "used", "using",
    "your", "you", "does", "do", "it", "or", "an", "at", "if", "all", "any",
    "every", "each", "no", "file", "files", "error", "errors", "found", "missing",
    "failed", "unknown", "timed", "out", "too", "large", "limit", "reached",
    "invalid", "empty", "string", "required", "one", "list", "lists", "read",
    "write", "run", "runs", "start", "set", "get", "show", "shows", "call", "calls",
    "send", "new", "current", "result", "results", "task", "tasks", "user", "entry",
    "entries", "memory", "sheet", "slide", "directory", "directories", "binary",
    "text", "deleted", "moved", "created", "updated", "edited", "attached",
    "warning", "interrupted", "execution", "host", "kernel", "live", "resource",
    "process", "open", "event", "loop", "saved", "snapshot", "spent", "bytes",
    "lines", "line", "chars", "omitted", "delivered", "turn", "scheduled",
    "matching", "matches", "times", "replacement", "replacements", "changed",
    "disk", "since", "first", "again", "exists", "such", "where", "while", "until",
    "after", "before", "without", "within", "whether", "still", "running",
    "command", "commands", "output", "search", "fetch", "child", "children",
    "sibling", "siblings", "scope", "project", "status", "progress", "interval",
    "seconds", "least", "most",
}


CODE = re.compile(r"\b\w+=|\b\w+(?:[._]\w+)+\b|``.*?``|`[^`]*`|\{[^{}]*\}|<[^<>]*>|'[^'\s]*'|\"[^\"]*\"|https?://\S+|\b\w+\([^()]*\)|^\w+ — ")
WORD = re.compile(r"[A-Za-zÀ-ÿ]+(?:'[a-z]+)?")


def _strings(tree):
    """(ligne, texte) de chaque chaîne du module, f-strings comprises."""
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = "".join(
                part.value if isinstance(part, ast.Constant) and isinstance(part.value, str) else "{x}"
                for part in node.values
            )
            out.append((node.lineno, text))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and not getattr(node, "_vu", False):
            out.append((node.lineno, node.value))
    return out


def _english(text):
    if not re.search(r"\s", text):  # sans espace : identifiant, annotation, clé
        return []
    cleaned, previous = text, None
    while cleaned != previous:  # {…} imbriquées : on retire de l'intérieur vers l'extérieur
        previous, cleaned = cleaned, CODE.sub(" ", cleaned)
    words = [w.lower() for w in WORD.findall(cleaned)]
    if len(words) < 2:  # identifiants, clés du protocole, valeurs techniques
        return []
    return [w for w in words if w in ENGLISH]


def _ignored(text):
    """Chaînes techniques : scripts shell, commandes, motifs."""
    return (
        "$ProgressPreference" in text or "LASTEXITCODE" in text or "printf" in text
        or text.startswith(("-", "/", "\\", "^", "%", "echo ", "ppt/", "word/", "xl/"))
        or text.strip().startswith(("import ", "python ", "soffice"))
    )


def _offenders():
    found = []
    for name in sorted(os.listdir(KERNEL)):
        if not name.endswith(".py"):
            continue
        path = os.path.join(KERNEL, name)
        with open(path, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), path)
        # Les parties de f-strings sont lues avec leur f-string : on les marque
        # avant le parcours pour ne pas les relire seules.
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr):
                for part in node.values:
                    part._vu = True
        for lineno, text in _strings(tree):
            if _ignored(text):
                continue
            bad = _english(text)
            if bad:
                found.append(f"{name}:{lineno}: {sorted(set(bad))} « {text.strip()[:90]} »")
    return found


def test_aucun_texte_anglais_visible():
    offenders = _offenders()
    assert not offenders, "Texte anglais visible dans le noyau :\n" + "\n".join(offenders)


def test_catalogue_en_francais():
    """Les docstrings vues dans le prompt (catalogue des modules) sont en français."""
    import importlib

    from axecode_kernel.__main__ import MODULES

    bad = []
    for name in MODULES:
        module = importlib.import_module(f"axecode_kernel.{name}")
        docs = [(name, inspect.getdoc(module) or "")]
        for fn_name in getattr(module, "__all__", []):
            fn = getattr(module, fn_name)
            docs.append((f"{name}.{fn_name}", inspect.getdoc(fn) or ""))
        for label, doc in docs:
            assert doc.strip(), f"{label} sans docstring"
            words = _english(doc)
            if words:
                bad.append(f"{label}: {sorted(set(words))}")
    assert not bad, "Docstrings anglaises :\n" + "\n".join(bad)


def test_le_detecteur_voit_l_anglais():
    """Le garde-fou n'est pas vide : de l'anglais typique est bien repéré."""
    assert _english("{path} is a binary file: files.read only returns text")
    assert _english("Return the text of a file (optionally lines ``offset``).")
    assert not _english("{path} est un fichier binaire : ``files.read`` ne renvoie que du texte")
    assert not _english("error")  # un seul mot : clé du protocole

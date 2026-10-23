export function workspaceUnavailable(error: string): { title: string; description: string } {
  if (/unknown method\s+(?:fs|git)\./i.test(error)) {
    return {
      title: "Serveur joignable · IDE distant non activé",
      description: "Le service de l’SavIDE utilise encore une ancienne version. Les fichiers, l’éditeur et Git nécessitent une mise à jour du serveur par l’administrateur. Réinstaller l’application ne suffit pas.",
    };
  }
  if (/workspace root is not configured/i.test(error)) {
    return {
      title: "Espace de travail non configuré",
      description: "Le serveur prend en charge l’IDE distant, mais aucun dossier de travail n’a été configuré pour ce service. L’administrateur doit terminer sa configuration.",
    };
  }
  return {
    title: "Espace distant indisponible",
    description: "La vérification des fichiers distants a échoué. Réessayez ; si le problème persiste, revenez à l’écran connecté et faites vérifier le service de l’SavIDE.",
  };
}

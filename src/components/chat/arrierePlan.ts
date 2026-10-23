// axe:arriere-plan — « Arrière-plan » : libérer la conversation sans perdre le
// travail en cours (demande de l'utilisateur : « pour ne pas monopoliser la conv,
// qu'on puisse décider de mettre en arrière-plan ce que tu fais pour que le
// message en queue se lance »).
//
// 1. sessions.stop sur la conversation : arrêt poli (le démon laisse 8 s au
//    tour, puis l'abandonne) ;
// 2. on attend que la session ne tourne plus : journal complet, instantané du
//    noyau écrit en fin de tour ;
// 3. sessions.fork depuis la dernière entrée, parentId = la conversation : le
//    clone (« <titre> — arrière-plan ») apparaît sous elle dans la vue Agents,
//    avec les variables du noyau (instantané copié par le démon) ;
// 4. sessions.send au clone : il reprend la tâche et rendra compte à la
//    conversation parente ;
// 5. (ChatPane) la conversation est libérée : son premier message en file part,
//    précédé de `noteConversation`.
//
// Module pur (aucun import) : testé par tests/arrierePlan.test.cjs.

export const SUFFIXE_ARRIERE_PLAN = " — arrière-plan";
/** 8 s de grâce du démon (DaemonConfig.stop_grace) + l'abandon du noyau. */
export const ATTENTE_ARRET_MAX_MS = 15_000;
export const PAS_ATTENTE_MS = 250;

function titrePropre(titre: string | null | undefined): string {
  const t = (titre ?? "").replace(/\s+/g, " ").trim();
  return t || "Conversation";
}

/** Nom de la session d'arrière-plan (vue Agents). */
export function nomArrierePlan(titre: string | null | undefined): string {
  return `${titrePropre(titre)}${SUFFIXE_ARRIERE_PLAN}`;
}

/** Message envoyé à la session d'arrière-plan. */
export function consigneArrierePlan(titre: string | null | undefined): string {
  return (
    `Tu continues en arrière-plan la tâche de la conversation « ${titrePropre(titre)} », ` +
    "que l'utilisateur a libérée. Reprends exactement où le travail s'est arrêté, sans refaire " +
    "ce qui est fait. À la fin, rends compte en deux phrases à la conversation parente " +
    "avec messages.send(…, receiver_role='parent')."
  );
}

/** Ligne mise devant le prochain message de la conversation libérée. */
export function noteConversation(nom: string): string {
  return (
    `(Le travail en cours continue en arrière-plan dans « ${nom} » : ` +
    "ne le reprends pas ici.)"
  );
}

/** Le message qui part : la note (s'il y en a une), une ligne vide, le texte. */
export function avecNote(note: string | null | undefined, texte: string): string {
  return note ? `${note}\n\n${texte}` : texte;
}

export type StatutSession = "running" | "idle" | "inactive" | string | null;

export type ServicesArrierePlan = {
  arreter(id: string): Promise<unknown>;
  statut(id: string): Promise<StatutSession>;
  forker(id: string, nom: string, parentId: string): Promise<{ id: string; name?: string }>;
  envoyer(id: string, texte: string): Promise<unknown>;
  attendre(ms: number): Promise<void>;
};

export class ErreurArrierePlan extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurArrierePlan";
  }
}

export async function mettreEnArrierePlan(
  services: ServicesArrierePlan,
  conversation: { id: string; titre: string | null | undefined },
  options: { attenteMaxMs?: number; pasMs?: number } = {},
): Promise<{ id: string; nom: string }> {
  const max = options.attenteMaxMs ?? ATTENTE_ARRET_MAX_MS;
  const pas = Math.max(1, options.pasMs ?? PAS_ATTENTE_MS);
  await services.arreter(conversation.id);
  let ecoule = 0;
  for (;;) {
    const statut = await services.statut(conversation.id);
    if (statut !== "running") break;
    if (ecoule >= max) {
      throw new ErreurArrierePlan(
        "le tour ne s'est pas arrêté à temps : rien n'est parti en arrière-plan",
      );
    }
    await services.attendre(pas);
    ecoule += pas;
  }
  const nom = nomArrierePlan(conversation.titre);
  const clone = await services.forker(conversation.id, nom, conversation.id);
  if (!clone?.id) throw new ErreurArrierePlan("le service n'a pas créé la session d'arrière-plan");
  await services.envoyer(clone.id, consigneArrierePlan(conversation.titre));
  return { id: clone.id, nom: clone.name || nom };
}

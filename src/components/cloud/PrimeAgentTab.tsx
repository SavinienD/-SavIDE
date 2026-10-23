// axe:cloud — « Prime Agent » tab: chat with Prime (portal API, one task at a
// time, answer polled every 2 s), tickets and quick links from the local
// cache of Prime. Everything goes through `cloud_api` (Bearer added in Rust).
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../../lib/ipc";
import {
  CloudError,
  errorText,
  primeApi,
  type ChatMessage,
  type Download,
  type PrimeMoi,
  type QuickLink,
  type Ticket,
} from "./cloudApi";
import { CloudLoginButton, useCloudState } from "./CloudLoginButton";

const POLL_MS = 2000;
/** The portal stops a task after 300 s (queue + run): stop polling a bit later. */
const POLL_LIMIT_MS = 310_000;

type Pending = { tache: string; since: number };

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function openLink(url?: string) {
  if (url && /^https:\/\//i.test(url)) void api.openExternalUrl(url).catch(() => undefined);
}

// axe:connexion-google - non connecte : bouton de connexion au lieu d'un panneau vide.
export function PrimeAgentTab({ active }: { active: boolean }) {
  const etat = useCloudState();
  if (etat && !etat.connected) {
    return (
      <div className="axc-prime" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 24 }}>
        <p>Prime Agent nécessite une connexion à Axe Cloud.</p>
        <CloudLoginButton className="axc-btn" />
      </div>
    );
  }
  return <PrimeAgentTabConnecte active={active} />;
}

function PrimeAgentTabConnecte({ active }: { active: boolean }) {
  const [moi, setMoi] = useState<PrimeMoi | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  const [links, setLinks] = useState<QuickLink[] | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const logBox = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      setMessages((await primeApi.history()).messages ?? []);
    } catch (err) {
      setChatError(errorText(err));
    }
  }, []);

  const loadTickets = useCallback(async () => {
    setTicketsError(null);
    try {
      setTickets((await primeApi.tickets()).tickets ?? []);
    } catch (err) {
      setTicketsError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void primeApi
      .moi()
      .then(setMoi)
      .catch((err) => setChatError(errorText(err)));
    void loadHistory();
    void loadTickets();
    void primeApi
      .links()
      .then((reply) => {
        setLinks(reply.liens ?? []);
        setDownloads(reply.telechargements ?? []);
      })
      .catch((err) => setLinksError(errorText(err)));
  }, [loadHistory, loadTickets]);

  // Poll the running task until it ends (or the portal's time limit passes).
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      if (stopped) return;
      if (Date.now() - pending.since > POLL_LIMIT_MS) {
        setPending(null);
        setChatError("Prime n'a pas répondu à temps (5 minutes). Réessayez plus tard.");
        return;
      }
      try {
        const task = await primeApi.task(pending.tache);
        if (stopped || task.etat === "en_cours") return;
        setPending(null);
        if (task.etat === "fini") {
          setMessages((list) => [...list, { role: "prime", texte: task.reponse ?? "", date: task.fin ?? new Date().toISOString() }]);
          void loadHistory();
        } else {
          setChatError(task.erreur || "Prime n'a pas pu répondre.");
        }
      } catch (err) {
        if (err instanceof CloudError && err.status === 404) {
          setPending(null);
          setChatError("Cette demande n'existe plus. Renvoyez votre message.");
        }
        // Network hiccup: keep polling until the time limit.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pending, loadHistory]);

  useEffect(() => {
    // axe:robustesse — défiler la zone des messages elle-même (jamais scrollIntoView : il défile aussi les parents).
    const log = logBox.current;
    if (active && log) log.scrollTop = log.scrollHeight;
  }, [messages, pending, active]);

  const chatAllowed = moi ? moi.chat : true;

  const send = async () => {
    const text = draft.trim();
    if (!text || pending || !chatAllowed) return;
    setChatError(null);
    try {
      const reply = await primeApi.send(text, fresh);
      setMessages((list) => [...(fresh ? [] : list), { role: "moi", texte: text, date: new Date().toISOString() }]);
      setDraft("");
      setFresh(false);
      setPending({ tache: reply.tache, since: Date.now() });
    } catch (err) {
      const data = err instanceof CloudError ? (err.data as { tache?: string } | null) : null;
      if (err instanceof CloudError && err.status === 409 && data?.tache) {
        // A task is already running for this person: follow it.
        setPending({ tache: data.tache, since: Date.now() });
      }
      setChatError(errorText(err));
    }
  };

  const newConversation = () => {
    setMessages([]);
    setFresh(true);
    setChatError(null);
  };

  return (
    <div className="axc-prime">
      {/* axe:l8 — le tableau de bord Prime (tickets, surveillances, journal) en un clic ;
          main.tsx ouvre les liens https dans le navigateur. */}
      <a
        className="axc-l8"
        href="https://cloud.exemple.invalid/prime/"
        title="Ouvrir le tableau de bord Prime dans le navigateur"
      >
        Tableau de bord Prime ↗
      </a>
      <section className="axc-chat" aria-label="Discussion avec Prime">
        {moi && !moi.chat ? (
          <p className="axc-banner axc-banner--warn" role="status">
            {moi.chat_motif || "La discussion avec Prime n'est pas encore ouverte pour votre compte."}
          </p>
        ) : null}
        <div className="axc-chat__log" ref={logBox}>
          {messages.length === 0 && !pending ? (
            <p className="axc-empty">
              {fresh ? "Nouvelle conversation : écrivez votre premier message." : "Posez votre question à Prime : un ticket, un client, une procédure…"}
            </p>
          ) : null}
          {messages.map((message, index) => (
            <div key={index} className="axc-msg" data-role={message.role}>
              <div className="axc-msg__meta">
                {message.role === "moi" ? "Vous" : "Prime"} · {timeLabel(message.date)}
              </div>
              {message.role === "prime" ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.texte}</ReactMarkdown>
              ) : (
                <p>{message.texte}</p>
              )}
            </div>
          ))}
          {pending ? (
            <div className="axc-msg axc-msg--pending" data-role="prime" role="status">
              <span className="axc-spinner" aria-hidden="true" /> Prime réfléchit… (jusqu'à 5 minutes)
            </div>
          ) : null}
          {chatError ? (
            <div className="axc-msg axc-msg--error" data-role="prime" role="alert">
              {chatError}
            </div>
          ) : null}
        </div>
        <div className="axc-chat__composer">
          <textarea
            className="axc-chat__input"
            rows={2}
            maxLength={8000}
            placeholder={chatAllowed ? "Votre message à Prime (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)" : "Discussion indisponible"}
            value={draft}
            disabled={!chatAllowed}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" className="axc-btn axc-btn--ghost" onClick={newConversation} disabled={!!pending}>
            Nouvelle conversation
          </button>
          <button
            type="button"
            className="axc-btn axc-btn--primary"
            onClick={() => void send()}
            disabled={!draft.trim() || !!pending || !chatAllowed}
          >
            Envoyer
          </button>
        </div>
      </section>

      <aside className="axc-side">
        {/* axe:liens — liens rapides EN PREMIER : sous la liste des tickets (jusqu'à 50), ils étaient invisibles sans défiler. */}
        <section>
          <h2 className="axc-section__title">
            <span>Liens rapides</span>
          </h2>
          {linksError ? <p className="axc-error">{linksError}</p> : null}
          <div className="axc-links">
            {(links ?? []).map((link) => (
              <button key={link.url} type="button" className="axc-link" onClick={() => openLink(link.url)} title={link.url}>
                <span className="axc-link__icon" aria-hidden="true">
                  {link.nom.charAt(0).toUpperCase()}
                </span>
                <span>
                  <span className="axc-link__name">{link.nom}</span>
                  {link.description ? <span className="axc-link__desc">{link.description}</span> : null}
                </span>
              </button>
            ))}
            {downloads.slice(0, 1).map((d) => (
              <button key={d.url} type="button" className="axc-link" onClick={() => openLink(d.url)} title={d.url}>
                <span className="axc-link__icon" aria-hidden="true">↓</span>
                <span>
                  <span className="axc-link__name">Télécharger SavIDE</span>
                  <span className="axc-link__desc">{d.nom}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2 className="axc-section__title">
            <span>Tickets suivis par Prime</span>
            <button type="button" className="axc-btn axc-btn--ghost" onClick={() => void loadTickets()}>
              Actualiser
            </button>
          </h2>
          {ticketsError ? <p className="axc-error">{ticketsError}</p> : null}
          {tickets === null && !ticketsError ? <p className="axc-empty">Chargement…</p> : null}
          {tickets && tickets.length === 0 ? <p className="axc-empty">Aucun ticket en cours.</p> : null}
          <ul className="axc-tickets">
            {(tickets ?? []).slice(0, 50).map((ticket) => (
              <li key={String(ticket.id)}>
                <button type="button" className="axc-ticket" onClick={() => openLink(ticket.url)} disabled={!ticket.url}>
                  <span className="axc-ticket__id">#{ticket.id}</span>
                  <span className="axc-ticket__subject">{ticket.sujet || "(sujet inconnu)"}</span>
                  <span className="axc-ticket__meta">
                    {ticket.etat} · {timeLabel(ticket.maj)}
                    {ticket.derniere_action ? ` · ${ticket.derniere_action}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

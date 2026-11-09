// Réglages > Serveurs MCP : liste dépliable (état, outils, interrupteur), détail, Tester, Supprimer.
import { useEffect, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Icon } from "@iconify/react";
import { McpCatalogPanel } from "./McpCatalogPanel";
import { ErreurMcp } from "./McpErreur";
import { expliquerErreurMcp } from "../../axe/mcpGuide";
import { redactCommand } from "../../axe/mcpCatalog";
import { serveurInterne, sondeDuServeur, etatLigne } from "../../lib/mcpServeurs";
import { loadTextScale, MONO_BASE_PX, MONO_LINE_BASE_PX, onTextScaleChange } from "../../axe/zoom";
import type { McpOAuthStatus, McpServerConfig, McpServerProbe } from "../../types";
import "./mcp-serveurs.css";

export type McpSectionProps = {
  loading: boolean;
  saving: boolean;
  probing: boolean;
  dirty: boolean;
  status: string | null;
  parseError: string | null;
  jsonText: string;
  onJsonChange: (value: string) => void;
  onSave: () => void;
  servers: McpServerConfig[];
  probes: McpServerProbe[];
  openServerId: string | null;
  onOpenServer: (id: string | null) => void;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  knownToolCounts: Record<string, number>;
  onToggleEnabled: (id: string) => void;
  oauthStatuses: Record<string, McpOAuthStatus>;
  oauthBusyId: string | null;
  onConnectOAuth: (id: string) => void;
  onCancelOAuth: (id: string) => void;
  onDisconnectOAuth: (id: string) => void;
  deletingServerId: string | null;
  onDeleteServer: (id: string) => void;
  onMount: OnMount;
  catalogOpen: boolean;
  onOpenCatalog: () => void;
  onCloseCatalog: () => void;
  onAddServer: (server: McpServerConfig, connecter: boolean) => Promise<boolean>;
  onTestCandidate: (server: McpServerConfig) => Promise<McpServerProbe>;
  testingServerId: string | null;
  testedIds: Set<string>;
  onTestServer: (id: string) => void;
  actionsInterop?: React.ReactNode;
};

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

export function McpSection(p: McpSectionProps) {
  const [textScale, setTextScale] = useState<number>(() => loadTextScale());
  useEffect(() => onTextScaleChange(setTextScale), []);
  const actifs = p.servers.filter((s) => s.enabled).length;
  const enErreur = p.servers.filter((s) => {
    const sonde = sondeDuServeur(p.probes, s);
    return s.enabled && sonde && !sonde.ok;
  }).length;
  const resume = p.loading
    ? "Chargement…"
    : p.servers.length === 0
      ? "Aucun serveur."
      : `${actifs}/${p.servers.length} actif${actifs > 1 ? "s" : ""}${enErreur ? ` · ${enErreur} en erreur` : ""}${p.probing ? " · vérification…" : ""}`;

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Serveurs MCP</h1>
          <p className="settings-pane__subtitle" data-court="true" title={resume}>{resume}</p>
        </div>
        <div className="settings-pane__actions">
          {p.actionsInterop}
          <button type="button" className="settings-pane__btn" data-primary="true" onClick={p.onOpenCatalog} disabled={p.loading || p.saving}>
            <Icon icon="solar:add-circle-linear" width={13} height={13} />
            <span>Ajouter un serveur</span>
          </button>
          <button type="button" className="settings-pane__btn" data-action="mcp-json" onClick={() => p.onAdvancedOpenChange(!p.advancedOpen)} disabled={p.loading}>
            <Icon icon="solar:code-square-linear" width={13} height={13} />
            <span>{p.advancedOpen ? "Fermer le JSON" : "Modifier en JSON"}</span>
          </button>
        </div>
      </header>

      {p.status && (
        <div className="mcp-avis" data-tone={p.parseError ? "error" : "ok"} role="status">{p.status}</div>
      )}

      {p.catalogOpen ? (
        <McpCatalogPanel
          busy={p.saving}
          error={p.parseError}
          existingIds={p.servers.map((s) => s.id)}
          onTest={p.onTestCandidate}
          onAdd={p.onAddServer}
          onCancel={p.onCloseCatalog}
        />
      ) : null}

      <div className="settings-pane__body settings-pane__body--mcp mcp-page">
        {p.advancedOpen ? (
          <div className="settings-pane__editor-card mcp-json">
            <div className="settings-pane__editor-bar">
              <div className="settings-pane__editor-bar-left">
                <Icon icon="solar:code-square-linear" width={13} height={13} />
                <span>mcp.json</span>
              </div>
              <div className="settings-pane__editor-bar-right">
                <button type="button" className="settings-pane__btn mcp-json__enregistrer" data-primary="true" onClick={p.onSave} disabled={p.saving || !p.dirty || Boolean(p.parseError)}>
                  <span>{p.saving ? "Enregistrement…" : p.dirty ? "Enregistrer" : "Aucune modification"}</span>
                </button>
              </div>
            </div>
            <div className="settings-pane__editor-host">
              <Editor
                value={p.jsonText}
                language="json"
                theme="axecode-cool"
                onChange={(value) => p.onJsonChange(value ?? "")}
                onMount={p.onMount}
                options={{
                  fontFamily: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
                  fontSize: Math.max(1, Math.round(MONO_BASE_PX * textScale)),
                  lineHeight: Math.max(1, Math.round(MONO_LINE_BASE_PX * textScale)),
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  padding: { top: 12, bottom: 12 },
                  tabSize: 2,
                  wordWrap: "on",
                  automaticLayout: true,
                  lineNumbersMinChars: 3,
                }}
              />
            </div>
            {p.parseError && (
              <div className="settings-pane__editor-error">
                <Icon icon="solar:danger-triangle-linear" width={13} height={13} />
                <span>{p.parseError}</span>
              </div>
            )}
          </div>
        ) : p.servers.length === 0 && !p.loading ? (
          <div className="settings-pane__empty-state">
            <Icon icon="solar:server-square-cloud-linear" width={18} height={18} />
            <div>
              <strong>Aucun serveur MCP.</strong>
              <span>« Ajouter » propose les serveurs courants ; « Importer » reprend ceux de Claude Code, Codex, Cursor ou VS Code.</span>
            </div>
          </div>
        ) : (
          <ul className="mcp-liste" aria-label="Serveurs">
            {p.servers.map((server) => {
              const sonde = sondeDuServeur(p.probes, server);
              const etat = etatLigne(server, sonde, p.probing, p.knownToolCounts[server.id]);
              const ouvert = p.openServerId === server.id;
              const nom = server.name || "Sans nom";
              const interne = serveurInterne(server);
              return (
                <li key={server.id} className="settings-pane__nav-list-item mcp-serveur" data-server={server.name} data-open={ouvert ? "true" : "false"} data-on={server.enabled ? "true" : "false"}>
                  <div className="mcp-serveur__ligne">
                    <button
                      type="button"
                      className="settings-pane__nav-list-item-main mcp-serveur__titre"
                      data-etat={etat.ton}
                      aria-expanded={ouvert}
                      onClick={() => p.onOpenServer(ouvert ? null : server.id)}
                    >
                      <Icon icon="solar:alt-arrow-right-linear" width={12} height={12} className="mcp-serveur__fleche" />
                      <span className="mcp-serveur__point" data-tone={etat.ton} aria-hidden />
                      <span className="mcp-serveur__nom">{nom}</span>
                      {interne && <span className="mcp-serveur__marque" title={interne}>interne à Codex</span>}
                      <span className="mcp-serveur__etat" data-tone={etat.ton}>{etat.libelle}</span>
                    </button>
                    <button
                      type="button"
                      className="settings-pane__switch"
                      role="switch"
                      aria-checked={server.enabled}
                      aria-label={`${server.enabled ? "Désactiver" : "Activer"} ${nom}`}
                      title={server.enabled ? "Actif : cliquer pour désactiver" : "Désactivé : cliquer pour activer"}
                      data-on={server.enabled ? "true" : "false"}
                      disabled={p.loading || p.saving || Boolean(p.parseError)}
                      onClick={() => p.onToggleEnabled(server.id)}
                    >
                      <span className="settings-pane__switch-thumb" />
                    </button>
                  </div>
                  {ouvert && (
                    <DetailServeur
                      server={server}
                      probe={sonde}
                      probing={p.probing}
                      interne={interne}
                      oauthStatus={p.oauthStatuses[server.id]}
                      oauthBusy={p.oauthBusyId === server.id}
                      onConnectOAuth={p.onConnectOAuth}
                      onCancelOAuth={p.onCancelOAuth}
                      onDisconnectOAuth={p.onDisconnectOAuth}
                      deleting={p.deletingServerId === server.id}
                      deleteDisabled={p.saving || p.loading || p.deletingServerId !== null}
                      onDelete={p.onDeleteServer}
                      testing={p.testingServerId === server.id}
                      tested={p.testedIds.has(server.id)}
                      onTest={p.onTestServer}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

type DetailProps = {
  server: McpServerConfig;
  probe: McpServerProbe | null;
  probing: boolean;
  interne: string | null;
  oauthStatus: McpOAuthStatus | undefined;
  oauthBusy: boolean;
  onConnectOAuth: (id: string) => void;
  onCancelOAuth: (id: string) => void;
  onDisconnectOAuth: (id: string) => void;
  deleting: boolean;
  deleteDisabled: boolean;
  onDelete: (id: string) => void;
  testing: boolean;
  tested: boolean;
  onTest: (id: string) => void;
};

function DetailServeur({
  server, probe, probing, interne, oauthStatus, oauthBusy, onConnectOAuth, onCancelOAuth, onDisconnectOAuth,
  deleting, deleteDisabled, onDelete, testing, tested, onTest,
}: DetailProps) {
  // Premier clic : demande de confirmation (3 s) ; second clic : suppression.
  const [confirmer, setConfirmer] = useState(false);
  useEffect(() => {
    if (!confirmer) return;
    const id = window.setTimeout(() => setConfirmer(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirmer]);

  const url = server.url?.trim() ?? "";
  const commande = url || redactCommand([server.command, ...server.args]);
  const connecting = oauthStatus?.connectionState === "connecting";
  const authenticated = connecting ? false : oauthStatus ? oauthStatus.connected : Boolean(probe?.authenticated);
  const oauthError = oauthStatus?.connectionState === "error" ? oauthStatus.error : null;
  const montrerAuth = Boolean(url) || Boolean(probe?.authRequired);
  const erreur = probe && !probe.ok
    ? expliquerErreurMcp(probe.error, { transport: probe.transport, authRequired: probe.authRequired })
    : null;
  const outils = probe?.ok ? probe.tools : [];

  return (
    <div className="settings-pane__detail mcp-detail">
      {interne && (
        <p className="mcp-detail__alerte">
          Serveur interne de Codex : il ne sert qu'à Codex. Mieux vaut le désactiver ou le supprimer.
        </p>
      )}
      <div className="mcp-detail__actions">
        <button type="button" className="settings-pane__btn settings-pane__mcp-tester" onClick={() => onTest(server.id)} disabled={testing} title="Lancer le serveur et lister ses outils">
          <Icon icon={testing ? "solar:refresh-linear" : "solar:plug-circle-linear"} width={13} height={13} />
          <span>{testing ? "Test en cours…" : "Tester"}</span>
        </button>
        <button
          type="button"
          className="settings-pane__btn settings-pane__mcp-delete"
          data-danger="true"
          data-confirm={confirmer ? "true" : "false"}
          disabled={deleteDisabled}
          aria-label={confirmer ? `Confirmer la suppression de ${server.name}` : `Supprimer ${server.name}`}
          onClick={() => {
            if (confirmer) {
              setConfirmer(false);
              onDelete(server.id);
            } else {
              setConfirmer(true);
            }
          }}
        >
          <Icon icon={deleting ? "solar:refresh-linear" : "solar:trash-bin-trash-linear"} width={13} height={13} />
          <span>{deleting ? "Suppression…" : confirmer ? "Cliquer pour confirmer" : "Supprimer"}</span>
        </button>
      </div>

      <dl className="mcp-detail__infos">
        <dt>{url ? "Adresse" : "Commande"}</dt>
        <dd><code className="mcp-detail__commande" title={commande}>{commande || "—"}</code></dd>
        {server.cwd && (<><dt>Dossier</dt><dd><code>{server.cwd}</code></dd></>)}
        {server.env.length > 0 && (
          <>
            <dt>Variables</dt>
            <dd>
              <ul className="mcp-detail__variables">
                {server.env.map((v) => (
                  <li key={v.key}>
                    <code>{v.key}</code>
                    <span className="mcp-detail__valeur">{v.value ? "••••••" : "vide"}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      {tested && probe && !testing && (
        <div className="settings-pane__mcp-test mcp-detail__test" data-tone={probe.ok ? "ok" : probe.authRequired ? "auth" : "error"} role="status">
          {probe.ok
            ? `Test réussi : ${pluriel(probe.tools.length, "outil")}.`
            : probe.authRequired
              ? "Test : connexion requise."
              : "Test échoué (détail ci-dessous)."}
        </div>
      )}

      {montrerAuth && (
        <div className="settings-pane__mcp-auth mcp-detail__auth">
          <span>{connecting ? "Connexion…" : authenticated ? "Connecté." : "Pas connecté : autorisez ce serveur dans le navigateur."}</span>
          {connecting ? (
            <button type="button" className="settings-pane__btn" onClick={() => onCancelOAuth(server.id)}>Annuler</button>
          ) : authenticated ? (
            <button type="button" className="settings-pane__btn" onClick={() => onDisconnectOAuth(server.id)} disabled={oauthBusy}>
              {oauthBusy ? "Déconnexion…" : "Déconnecter"}
            </button>
          ) : (
            <button type="button" className="settings-pane__btn" data-primary="true" onClick={() => onConnectOAuth(server.id)} disabled={oauthBusy}>
              {oauthBusy ? "Ouverture…" : "Connecter"}
            </button>
          )}
          {oauthError && <div className="settings-pane__mcp-auth-error">{oauthError}</div>}
        </div>
      )}

      {erreur && <ErreurMcp erreur={erreur} />}

      <div className="mcp-detail__titre">Outils{outils.length ? ` (${outils.length})` : ""}</div>
      {outils.length > 0 ? (
        <ul className="settings-pane__tool-list mcp-outils">
          {outils.map((t) => (
            <li key={t.toolName} className="mcp-outil">
              <code className="mcp-outil__nom">{t.title || t.name}</code>
              {t.description?.trim() ? <span className="mcp-outil__desc" title={t.description}>{t.description}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-pane__muted mcp-detail__vide">
          {probe?.ok && probe.enabled
            ? "Le serveur ne propose aucun outil."
            : !server.enabled
              ? "Serveur désactivé. « Tester » liste ses outils sans l'activer."
              : erreur
                ? "Aucun outil : le serveur ne répond pas."
                : probing || testing
                  ? "Interrogation du serveur…"
                  : "Pas encore interrogé : cliquez sur « Tester »."}
        </p>
      )}
    </div>
  );
}

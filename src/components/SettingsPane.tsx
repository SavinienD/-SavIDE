import { EDITION_LOCALE } from "../lib/edition";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Icon } from "@iconify/react";
import { api, cloudRpc } from "../lib/ipc"; // axe:e16
import { Markdown } from "./chat/Markdown";
import { AxeLogo } from "../axe/Logo";
import { RaccourcisSection } from "../axe/RaccourcisSection"; // axe:raccourcis
import { VoixSection } from "../axe/voix/VoixSection"; // axe:voix
import { AppearanceSection } from "../axe/AppearanceSection"; // axe:theme
import { monacoThemeData } from "../axe/themeTargets"; // axe:theme
import {
  loadTextScale,
  MONO_BASE_PX,
  MONO_LINE_BASE_PX,
  onTextScaleChange,
} from "../axe/zoom"; // axe:zoom
import { CustomProvidersPanel } from "../axe/CustomProvidersPanel"; // axe:providers
import { GeminiWebCard } from "../axe/GeminiWebCard"; // axe:gemini-web
import { HarnessBackupSection } from "../axe/HarnessBackupSection"; // axe:cleanup
import { customModelEntries, providerApi } from "../axe/providers"; // axe:providers
import { HarnessPane } from "./settings/HarnessPane"; // axe:harness
import { ReplToolsPane } from "./settings/ReplToolsPane"; // axe:repl
import { RegistrePane } from "./settings/RegistrePane"; // axe:e4
import { ServicePane } from "./settings/ServicePane"; // axe:daemon
import { ConnectionsPane } from "./settings/ConnectionsPane"; // axe:remote
import { McpCatalogPanel } from "./settings/McpCatalogPanel"; // axe:e7
import {
  collectMcpSecrets,
  redactCommand,
  redactMcpSecrets,
  restoreMcpSecrets,
  type McpSecretVault,
} from "../axe/mcpCatalog"; // axe:e7
// axe:cleanup — unified Skills tab (Markdown recipes + harness Python skills)
import { harnessApi, type HarnessEntry } from "./settings/harnessApi";
import { CLOUD_CONNECTION, cloudApi } from "./cloud/cloudApi"; // axe:e16
import { oublierSectionReglages, sectionReglagesDemandee } from "../lib/sectionReglages"; // axe:parcours-collegue
import { PythonSkillPreview, isPySkillEnabled } from "./settings/PythonSkillPreview";
type SkillKindFilter = "all" | "recipe" | "python";
import { sanitizeOpenRouterName, type ModelEntry } from "../lib/models";
import type {
  AnthropicProviderStatus,
  GoogleProviderStatus,
  InstalledSkill,
  KimiProviderStatus,
  McpAuthConfig,
  McpEnvVar,
  McpHeader,
  McpOAuthStatus,
  McpServerConfig,
  McpServerProbe,
  McpSettings,
  OpenAiProviderStatus,
  OpenRouterModel,
  OpenRouterModelSearchResult,
  OpenRouterProviderStatus,
  SkillSettings,
} from "../types";

const EMPTY_SETTINGS: McpSettings = { servers: [] };
const PROVIDERS_CHANGED_EVENT = "axecode:providers-changed";

type Props = {
  workspacePath: string;
};

type Section =
  | "about"
  | "appearance" // axe:theme
  | "providers"
  | "mcp"
  | "skills"
  | "harness" // axe:harness
  | "repl" // axe:repl
  | "service" // axe:daemon
  | "connections" // axe:remote
  | "shortcuts" // axe:raccourcis
  | "voice"; // axe:voix

export function SettingsPane({ workspacePath }: Props) {
  // axe:parcours-collegue — section demandée avant le montage (« Connect a provider ») : avant, « About ».
  const [section, setSection] = useState<Section>(
    () => (sectionReglagesDemandee() as Section | null) ?? "about",
  );
  const [settings, setSettings] = useState<McpSettings>(EMPTY_SETTINGS);
  const [savedJson, setSavedJson] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [mcpAdvancedOpen, setMcpAdvancedOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [probes, setProbes] = useState<McpServerProbe[]>([]);
  // Last known successful tool count per server id. We keep it across toggles
  // so that disabling a server doesn't make us forget how many tools it had.
  const [knownToolCounts, setKnownToolCounts] = useState<Record<string, number>>({});

  const [probing, setProbing] = useState(false);

  // axe:e7 — catalogue d'ajout : la configuration affichée est expurgée des
  // secrets (clés API, jetons, chaînes de connexion) ; les valeurs réelles
  // restent dans ce coffre en mémoire et sont réinjectées à l'enregistrement.
  const [adding, setAdding] = useState(false);
  const secretVaultRef = useRef<McpSecretVault>(new Map());

  // Per-server MCP OAuth status, keyed by server id. Populated lazily as the
  // user connects/disconnects URL-based servers. `oauthBusyId` marks the
  // server with an in-flight start/disconnect request so its buttons disable.
  const [oauthStatuses, setOauthStatuses] = useState<
    Record<string, McpOAuthStatus>
  >({});
  const [oauthBusyId, setOauthBusyId] = useState<string | null>(null);

  const [skills, setSkills] = useState<InstalledSkill[] | null>(null);
  // axe:e16 — les competences de l'espace Axe Cloud (celles de Prime Agent).
  // L'interface classique les lit au service : c'est la meme source, rien a
  // recopier. Lecture seule ici, les modifications passent par l'espace.
  const [serviceSkills, setServiceSkills] = useState<InstalledSkill[]>([]);
  const [serviceSkillsNote, setServiceSkillsNote] = useState<string | null>(null);
  useEffect(() => {
    let annule = false;
    const charger = async () => {
      try {
        const etat = await cloudApi.state();
        if (!etat?.connected) {
          if (!annule) {
            setServiceSkills([]);
            setServiceSkillsNote(null);
          }
          return;
        }
        const connexion = etat.connectionId || CLOUD_CONNECTION;
        const liste = await cloudRpc<InstalledSkill[]>(connexion, "skills.list", {});
        if (annule) return;
        setServiceSkills(Array.isArray(liste) ? liste : []);
        setServiceSkillsNote(null);
      } catch (e) {
        if (annule) return;
        setServiceSkills([]);
        setServiceSkillsNote("Les compétences d'Axe Cloud n'ont pas pu être lues.");
      }
    };
    void charger();
    return () => {
      annule = true;
    };
  }, []);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsSaving, setSkillsSaving] = useState(false);
  const [skillsDeleting, setSkillsDeleting] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsStatus, setSkillsStatus] = useState<string | null>(null);
  const [savedSkillsJson, setSavedSkillsJson] = useState("");
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [skillFilter, setSkillFilter] = useState("");
  // axe:cleanup — harness Python skills
  const [pySkills, setPySkills] = useState<HarnessEntry[]>([]);
  const [selectedPySkillId, setSelectedPySkillId] = useState<string | null>(null);
  const [skillKind, setSkillKind] = useState<SkillKindFilter>("all");
  const [pyBusy, setPyBusy] = useState(false);
  const loadPySkills = useCallback(async () => {
    try {
      setPySkills(await harnessApi.list(workspacePath, "skill"));
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : String(err));
    }
  }, [workspacePath]);
  useEffect(() => {
    void loadPySkills();
  }, [loadPySkills]);
  const runPySkill = useCallback(
    async (action: () => Promise<unknown>) => {
      setPyBusy(true);
      try {
        await action();
        await loadPySkills();
      } catch (err) {
        setSkillsStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setPyBusy(false);
      }
    },
    [loadPySkills],
  );
  const togglePySkill = useCallback(
    (entry: HarnessEntry) =>
      void runPySkill(() =>
        harnessApi.update(workspacePath, entry.id, {
          tags: isPySkillEnabled(entry)
            ? [...entry.tags, "disabled"]
            : entry.tags.filter((tag) => tag !== "disabled"),
        }),
      ),
    [runPySkill, workspacePath],
  );
  const movePySkill = useCallback(
    (entry: HarnessEntry) =>
      void runPySkill(() =>
        entry.scope === "project"
          ? harnessApi.promote(workspacePath, entry.id)
          : harnessApi.demote(workspacePath, entry.id),
      ),
    [runPySkill, workspacePath],
  );
  // axe:cleanup end

  const [openAiStatus, setOpenAiStatus] = useState<OpenAiProviderStatus | null>(null);
  const [anthropicStatus, setAnthropicStatus] = useState<AnthropicProviderStatus | null>(null);
  const [googleStatus, setGoogleStatus] = useState<GoogleProviderStatus | null>(null);
  const [kimiStatus, setKimiStatus] = useState<KimiProviderStatus | null>(null);
  const [openRouterStatus, setOpenRouterStatus] = useState<OpenRouterProviderStatus | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersBusy, setProvidersBusy] = useState(false);
  const [providersMessage, setProvidersMessage] = useState<string | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<ModelEntry[]>([]); // axe:providers

  useEffect(() => {
    setSkills(null);
    setSavedSkillsJson("");
    setSkillsStatus(null);
    setSkillsError(null);
    setSelectedSkillName(null);
  }, [workspacePath]);

  // Outside callers (e.g. the composer's "Connect a provider" CTA) can jump
  // straight to a specific section by dispatching this window event. We
  // listen unconditionally so it works whether or not the pane has been
  // opened before.
  useEffect(() => {
    oublierSectionReglages(); // axe:parcours-collegue — demande prise en compte au montage
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: Section }>).detail;
      if (detail?.section) setSection(detail.section);
      oublierSectionReglages(); // axe:parcours-collegue
    };
    window.addEventListener("axecode:open-settings-section", handler);
    return () =>
      window.removeEventListener("axecode:open-settings-section", handler);
  }, []);

  // ---- MCP load ---------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setProbing(true);
    (async () => {
      try {
        const loaded = await api.listMcpSettings();
        if (disposed) return;
        const normalized = normalizeSettings(loaded);
        collectMcpSecrets(normalized, secretVaultRef.current);
        const real = normalizeSettings(
          restoreMcpSecrets(normalized, secretVaultRef.current),
        );
        const nextJson = displayJson(real.servers, secretVaultRef.current);
        setSettings(real);
        setSavedJson(nextJson);
        setJsonText(nextJson);
        setSelectedServerId(real.servers[0]?.id ?? null);
        setLoading(false);

        if (normalized.servers.some((server) => server.enabled)) {
          const nextProbes = await api.probeMcpTools();
          if (disposed) return;
          setProbes(nextProbes);
          const failures = nextProbes.filter(
            (probe) => probe.enabled && !probe.ok,
          ).length;
          if (failures) {
            setStatus(`${failures} serveur${failures === 1 ? "" : "s"} en échec`);
          }
        }
      } catch (err) {
        if (!disposed) setStatus(String(err));
      } finally {
        if (!disposed) {
          setLoading(false);
          setProbing(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // Remember the latest successful tool count per server so we can keep
  // displaying a count (in a disabled tone) even after the server is toggled
  // off and the probe stops reflecting it.
  useEffect(() => {
    if (probes.length === 0) return;
    setKnownToolCounts((current) => {
      let changed = false;
      const next = { ...current };
      for (const probe of probes) {
        if (probe.enabled && probe.ok) {
          const count = probe.tools.length;
          if (next[probe.serverId] !== count) {
            next[probe.serverId] = count;
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [probes]);

  // Re-parse on every JSON edit so cards reflect the latest text. Le texte
  // affiche contient des etoiles a la place des secrets : on reinjecte les
  // valeurs reelles depuis le coffre avant de reconstruire les cartes.
  useEffect(() => {
    try {
      const parsed = restoreMcpSecrets(
        parseMcpJson(jsonText),
        secretVaultRef.current,
      );
      setSettings(parsed);
      setParseError(null);
      setSelectedServerId((current) => {
        if (current && parsed.servers.some((server) => server.id === current)) {
          return current;
        }
        return parsed.servers[0]?.id ?? null;
      });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, [jsonText]);

  const dirty = jsonText !== savedJson;
  const selectedServer =
    settings.servers.find((server) => server.id === selectedServerId) ?? null;
  const selectedProbe =
    probes.find((probe) => probe.serverId === selectedServerId) ?? null;

  const loadConfiguredProviders = useCallback(async () => {
    try {
      const [providers, models, custom] = await Promise.all([
        api.listConfiguredModelProviders(),
        api.listOpenRouterModels().catch(() => []),
        providerApi.get().catch(() => null), // axe:providers
      ]);
      setConfiguredProviders(providers);
      setOpenRouterModels(models);
      setCustomModels(customModelEntries(custom));
    } catch {
      setConfiguredProviders([]);
      setOpenRouterModels([]);
    }
  }, []);

  useEffect(() => {
    void loadConfiguredProviders();
    // axe:providers — refresh when configurable providers change.
    const refresh = () => void loadConfiguredProviders();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROVIDERS_CHANGED_EVENT, refresh);
  }, [loadConfiguredProviders]);

  const loadOpenAiStatus = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const status = await api.getOpenAiProviderStatus();
      setOpenAiStatus(status);
      setProvidersMessage(status.error ?? null);
      if (status.connectionState !== "connecting") {
        void loadConfiguredProviders();
        window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
      }
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersLoading(false);
    }
  }, [loadConfiguredProviders]);

  const loadAnthropicStatus = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const status = await api.getAnthropicProviderStatus();
      setAnthropicStatus(status);
      setProvidersMessage(status.error ?? null);
      if (status.connectionState !== "connecting") {
        void loadConfiguredProviders();
        window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
      }
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersLoading(false);
    }
  }, [loadConfiguredProviders]);

  const loadGoogleStatus = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const status = await api.getGoogleProviderStatus();
      setGoogleStatus(status);
      setProvidersMessage(status.error ?? null);
      if (status.connectionState !== "connecting") {
        void loadConfiguredProviders();
        window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
      }
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersLoading(false);
    }
  }, [loadConfiguredProviders]);

  const loadKimiStatus = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const status = await api.getKimiProviderStatus();
      setKimiStatus(status);
      setProvidersMessage(status.error ?? null);
      if (status.connectionState !== "connecting") {
        void loadConfiguredProviders();
        window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
      }
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersLoading(false);
    }
  }, [loadConfiguredProviders]);

  const loadOpenRouterStatus = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const [status, models] = await Promise.all([
        api.getOpenRouterProviderStatus(),
        api.listOpenRouterModels(),
      ]);
      setOpenRouterStatus(status);
      setOpenRouterModels(models);
      setProvidersMessage(status.error ?? null);
      void loadConfiguredProviders();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersLoading(false);
    }
  }, [loadConfiguredProviders]);

  useEffect(() => {
    if (section !== "providers") return;
    if (openAiStatus === null) void loadOpenAiStatus();
    if (anthropicStatus === null) void loadAnthropicStatus();
    if (googleStatus === null) void loadGoogleStatus();
    if (kimiStatus === null) void loadKimiStatus();
    if (openRouterStatus === null) void loadOpenRouterStatus();
  }, [
    section,
    openAiStatus,
    anthropicStatus,
    googleStatus,
    kimiStatus,
    openRouterStatus,
    loadOpenAiStatus,
    loadAnthropicStatus,
    loadGoogleStatus,
    loadKimiStatus,
    loadOpenRouterStatus,
  ]);

  useEffect(() => {
    const openAiConnecting = openAiStatus?.connectionState === "connecting";
    const anthropicConnecting = anthropicStatus?.connectionState === "connecting";
    const googleConnecting = googleStatus?.connectionState === "connecting";
    const kimiConnecting = kimiStatus?.connectionState === "connecting";
    if (!openAiConnecting && !anthropicConnecting && !googleConnecting && !kimiConnecting) return;
    const timer = window.setInterval(() => {
      if (openAiConnecting) void loadOpenAiStatus();
      if (anthropicConnecting) void loadAnthropicStatus();
      if (googleConnecting) void loadGoogleStatus();
      if (kimiConnecting) void loadKimiStatus();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [
    openAiStatus?.connectionState,
    anthropicStatus?.connectionState,
    googleStatus?.connectionState,
    kimiStatus?.connectionState,
    loadOpenAiStatus,
    loadAnthropicStatus,
    loadGoogleStatus,
    loadKimiStatus,
  ]);

  const connectOpenAi = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      const login = await api.startOpenAiOAuthLogin();
      const connecting: OpenAiProviderStatus = {
        connected: false,
        connectionState: "connecting",
        loginId: login.loginId,
      };
      setOpenAiStatus(connecting);
      await api.openExternalUrl(login.authUrl);
      setProvidersMessage("En attente de la confirmation dans le navigateur…");
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
      void loadOpenAiStatus();
    } finally {
      setProvidersBusy(false);
    }
  }, [loadOpenAiStatus]);

  const cancelOpenAi = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setOpenAiStatus(await api.cancelOpenAiOAuthLogin());
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, []);

  const disconnectOpenAi = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setOpenAiStatus(await api.disconnectOpenAiProvider());
      setProvidersMessage("Déconnecté");
      void loadConfiguredProviders();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, [loadConfiguredProviders]);

  const connectAnthropic = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      const login = await api.startAnthropicOAuthLogin();
      const connecting: AnthropicProviderStatus = {
        connected: false,
        connectionState: "connecting",
        loginId: login.loginId,
      };
      setAnthropicStatus(connecting);
      await api.openExternalUrl(login.authUrl);
      setProvidersMessage("En attente de la confirmation dans le navigateur…");
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
      void loadAnthropicStatus();
    } finally {
      setProvidersBusy(false);
    }
  }, [loadAnthropicStatus]);

  const cancelAnthropic = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setAnthropicStatus(await api.cancelAnthropicOAuthLogin());
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, []);

  const disconnectAnthropic = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setAnthropicStatus(await api.disconnectAnthropicProvider());
      setProvidersMessage("Déconnecté");
      void loadConfiguredProviders();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, [loadConfiguredProviders]);

  const connectGoogle = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      const login = await api.startGoogleOAuthLogin();
      const connecting: GoogleProviderStatus = {
        connected: false,
        connectionState: "connecting",
        loginId: login.loginId,
      };
      setGoogleStatus(connecting);
      await api.openExternalUrl(login.authUrl);
      setProvidersMessage("En attente de la confirmation dans le navigateur…");
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
      void loadGoogleStatus();
    } finally {
      setProvidersBusy(false);
    }
  }, [loadGoogleStatus]);

  const cancelGoogle = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setGoogleStatus(await api.cancelGoogleOAuthLogin());
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, []);

  const disconnectGoogle = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setGoogleStatus(await api.disconnectGoogleProvider());
      setProvidersMessage("Déconnecté");
      void loadConfiguredProviders();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, [loadConfiguredProviders]);

  const connectKimi = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      const login = await api.startKimiOAuthLogin();
      const connecting: KimiProviderStatus = {
        connected: false,
        connectionState: "connecting",
        loginId: login.loginId,
      };
      setKimiStatus(connecting);
      await api.openExternalUrl(login.authUrl);
      setProvidersMessage(`En attente de la confirmation dans le navigateur (${login.userCode})…`);
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
      void loadKimiStatus();
    } finally {
      setProvidersBusy(false);
    }
  }, [loadKimiStatus]);

  const cancelKimi = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setKimiStatus(await api.cancelKimiOAuthLogin());
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, []);

  const disconnectKimi = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setKimiStatus(await api.disconnectKimiProvider());
      setProvidersMessage("Déconnecté");
      void loadConfiguredProviders();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, [loadConfiguredProviders]);

  const disconnectOpenRouter = useCallback(async () => {
    setProvidersBusy(true);
    setProvidersMessage(null);
    try {
      setOpenRouterStatus(await api.disconnectOpenRouterProvider());
      setProvidersMessage("Déconnecté");
      void loadConfiguredProviders();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setProvidersMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setProvidersBusy(false);
    }
  }, [loadConfiguredProviders]);

  const handleOpenRouterChanged = useCallback(() => {
    void loadConfiguredProviders();
    window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
  }, [loadConfiguredProviders]);

  const saveAndDetect = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const parsed = normalizeSettings(
        restoreMcpSecrets(parseMcpJson(jsonText), secretVaultRef.current),
      );
      const saved = await api.saveMcpSettings(parsed);
      const normalized = normalizeSettings(saved);
      collectMcpSecrets(normalized, secretVaultRef.current);
      const nextJson = displayJson(normalized.servers, secretVaultRef.current);
      setSettings(normalized);
      setSavedJson(nextJson);
      setJsonText(nextJson);
      setParseError(null);

      const nextProbes = await api.probeMcpTools();
      setProbes(nextProbes);
      const failures = nextProbes.filter((probe) => probe.enabled && !probe.ok).length;
      if (failures) {
        setStatus(`${failures} serveur${failures === 1 ? "" : "s"} en échec`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setParseError(message);
      setStatus(message);
    } finally {
      setSaving(false);
    }
  }, [jsonText]);

  // axe:e7 — ajout depuis le catalogue : nom + cle, la configuration reelle
  // est ecrite (secrets compris) puis l'etat du serveur est verifie.
  const addServerFromCatalog = useCallback(
    async (server: McpServerConfig): Promise<boolean> => {
      setSaving(true);
      setStatus(null);
      try {
        const next = normalizeSettings({
          servers: [...settings.servers, server],
        });
        const saved = normalizeSettings(await api.saveMcpSettings(next));
        collectMcpSecrets(saved, secretVaultRef.current);
        const nextJson = displayJson(saved.servers, secretVaultRef.current);
        setSettings(saved);
        setSavedJson(nextJson);
        setJsonText(nextJson);
        setSelectedServerId(server.id);
        setParseError(null);
        const nextProbes = await api.probeMcpTools();
        setProbes(nextProbes);
        const failures = nextProbes.filter(
          (probe) => probe.enabled && !probe.ok,
        ).length;
        setStatus(
          failures
            ? `${failures} serveur${failures === 1 ? "" : "s"} sans réponse`
            : "Serveur ajouté",
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setParseError(message);
        setStatus(message);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [settings.servers],
  );

  const toggleEnabled = useCallback(
    async (id: string) => {
      if (parseError || saving) return;
      const next = normalizeSettings({
        servers: settings.servers.map((server) =>
          server.id === id ? { ...server, enabled: !server.enabled } : server,
        ),
      });
      const optimisticJson = displayJson(next.servers, secretVaultRef.current);
      setSettings(next);
      setJsonText(optimisticJson);
      setSaving(true);
      setStatus(null);
      try {
        const saved = normalizeSettings(await api.saveMcpSettings(next));
        collectMcpSecrets(saved, secretVaultRef.current);
        const nextJson = displayJson(saved.servers, secretVaultRef.current);
        setSettings(saved);
        setSavedJson(nextJson);
        setJsonText(nextJson);
        setParseError(null);

        const nextProbes = await api.probeMcpTools();
        setProbes(nextProbes);
        const failures = nextProbes.filter((probe) => probe.enabled && !probe.ok).length;
        setStatus(
          failures
            ? `${failures} serveur${failures === 1 ? "" : "s"} en échec`
            : "Enregistré",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setParseError(message);
        setStatus(message);
      } finally {
        setSaving(false);
      }
    },
    [parseError, saving, settings],
  );

  // ---- MCP OAuth --------------------------------------------------------
  // Re-probe after auth changes so tool counts / errors reflect the new
  // credentials. Kept dependency-free so the polling effect can rely on it.
  const refreshProbes = useCallback(async () => {
    setProbing(true);
    try {
      const nextProbes = await api.probeMcpTools();
      setProbes(nextProbes);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }, []);

  const connectMcpOAuth = useCallback(async (serverId: string) => {
    setOauthBusyId(serverId);
    try {
      const login = await api.startMcpOAuthLogin(serverId);
      setOauthStatuses((prev) => ({
        ...prev,
        [serverId]: {
          connected: false,
          connectionState: "connecting",
          loginId: login.loginId,
        },
      }));
      await api.openExternalUrl(login.authUrl);
    } catch (err) {
      setOauthStatuses((prev) => ({
        ...prev,
        [serverId]: {
          connected: false,
          connectionState: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setOauthBusyId((current) => (current === serverId ? null : current));
    }
  }, []);

  const cancelMcpOAuth = useCallback(async (serverId: string) => {
    try {
      const status = await api.cancelMcpOAuthLogin(serverId);
      setOauthStatuses((prev) => ({ ...prev, [serverId]: status }));
    } catch (err) {
      setOauthStatuses((prev) => ({
        ...prev,
        [serverId]: {
          connected: false,
          connectionState: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, []);

  const disconnectMcpOAuth = useCallback(
    async (serverId: string) => {
      setOauthBusyId(serverId);
      try {
        const status = await api.disconnectMcpOAuth(serverId);
        setOauthStatuses((prev) => ({ ...prev, [serverId]: status }));
        await refreshProbes();
      } catch (err) {
        setOauthStatuses((prev) => ({
          ...prev,
          [serverId]: {
            connected: false,
            connectionState: "error",
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      } finally {
        setOauthBusyId((current) => (current === serverId ? null : current));
      }
    },
    [refreshProbes],
  );

  // While any server is mid-login, poll its status. When it leaves the
  // "connecting" state we refresh probes once so the catalog updates. The
  // dependency is a stable key of connecting ids so the interval is not torn
  // down on every status tick.
  const connectingKey = useMemo(
    () =>
      Object.entries(oauthStatuses)
        .filter(([, status]) => status.connectionState === "connecting")
        .map(([id]) => id)
        .sort()
        .join(","),
    [oauthStatuses],
  );

  useEffect(() => {
    if (!connectingKey) return;
    const ids = connectingKey.split(",");
    const timer = window.setInterval(() => {
      for (const id of ids) {
        void (async () => {
          try {
            const status = await api.getMcpOAuthStatus(id);
            setOauthStatuses((prev) => ({ ...prev, [id]: status }));
            if (status.connectionState !== "connecting") {
              void refreshProbes();
            }
          } catch (err) {
            setOauthStatuses((prev) => ({
              ...prev,
              [id]: {
                connected: false,
                connectionState: "error",
                error: err instanceof Error ? err.message : String(err),
              },
            }));
          }
        })();
      }
    }, 1300);
    return () => window.clearInterval(timer);
  }, [connectingKey, refreshProbes]);

  // ---- Skills load ------------------------------------------------------
  const loadSkills = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    setSkillsStatus(null);
    try {
      const list = await api.listInstalledSkills(workspacePath);
      setSkills(list);
      setSavedSkillsJson(skillsFingerprint(list));
      setSelectedSkillName((current) => {
        if (current && list.some((item) => item.name === current)) return current;
        return list[0]?.name ?? null;
      });
    } catch (err) {
      setSkillsError(err instanceof Error ? err.message : String(err));
      setSkills([]);
      setSavedSkillsJson(skillsFingerprint([]));
    } finally {
      setSkillsLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    if (skills !== null) return;
    void loadSkills();
  }, [skills, loadSkills]);

  const filteredSkills = useMemo(() => {
    if (!skills) return [];
    const needle = skillFilter.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => {
      if (skill.name.toLowerCase().includes(needle)) return true;
      if (skill.description?.toLowerCase().includes(needle)) return true;
      if (skill.rootLabel.toLowerCase().includes(needle)) return true;
      return false;
    });
  }, [skills, skillFilter]);

  const filteredPySkills = useMemo(() => {
    const needle = skillFilter.trim().toLowerCase();
    return pySkills
      .filter((entry) => !needle || entry.title.toLowerCase().includes(needle) || entry.body.toLowerCase().includes(needle))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [pySkills, skillFilter]);
  const selectedPySkill = pySkills.find((entry) => entry.id === selectedPySkillId) ?? null;

  const selectedSkill =
    skills?.find((skill) => skill.name === selectedSkillName) ?? null;
  const skillsDirty =
    skills !== null && skillsFingerprint(skills) !== savedSkillsJson;

  const toggleSkillEnabled = useCallback((name: string) => {
    setSkills((current) => {
      if (!current) return current;
      return current.map((skill) =>
        skill.name === name ? { ...skill, enabled: !skill.enabled } : skill,
      );
    });
  }, []);

  const saveSkills = useCallback(async () => {
    if (!skills) return;
    setSkillsSaving(true);
    setSkillsError(null);
    setSkillsStatus(null);
    try {
      const saved = await api.saveSkillSettings(workspacePath, settingsFromSkills(skills));
      setSkills(saved);
      setSavedSkillsJson(skillsFingerprint(saved));
      setSelectedSkillName((current) => {
        if (current && saved.some((skill) => skill.name === current)) return current;
        return saved[0]?.name ?? null;
      });
      setSkillsStatus("Enregistré");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSkillsError(message);
      setSkillsStatus(message);
    } finally {
      setSkillsSaving(false);
    }
  }, [skills, workspacePath]);

  const revealSkill = useCallback(async (skill: InstalledSkill) => {
    setSkillsError(null);
    setSkillsStatus(null);
    try {
      await api.revealAbsolutePath(skill.absolutePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSkillsError(message);
      setSkillsStatus(message);
    }
  }, []);

  const deleteSkill = useCallback(
    async (skill: InstalledSkill) => {
      if (!skills) return;
      const nextSkills = skills.filter(
        (item) => item.absolutePath !== skill.absolutePath,
      );
      setSkillsDeleting(true);
      setSkillsError(null);
      setSkillsStatus(null);
      try {
        await api.deleteSkill(workspacePath, skill.absolutePath);
        if (skillsDirty) {
          setSkills(nextSkills);
        } else {
          const saved = await api.saveSkillSettings(
            workspacePath,
            settingsFromSkills(nextSkills),
          );
          setSkills(saved);
          setSavedSkillsJson(skillsFingerprint(saved));
        }
        setSelectedSkillName((current) => {
          if (current !== skill.name) return current;
          return nextSkills[0]?.name ?? null;
        });
        setSkillsStatus("Supprimé");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSkillsError(message);
        setSkillsStatus(message);
      } finally {
        setSkillsDeleting(false);
      }
    },
    [skills, skillsDirty, workspacePath],
  );

  const createSkill = useCallback(async () => {
    setSkillsSaving(true);
    setSkillsError(null);
    setSkillsStatus(null);
    try {
      const { name, skills: refreshed } = await api.createSkill(workspacePath);
      setSkills(refreshed);
      setSavedSkillsJson(skillsFingerprint(refreshed));
      setSelectedSkillName(name);
      setSkillFilter("");
      setSkillsStatus("Créé");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSkillsError(message);
      setSkillsStatus(message);
    } finally {
      setSkillsSaving(false);
    }
  }, [workspacePath]);

  const saveSkillContent = useCallback(
    async (skill: InstalledSkill, content: string) => {
      setSkillsSaving(true);
      setSkillsError(null);
      setSkillsStatus(null);
      try {
        const { name, skills: refreshed } = await api.updateSkillContent(
          workspacePath,
          skill.absolutePath,
          content,
        );
        const enabledByPath = new Map(
          (skills ?? []).map((item) => [item.absolutePath, item.enabled]),
        );
        const merged = refreshed.map((item) => {
          const enabled = enabledByPath.get(item.absolutePath);
          return enabled === undefined ? item : { ...item, enabled };
        });
        const saved = await api.saveSkillSettings(
          workspacePath,
          settingsFromSkills(merged),
        );
        setSkills(saved);
        setSavedSkillsJson(skillsFingerprint(saved));
        setSelectedSkillName(
          name || saved.find((item) => item.absolutePath === skill.absolutePath)?.name || skill.name,
        );
        setSkillFilter("");
        setSkillsStatus("Enregistré");
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSkillsError(message);
        setSkillsStatus(message);
        return false;
      } finally {
        setSkillsSaving(false);
      }
    },
    [skills, workspacePath],
  );

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    defineAxecodeCoolTheme(monaco);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveAndDetectRef.current();
    });
  }, []);

  // Mutable ref so the Monaco command picks up the latest closure.
  const saveAndDetectRef = useRef(saveAndDetect);
  useEffect(() => {
    saveAndDetectRef.current = saveAndDetect;
  }, [saveAndDetect]);

  return (
    <div className="settings-pane">
      <nav className="settings-pane__nav" aria-label="Sections des réglages">
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="about"
          data-active={section === "about" ? "true" : "false"}
          onClick={() => setSection("about")}
        >
          <Icon
            icon="solar:info-circle-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">À propos</span>
          <span className="settings-pane__nav-count" />
        </button>
        {/* axe:theme */}
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="appearance"
          data-active={section === "appearance" ? "true" : "false"}
          onClick={() => setSection("appearance")}
        >
          <Icon
            icon="solar:palette-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Apparence</span>
          <span className="settings-pane__nav-count" />
        </button>
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="providers"
          data-active={section === "providers" ? "true" : "false"}
          onClick={() => setSection("providers")}
        >
          <Icon
            icon="solar:cloud-check-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Fournisseurs</span>
          <span className="settings-pane__nav-count">
            {configuredProviders.length}
          </span>
        </button>
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="mcp"
          data-active={section === "mcp" ? "true" : "false"}
          onClick={() => setSection("mcp")}
        >
          <Icon
            icon="solar:server-square-cloud-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">MCP</span>
          <span className="settings-pane__nav-count">{settings.servers.length}</span>
        </button>
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="skills"
          data-active={section === "skills" ? "true" : "false"}
          onClick={() => setSection("skills")}
        >
          <Icon
            icon="solar:magic-stick-3-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Skills</span>
          <span className="settings-pane__nav-count">{skills ? skills.length + pySkills.length : "·"}</span>
        </button>
        {/* axe:harness */}
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="harness"
          data-active={section === "harness" ? "true" : "false"}
          onClick={() => setSection("harness")}
        >
          <Icon
            icon="solar:lightbulb-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Harnais</span>
          <span className="settings-pane__nav-count" />
        </button>
        {/* axe:harness end */}
        {/* axe:repl */}
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="repl"
          data-active={section === "repl" ? "true" : "false"}
          onClick={() => setSection("repl")}
        >
          <Icon
            icon="solar:code-square-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Outils REPL</span>
          <span className="settings-pane__nav-count" />
        </button>
        {/* axe:daemon — section cloud : masquée dans l'édition locale */}
        {EDITION_LOCALE ? null : <button
          type="button"
          className="settings-pane__nav-item"
          data-section="service"
          data-active={section === "service" ? "true" : "false"}
          onClick={() => setSection("service")}
        >
          <Icon
            icon="solar:server-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Service</span>
          <span className="settings-pane__nav-count" />
        </button>}
        {/* axe:e5 — joindre un autre appareil pour lui confier du calcul */}
        {EDITION_LOCALE ? null : <button
          type="button"
          className="settings-pane__nav-item"
          data-section="connections"
          data-active={section === "connections" ? "true" : "false"}
          onClick={() => setSection("connections")}
        >
          <Icon
            icon="solar:global-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Appareils</span>
          <span className="settings-pane__nav-count" />
        </button>}
        {/* axe:e5 end */}
        {/* axe:raccourcis */}
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="shortcuts"
          data-active={section === "shortcuts" ? "true" : "false"}
          onClick={() => setSection("shortcuts")}
        >
          <Icon
            icon="solar:keyboard-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Raccourcis</span>
          <span className="settings-pane__nav-count" />
        </button>
        {/* axe:voix */}
        <button
          type="button"
          className="settings-pane__nav-item"
          data-section="voice"
          data-active={section === "voice" ? "true" : "false"}
          onClick={() => setSection("voice")}
        >
          <Icon
            icon="solar:microphone-3-linear"
            width={15}
            height={15}
            className="settings-pane__nav-icon"
          />
          <span className="settings-pane__nav-label">Dictée vocale</span>
          <span className="settings-pane__nav-count" />
        </button>
      </nav>

      <section className="settings-pane__main">
        {section === "about" ? (
          <AboutSection />
        ) : section === "appearance" ? (
          <AppearanceSection /> /* axe:theme */
        ) : section === "providers" ? (
          <ProvidersSection
            openAiStatus={openAiStatus}
            anthropicStatus={anthropicStatus}
            googleStatus={googleStatus}
            kimiStatus={kimiStatus}
            openRouterStatus={openRouterStatus}
            openRouterModels={openRouterModels}
            loading={providersLoading}
            busy={providersBusy}
            message={providersMessage}
            onRefresh={() => {
              void loadOpenAiStatus();
              void loadAnthropicStatus();
              void loadGoogleStatus();
              void loadKimiStatus();
              void loadOpenRouterStatus();
            }}
            onConnect={() => void connectOpenAi()}
            onCancel={() => void cancelOpenAi()}
            onDisconnect={() => void disconnectOpenAi()}
            onConnectAnthropic={() => void connectAnthropic()}
            onCancelAnthropic={() => void cancelAnthropic()}
            onDisconnectAnthropic={() => void disconnectAnthropic()}
            onConnectGoogle={() => void connectGoogle()}
            onCancelGoogle={() => void cancelGoogle()}
            onDisconnectGoogle={() => void disconnectGoogle()}
            onConnectKimi={() => void connectKimi()}
            onCancelKimi={() => void cancelKimi()}
            onDisconnectKimi={() => void disconnectKimi()}
            onDisconnectOpenRouter={() => void disconnectOpenRouter()}
            onOpenRouterStatusChange={setOpenRouterStatus}
            onOpenRouterModelsChange={setOpenRouterModels}
            onOpenRouterChanged={handleOpenRouterChanged}
          />
        ) : section === "mcp" ? (
          <McpSection
            loading={loading}
            saving={saving}
            probing={probing}
            dirty={dirty}
            status={status}
            parseError={parseError}
            jsonText={jsonText}
            onJsonChange={(value) => setJsonText(value)}
            onSave={() => void saveAndDetect()}
            servers={settings.servers}
            probes={probes}
            onSelectServer={(id) => {
              setSelectedServerId(id);
              setMcpAdvancedOpen(false);
            }}
            selectedServer={selectedServer}
            advancedOpen={mcpAdvancedOpen}
            onAdvancedOpenChange={setMcpAdvancedOpen}
            selectedProbe={selectedProbe}
            knownToolCounts={knownToolCounts}
            onToggleEnabled={toggleEnabled}
            oauthStatuses={oauthStatuses}
            oauthBusyId={oauthBusyId}
            onConnectOAuth={(id) => void connectMcpOAuth(id)}
            onCancelOAuth={(id) => void cancelMcpOAuth(id)}
            onDisconnectOAuth={(id) => void disconnectMcpOAuth(id)}
            onMount={handleEditorMount}
            catalogOpen={adding}
            onOpenCatalog={() => {
              setAdding(true);
              setMcpAdvancedOpen(false);
            }}
            onCloseCatalog={() => setAdding(false)}
            onAddServer={addServerFromCatalog}
          />
        ) : section === "harness" ? (
          <>
            <HarnessPane workspacePath={workspacePath} /> {/* axe:harness */}
            <HarnessBackupSection workspacePath={workspacePath} /> {/* axe:cleanup */}
          </>
        ) : section === "repl" ? (
          <><ReplToolsPane workspacePath={workspacePath} /><RegistrePane /></> /* axe:repl + axe:e4 */
        ) : section === "service" ? (
          <ServicePane /> /* axe:daemon */
        ) : section === "shortcuts" ? (
          <RaccourcisSection /> /* axe:raccourcis */
        ) : section === "voice" ? (
          <VoixSection workspacePath={workspacePath} /> /* axe:voix */
        ) : section === "connections" ? (
          <ConnectionsPane /> /* axe:e5 */
        ) : section === "skills" ? (
          <SkillsSection
            skills={skillKind === "python" ? [] : filteredSkills}
            allSkills={skills}
            pySkills={skillKind === "recipe" ? [] : filteredPySkills}
            pyTotal={pySkills.length}
            selectedPySkill={selectedPySkill}
            pyBusy={pyBusy}
            kindFilter={skillKind}
            onKindFilterChange={setSkillKind}
            onSelectPySkill={(id) => {
              setSelectedPySkillId(id);
              setSelectedSkillName(null);
            }}
            onTogglePySkill={togglePySkill}
            onMovePySkill={movePySkill}
            loading={skillsLoading}
            saving={skillsSaving}
            dirty={skillsDirty}
            error={skillsError}
            status={skillsStatus}
            filter={skillFilter}
            onFilterChange={setSkillFilter}
            selectedSkill={selectedSkill}
            deleting={skillsDeleting}
            onSelectSkill={(name) => {
              setSelectedSkillName(name);
              setSelectedPySkillId(null);
            }}
            onRefresh={() => {
              void loadSkills();
              void loadPySkills();
            }}
            onSave={() => void saveSkills()}
            onCreate={() => void createSkill()}
            onToggleSkill={toggleSkillEnabled}
            onRevealSkill={(skill) => void revealSkill(skill)}
            onDeleteSkill={(skill) => void deleteSkill(skill)}
            onSaveSkillContent={saveSkillContent}
            serviceSkills={serviceSkills}
            serviceNote={serviceSkillsNote}
          />
        ) : null}
      </section>
    </div>
  );
}

// ---- About section -----------------------------------------------------

function AboutSection() {
  return (
    <div className="settings-pane__body settings-pane__body--about">
      <div className="settings-pane__about-hero">
        <span className="settings-pane__about-mark" aria-hidden>
          <AxeLogo variant="mark" size={30} />
        </span>
        <div className="settings-pane__about-title">
          <h1>SavIDE</h1>
        </div>
      </div>

      <p className="settings-pane__about-line">
        SavIDE est un IDE agentique 100 % local : éditeur, terminal, conversation et
        retour en arrière, avec un REPL Python persistant comme outil principal et un
        harnais que l&apos;agent fait évoluer lui-même. Rien ne part vers un cloud.
      </p>
      <p className="settings-pane__about-line">
        Les sessions survivent à la fermeture de la fenêtre, chaque fonction exposée
        à l&apos;agent est désactivable et sa description éditable, et n&apos;importe quel
        fournisseur de modèles peut être branché.
      </p>

      <div className="settings-pane__about-links">
        <a
          className="settings-pane__about-link"
          href="https://www.axe-international.com"
          target="_blank"
          rel="noreferrer"
        >
          <Icon icon="solar:global-linear" width={13} height={13} />
          <span>www.axe-international.com</span>
        </a>
      </div>
    </div>
  );
}

// ---- Providers section -------------------------------------------------

type ProvidersSectionProps = {
  openAiStatus: OpenAiProviderStatus | null;
  anthropicStatus: AnthropicProviderStatus | null;
  googleStatus: GoogleProviderStatus | null;
  kimiStatus: KimiProviderStatus | null;
  openRouterStatus: OpenRouterProviderStatus | null;
  openRouterModels: OpenRouterModel[];
  loading: boolean;
  busy: boolean;
  message: string | null;
  onRefresh: () => void;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onConnectAnthropic: () => void;
  onCancelAnthropic: () => void;
  onDisconnectAnthropic: () => void;
  onConnectGoogle: () => void;
  onCancelGoogle: () => void;
  onDisconnectGoogle: () => void;
  onConnectKimi: () => void;
  onCancelKimi: () => void;
  onDisconnectKimi: () => void;
  onDisconnectOpenRouter: () => void;
  onOpenRouterStatusChange: (status: OpenRouterProviderStatus) => void;
  onOpenRouterModelsChange: (models: OpenRouterModel[]) => void;
  onOpenRouterChanged: () => void;
};

function ProvidersSection({
  openAiStatus,
  anthropicStatus,
  googleStatus,
  kimiStatus,
  openRouterStatus,
  openRouterModels,
  loading,
  busy,
  message,
  onRefresh,
  onConnect,
  onCancel,
  onDisconnect,
  onConnectAnthropic,
  onCancelAnthropic,
  onDisconnectAnthropic,
  onConnectGoogle,
  onCancelGoogle,
  onDisconnectGoogle,
  onConnectKimi,
  onCancelKimi,
  onDisconnectKimi,
  onDisconnectOpenRouter,
  onOpenRouterStatusChange,
  onOpenRouterModelsChange,
  onOpenRouterChanged,
}: ProvidersSectionProps) {
  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Fournisseurs</h1>
          <p className="settings-pane__subtitle">
            Connectez les fournisseurs de modèles de SavIDE.
          </p>
        </div>
        <div className="settings-pane__actions">
          {message && (
            <span
              className="settings-pane__status"
              data-tone={message === "Déconnecté" ? "ok" : "pending"}
            >
              {message}
            </span>
          )}
          <button
            type="button"
            className="settings-pane__btn"
            onClick={onRefresh}
            disabled={loading || busy}
          >
            <Icon icon="solar:refresh-linear" width={13} height={13} />
            <span>{loading ? "Actualisation…" : "Actualiser"}</span>
          </button>
        </div>
      </header>

      <div className="settings-pane__body settings-pane__body--providers">
        <ProviderCard
          name="Anthropic"
          icon="simple-icons:anthropic"
          description="Connexion OAuth à votre compte Claude pour les modèles Anthropic."
          status={anthropicStatus}
          connectedMeta={["Claude OAuth"]}
          loading={loading}
          busy={busy}
          onConnect={onConnectAnthropic}
          onCancel={onCancelAnthropic}
          onDisconnect={onDisconnectAnthropic}
        />
        <ProviderCard
          name="OpenAI"
          icon="simple-icons:openai"
          description="Connexion OAuth à votre compte ChatGPT pour les modèles OpenAI."
          status={openAiStatus}
          connectedMeta={[
            openAiStatus?.email || "Connecté",
            openAiStatus?.planType ?? null,
          ]}
          loading={loading}
          busy={busy}
          onConnect={onConnect}
          onCancel={onCancel}
          onDisconnect={onDisconnect}
        />
        <ProviderCard
          name="Google"
          icon="simple-icons:google"
          description="Connexion OAuth à votre compte Google pour les modèles Gemini."
          status={googleStatus}
          connectedMeta={[
            googleStatus?.email || "Connecté",
            googleStatus?.userTier ?? null,
            googleStatus?.projectId
              ? `Projet ${googleStatus.projectId}`
              : null,
          ]}
          loading={loading}
          busy={busy}
          onConnect={onConnectGoogle}
          onCancel={onCancelGoogle}
          onDisconnect={onDisconnectGoogle}
        />
        <GeminiWebCard /> {/* axe:gemini-web */}
        <ProviderCard
          name="Kimi"
          icon="local:kimi"
          description="Connexion OAuth à votre compte Kimi pour Kimi K2.7 Code."
          status={kimiStatus}
          connectedMeta={["Kimi OAuth"]}
          loading={loading}
          busy={busy}
          onConnect={onConnectKimi}
          onCancel={onCancelKimi}
          onDisconnect={onDisconnectKimi}
        />
        <OpenRouterProviderCard
          status={openRouterStatus}
          models={openRouterModels}
          loading={loading}
          busy={busy}
          onDisconnect={onDisconnectOpenRouter}
          onStatusChange={onOpenRouterStatusChange}
          onModelsChange={onOpenRouterModelsChange}
          onChanged={onOpenRouterChanged}
        />
        <CustomProvidersPanel /> {/* axe:providers */}
      </div>
    </>
  );
}

type ProviderCardStatus =
  | OpenAiProviderStatus
  | AnthropicProviderStatus
  | GoogleProviderStatus
  | KimiProviderStatus
  | null;

type ProviderCardProps = {
  name: string;
  icon: string;
  description: string;
  status: ProviderCardStatus;
  connectedMeta: (string | null | undefined)[];
  loading: boolean;
  busy: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
};

function ProviderCard({
  name,
  icon,
  description,
  status,
  connectedMeta,
  loading,
  busy,
  onConnect,
  onCancel,
  onDisconnect,
}: ProviderCardProps) {
  const state = status?.connectionState ?? "disconnected";
  const connected = Boolean(status?.connected);
  const connecting = state === "connecting";
  const error = state === "error" ? status?.error : null;
  const statusLabel = connecting
    ? "Connexion…"
    : connected
      ? "Connecté"
      : state === "error"
        ? "À vérifier"
        : "Non connecté";
  const statusTone = connecting
    ? "pending"
    : connected
      ? "ok"
      : state === "error"
        ? "error"
        : "off";
  const meta = connectedMeta.filter((item): item is string => Boolean(item));

  return (
    <section className="settings-pane__provider-card">
      <div className="settings-pane__provider-main">
        <div className="settings-pane__provider-mark" aria-hidden>
          <Icon icon={icon} width={24} height={24} />
        </div>
        <div className="settings-pane__provider-copy">
          <div className="settings-pane__provider-title-row">
            <h2>{name}</h2>
            <span className="settings-pane__chip" data-tone={statusTone}>
              <span className="settings-pane__chip-dot" />
              {statusLabel}
            </span>
          </div>
          <p>{description}</p>
          {connected && meta.length > 0 && (
            <div className="settings-pane__provider-meta">
              {meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
          {error && <div className="settings-pane__provider-error">{error}</div>}
        </div>
      </div>
      <div className="settings-pane__provider-actions">
        {connecting ? (
          <button
            type="button"
            className="settings-pane__btn"
            onClick={onCancel}
            disabled={busy}
          >
            <Icon icon="solar:close-circle-linear" width={13} height={13} />
            <span>Annuler</span>
          </button>
        ) : connected ? (
          <button
            type="button"
            className="settings-pane__btn"
            onClick={onDisconnect}
            disabled={busy}
          >
            <Icon icon="solar:logout-2-linear" width={13} height={13} />
            <span>{busy ? "Déconnexion…" : "Déconnecter"}</span>
          </button>
        ) : (
          <button
            type="button"
            className="settings-pane__btn"
            data-primary="true"
            onClick={onConnect}
            disabled={loading || busy}
          >
            <Icon
              icon={busy ? "solar:refresh-linear" : "solar:login-2-linear"}
              width={13}
              height={13}
            />
            <span>{busy ? "Ouverture…" : "Connecter"}</span>
          </button>
        )}
      </div>
    </section>
  );
}

type OpenRouterProviderCardProps = {
  status: OpenRouterProviderStatus | null;
  models: OpenRouterModel[];
  loading: boolean;
  busy: boolean;
  onDisconnect: () => void;
  onStatusChange: (status: OpenRouterProviderStatus) => void;
  onModelsChange: (models: OpenRouterModel[]) => void;
  onChanged: () => void;
};

function OpenRouterProviderCard({
  status,
  models,
  loading,
  busy,
  onDisconnect,
  onStatusChange,
  onModelsChange,
  onChanged,
}: OpenRouterProviderCardProps) {
  const [apiKey, setApiKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpenRouterModelSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mutatingModelId, setMutatingModelId] = useState<string | null>(null);
  const validationSeq = useRef(0);
  const searchSeq = useRef(0);

  const displayStatus: OpenRouterProviderStatus = validating
    ? {
        connected: false,
        connectionState: "connecting",
        modelCount: models.length,
      }
    : status ?? {
        connected: false,
        connectionState: "disconnected",
        modelCount: models.length,
      };
  const state = displayStatus.connectionState;
  const connected = Boolean(displayStatus.connected);
  const connecting = state === "connecting";
  const error = validationError ?? (state === "error" ? displayStatus.error : null);
  const statusLabel = connecting
    ? "Connexion…"
    : connected
      ? "Connecté"
      : state === "error"
        ? "À vérifier"
        : "Non connecté";
  const statusTone = connecting
    ? "pending"
    : connected
      ? "ok"
      : state === "error"
        ? "error"
        : "off";
  const modelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const searchEnabled = connected && !validating;

  useEffect(() => {
    const key = apiKey.trim();
    validationSeq.current += 1;
    const seq = validationSeq.current;
    setValidationError(null);
    if (!key) {
      setValidating(false);
      return;
    }
    setValidating(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await api.validateOpenRouterApiKey(key);
          if (validationSeq.current !== seq) return;
          onStatusChange(next);
          setApiKey("");
          setValidationError(null);
          onChanged();
        } catch (err) {
          if (validationSeq.current !== seq) return;
          const message = err instanceof Error ? err.message : String(err);
          setValidationError(message);
          onStatusChange({
            connected: false,
            connectionState: "error",
            modelCount: models.length,
            error: message,
          });
        } finally {
          if (validationSeq.current === seq) setValidating(false);
        }
      })();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [apiKey, models.length, onChanged, onStatusChange]);

  useEffect(() => {
    const trimmed = query.trim();
    searchSeq.current += 1;
    const seq = searchSeq.current;
    setSearchError(null);
    if (!trimmed || !searchEnabled) {
      setSearching(false);
      setResults([]);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const found = await api.searchOpenRouterModels(trimmed);
          if (searchSeq.current !== seq) return;
          setResults(found);
        } catch (err) {
          if (searchSeq.current !== seq) return;
          const message = err instanceof Error ? err.message : String(err);
          setSearchError(message);
          setResults([]);
          onStatusChange({
            connected: false,
            connectionState: "error",
            modelCount: models.length,
            error: message,
          });
        } finally {
          if (searchSeq.current === seq) setSearching(false);
        }
      })();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [models.length, onStatusChange, query, searchEnabled]);

  const addModel = async (model: OpenRouterModelSearchResult) => {
    setMutatingModelId(model.id);
    setSearchError(null);
    try {
      const cleanName = sanitizeOpenRouterName(model.name) || model.id;
      const next = await api.addOpenRouterModel({ ...model, name: cleanName });
      onModelsChange(next);
      onStatusChange({
        ...(status ?? displayStatus),
        connected: true,
        connectionState: "connected",
        modelCount: next.length,
        error: null,
      });
      onChanged();
      setQuery("");
      setSearchError(null);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingModelId(null);
    }
  };

  const removeModel = async (id: string) => {
    setMutatingModelId(id);
    setSearchError(null);
    try {
      const next = await api.removeOpenRouterModel(id);
      onModelsChange(next);
      if (status) {
        onStatusChange({ ...status, modelCount: next.length });
      }
      onChanged();
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutatingModelId(null);
    }
  };

  return (
    <section className="settings-pane__provider-card settings-pane__provider-card--openrouter">
      <div className="settings-pane__provider-main">
        <div className="settings-pane__provider-mark" aria-hidden>
          <Icon icon="simple-icons:openrouter" width={24} height={24} />
        </div>
        <div className="settings-pane__provider-copy">
          <div className="settings-pane__provider-title-row">
            <h2>OpenRouter</h2>
            <span className="settings-pane__chip" data-tone={statusTone}>
              <span className="settings-pane__chip-dot" />
              {statusLabel}
            </span>
          </div>
          <p>Utilisez n'importe quel modèle OpenRouter avec votre propre clé d'API.</p>
          {error && <div className="settings-pane__provider-error">{error}</div>}
        </div>
      </div>

      <div className="settings-pane__provider-detail">
        <label className="settings-pane__tool-credential">
          <span className="settings-pane__tool-credential-label">Clé d'API</span>
          <div className="settings-pane__tool-credential-field">
            <input
              type={revealed ? "text" : "password"}
              value={apiKey}
              placeholder={connected ? displayStatus.keyPreview ?? "Clé enregistrée" : "sk-or-..."}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="settings-pane__tool-credential-actions">
              <button
                type="button"
                className="settings-pane__icon-btn"
                onClick={() => setRevealed((value) => !value)}
                title={revealed ? "Masquer la clé" : "Afficher la clé"}
                aria-label={revealed ? "Masquer la clé" : "Afficher la clé"}
              >
                <Icon
                  icon={revealed ? "solar:eye-closed-linear" : "solar:eye-linear"}
                  width={13}
                  height={13}
                />
              </button>
              {connected && (
                <button
                  type="button"
                  className="settings-pane__icon-btn"
                  onClick={onDisconnect}
                  disabled={busy}
                  title="Retirer la clé d'API"
                  aria-label="Retirer la clé d'API"
                >
                  <Icon icon="solar:trash-bin-trash-linear" width={13} height={13} />
                </button>
              )}
            </div>
          </div>
        </label>

        <label className="settings-pane__tool-credential">
          <span className="settings-pane__tool-credential-label">Recherche</span>
          <div className="settings-pane__tool-credential-field">
            <input
              type="text"
              value={query}
              disabled={!searchEnabled}
              placeholder={searchEnabled ? "Nom du modèle…" : "Enregistrez d'abord une clé valide"}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </label>

        {searchEnabled && query.trim() !== "" && (
          <div className="settings-pane__openrouter-results" aria-live="polite">
            {searching ? (
              <div className="settings-pane__openrouter-hint">Recherche…</div>
            ) : searchError ? (
              <div className="settings-pane__provider-error">{searchError}</div>
            ) : results.length === 0 ? (
              <div className="settings-pane__openrouter-hint">Aucun modèle trouvé.</div>
            ) : (
              results.map((model) => {
                const added = modelIds.has(model.id);
                const label = sanitizeOpenRouterName(model.name) || model.id;
                return (
                  <div key={model.id} className="settings-pane__openrouter-row">
                    <span title={model.id}>{label}</span>
                    {added ? (
                      <span className="settings-pane__openrouter-added">Ajouté</span>
                    ) : (
                      <button
                        type="button"
                        className="settings-pane__btn"
                        onClick={() => void addModel(model)}
                        disabled={mutatingModelId === model.id}
                      >
                        <Icon icon="solar:add-circle-linear" width={13} height={13} />
                        <span>{mutatingModelId === model.id ? "Ajout…" : "Ajouter"}</span>
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {models.length > 0 && (
          <div className="settings-pane__openrouter-list">
            {models.map((model) => {
              const label = sanitizeOpenRouterName(model.name) || model.id;
              return (
                <div key={model.id} className="settings-pane__openrouter-row">
                  <span title={model.id}>{label}</span>
                  <button
                    type="button"
                    className="settings-pane__icon-btn"
                    onClick={() => void removeModel(model.id)}
                    disabled={mutatingModelId === model.id}
                    title="Retirer le modèle"
                    aria-label={`Retirer ${label}`}
                  >
                    <Icon icon="solar:trash-bin-trash-linear" width={13} height={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ---- MCP section component ---------------------------------------------

type McpSectionProps = {
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
  onSelectServer: (id: string) => void;
  selectedServer: McpServerConfig | null;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  selectedProbe: McpServerProbe | null;
  knownToolCounts: Record<string, number>;
  onToggleEnabled: (id: string) => void;
  oauthStatuses: Record<string, McpOAuthStatus>;
  oauthBusyId: string | null;
  onConnectOAuth: (id: string) => void;
  onCancelOAuth: (id: string) => void;
  onDisconnectOAuth: (id: string) => void;
  onMount: OnMount;
  // axe:e7 — catalogue d'ajout (formulaire minimal, cle API masquee).
  catalogOpen: boolean;
  onOpenCatalog: () => void;
  onCloseCatalog: () => void;
  onAddServer: (server: McpServerConfig) => Promise<boolean>;
};

function McpSection({
  loading,
  saving,
  probing,
  dirty,
  status,
  parseError,
  jsonText,
  onJsonChange,
  onSave,
  servers,
  probes,
  onSelectServer,
  selectedServer,
  advancedOpen,
  onAdvancedOpenChange,
  selectedProbe,
  knownToolCounts,
  onToggleEnabled,
  oauthStatuses,
  oauthBusyId,
  onConnectOAuth,
  onCancelOAuth,
  onDisconnectOAuth,
  onMount,
  catalogOpen,
  onOpenCatalog,
  onCloseCatalog,
  onAddServer,
}: McpSectionProps) {
  // axe:zoom — the JSON editor follows the text size (only chars grow).
  const [textScale, setTextScale] = useState<number>(() => loadTextScale());
  useEffect(() => onTextScaleChange(setTextScale), []);

  const enabledCount = servers.filter((server) => server.enabled).length;
  const failedCount = probes.filter((probe) => probe.enabled && !probe.ok).length;

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Serveurs MCP</h1>
          <p className="settings-pane__subtitle">
            {loading
              ? "Chargement des serveurs…"
              : servers.length === 0
                ? "Ajoutez un serveur courant : le catalogue écrit la configuration à votre place."
                : `${enabledCount}/${servers.length} actif${enabledCount > 1 ? "s" : ""}${failedCount ? ` · ${failedCount} sans réponse` : ""}`}
          </p>
        </div>
        <div className="settings-pane__actions">
          {status && (
            <span className="settings-pane__status" data-tone={parseError ? "error" : "ok"}>
              {status}
            </span>
          )}
          <button
            type="button"
            className="settings-pane__btn"
            data-primary="true"
            onClick={onOpenCatalog}
            disabled={loading || saving}
          >
            <Icon icon="solar:add-circle-linear" width={13} height={13} />
            <span>Ajouter un serveur</span>
          </button>
          {/* axe:e7 — la configuration avancee reste disponible, en second recours. */}
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => onAdvancedOpenChange(!advancedOpen)}
            disabled={loading}
          >
            <Icon icon="solar:code-square-linear" width={13} height={13} />
            <span>{advancedOpen ? "Masquer la configuration" : "Configuration avancée"}</span>
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            data-primary="true"
            onClick={onSave}
            disabled={loading || saving || !dirty}
          >
            <Icon
              icon={saving ? "solar:refresh-linear" : "solar:diskette-linear"}
              width={13}
              height={13}
            />
            <span>
              {saving ? "Vérification…" : dirty ? "Enregistrer" : "Enregistré"}
            </span>
          </button>
        </div>
      </header>

      {catalogOpen ? (
        <McpCatalogPanel
          busy={saving}
          error={parseError}
          onAdd={onAddServer}
          onCancel={onCloseCatalog}
        />
      ) : null}

      <div className="settings-pane__body settings-pane__body--mcp">
        <aside className="settings-pane__nav-list">
          <div className="settings-pane__nav-list-head">
            <span>Serveurs</span>
            {probing && (
              <span className="settings-pane__servers-meta">vérification…</span>
            )}
          </div>
          <div className="settings-pane__nav-list-items">
            {servers.map((server) => {
              const probe = probes.find((item) => item.serverId === server.id);
              const tone = !server.enabled
                ? "off"
                : !probe
                  ? "pending"
                  : probe.ok
                    ? "ok"
                    : "error";
              const isActive = selectedServer?.id === server.id;
              const knownCount = knownToolCounts[server.id];
              const toolCount = probe?.ok
                ? probe.tools.length
                : knownCount ?? null;
              const toggleDisabled =
                loading || saving || Boolean(parseError);
              const displayName = server.name || "Sans nom";
              return (
                <div
                  key={server.id}
                  className="settings-pane__nav-list-item"
                  data-active={isActive ? "true" : "false"}
                  data-on={server.enabled ? "true" : "false"}
                >
                  <button
                    type="button"
                    className="settings-pane__nav-list-item-main"
                    onClick={() => onSelectServer(server.id)}
                  >
                    <span
                      className="settings-pane__nav-list-item-dot"
                      data-tone={tone}
                      aria-hidden
                    />
                    <span className="settings-pane__nav-list-item-name">
                      {displayName}
                    </span>
                    {toolCount !== null && (
                      <span
                        className="settings-pane__nav-list-item-count"
                        data-on={server.enabled ? "true" : "false"}
                        title={`${toolCount} outil${toolCount === 1 ? "" : "s"}`}
                        aria-label={`${toolCount} outil${toolCount === 1 ? "" : "s"}`}
                      >
                        {toolCount}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="settings-pane__switch"
                    role="switch"
                    aria-checked={server.enabled}
                    aria-label={`${server.enabled ? "Désactiver" : "Activer"} ${displayName}`}
                    data-on={server.enabled ? "true" : "false"}
                    disabled={toggleDisabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleEnabled(server.id);
                    }}
                  >
                    <span className="settings-pane__switch-thumb" />
                  </button>
                </div>
              );
            })}
            {servers.length === 0 && (
              <div className="settings-pane__nav-list-empty">
                Aucun serveur pour l'instant — utilisez « Ajouter un serveur ».
              </div>
            )}
          </div>
        </aside>

        <main className="settings-pane__detail-pane">
          {advancedOpen ? (
            <div className="settings-pane__editor-card">
              <div className="settings-pane__editor-bar">
                <div className="settings-pane__editor-bar-left">
                  <Icon icon="solar:code-square-linear" width={13} height={13} />
                  <span>mcp.json</span>
                </div>
                <div className="settings-pane__editor-bar-right">
                  {dirty ? (
                    <span className="settings-pane__pill" data-tone="dirty">
                      <span className="settings-pane__pill-dot" />
                      Modifié
                    </span>
                  ) : (
                    <span className="settings-pane__pill" data-tone="ok">
                      À jour
                    </span>
                  )}
                </div>
              </div>
              <div className="settings-pane__editor-host">
                <Editor
                  value={jsonText}
                  language="json"
                  theme="axecode-cool"
                  onChange={(value) => onJsonChange(value ?? "")}
                  onMount={onMount}
                  options={{
                    fontFamily:
                      '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
                    fontSize: Math.max(1, Math.round(MONO_BASE_PX * textScale)),
                    lineHeight: Math.max(1, Math.round(MONO_LINE_BASE_PX * textScale)),
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    renderLineHighlight: "line",
                    padding: { top: 12, bottom: 12 },
                    tabSize: 2,
                    wordWrap: "off",
                    automaticLayout: true,
                    lineNumbers: "on",
                    lineNumbersMinChars: 3,
                    folding: true,
                    bracketPairColorization: { enabled: true },
                    scrollbar: {
                      verticalScrollbarSize: 9,
                      horizontalScrollbarSize: 9,
                    },
                  }}
                />
              </div>
              {parseError && (
                <div className="settings-pane__editor-error">
                  <Icon icon="solar:danger-triangle-linear" width={13} height={13} />
                  <span>{parseError}</span>
                </div>
              )}
            </div>
          ) : selectedServer ? (
            <ServerDetail
              key={selectedServer.id}
              server={selectedServer}
              probe={selectedProbe}
              probing={probing}
              knownToolCount={knownToolCounts[selectedServer.id]}
              oauthStatus={oauthStatuses[selectedServer.id]}
              oauthBusy={oauthBusyId === selectedServer.id}
              onConnectOAuth={onConnectOAuth}
              onCancelOAuth={onCancelOAuth}
              onDisconnectOAuth={onDisconnectOAuth}
            />
          ) : (
            <div className="settings-pane__empty-state">
              <Icon icon="solar:server-square-cloud-linear" width={18} height={18} />
              <div>
                <strong>Aucun serveur MCP configuré.</strong>
                <span>
                  « Ajouter un serveur » écrit la configuration à votre place ;
                  la configuration avancée reste là en second recours.
                </span>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

type ServerDetailProps = {
  server: McpServerConfig;
  probe: McpServerProbe | null;
  probing: boolean;
  knownToolCount: number | undefined;
  oauthStatus: McpOAuthStatus | undefined;
  oauthBusy: boolean;
  onConnectOAuth: (id: string) => void;
  onCancelOAuth: (id: string) => void;
  onDisconnectOAuth: (id: string) => void;
};

function ServerDetail({
  server,
  probe,
  probing,
  knownToolCount,
  oauthStatus,
  oauthBusy,
  onConnectOAuth,
  onCancelOAuth,
  onDisconnectOAuth,
}: ServerDetailProps) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const toggleTool = useCallback((toolName: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  }, []);
  const tone = !server.enabled
    ? "off"
    : !probe
      ? "pending"
      : probe.ok
        ? "ok"
        : "error";
  const statusLabel = !server.enabled
    ? knownToolCount != null
      ? `${knownToolCount} outil${knownToolCount === 1 ? "" : "s"}`
      : "désactivé"
    : !probe
      ? probing
        ? "vérification…"
        : "en attente"
      : !probe.ok
        ? "en erreur"
        : `${probe.tools.length} outil${probe.tools.length === 1 ? "" : "s"}`;
  // axe:e7 — une chaine de connexion (PostgreSQL) contient le mot de passe :
  // elle est masquee a l'affichage, comme dans le JSON.
  const command = redactCommand([server.command, ...server.args]);

  const serverUrl = server.url?.trim() ?? "";
  const isUrlBased = serverUrl.length > 0;
  // OAuth only applies to URL-based servers; surface it when the probe demands
  // authentication or simply because a URL server is able to authenticate.
  const canAuthenticate = isUrlBased || Boolean(probe?.authRequired);
  const connecting = oauthStatus?.connectionState === "connecting";
  const authenticated = connecting
    ? false
    : oauthStatus
      ? oauthStatus.connected
      : Boolean(probe?.authenticated);
  const oauthError =
    oauthStatus?.connectionState === "error" ? oauthStatus.error : null;
  const authLabel = connecting
    ? "Connexion\u2026"
    : authenticated
      ? "Connecté"
      : "Non connecté";
  const authTone = connecting ? "pending" : authenticated ? "ok" : "off";

  return (
    <div className="settings-pane__detail">
      <div className="settings-pane__detail-head">
        <span className="settings-pane__detail-title">{server.name}</span>
        <span className="settings-pane__chip" data-tone={tone}>
          <span className="settings-pane__chip-dot" />
          {statusLabel}
        </span>
      </div>

      <div className="settings-pane__detail-body">
        {isUrlBased ? (
          <code className="settings-pane__detail-cmd" title={serverUrl}>
            {serverUrl}
          </code>
        ) : command ? (
          <code className="settings-pane__detail-cmd" title={command}>
            {command}
          </code>
        ) : null}
        <div className="settings-pane__detail-meta">
          <span className="settings-pane__detail-key">type</span>
          <code>{isUrlBased ? "URL \u00b7 HTTP" : "stdio"}</code>
        </div>
        {server.cwd && (
          <div className="settings-pane__detail-meta">
            <span className="settings-pane__detail-key">cwd</span>
            <code>{server.cwd}</code>
          </div>
        )}
        {server.env.length > 0 && (
          <div className="settings-pane__detail-meta">
            <span className="settings-pane__detail-key">env</span>
            <code>{server.env.map((item) => item.key).join(", ")}</code>
          </div>
        )}

        {canAuthenticate && (
          <div className="settings-pane__mcp-auth">
            <div className="settings-pane__mcp-auth-head">
              <span className="settings-pane__detail-section">
                Authentification
              </span>
              <span className="settings-pane__chip" data-tone={authTone}>
                <span className="settings-pane__chip-dot" />
                {authLabel}
              </span>
            </div>
            <div className="settings-pane__mcp-auth-row">
              <span className="settings-pane__mcp-auth-hint">
                {authenticated
                  ? "Connecté : le jeton est enregistré. « Déconnecter » le supprime."
                  : "Autorisez ce serveur dans votre navigateur pour charger ses outils."}
              </span>
              {connecting ? (
                <button
                  type="button"
                  className="settings-pane__btn"
                  onClick={() => onCancelOAuth(server.id)}
                >
                  <Icon
                    icon="solar:close-circle-linear"
                    width={13}
                    height={13}
                  />
                  <span>Annuler</span>
                </button>
              ) : authenticated ? (
                <button
                  type="button"
                  className="settings-pane__btn"
                  onClick={() => onDisconnectOAuth(server.id)}
                  disabled={oauthBusy}
                >
                  <Icon icon="solar:logout-2-linear" width={13} height={13} />
                  <span>{oauthBusy ? "Déconnexion\u2026" : "Déconnecter"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="settings-pane__btn"
                  data-primary="true"
                  onClick={() => onConnectOAuth(server.id)}
                  disabled={oauthBusy}
                >
                  <Icon
                    icon={
                      oauthBusy
                        ? "solar:refresh-linear"
                        : "solar:login-2-linear"
                    }
                    width={13}
                    height={13}
                  />
                  <span>{oauthBusy ? "Ouverture\u2026" : "Connecter"}</span>
                </button>
              )}
            </div>
            {oauthError && (
              <div className="settings-pane__mcp-auth-error">{oauthError}</div>
            )}
          </div>
        )}

        {probe?.error && (
          <div className="settings-pane__tools-error">{probe.error}</div>
        )}

        <div className="settings-pane__detail-section">Outils</div>
        <div className="settings-pane__tool-list">
          {probe?.tools.map((tool) => {
            const isOpen = expandedTools.has(tool.toolName);
            const hasDescription = Boolean(tool.description?.trim());
            return (
              <div className="settings-pane__tool" key={tool.toolName}>
                <button
                  type="button"
                  className="settings-pane__tool-head"
                  onClick={() => toggleTool(tool.toolName)}
                  aria-expanded={isOpen}
                  data-open={isOpen ? "true" : "false"}
                >
                  <span className="settings-pane__tool-head-text">
                    <span className="settings-pane__tool-name">
                      {tool.title || tool.name}
                    </span>
                    <code className="settings-pane__tool-id">
                      {tool.toolName}
                    </code>
                  </span>
                  <Icon
                    icon="solar:alt-arrow-down-linear"
                    width={12}
                    height={12}
                    className="settings-pane__tool-caret"
                  />
                </button>
                {isOpen && (
                  <div className="settings-pane__tool-body">
                    {hasDescription ? (
                      <Markdown
                        text={tool.description ?? ""}
                        onOpenFile={noop}
                      />
                    ) : (
                      <div className="settings-pane__muted">
                        Aucune description.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {probe?.ok && probe.tools.length === 0 && (
            <div className="settings-pane__muted">Le serveur n'a renvoyé aucun outil.</div>
          )}
          {!probe && (
            <div className="settings-pane__muted">
              {probing ? "Interrogation du serveur…" : "Pas encore interrogé."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Skills section ----------------------------------------------------

type SkillsSectionProps = {
  skills: InstalledSkill[];
  allSkills: InstalledSkill[] | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  status: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  selectedSkill: InstalledSkill | null;
  deleting: boolean;
  onSelectSkill: (name: string) => void;
  onRefresh: () => void;
  onSave: () => void;
  onCreate: () => void;
  onToggleSkill: (name: string) => void;
  onRevealSkill: (skill: InstalledSkill) => void;
  onDeleteSkill: (skill: InstalledSkill) => void;
  onSaveSkillContent: (skill: InstalledSkill, content: string) => Promise<boolean>;
  // axe:e16 — competences lues au service (lecture seule)
  serviceSkills: InstalledSkill[];
  serviceNote: string | null;
  // axe:cleanup
  pySkills: HarnessEntry[];
  pyTotal: number;
  selectedPySkill: HarnessEntry | null;
  pyBusy: boolean;
  kindFilter: SkillKindFilter;
  onKindFilterChange: (value: SkillKindFilter) => void;
  onSelectPySkill: (id: string) => void;
  onTogglePySkill: (entry: HarnessEntry) => void;
  onMovePySkill: (entry: HarnessEntry) => void;
};

function SkillsSection({
  skills,
  allSkills,
  loading,
  saving,
  dirty,
  error,
  status,
  filter,
  onFilterChange,
  selectedSkill,
  deleting,
  onSelectSkill,
  onRefresh,
  onSave,
  onCreate,
  onToggleSkill,
  onRevealSkill,
  onDeleteSkill,
  onSaveSkillContent,
  serviceSkills,
  serviceNote,
  pySkills,
  pyTotal,
  selectedPySkill,
  pyBusy,
  kindFilter,
  onKindFilterChange,
  onSelectPySkill,
  onTogglePySkill,
  onMovePySkill,
}: SkillsSectionProps) {
  const total = (allSkills?.length ?? 0) + pyTotal;
  const visible = skills.length + pySkills.length;
  // axe:e16 — le filtre s'applique aussi aux competences du service.
  const serviceVisible = serviceSkills.filter((skill) => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return true;
    return (
      skill.name.toLowerCase().includes(needle) ||
      (skill.description ?? "").toLowerCase().includes(needle) ||
      (skill.rootLabel ?? "").toLowerCase().includes(needle)
    );
  });
  const enabled = (allSkills?.filter((skill) => skill.enabled).length ?? 0) + pySkills.filter(isPySkillEnabled).length;

  return (
    <>
      <header className="settings-pane__header">
        <div className="settings-pane__header-text">
          <h1 className="settings-pane__title">Skills</h1>
          <p className="settings-pane__subtitle">
            {loading
              ? "Analyse…"
              : total === 0
                ? "Déposez des SKILL.md dans .agents/skills ou ~/.agents/skills, ou créez un skill Python avec le harnais."
                : `${enabled}/${total} disponibles pour l'agent · Recettes Markdown et skills Python du harnais`}
          </p>
        </div>
        <div className="settings-pane__actions">
          {status && (
            <span
              className="settings-pane__status"
              data-tone={
                status === "Enregistré" || status === "Créé" || status === "Supprimé"
                  ? "ok"
                  : "error"
              }
            >
              {status}
            </span>
          )}
          <button
            type="button"
            className="settings-pane__btn"
            onClick={onCreate}
            disabled={loading || saving || deleting}
          >
            <Icon icon="solar:add-circle-linear" width={13} height={13} />
            <span>Nouvelle recette</span>
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            onClick={onRefresh}
            disabled={loading || deleting}
          >
            <Icon icon="solar:refresh-linear" width={13} height={13} />
            <span>Actualiser</span>
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            data-primary="true"
            onClick={onSave}
            disabled={loading || saving || deleting || !dirty}
          >
            <Icon
              icon={saving ? "solar:refresh-linear" : "solar:diskette-linear"}
              width={13}
              height={13}
            />
            <span>{saving ? "Enregistrement…" : "Enregistrer"}</span>
          </button>
        </div>
      </header>

      <div className="settings-pane__body settings-pane__body--skills">
        <aside className="settings-pane__skill-list">
          <div className="settings-pane__search">
            <Icon icon="solar:magnifer-linear" width={13} height={13} />
            <input
              type="search"
              value={filter}
              onChange={(event) => onFilterChange(event.target.value)}
              placeholder={total ? `Filtrer ${total} skills` : "Filtrer les skills"}
            />
          </div>
          <div className="settings-pane__tool-provider-switch settings-pane__skill-kinds" role="group" aria-label="Type de skill">
            {([["all", "Tous"], ["recipe", "Recettes"], ["python", "Python"]] as const).map(([id, label]) => (
              <button key={id} type="button" data-active={kindFilter === id ? "true" : "false"} onClick={() => onKindFilterChange(id)}>
                {label}
              </button>
            ))}
          </div>

          {error && (
            <div className="settings-pane__editor-error">
              <Icon icon="solar:danger-triangle-linear" width={13} height={13} />
              <span>{error}</span>
            </div>
          )}

          {/* axe:e16 — les competences de Prime Agent, telles que le service
              les voit : la meme liste que dans l'espace Axe Cloud. */}
          {serviceVisible.length > 0 || serviceNote ? (
            <div className="settings-pane__skill-service">
              <div className="settings-pane__skill-service-head">
                <Icon icon="solar:cloud-check-linear" width={13} height={13} />
                <span>Espace Axe Cloud</span>
                <span className="settings-pane__skill-service-count">
                  {serviceVisible.length}
                </span>
                <em>lecture seule</em>
              </div>
              {serviceNote ? (
                <p className="settings-pane__skill-service-note">{serviceNote}</p>
              ) : null}
              <div className="settings-pane__skill-service-list">
                {serviceVisible.map((skill) => (
                  <div
                    key={`service-${skill.name}`}
                    className="settings-pane__skill-service-item"
                    title={skill.absolutePath}
                  >
                    <span className="settings-pane__skill-name">{skill.name}</span>
                    {skill.description ? (
                      <span className="settings-pane__skill-service-desc">
                        {skill.description}
                      </span>
                    ) : null}
                    <span className="settings-pane__skill-source" data-source={skill.source}>
                      {skill.rootLabel || (skill.source === "workspace" ? "projet" : "global")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="settings-pane__skill-scroll">
            {skills.map((skill) => (
              <div
                key={skill.name}
                className="settings-pane__skill-item"
                data-active={selectedSkill?.name === skill.name ? "true" : "false"}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSkill(skill.name)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectSkill(skill.name);
                }}
              >
                <div className="settings-pane__skill-row">
                  <div className="settings-pane__subagent-list-head">
                    <span className="settings-pane__skill-name">{skill.name}</span>
                    <span className="settings-pane__skill-kind" data-kind="recipe">Recette</span>
                    <span
                      className="settings-pane__skill-source"
                      data-source={skill.source}
                    >
                      {skill.source === "workspace" ? "projet" : "global"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-pane__switch"
                    role="switch"
                    aria-checked={skill.enabled}
                    aria-label={`${skill.enabled ? "Désactiver" : "Activer"} ${skill.name}`}
                    data-on={skill.enabled ? "true" : "false"}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleSkill(skill.name);
                    }}
                  >
                    <span className="settings-pane__switch-thumb" />
                  </button>
                </div>
                {skill.description && (
                  <span className="settings-pane__skill-desc">
                    {skill.description}
                  </span>
                )}
              </div>
            ))}
            {pySkills.map((entry) => (
              <div
                key={entry.id}
                className="settings-pane__skill-item"
                data-active={selectedPySkill?.id === entry.id ? "true" : "false"}
                role="button"
                tabIndex={0}
                onClick={() => onSelectPySkill(entry.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectPySkill(entry.id);
                }}
              >
                <div className="settings-pane__skill-row">
                  <div className="settings-pane__subagent-list-head">
                    <span className="settings-pane__skill-name">{entry.title}</span>
                    <span className="settings-pane__skill-kind" data-kind="python">Python</span>
                    <span className="settings-pane__skill-source" data-source={entry.scope === "project" ? "workspace" : "global"}>
                      {entry.scope === "project" ? "projet" : "global"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-pane__switch"
                    role="switch"
                    aria-checked={isPySkillEnabled(entry)}
                    aria-label={`${isPySkillEnabled(entry) ? "Désactiver" : "Activer"} ${entry.title}`}
                    data-on={isPySkillEnabled(entry) ? "true" : "false"}
                    disabled={pyBusy}
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTogglePySkill(entry);
                    }}
                  >
                    <span className="settings-pane__switch-thumb" />
                  </button>
                </div>
              </div>
            ))}
            {!loading && visible === 0 && total > 0 && (
              <div className="settings-pane__muted settings-pane__muted--center">
                Aucun skill ne correspond.
              </div>
            )}
            {!loading && total === 0 && (
              <div className="settings-pane__empty">
                <Icon icon="solar:magic-stick-3-linear" width={22} height={22} />
                <span className="settings-pane__empty-title">Aucun skill</span>
                <span className="settings-pane__empty-sub">
                  Créez un dossier <code>.agents/skills/&lt;nom&gt;/</code>{" "}
                  avec un fichier <code>SKILL.md</code>.
                </span>
              </div>
            )}
          </div>
        </aside>

        <div className="settings-pane__skill-preview">
          {selectedPySkill ? (
            <PythonSkillPreview
              entry={selectedPySkill}
              busy={pyBusy}
              onToggle={() => onTogglePySkill(selectedPySkill)}
              onMove={() => onMovePySkill(selectedPySkill)}
            />
          ) : selectedSkill ? (
            <SkillPreview
              skill={selectedSkill}
              saving={saving}
              deleting={deleting}
              onReveal={() => onRevealSkill(selectedSkill)}
              onDelete={() => onDeleteSkill(selectedSkill)}
              onSaveContent={(content) => onSaveSkillContent(selectedSkill, content)}
            />
          ) : (
            <div className="settings-pane__empty settings-pane__empty--main">
              <Icon icon="solar:document-text-linear" width={22} height={22} />
              <span className="settings-pane__empty-title">
                {total === 0 ? "Rien à afficher" : "Sélectionnez un skill"}
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function SkillPreview({
  skill,
  saving,
  deleting,
  onReveal,
  onDelete,
  onSaveContent,
}: {
  skill: InstalledSkill;
  saving: boolean;
  deleting: boolean;
  onReveal: () => void;
  onDelete: () => void;
  onSaveContent: (content: string) => Promise<boolean>;
}) {
  const body = stripFrontmatter(skill.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  // axe:zoom — the markdown editor follows the text size (only chars grow).
  const [textScale, setTextScale] = useState<number>(() => loadTextScale());
  useEffect(() => onTextScaleChange(setTextScale), []);
  const [draftName, setDraftName] = useState(skill.name);
  const [draftDescription, setDraftDescription] = useState(skill.description ?? "");
  const [draftBody, setDraftBody] = useState(body);
  const nameValid = draftName.trim().length > 0;

  const resetDraft = useCallback(() => {
    setDraftName(skill.name);
    setDraftDescription(skill.description ?? "");
    setDraftBody(stripFrontmatter(skill.content));
  }, [skill.content, skill.description, skill.name]);

  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  useEffect(() => {
    setConfirmDelete(false);
    setEditing(false);
    resetDraft();
  }, [resetDraft, skill.absolutePath]);

  const saveDraft = useCallback(async () => {
    if (!nameValid || saving || deleting) return;
    const ok = await onSaveContent(
      buildSkillContent(draftName, draftDescription, draftBody),
    );
    if (ok) setEditing(false);
  }, [deleting, draftBody, draftDescription, draftName, nameValid, onSaveContent, saving]);

  return (
    <article className="settings-pane__skill-doc">
      <header className="settings-pane__skill-doc-head">
        <div className="settings-pane__skill-doc-top">
          <div className="settings-pane__skill-doc-title">
            {editing ? (
              <input
                className="settings-pane__skill-doc-title-input"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="skill-name"
                aria-invalid={!nameValid}
                spellCheck={false}
                autoFocus
              />
            ) : (
              <h2>{skill.name}</h2>
            )}
            <span
              className="settings-pane__skill-source"
              data-source={skill.source}
            >
              {skill.source === "workspace" ? "workspace" : "global"}
            </span>
          </div>
          <div className="settings-pane__skill-doc-actions">
            {editing ? (
              <>
                <button
                  type="button"
                  className="settings-pane__skill-doc-action"
                  onClick={() => {
                    resetDraft();
                    setEditing(false);
                  }}
                  disabled={saving || deleting}
                >
                  <Icon icon="solar:close-circle-linear" width={13} height={13} />
                  <span>Annuler</span>
                </button>
                <button
                  type="button"
                  className="settings-pane__skill-doc-action"
                  data-primary="true"
                  onClick={() => void saveDraft()}
                  disabled={saving || deleting || !nameValid}
                >
                  <Icon
                    icon={saving ? "solar:refresh-linear" : "solar:diskette-linear"}
                    width={13}
                    height={13}
                  />
                  <span>{saving ? "Enregistrement…" : "Enregistrer"}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="settings-pane__skill-doc-action"
                onClick={() => setEditing(true)}
                disabled={saving || deleting}
                title="Modifier le contenu du skill"
              >
                <Icon icon="solar:code-square-linear" width={13} height={13} />
                <span>Source</span>
              </button>
            )}
            {!editing && (
              <>
                <button
                  type="button"
                  className="settings-pane__skill-doc-action"
                  onClick={onReveal}
                  disabled={saving || deleting}
                  title="Afficher dans l'Explorateur"
                  aria-label={`Afficher ${skill.name} dans l'Explorateur`}
                >
                  <Icon icon="solar:folder-open-linear" width={13} height={13} />
                  <span>Afficher dans l'Explorateur</span>
                </button>
                <button
                  type="button"
                  className="settings-pane__skill-doc-action"
                  data-danger="true"
                  data-confirm={confirmDelete ? "true" : "false"}
                  disabled={saving || deleting}
                  title={confirmDelete ? "Cliquer encore pour confirmer" : "Supprimer le skill"}
                  aria-label={confirmDelete ? "Confirmer la suppression du skill" : `Supprimer ${skill.name}`}
                  onClick={() => {
                    if (confirmDelete) {
                      onDelete();
                    } else {
                      setConfirmDelete(true);
                    }
                  }}
                >
                  <Icon
                    icon={
                      deleting
                        ? "solar:refresh-linear"
                        : "solar:trash-bin-trash-linear"
                    }
                    width={13}
                    height={13}
                  />
                  <span>
                    {deleting
                      ? "Suppression…"
                      : confirmDelete
                        ? "Confirmer la suppression"
                        : "Supprimer"}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
        <code className="settings-pane__skill-path">{skill.absolutePath}</code>
        {editing ? (
          <input
            className="settings-pane__skill-doc-desc-input"
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            placeholder="Quand l'agent doit-il utiliser ce skill ?"
            spellCheck={false}
          />
        ) : (
          skill.description && (
            <p className="settings-pane__skill-doc-desc">{skill.description}</p>
          )
        )}
      </header>
      {editing ? (
        <div className="settings-pane__skill-doc-editor">
          {!nameValid && (
            <div className="settings-pane__editor-error">
              <Icon icon="solar:danger-triangle-linear" width={13} height={13} />
              <span>Le nom est obligatoire.</span>
            </div>
          )}
          <div className="settings-pane__skill-doc-editor-host">
            <Editor
              value={draftBody}
              language="markdown"
              theme="axecode-cool"
              onChange={(value) => setDraftBody(value ?? "")}
              onMount={(_editor, monaco) => defineAxecodeCoolTheme(monaco)}
              options={{
                fontFamily:
                  '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
                fontSize: Math.max(1, Math.round(MONO_BASE_PX * textScale)),
                lineHeight: Math.max(1, Math.round(MONO_LINE_BASE_PX * textScale)),
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                renderLineHighlight: "line",
                padding: { top: 12, bottom: 12 },
                tabSize: 2,
                wordWrap: "on",
                automaticLayout: true,
                lineNumbers: "on",
                lineNumbersMinChars: 3,
                folding: true,
                scrollbar: {
                  verticalScrollbarSize: 9,
                  horizontalScrollbarSize: 9,
                },
              }}
            />
          </div>
        </div>
      ) : (
        <div className="settings-pane__skill-doc-body">
          <Markdown text={body || "_(SKILL.md vide)_"} onOpenFile={noop} />
        </div>
      )}
    </article>
  );
}

function noop(): void {}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content.trim();
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content.trim();
  return content.slice(end + 4).trim();
}

type MonacoNs = Parameters<OnMount>[1];

// axe:theme — Settings editors share the Axe theme (light/dark follows the background).
function defineAxecodeCoolTheme(monaco: MonacoNs): void {
  monaco.editor.defineTheme("axecode-cool", monacoThemeData());
  monaco.editor.setTheme("axecode-cool");
}

function buildSkillContent(name: string, description: string, body: string): string {
  const normalizedBody = body.replace(/\r\n/g, "\n").trimEnd();
  return [
    "---",
    `name: ${cleanFrontmatterValue(name)}`,
    `description: ${cleanFrontmatterValue(description)}`,
    "---",
    "",
    normalizedBody,
  ].join("\n");
}

function cleanFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function settingsFromSkills(skills: InstalledSkill[]): SkillSettings {
  return {
    skills: skills.map((skill) => ({
      name: skill.name,
      enabled: skill.enabled,
    })),
  };
}

function skillsFingerprint(skills: InstalledSkill[]): string {
  return JSON.stringify(settingsFromSkills(skills));
}

// ---- JSON parsing helpers (unchanged) ----------------------------------

function parseMcpJson(source: string): McpSettings {
  const trimmed = source.trim();
  if (!trimmed) return EMPTY_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "JSON invalide");
  }

  return normalizeSettings(settingsFromUnknown(parsed));
}

function settingsFromUnknown(value: unknown): McpSettings {
  if (Array.isArray(value)) {
    return {
      servers: value.map((item, index) => serverFromUnknown(item, `server-${index + 1}`)),
    };
  }

  if (!isRecord(value)) {
    throw new Error("Le JSON doit être un objet ou un tableau");
  }

  if (isRecord(value.mcpServers)) {
    return {
      servers: Object.entries(value.mcpServers).map(([name, config]) =>
        serverFromUnknown(config, name),
      ),
    };
  }

  if (Array.isArray(value.servers)) {
    return {
      servers: value.servers.map((item, index) =>
        serverFromUnknown(item, `server-${index + 1}`),
      ),
    };
  }

  throw new Error('Use {"mcpServers": {...}} or {"servers": [...]}');
}

function serverFromUnknown(value: unknown, fallbackName: string): McpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`Configuration MCP invalide pour ${fallbackName}`);
  }

  const name = stringValue(value.name) || fallbackName;
  const command = stringValue(value.command);
  const url = stringValue(value.url);
  if (!command && !url) {
    throw new Error(`Commande ou URL manquante pour ${name}`);
  }

  return {
    id: stringValue(value.id) || deterministicId(name),
    name,
    command,
    url: url || null,
    args: arrayOfStrings(value.args),
    env: envFromUnknown(value.env),
    headers: headersFromUnknown(value.headers),
    auth: authFromUnknown(value.auth),
    cwd: stringValue(value.cwd) || null,
    enabled: value.enabled === false || value.disabled === true ? false : true,
  };
}

function normalizeSettings(settings: McpSettings): McpSettings {
  const seen = new Map<string, number>();
  return {
    servers: (settings.servers ?? []).map((server, index) => {
      const name = server.name || `server-${index + 1}`;
      const baseId = server.id || deterministicId(name);
      const count = seen.get(baseId) ?? 0;
      seen.set(baseId, count + 1);
      const id = count ? `${baseId}-${count + 1}` : baseId;
      const url =
        typeof server.url === "string" && server.url.trim()
          ? server.url.trim()
          : null;
      return {
        id,
        name,
        command: server.command ?? "",
        url,
        args: server.args ?? [],
        env: server.env ?? [],
        headers: server.headers ?? [],
        auth: server.auth ?? null,
        cwd: server.cwd ?? null,
        enabled: server.enabled ?? true,
      };
    }),
  };
}

/// axe:e7 — JSON affiché dans la configuration avancée : les valeurs secrètes
/// (clés API, jetons, chaînes de connexion) sont remplacées par des étoiles.
/// Les vraies valeurs restent dans le coffre en mémoire et repartent au
/// prochain enregistrement.
function displayJson(
  servers: McpServerConfig[],
  vault: McpSecretVault,
): string {
  return settingsToJson({ servers: redactMcpSecrets({ servers }, vault).servers });
}

function settingsToJson(settings: McpSettings): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of settings.servers) {
    const entry: Record<string, unknown> = {};
    const url = server.url?.trim();
    if (url) {
      entry.url = url;
    } else {
      entry.command = server.command;
    }
    if (server.args.length) entry.args = server.args;
    if (server.cwd) entry.cwd = server.cwd;
    if (server.env.length) entry.env = envToObject(server.env);
    if (server.headers.length) entry.headers = headersToObject(server.headers);
    const auth = server.auth ? authToJson(server.auth) : null;
    if (auth) entry.auth = auth;
    if (!server.enabled) entry.disabled = true;
    mcpServers[server.name || server.id] = entry;
  }

  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

function deterministicId(name: string): string {
  return `mcp_${slug(name) || "server"}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function envFromUnknown(value: unknown): McpEnvVar[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((item) => ({ key: stringValue(item.key), value: stringValue(item.value) }))
      .filter((item) => item.key);
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, item]) => ({
      key,
      value: typeof item === "string" ? item : JSON.stringify(item),
    }));
  }
  return [];
}

function envToObject(env: McpEnvVar[]): Record<string, string> {
  return Object.fromEntries(env.map((item) => [item.key, item.value]));
}

// Headers accept either the array form ([{key,value}]) used internally or the
// object form ({ "Authorization": "Bearer …" }) typical of mcp.json snippets.
function headersFromUnknown(value: unknown): McpHeader[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((item) => ({ key: stringValue(item.key), value: stringValue(item.value) }))
      .filter((item) => item.key);
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, item]) => ({
      key,
      value: typeof item === "string" ? item : JSON.stringify(item),
    }));
  }
  return [];
}

function headersToObject(headers: McpHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((item) => [item.key, item.value]));
}

function authFromUnknown(value: unknown): McpAuthConfig | null {
  if (!isRecord(value)) return null;
  const type = stringValue(value.type);
  const token = stringValue(value.token);
  const scopes = arrayOfStrings(value.scopes);
  if (!type && !token && scopes.length === 0) return null;
  return {
    type: type || "bearer",
    token: token || undefined,
    scopes,
  };
}

function authToJson(auth: McpAuthConfig): Record<string, unknown> | null {
  const entry: Record<string, unknown> = {};
  const type = auth.type?.trim();
  if (type) entry.type = type;
  const token = auth.token?.trim();
  if (token) entry.token = token;
  if (auth.scopes.length) entry.scopes = auth.scopes;
  return Object.keys(entry).length ? entry : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

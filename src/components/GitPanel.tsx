import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { api, cloudConnectionFromPath } from "../lib/ipc";
import type {
  GitBranch,
  GitPullRequestOutput,
  GitRepositorySnapshot,
  GitStatusFile,
  GitWorktree,
} from "../types";

// Official Git logo, traced from the SVG distributed on git-scm.com:
// a 45°-rotated diamond with a small Y-shaped branch fork inside.
// Used as a monochrome icon next to the Git tab label and next to
// each worktree row.
export function GitMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M23.546 10.93 13.067.452a1.55 1.55 0 0 0-2.188 0L8.708 2.627l2.76 2.76a1.838 1.838 0 0 1 2.327 2.341l2.658 2.66a1.838 1.838 0 0 1 1.9 3.039 1.837 1.837 0 0 1-2.6 0 1.846 1.846 0 0 1-.404-2.008L12.86 8.99v6.59a1.847 1.847 0 1 1-1.51-.048V8.876a1.835 1.835 0 0 1-.997-2.41L7.638 3.748.452 10.934a1.55 1.55 0 0 0 0 2.19L10.93 23.547a1.55 1.55 0 0 0 2.188 0l10.428-10.43a1.55 1.55 0 0 0 0-2.188"
      />
    </svg>
  );
}

type Props = {
  workspacePath: string;
  // When false (tab inactive), polling is suspended. Inputs and local UI
  // state are preserved across tab switches.
  active: boolean;
  onSwitchWorkspace: (path: string) => Promise<void>;
  // True when *any* conversation in this window is currently streaming.
  // Switching worktrees while a stream is in flight would orphan it, so
  // we surface a disabled state with a tooltip rather than letting the
  // user fire the action and discover the failure after the fact.
  hasStreamingConversation: boolean;
};

type Notice = {
  kind: "success" | "error";
  text: string;
  sticky?: boolean;
};

type RemoveTarget = {
  wt: GitWorktree;
};

// Confirmation state for deleting a local branch. We track `force` so a
// first attempt that fails with the classic "not fully merged" error can
// be retried in-place by escalating the button. `lastError` is rendered
// inline inside the dialog so the user keeps context across retries.
type DeleteBranchTarget = {
  branch: GitBranch;
  force: boolean;
  deleteUpstream: boolean;
  lastError: string | null;
};

// Composer state for renaming a local branch.
type RenameBranchTarget = {
  branch: GitBranch;
  newName: string;
  syncRemote: boolean;
};

const POLL_INTERVAL_MS = 6000;
const NOTICE_AUTO_DISMISS_MS = 4500;

// ----------------------------------------------------------------------
// Main component
// ----------------------------------------------------------------------

export function GitPanel({
  workspacePath,
  active,
  onSwitchWorkspace,
  hasStreamingConversation,
}: Props) {
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null);
  const enCoursRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Commit composer (row click toggles selection — no checkbox glyph,
  // mirrors how multi-select works in the rest of the sidebar).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState("");

  // Worktree composer (modal)
  const [createWtOpen, setCreateWtOpen] = useState(false);
  const [wtBranchName, setWtBranchName] = useState("");
  const [wtBaseBranch, setWtBaseBranch] = useState("");
  const [wtPushImmediately, setWtPushImmediately] = useState(false);

  // Remove worktree confirmation (modal)
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);

  // Delete / rename branch composers (modals)
  const [deleteBranchTarget, setDeleteBranchTarget] =
    useState<DeleteBranchTarget | null>(null);
  const [renameBranchTarget, setRenameBranchTarget] =
    useState<RenameBranchTarget | null>(null);

  // Branch composer + ghost tab filter
  const [branchTab, setBranchTab] = useState<"local" | "remote">("local");
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchBase, setNewBranchBase] = useState("");

  // Pull-request composer (modal)
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prTarget, setPrTarget] = useState("");
  const [prResult, setPrResult] = useState<GitPullRequestOutput | null>(null);

  // Refs for stale-callback guards across awaits / debounced timers.
  const workspacePathRef = useRef(workspacePath);
  const requestSeqRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);

  // ---- Stable refs ----------------------------------------------------

  useEffect(() => {
    workspacePathRef.current = workspacePath;
  }, [workspacePath]);

  // ---- Reset transient UI when workspace changes ----------------------

  useEffect(() => {
    requestSeqRef.current += 1;
    setSnapshot(null);
    setLoading(true);
    setBusyKey(null);
    setNotice(null);
    setSelected(new Set());
    setCommitMessage("");
    setCreateWtOpen(false);
    setWtBranchName("");
    setWtBaseBranch("");
    setWtPushImmediately(false);
    setRemoveTarget(null);
    setDeleteBranchTarget(null);
    setRenameBranchTarget(null);
    setCreateBranchOpen(false);
    setNewBranchName("");
    setNewBranchBase("");
    setPrOpen(false);
    setPrTitle("");
    setPrBody("");
    setPrTarget("");
    setPrResult(null);
  }, [workspacePath]);

  // ---- Notification plumbing ------------------------------------------

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }, []);

  const showNotice = useCallback(
    (next: Notice) => {
      clearNoticeTimer();
      setNotice(next);
      if (next.kind === "success" && !next.sticky) {
        noticeTimerRef.current = window.setTimeout(() => {
          setNotice(null);
          noticeTimerRef.current = null;
        }, NOTICE_AUTO_DISMISS_MS);
      }
    },
    [clearNoticeTimer],
  );

  const dismissNotice = useCallback(() => {
    clearNoticeTimer();
    setNotice(null);
  }, [clearNoticeTimer]);

  useEffect(() => () => clearNoticeTimer(), [clearNoticeTimer]);

  // ---- Snapshot refresh ------------------------------------------------

  const refresh = useCallback(async (showSpinner: boolean) => {
    const ws = workspacePathRef.current;
    // axe:0.1.75 — un relevé périodique ne doit pas annuler un relevé encore en cours
    // (gros dépôt : `git status` > 6 s, chaque réponse était jetée et la liste restait vide).
    if (!showSpinner && enCoursRef.current === ws) return;
    enCoursRef.current = ws;
    const seq = ++requestSeqRef.current;
    if (showSpinner) setLoading(true);
    try {
      const next = await api.gitSnapshot(ws);
      if (workspacePathRef.current !== ws || seq !== requestSeqRef.current) {
        return;
      }
      setSnapshot(next);
      // Drop any stale selections for files no longer in status.
      const available = new Set(next.status.map((file) => file.path));
      setSelected((prev) => {
        let mutated = false;
        const filtered = new Set<string>();
        prev.forEach((path) => {
          if (available.has(path)) {
            filtered.add(path);
          } else {
            mutated = true;
          }
        });
        return mutated ? filtered : prev;
      });
      // Seed defaults for the create-worktree / branch / PR forms once we
      // have a snapshot. We only fill them when empty so the user's own
      // input is never overwritten across refreshes.
      const fallbackBase = next.mainBranch ?? next.currentBranch ?? "";
      setWtBaseBranch((prev) => (prev ? prev : fallbackBase));
      setNewBranchBase((prev) =>
        prev ? prev : next.currentBranch ?? fallbackBase,
      );
      setPrTarget((prev) => (prev ? prev : fallbackBase));
    } catch (err) {
      if (workspacePathRef.current !== ws || seq !== requestSeqRef.current) {
        return;
      }
      // Build a synthetic "git not available" snapshot from the error so
      // the user sees something actionable instead of a blank panel.
      setSnapshot({
        gitAvailable: false,
        ghAvailable: false,
        isRepository: false,
        workspacePath: ws,
        dirtyCount: 0,
        status: [],
        worktrees: [],
        branches: [],
        error: stringifyError(err),
      });
    } finally {
      if (seq === requestSeqRef.current) enCoursRef.current = null;
      if (workspacePathRef.current === ws && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Immediate refresh on activation or when the workspace changes.
  useEffect(() => {
    if (!active) return;
    void refresh(true);
  }, [active, refresh, workspacePath]);

  // Periodic refresh, only while visible.
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => {
      void refresh(false);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, refresh]);

  // Refresh when the window regains focus (covers external edits via a
  // terminal, sibling SavIDE window, etc.).
  useEffect(() => {
    if (!active) return;
    const onFocus = () => void refresh(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, refresh]);

  // ---- Action runner ---------------------------------------------------

  // Centralised wrapper so every git action gets the same lifecycle: mark
  // a busy key (used to disable buttons and animate the right spinner),
  // surface success/error notices, and always re-fetch the snapshot at
  // the end so the panel reflects the new repo state.
  const runAction = useCallback(
    async <T,>(
      key: string,
      fn: () => Promise<T>,
      describe?: (result: T) => Notice | null,
    ): Promise<T | null> => {
      if (busyKey) return null;
      setBusyKey(key);
      try {
        const result = await fn();
        if (describe) {
          const n = describe(result);
          if (n) showNotice(n);
        }
        return result;
      } catch (err) {
        showNotice({ kind: "error", text: stringifyError(err), sticky: true });
        return null;
      } finally {
        setBusyKey(null);
        void refresh(false);
      }
    },
    [busyKey, refresh, showNotice],
  );

  // ---- Action handlers -------------------------------------------------

  const handleInit = useCallback(() => {
    void runAction(
      "init",
      () => api.gitInit(workspacePath),
      (snap) => {
        setSnapshot(snap);
        return { kind: "success", text: "Dépôt initialisé." };
      },
    );
  }, [runAction, workspacePath]);

  const toggleFile = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!snapshot) return;
    setSelected((prev) => {
      if (prev.size === snapshot.status.length) return new Set();
      return new Set(snapshot.status.map((file) => file.path));
    });
  }, [snapshot]);

  const handleCommit = useCallback(() => {
    const message = commitMessage.trim();
    if (!message) {
      showNotice({ kind: "error", text: "Saisissez un message de validation (commit)." });
      return;
    }
    const paths = Array.from(selected);
    if (paths.length === 0) {
      showNotice({ kind: "error", text: "Sélectionnez au moins un fichier à valider." });
      return;
    }
    void runAction(
      "commit",
      () => api.gitCommit(workspacePath, message, paths),
      (result) => {
        setCommitMessage("");
        setSelected(new Set());
        return { kind: "success", text: result.message };
      },
    );
  }, [commitMessage, runAction, selected, showNotice, workspacePath]);

  const handlePush = useCallback(() => {
    void runAction(
      "push",
      () => api.gitPush(workspacePath),
      (result) => ({ kind: "success", text: result.message }),
    );
  }, [runAction, workspacePath]);

  const handlePull = useCallback(() => {
    void runAction(
      "pull",
      () => api.gitPull(workspacePath),
      (result) => ({ kind: "success", text: result.message }),
    );
  }, [runAction, workspacePath]);

  const handleCheckout = useCallback(
    (branch: string) => {
      if (!branch || branch === snapshot?.currentBranch) return;
      void runAction(
        `checkout:${branch}`,
        () => api.gitCheckout(workspacePath, branch),
        (result) => ({ kind: "success", text: result.message }),
      );
    },
    [runAction, snapshot?.currentBranch, workspacePath],
  );

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtBranchName.trim();
    if (!branch) {
      showNotice({ kind: "error", text: "Saisissez un nom de branche." });
      return;
    }
    const base = wtBaseBranch.trim() || null;
    const created = await runAction("create-worktree", () =>
      api.gitCreateWorktree(workspacePath, branch, base, wtPushImmediately),
    );
    if (!created) return;
    // Reset composer regardless of switch outcome — the worktree exists on
    // disk now and re-entering the same form values would feel weird. The
    // notice / refresh below tells the user where things stand.
    setWtBranchName("");
    setWtPushImmediately(false);
    setCreateWtOpen(false);
    try {
      await onSwitchWorkspace(created.worktreePath);
      // If a switch succeeded the panel remounts against the new
      // workspace, so this notice is best-effort only; we still set it so
      // the previous workspace's panel shows something on re-entry.
      showNotice({
        kind: "success",
        text: created.warning
          ? `${created.message} — ${created.warning}`
          : created.message,
        sticky: Boolean(created.warning),
      });
    } catch (err) {
      // The worktree was created but the auto-switch is blocked
      // (typically: a stream is in flight). Surface a sticky notice so
      // the user knows where their work landed and can switch manually
      // when ready.
      showNotice({
        kind: "error",
        sticky: true,
        text: `Arbre de travail ${created.worktreePath} créé — bascule automatique bloquée : ${stringifyError(err)}`,
      });
    }
  }, [
    onSwitchWorkspace,
    runAction,
    showNotice,
    workspacePath,
    wtBaseBranch,
    wtBranchName,
    wtPushImmediately,
  ]);

  const handleSwitchWorktree = useCallback(
    async (wt: GitWorktree) => {
      if (wt.isCurrent) return;
      if (hasStreamingConversation) {
        showNotice({
          kind: "error",
          text: "Une conversation est en cours de réponse. Arrêtez-la avant de changer d'arbre de travail.",
          sticky: true,
        });
        return;
      }
      try {
        await onSwitchWorkspace(wt.path);
      } catch (err) {
        showNotice({
          kind: "error",
          sticky: true,
          text: `Bascule bloquée : ${stringifyError(err)}`,
        });
      }
    },
    [hasStreamingConversation, onSwitchWorkspace, showNotice],
  );

  const requestRemoveWorktree = useCallback(
    (wt: GitWorktree) => {
      if (wt.isCurrent) {
        showNotice({
          kind: "error",
          text: "Impossible de retirer l'arbre de travail où vous êtes. Changez d'abord d'arbre.",
        });
        return;
      }
      setRemoveTarget({ wt });
    },
    [showNotice],
  );

  const handleConfirmRemoveWorktree = useCallback(() => {
    const target = removeTarget;
    if (!target) return;
    const wt = target.wt;
    const force = wt.dirty;
    void runAction(
      `remove-wt:${wt.path}`,
      () => api.gitRemoveWorktree(workspacePath, wt.path, force),
      (result) => {
        setRemoveTarget(null);
        return { kind: "success", text: result.message };
      },
    );
  }, [removeTarget, runAction, workspacePath]);

  const handleCreateBranch = useCallback(() => {
    const name = newBranchName.trim();
    if (!name) {
      showNotice({ kind: "error", text: "Saisissez un nom de branche." });
      return;
    }
    const base = newBranchBase.trim() || null;
    void runAction(
      "create-branch",
      () => api.gitCreateBranch(workspacePath, name, base),
      (result) => {
        setNewBranchName("");
        setCreateBranchOpen(false);
        return { kind: "success", text: result.message };
      },
    );
  }, [newBranchBase, newBranchName, runAction, showNotice, workspacePath]);

  // -- Local branch: delete --------------------------------------------

  const requestDeleteBranch = useCallback((branch: GitBranch) => {
    setDeleteBranchTarget({
      branch,
      force: false,
      // Default to NOT deleting the upstream — destructive and shared.
      // We only surface the toggle when an upstream actually exists.
      deleteUpstream: false,
      lastError: null,
    });
  }, []);

  // Inline lifecycle (instead of `runAction`) so we can inspect the
  // error: a "not fully merged" failure flips the modal into a force
  // retry rather than dumping a sticky notice and closing.
  const handleConfirmDeleteBranch = useCallback(async () => {
    const target = deleteBranchTarget;
    if (!target || busyKey) return;
    const key = `delete-branch:${target.branch.name}`;
    setBusyKey(key);
    try {
      const result = await api.gitDeleteBranch(
        workspacePath,
        target.branch.name,
        target.force,
        target.deleteUpstream,
      );
      setDeleteBranchTarget(null);
      showNotice({ kind: "success", text: result.message });
    } catch (err) {
      const text = stringifyError(err);
      const unmerged = /not\s+(?:fully\s+)?merged/i.test(text);
      // Keep the modal open so the user has context for the retry /
      // upstream toggle. We deliberately don't pop the global sticky
      // notice here — the inline error inside the dialog is enough.
      setDeleteBranchTarget({
        ...target,
        force: target.force || unmerged,
        lastError: text,
      });
    } finally {
      setBusyKey(null);
      void refresh(false);
    }
  }, [busyKey, deleteBranchTarget, refresh, showNotice, workspacePath]);

  // -- Local branch: rename --------------------------------------------

  const requestRenameBranch = useCallback((branch: GitBranch) => {
    setRenameBranchTarget({
      branch,
      newName: branch.name,
      // Pre-check sync only when there is actually an upstream to push.
      syncRemote: Boolean(branch.upstream),
    });
  }, []);

  const handleConfirmRenameBranch = useCallback(() => {
    const target = renameBranchTarget;
    if (!target) return;
    const newName = target.newName.trim();
    if (!newName || newName === target.branch.name) return;
    void runAction(
      `rename-branch:${target.branch.name}`,
      () =>
        api.gitRenameBranch(
          workspacePath,
          target.branch.name,
          newName,
          target.syncRemote,
        ),
      (result) => {
        setRenameBranchTarget(null);
        return { kind: "success", text: result.message };
      },
    );
  }, [renameBranchTarget, runAction, workspacePath]);

  const handleCreatePr = useCallback(() => {
    const title = prTitle.trim();
    const target = prTarget.trim();
    if (!title) {
      showNotice({ kind: "error", text: "Saisissez un titre de PR." });
      return;
    }
    if (!target) {
      showNotice({ kind: "error", text: "Saisissez une branche cible." });
      return;
    }
    void runAction(
      "create-pr",
      () => api.gitCreatePullRequest(workspacePath, title, prBody.trim(), target),
      (result) => {
        setPrResult(result);
        setPrTitle("");
        setPrBody("");
        setPrOpen(false);
        return { kind: "success", text: result.message };
      },
    );
  }, [prBody, prTarget, prTitle, runAction, showNotice, workspacePath]);

  const handleOpenPrUrl = useCallback(() => {
    if (!prResult?.url) return;
    void api.openExternalUrl(prResult.url).catch((err) => {
      showNotice({
        kind: "error",
        sticky: true,
        text: `Impossible d'ouvrir ${prResult.url} : ${stringifyError(err)}`,
      });
    });
  }, [prResult, showNotice]);

  const handleDismissPrResult = useCallback(() => {
    setPrResult(null);
  }, []);

  const handleOpenGhInstall = useCallback(() => {
    void api.openExternalUrl("https://cli.github.com").catch((err) => {
      showNotice({
        kind: "error",
        sticky: true,
        text: stringifyError(err),
      });
    });
  }, [showNotice]);

  // ---- Derived data ----------------------------------------------------

  // Lookup: which worktree (if any) currently has each local branch
  // checked out. Detached worktrees (no `branch`) are skipped — they
  // can't conflict with a named branch by definition.
  const worktreeByBranch = useMemo<Map<string, GitWorktree>>(() => {
    const map = new Map<string, GitWorktree>();
    if (!snapshot) return map;
    for (const wt of snapshot.worktrees) {
      if (wt.branch) map.set(wt.branch, wt);
    }
    return map;
  }, [snapshot]);

  const localBranches = useMemo<GitBranch[]>(
    () => (snapshot ? snapshot.branches.filter((b) => b.kind === "local") : []),
    [snapshot],
  );

  const branchesForActiveTab = useMemo<GitBranch[]>(() => {
    if (!snapshot) return [];
    return snapshot.branches.filter((b) =>
      branchTab === "local" ? b.kind === "local" : b.kind === "remote",
    );
  }, [branchTab, snapshot]);

  // ---- Render ----------------------------------------------------------

  if (loading && !snapshot) {
    return (
      <div className="git-panel git-panel--state">
        <span className="git-panel__spinner" />
        <span className="git-panel__state-text">Lecture du dépôt…</span>
      </div>
    );
  }

  if (!snapshot) return null;

  if (!snapshot.gitAvailable) {
    return (
      <div className="git-panel git-panel--state">
        <Icon icon="solar:danger-triangle-linear" width={18} height={18} />
        <span className="git-panel__state-title">Git est indisponible</span>
        <span className="git-panel__state-text">
          SavIDE n'a trouvé aucun exécutable <code>git</code> utilisable dans le{" "}
          <code>PATH</code> ni dans les dossiers d'installation habituels. Installez Git,
          redémarrez SavIDE si besoin, et ce panneau reviendra.
        </span>
        {snapshot.error && (
          <span className="git-panel__state-error">{snapshot.error}</span>
        )}
      </div>
    );
  }

  if (!snapshot.isRepository) {
    return (
      <div className="git-panel git-panel--state">
        <GitMark size={18} />
        <span className="git-panel__state-title">Pas un dépôt Git</span>
        <span className="git-panel__state-text">
          Cet espace de travail n'est pas encore suivi. Initialisez un dépôt pour
          versionner votre travail.
        </span>
        <button
          type="button"
          className="git-panel__state-btn"
          onClick={handleInit}
          disabled={busyKey === "init"}
        >
          {busyKey === "init" ? (
            <span className="git-panel__spinner git-panel__spinner--inline" />
          ) : null}
          <span>
            {busyKey === "init" ? "Initialisation…" : "Initialiser le dépôt"}
          </span>
        </button>
        {snapshot.error && (
          <span className="git-panel__state-error">{snapshot.error}</span>
        )}
      </div>
    );
  }

  const totalChanges = snapshot.status.length;
  const allSelected = totalChanges > 0 && selected.size === totalChanges;
  const noneSelected = selected.size === 0;
  const anyBusy = busyKey !== null;
  const isCloud = cloudConnectionFromPath(workspacePath) !== null;
  const branchOptions =
    snapshot.currentBranch && !localBranches.some((b) => b.name === snapshot.currentBranch)
      ? [snapshot.currentBranch, ...localBranches.map((b) => b.name)]
      : localBranches.map((b) => b.name);

  return (
    <div className="git-panel">
      {/* Pinned status / actions. Mirrors the 32px `sidebar__head` rhythm
          used everywhere else, so it sits naturally below the
          Conversations/Git tab strip. */}
      <div className="git-panel__head">
        <span
          className="git-panel__head-branch"
          title={snapshot.currentBranch ?? "HEAD détachée"}
        >
          <span className="git-panel__head-branch-name">
            {snapshot.currentBranch ?? "(détachée)"}
          </span>
          {snapshot.dirtyCount > 0 && (
            <span
              className="git-panel__head-dirty"
              title={`${snapshot.dirtyCount} modification${
                snapshot.dirtyCount === 1 ? "" : "s"
              } non validée${snapshot.dirtyCount === 1 ? "" : "s"}`}
            >
              {snapshot.dirtyCount}
            </span>
          )}
        </span>
        <span className="git-panel__head-actions">
          {isCloud && branchOptions.length > 0 && (
            <select
              className="git-panel__head-select"
              value={snapshot.currentBranch ?? ""}
              onChange={(e) => handleCheckout(e.target.value)}
              disabled={anyBusy}
              title="Changer de branche"
              aria-label="Changer de branche"
            >
              {!snapshot.currentBranch && <option value="">(détachée)</option>}
              {branchOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="git-panel__head-action"
            onClick={handlePull}
            disabled={anyBusy}
            title="git pull"
          >
            {busyKey === "pull" ? (
              <span className="git-panel__spinner git-panel__spinner--inline" />
            ) : (
              <Icon
                icon="solar:square-alt-arrow-down-linear"
                width={13}
                height={13}
              />
            )}
            <span>Récupérer</span>
          </button>
          <button
            type="button"
            className="git-panel__head-action"
            onClick={handlePush}
            disabled={anyBusy}
            title="git push"
          >
            {busyKey === "push" ? (
              <span className="git-panel__spinner git-panel__spinner--inline" />
            ) : (
              <Icon
                icon="solar:square-alt-arrow-up-linear"
                width={13}
                height={13}
              />
            )}
            <span>Pousser</span>
          </button>
          <button
            type="button"
            className="git-panel__head-btn"
            onClick={() => void refresh(true)}
            disabled={anyBusy}
            title="Actualiser"
          >
            <Icon icon="solar:refresh-linear" width={14} height={14} />
          </button>
        </span>
      </div>

      {notice && (
        <div
          className="git-panel__notice"
          data-kind={notice.kind}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          <span className="git-panel__notice-text">{notice.text}</span>
          <button
            type="button"
            className="git-panel__notice-close"
            onClick={dismissNotice}
            title="Ignorer"
          >
            <Icon icon="solar:close-circle-linear" width={12} height={12} />
          </button>
        </div>
      )}

      <div className="git-panel__body">
        {/* CHANGES + COMMIT --------------------------------------------- */}
        <section className="git-panel__section">
          <div className="git-panel__section-head">
            <span className="git-panel__section-title">
              <span>Modifications</span>
              {totalChanges > 0 && (
                <span className="git-panel__count">{totalChanges}</span>
              )}
            </span>
            {totalChanges > 0 && (
              <button
                type="button"
                className="git-panel__section-link"
                onClick={toggleSelectAll}
              >
                {allSelected ? "Tout désélectionner" : "Tout sélectionner"}
              </button>
            )}
          </div>

          {totalChanges === 0 ? (
            <div className="git-panel__empty">
              Arbre de travail propre — rien à valider.
            </div>
          ) : (
            <div className="git-panel__rows">
              {snapshot.status.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  selected={selected.has(file.path)}
                  onToggle={() => toggleFile(file.path)}
                />
              ))}
            </div>
          )}

          <div className="git-panel__commit">
            <div className="git-panel__field">
              <input
                type="text"
                placeholder={
                  totalChanges === 0
                    ? "Rien à valider"
                    : noneSelected
                      ? "Sélectionnez les fichiers à valider"
                      : "Message de validation (commit)"
                }
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !noneSelected &&
                    commitMessage.trim()
                  ) {
                    e.preventDefault();
                    handleCommit();
                  }
                }}
                disabled={totalChanges === 0 || anyBusy}
              />
            </div>
            <button
              type="button"
              className="git-panel__action"
              onClick={handleCommit}
              disabled={anyBusy || noneSelected || !commitMessage.trim()}
              title={
                noneSelected
                  ? "Sélectionnez au moins un fichier"
                  : !commitMessage.trim()
                    ? "Écrivez un message de validation"
                    : `Valider ${selected.size} fichier${
                        selected.size === 1 ? "" : "s"
                      }`
              }
            >
              {busyKey === "commit" ? (
                <span className="git-panel__spinner git-panel__spinner--inline" />
              ) : null}
              <span>
                Valider{noneSelected ? "" : ` (${selected.size})`}
              </span>
            </button>
          </div>
        </section>

        {/* WORKTREES --------------------------------------------------- */}
        <section className="git-panel__section">
          <div className="git-panel__section-head">
            <span className="git-panel__section-title">
              <span>Arbres de travail</span>
              {snapshot.worktrees.length > 0 && (
                <span className="git-panel__count">
                  {snapshot.worktrees.length}
                </span>
              )}
            </span>
            <span className="git-panel__section-actions">
              <button
                type="button"
                className="git-panel__head-btn"
                onClick={() => setCreateWtOpen(true)}
                title="Nouvel arbre de travail"
              >
                <Icon
                  icon="solar:add-square-linear"
                  width={15}
                  height={15}
                />
              </button>
            </span>
          </div>

          {hasStreamingConversation && snapshot.worktrees.length > 1 && (
            <div className="git-panel__hint" role="note">
              <Icon icon="solar:info-circle-linear" width={12} height={12} />
              <span>
                Une conversation est en cours de réponse — le changement d'arbre attend
                qu'elle se termine.
              </span>
            </div>
          )}

          {snapshot.worktrees.length === 0 ? (
            <div className="git-panel__empty">
              Aucun arbre de travail enregistré.
            </div>
          ) : (
            <div className="git-panel__rows">
              {snapshot.worktrees.map((wt) => (
                <WorktreeRow
                  key={wt.path}
                  wt={wt}
                  busy={anyBusy}
                  switchBusy={busyKey === `switch-wt:${wt.path}`}
                  removeBusy={busyKey === `remove-wt:${wt.path}`}
                  blocked={hasStreamingConversation}
                  onSwitch={() => void handleSwitchWorktree(wt)}
                  onRemove={() => requestRemoveWorktree(wt)}
                />
              ))}
            </div>
          )}
        </section>

        {/* BRANCHES ---------------------------------------------------- */}
        <section className="git-panel__section">
          <div className="git-panel__section-head">
            <span className="git-panel__section-title">
              <span>Branches</span>
              {branchesForActiveTab.length > 0 && (
                <span className="git-panel__count">
                  {branchesForActiveTab.length}
                </span>
              )}
            </span>
            <span className="git-panel__section-actions">
              <button
                type="button"
                className="git-panel__head-btn"
                onClick={() => setCreateBranchOpen(true)}
                title="Nouvelle branche"
              >
                <Icon
                  icon="solar:add-square-linear"
                  width={15}
                  height={15}
                />
              </button>
            </span>
          </div>

          <div className="git-panel__sub-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className="git-panel__sub-tab"
              data-active={branchTab === "local" ? "true" : "false"}
              aria-selected={branchTab === "local"}
              onClick={() => setBranchTab("local")}
            >
              Locales
            </button>
            <button
              type="button"
              role="tab"
              className="git-panel__sub-tab"
              data-active={branchTab === "remote" ? "true" : "false"}
              aria-selected={branchTab === "remote"}
              onClick={() => setBranchTab("remote")}
            >
              Distantes
            </button>
          </div>

          {branchesForActiveTab.length === 0 ? (
            <div className="git-panel__empty">
              {branchTab === "local"
                ? "Aucune branche locale."
                : "Aucune branche distante."}
            </div>
          ) : (
            <div className="git-panel__rows">
              {branchesForActiveTab.map((b) => (
                <BranchRow
                  key={`${b.kind}:${b.name}`}
                  branch={b}
                  worktree={worktreeByBranch.get(b.name)}
                  busy={anyBusy}
                  deleteBusy={busyKey === `delete-branch:${b.name}`}
                  renameBusy={busyKey === `rename-branch:${b.name}`}
                  onDelete={() => requestDeleteBranch(b)}
                  onRename={() => requestRenameBranch(b)}
                />
              ))}
            </div>
          )}
        </section>

        {/* PULL REQUEST ----------------------------------------------- */}
        <section className="git-panel__section">
          <div className="git-panel__section-head">
            <span className="git-panel__section-title">
              <span>Pull Request</span>
            </span>
            <span className="git-panel__section-actions">
              <button
                type="button"
                className="git-panel__head-btn"
                disabled={!snapshot.ghAvailable}
                onClick={() => setPrOpen(true)}
                title={
                  snapshot.ghAvailable
                    ? "Rédiger une pull request"
                    : "Installez GitHub CLI (gh) pour créer des PR"
                }
              >
                <Icon
                  icon="solar:add-square-linear"
                  width={15}
                  height={15}
                />
              </button>
            </span>
          </div>

          {!snapshot.ghAvailable ? (
            <div className="git-panel__empty">
              SavIDE utilise l'outil officiel{" "}
              <button
                type="button"
                className="git-panel__link"
                onClick={handleOpenGhInstall}
              >
                GitHub CLI
              </button>{" "}
              pour ouvrir les PR. Installez <code>gh</code> puis rouvrez ce panneau pour
              activer le formulaire.
            </div>
          ) : prResult ? (
            <div className="git-panel__pr">
              <div className="git-panel__pr-head">
                <span className="git-panel__pr-label">
                  Pull request ouverte
                </span>
                <button
                  type="button"
                  className="git-panel__head-btn"
                  onClick={handleDismissPrResult}
                  title="Ignorer"
                >
                  <Icon icon="solar:close-circle-linear" width={13} height={13} />
                </button>
              </div>
              <div className="git-panel__pr-url" title={prResult.url}>
                {prResult.url}
              </div>
              <button
                type="button"
                className="git-panel__action git-panel__action--inline"
                onClick={handleOpenPrUrl}
              >
                <span>Ouvrir dans le navigateur</span>
              </button>
            </div>
          ) : (
            <div className="git-panel__empty">
              Rédigez une PR avec un titre, une description et une branche cible.
            </div>
          )}
        </section>
      </div>

      {/* Dialogs (portaled to document.body) ----------------------------- */}

      <GitDialog
        open={createWtOpen}
        onClose={() => setCreateWtOpen(false)}
        title="Nouvel arbre de travail"
        description="SavIDE crée un arbre de travail voisin et propose d'y basculer cette fenêtre."
        primaryLabel="Créer et basculer"
        primaryDisabled={!wtBranchName.trim()}
        primaryBusy={busyKey === "create-worktree"}
        onPrimary={() => void handleCreateWorktree()}
      >
        <DialogField label="Nom de la branche" htmlFor="git-panel-wt-branch">
          <input
            id="git-panel-wt-branch"
            type="text"
            className="git-panel__dialog-input"
            placeholder="feature/checkout-flow"
            value={wtBranchName}
            onChange={(e) => setWtBranchName(e.target.value)}
            autoFocus
          />
        </DialogField>
        <DialogField label="Branche de départ" htmlFor="git-panel-wt-base">
          <select
            id="git-panel-wt-base"
            className="git-panel__dialog-select"
            value={wtBaseBranch}
            onChange={(e) => setWtBaseBranch(e.target.value)}
          >
            {localBranches.length === 0 && (
              <option value="">(aucune branche locale)</option>
            )}
            {localBranches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </DialogField>
        <label className="git-panel__dialog-check">
          <input
            type="checkbox"
            checked={wtPushImmediately}
            onChange={(e) => setWtPushImmediately(e.target.checked)}
          />
          <span>Pousser tout de suite la nouvelle branche vers le dépôt distant</span>
        </label>
      </GitDialog>

      <GitDialog
        open={createBranchOpen}
        onClose={() => setCreateBranchOpen(false)}
        title="Nouvelle branche"
        description="Créer une branche dans cet arbre de travail sans basculer."
        primaryLabel="Créer la branche"
        primaryDisabled={!newBranchName.trim()}
        primaryBusy={busyKey === "create-branch"}
        onPrimary={handleCreateBranch}
      >
        <DialogField label="Nom de la branche" htmlFor="git-panel-branch-name">
          <input
            id="git-panel-branch-name"
            type="text"
            className="git-panel__dialog-input"
            placeholder="fix/login-redirect"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            autoFocus
          />
        </DialogField>
        <DialogField label="Branche de départ" htmlFor="git-panel-branch-base">
          <select
            id="git-panel-branch-base"
            className="git-panel__dialog-select"
            value={newBranchBase}
            onChange={(e) => setNewBranchBase(e.target.value)}
          >
            {localBranches.length === 0 && (
              <option value="">(aucune branche locale)</option>
            )}
            {localBranches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </DialogField>
      </GitDialog>

      <GitDialog
        open={prOpen}
        onClose={() => setPrOpen(false)}
        title="Ouvrir une pull request"
        description={
          snapshot.currentBranch
            ? `De ${snapshot.currentBranch} vers la branche cible.`
            : "Rédiger une pull request depuis cet arbre de travail."
        }
        primaryLabel="Ouvrir la PR"
        primaryDisabled={!prTitle.trim() || !prTarget.trim()}
        primaryBusy={busyKey === "create-pr"}
        onPrimary={handleCreatePr}
      >
        <DialogField label="Titre" htmlFor="git-panel-pr-title">
          <input
            id="git-panel-pr-title"
            type="text"
            className="git-panel__dialog-input"
            placeholder="Que change-t-elle ?"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            autoFocus
          />
        </DialogField>
        <DialogField label="Description" htmlFor="git-panel-pr-body">
          <textarea
            id="git-panel-pr-body"
            className="git-panel__dialog-textarea"
            placeholder="Détails, contexte et captures (facultatif)."
            rows={4}
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
          />
        </DialogField>
        <DialogField label="Branche cible" htmlFor="git-panel-pr-target">
          <input
            id="git-panel-pr-target"
            type="text"
            className="git-panel__dialog-input"
            placeholder="main"
            value={prTarget}
            onChange={(e) => setPrTarget(e.target.value)}
          />
        </DialogField>
      </GitDialog>

      <GitDialog
        open={removeTarget !== null}
        onClose={() => {
          if (busyKey?.startsWith("remove-wt:")) return;
          setRemoveTarget(null);
        }}
        title={
          removeTarget?.wt.dirty
            ? "Retirer l'arbre de travail et ses modifications non validées ?"
            : "Retirer l'arbre de travail ?"
        }
        description={removeTarget ? <RemoveDescription wt={removeTarget.wt} /> : null}
        primaryLabel={removeTarget?.wt.dirty ? "Retirer quand même" : "Retirer"}
        primaryDanger
        primaryBusy={Boolean(
          removeTarget && busyKey === `remove-wt:${removeTarget.wt.path}`,
        )}
        onPrimary={handleConfirmRemoveWorktree}
      />

      <GitDialog
        open={deleteBranchTarget !== null}
        onClose={() => {
          if (busyKey?.startsWith("delete-branch:")) return;
          setDeleteBranchTarget(null);
        }}
        title={
          deleteBranchTarget?.force
            ? "Forcer la suppression de la branche ?"
            : "Supprimer la branche ?"
        }
        description={
          deleteBranchTarget ? (
            <DeleteBranchDescription target={deleteBranchTarget} />
          ) : null
        }
        primaryLabel={
          deleteBranchTarget?.force ? "Forcer la suppression" : "Supprimer"
        }
        primaryDanger
        primaryBusy={Boolean(
          deleteBranchTarget &&
            busyKey === `delete-branch:${deleteBranchTarget.branch.name}`,
        )}
        onPrimary={() => void handleConfirmDeleteBranch()}
      >
        {deleteBranchTarget?.branch.upstream && (
          <label className="git-panel__dialog-check">
            <input
              type="checkbox"
              checked={deleteBranchTarget.deleteUpstream}
              onChange={(e) =>
                setDeleteBranchTarget((prev) =>
                  prev ? { ...prev, deleteUpstream: e.target.checked } : prev,
                )
              }
            />
            <span>
              Supprimer aussi la branche amont{" "}
              <code className="git-panel__dialog-code">
                {deleteBranchTarget.branch.upstream}
              </code>
            </span>
          </label>
        )}
        {deleteBranchTarget?.lastError && (
          <div className="git-panel__dialog-error" role="alert">
            {deleteBranchTarget.lastError}
          </div>
        )}
      </GitDialog>

      <GitDialog
        open={renameBranchTarget !== null}
        onClose={() => {
          if (busyKey?.startsWith("rename-branch:")) return;
          setRenameBranchTarget(null);
        }}
        title="Renommer la branche"
        description={
          renameBranchTarget ? (
            <span>
              Renommer{" "}
              <strong className="git-panel__dialog-strong">
                {renameBranchTarget.branch.name}
              </strong>
              . Les références locales changent d'un coup ; le dépôt distant se met à jour
              à part (pousser puis supprimer), ce que vous pouvez décocher ci-dessous.
            </span>
          ) : null
        }
        primaryLabel="Renommer"
        primaryDisabled={
          !renameBranchTarget ||
          !renameBranchTarget.newName.trim() ||
          renameBranchTarget.newName.trim() === renameBranchTarget.branch.name
        }
        primaryBusy={Boolean(
          renameBranchTarget &&
            busyKey === `rename-branch:${renameBranchTarget.branch.name}`,
        )}
        onPrimary={handleConfirmRenameBranch}
      >
        <DialogField label="Nouveau nom" htmlFor="git-panel-rename-branch">
          <input
            id="git-panel-rename-branch"
            type="text"
            className="git-panel__dialog-input"
            placeholder={renameBranchTarget?.branch.name ?? "nouveau-nom"}
            value={renameBranchTarget?.newName ?? ""}
            onChange={(e) =>
              setRenameBranchTarget((prev) =>
                prev ? { ...prev, newName: e.target.value } : prev,
              )
            }
            autoFocus
          />
        </DialogField>
        <label
          className="git-panel__dialog-check"
          data-disabled={
            renameBranchTarget && !renameBranchTarget.branch.upstream
              ? "true"
              : "false"
          }
        >
          <input
            type="checkbox"
            checked={renameBranchTarget?.syncRemote ?? false}
            disabled={!renameBranchTarget?.branch.upstream}
            onChange={(e) =>
              setRenameBranchTarget((prev) =>
                prev ? { ...prev, syncRemote: e.target.checked } : prev,
              )
            }
          />
          <span>
            {renameBranchTarget?.branch.upstream ? (
              <>
                Renommer aussi la branche amont{" "}
                <code className="git-panel__dialog-code">
                  {renameBranchTarget.branch.upstream}
                </code>
              </>
            ) : (
              <>Aucune branche amont suivie — pas de mise à jour du dépôt distant.</>
            )}
          </span>
        </label>
      </GitDialog>
    </div>
  );
}

// ----------------------------------------------------------------------
// Subcomponents
// ----------------------------------------------------------------------

function FileRow({
  file,
  selected,
  onToggle,
}: {
  file: GitStatusFile;
  selected: boolean;
  onToggle: () => void;
}) {
  const letter = statusLetter(file);
  return (
    <button
      type="button"
      className="git-panel__row git-panel__row--file"
      data-selected={selected ? "true" : "false"}
      onClick={onToggle}
      title={statusTooltip(file)}
      aria-pressed={selected}
    >
      <span
        className="git-panel__row-status"
        data-kind={normalizeKind(file.kind)}
      >
        {letter}
      </span>
      <span
        className="git-panel__row-path"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        {file.oldPath ? (
          <>
            <span className="git-panel__row-old">{file.oldPath}</span>
            <span className="git-panel__row-arrow"> → </span>
            {file.path}
          </>
        ) : (
          file.path
        )}
      </span>
    </button>
  );
}

function WorktreeRow({
  wt,
  busy,
  switchBusy,
  removeBusy,
  blocked,
  onSwitch,
  onRemove,
}: {
  wt: GitWorktree;
  busy: boolean;
  switchBusy: boolean;
  removeBusy: boolean;
  blocked: boolean;
  onSwitch: () => void;
  onRemove: () => void;
}) {
  const branchLabel = wt.branch ?? wt.head ?? "(détachée)";
  const switchDisabled = busy || (blocked && !wt.isCurrent);
  const switchTooltip = wt.isCurrent
    ? "Ouvert dans cette fenêtre"
    : blocked
      ? "Arrêtez la conversation en cours avant de basculer"
      : `Basculer cette fenêtre sur ${wt.path}`;
  return (
    <div
      className="git-panel__row git-panel__row--wt"
      data-current={wt.isCurrent ? "true" : "false"}
    >
      <span className="git-panel__row-mark">
        <GitMark size={13} />
      </span>
      <span className="git-panel__row-body">
        <span className="git-panel__row-title">
          <span className="git-panel__row-name">{wt.name}</span>
          {wt.dirty && (
            <span
              className="git-panel__row-dirty"
              title={`${wt.dirtyCount} modification${
                wt.dirtyCount === 1 ? "" : "s"
              } non validée${wt.dirtyCount === 1 ? "" : "s"}`}
            >
              {wt.dirtyCount}
            </span>
          )}
        </span>
        <span className="git-panel__row-sub" title={wt.path}>
          <span className="git-panel__row-branch">{branchLabel}</span>
          <span className="git-panel__row-sep" aria-hidden="true">
            ·
          </span>
          <span className="git-panel__row-path-sub">{wt.path}</span>
        </span>
      </span>
      <span className="git-panel__row-actions">
        {!wt.isCurrent && (
          <>
            <button
              type="button"
              className="git-panel__head-btn"
              onClick={onSwitch}
              disabled={switchDisabled}
              title={switchTooltip}
              aria-label={`Basculer sur ${wt.name}`}
            >
              {switchBusy ? (
                <span className="git-panel__spinner git-panel__spinner--inline" />
              ) : (
                <Icon
                  icon="solar:alt-arrow-right-linear"
                  width={13}
                  height={13}
                />
              )}
            </button>
            <button
              type="button"
              className="git-panel__head-btn git-panel__head-btn--danger"
              onClick={onRemove}
              disabled={busy}
              title="Retirer l'arbre de travail"
              aria-label={`Retirer l'arbre de travail ${wt.name}`}
            >
              {removeBusy ? (
                <span className="git-panel__spinner git-panel__spinner--inline" />
              ) : (
                <Icon
                  icon="solar:trash-bin-minimalistic-linear"
                  width={13}
                  height={13}
                />
              )}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

function BranchRow({
  branch,
  worktree,
  busy,
  deleteBusy,
  renameBusy,
  onDelete,
  onRename,
}: {
  branch: GitBranch;
  worktree: GitWorktree | undefined;
  busy: boolean;
  deleteBusy: boolean;
  renameBusy: boolean;
  onDelete: () => void;
  onRename: () => void;
}) {
  const isLocal = branch.kind === "local";
  // `branch.current` already flags the branch of the current worktree,
  // but we cross-check the worktree map so we can describe *which*
  // worktree blocks the action when it's a sibling worktree.
  const checkedOutHere = worktree?.isCurrent === true || branch.current;
  const checkedOutElsewhere = Boolean(worktree && !worktree.isCurrent);

  const deleteDisabled =
    busy || checkedOutHere || checkedOutElsewhere;
  const deleteTooltip = checkedOutHere
    ? "C'est la branche de l'arbre de travail actuel \u2014 basculez d'abord pour la supprimer."
    : checkedOutElsewhere
      ? `Extraite dans l'arbre de travail \u00ab\u00a0${worktree?.name}\u00a0\u00bb \u2014 retirez d'abord cet arbre.`
      : "Supprimer cette branche locale";

  // Renaming the branch you're standing on is supported by git (it
  // updates HEAD), so we only block when another worktree has it.
  const renameDisabled = busy || checkedOutElsewhere;
  const renameTooltip = checkedOutElsewhere
    ? `Extraite dans l'arbre de travail \u00ab\u00a0${worktree?.name}\u00a0\u00bb \u2014 renommez-la depuis cet arbre ou retirez-le d'abord.`
    : "Renommer cette branche";

  return (
    <div
      className="git-panel__row git-panel__row--branch"
      data-current={branch.current ? "true" : "false"}
    >
      <span className="git-panel__row-mark" aria-hidden="true" />
      <span className="git-panel__row-branch-name" title={branch.name}>
        {branch.name}
      </span>
      {branch.upstream && (
        <span
          className="git-panel__row-upstream"
          title={`suit ${branch.upstream}`}
        >
          {branch.upstream}
        </span>
      )}
      {isLocal && (
        <span className="git-panel__row-actions">
          <button
            type="button"
            className="git-panel__head-btn"
            onClick={onRename}
            disabled={renameDisabled}
            title={renameTooltip}
            aria-label={`Renommer la branche ${branch.name}`}
          >
            {renameBusy ? (
              <span className="git-panel__spinner git-panel__spinner--inline" />
            ) : (
              <Icon icon="solar:pen-linear" width={13} height={13} />
            )}
          </button>
          <button
            type="button"
            className="git-panel__head-btn git-panel__head-btn--danger"
            onClick={onDelete}
            disabled={deleteDisabled}
            title={deleteTooltip}
            aria-label={`Supprimer la branche ${branch.name}`}
          >
            {deleteBusy ? (
              <span className="git-panel__spinner git-panel__spinner--inline" />
            ) : (
              <Icon
                icon="solar:trash-bin-minimalistic-linear"
                width={13}
                height={13}
              />
            )}
          </button>
        </span>
      )}
    </div>
  );
}

function DeleteBranchDescription({
  target,
}: {
  target: DeleteBranchTarget;
}) {
  const { branch, force } = target;
  if (force) {
    return (
      <span>
        <strong className="git-panel__dialog-strong">{branch.name}</strong>{" "}
        contient des commits non fusionnés dans la branche actuelle. Forcer la
        suppression va{" "}
        <strong className="git-panel__dialog-strong">effacer ces commits</strong>
        {" "}de ce dépôt — sans retour possible.
      </span>
    );
  }
  return (
    <span>
      Supprimer la branche locale{" "}
      <strong className="git-panel__dialog-strong">{branch.name}</strong> ?
      {branch.upstream
        ? " La branche distante suivie reste en place, sauf si vous cochez ci-dessous."
        : " Aucune branche amont n'est suivie pour cette branche."}
    </span>
  );
}

function RemoveDescription({ wt }: { wt: GitWorktree }) {
  if (wt.dirty) {
    return (
      <span>
        <strong className="git-panel__dialog-strong">{wt.name}</strong> a{" "}
        {wt.dirtyCount} modification{wt.dirtyCount === 1 ? "" : "s"} non validée
        {wt.dirtyCount === 1 ? "" : "s"} dans{" "}
        <code className="git-panel__dialog-code">{wt.path}</code>. Le retirer
        va <strong className="git-panel__dialog-strong">effacer</strong> ces
        modifications locales — sans retour possible.
      </span>
    );
  }
  return (
    <span>
      Retirer l'arbre de travail{" "}
      <strong className="git-panel__dialog-strong">{wt.name}</strong> dans{" "}
      <code className="git-panel__dialog-code">{wt.path}</code> ? La branche
      elle-même reste intacte dans le dépôt.
    </span>
  );
}

function DialogField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="git-panel__dialog-field">
      <label className="git-panel__dialog-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ----------------------------------------------------------------------
// Dialog primitive
// ----------------------------------------------------------------------

function GitDialog({
  open,
  onClose,
  title,
  description,
  children,
  primaryLabel,
  primaryIcon,
  primaryDisabled = false,
  primaryBusy = false,
  primaryDanger = false,
  onPrimary,
  secondaryLabel = "Annuler",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  primaryLabel: string;
  primaryIcon?: string;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  primaryDanger?: boolean;
  onPrimary: () => void;
  secondaryLabel?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Focus the first interactive element inside the dialog whenever it
  // opens so the user can start typing or hit Enter immediately.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const root = panelRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>(
        "input, select, textarea, button",
      );
      target?.focus();
    }, 10);
    return () => window.clearTimeout(t);
  }, [open]);

  // Esc closes when not blocked; Enter on a non-textarea triggers primary.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!primaryBusy) onClose();
        return;
      }
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !primaryDisabled &&
        !primaryBusy
      ) {
        e.preventDefault();
        onPrimary();
      }
    },
    [onClose, onPrimary, primaryBusy, primaryDisabled],
  );

  if (!open) return null;

  return createPortal(
    <div
      className="git-panel__dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !primaryBusy) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="git-panel__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
      >
        <div className="git-panel__dialog-head">
          <h3 className="git-panel__dialog-title">{title}</h3>
          {description && (
            <p className="git-panel__dialog-desc">{description}</p>
          )}
        </div>
        {children && (
          <div className="git-panel__dialog-body">{children}</div>
        )}
        <div className="git-panel__dialog-foot">
          <button
            type="button"
            className="git-panel__dialog-btn"
            onClick={onClose}
            disabled={primaryBusy}
          >
            {secondaryLabel}
          </button>
          <button
            type="button"
            className="git-panel__dialog-btn git-panel__dialog-btn--primary"
            data-danger={primaryDanger ? "true" : "false"}
            onClick={onPrimary}
            disabled={primaryDisabled || primaryBusy}
          >
            {primaryBusy ? (
              <span className="git-panel__spinner git-panel__spinner--inline" />
            ) : primaryIcon ? (
              <Icon icon={primaryIcon} width={13} height={13} />
            ) : null}
            <span>{primaryLabel}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function normalizeKind(kind: string): string {
  switch (kind) {
    case "modified":
    case "added":
    case "deleted":
    case "untracked":
    case "renamed":
    case "conflicted":
      return kind;
    default:
      return "modified";
  }
}

function statusLetter(file: GitStatusFile): string {
  switch (file.kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "untracked":
      return "U";
    case "renamed":
      return "R";
    case "conflicted":
      return "!";
    default: {
      const indicator = (file.indexStatus + file.worktreeStatus)
        .trim()
        .slice(0, 1)
        .toUpperCase();
      return indicator || "?";
    }
  }
}

function statusTooltip(file: GitStatusFile): string {
  const index = file.indexStatus.trim() || "-";
  const tree = file.worktreeStatus.trim() || "-";
  return `index : ${index} · arbre de travail : ${tree}`;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// axe:cloud L2 — typed wrappers over the remote workspace commands (fs.* / git.*
// RPC of a cloud connection). All paths are relative to the service root.
import { invoke } from "@tauri-apps/api/core";
import type { FileDocument, WorkspaceEntry, WorkspaceSearchResult } from "../types";

export type RemoteWorkspaceInfo = { path: string; name: string };
export type RemoteGitStatus = { output: string; workspacePath: string; repoPath?: string };
export type RemoteGitRepo = { path: string; name: string; isRepo: boolean };
export type RemoteGitCommit = { message: string; output: string; workspacePath: string };

export const remoteWorkspaceApi = {
  info(connectionId: string) {
    return invoke<RemoteWorkspaceInfo>("remote_workspace_info", { input: { connectionId } });
  },
  listEntries(connectionId: string, relativePath?: string) {
    return invoke<WorkspaceEntry[]>("remote_workspace_entries", {
      input: { connectionId, relativePath: relativePath ?? null },
    });
  },
  readFile(connectionId: string, relativePath: string) {
    return invoke<FileDocument>("remote_workspace_read", { input: { connectionId, relativePath } });
  },
  writeFile(connectionId: string, relativePath: string, content: string) {
    return invoke<FileDocument>("remote_workspace_write", {
      input: { connectionId, relativePath, content },
    });
  },
  createFile(connectionId: string, targetRelativePath: string | null, name: string) {
    return invoke<WorkspaceEntry>("remote_workspace_create_file", {
      input: { connectionId, targetRelativePath, name },
    });
  },
  createDirectory(connectionId: string, targetRelativePath: string | null, name: string) {
    return invoke<WorkspaceEntry>("remote_workspace_create_directory", {
      input: { connectionId, targetRelativePath, name },
    });
  },
  rename(connectionId: string, relativePath: string, newName: string) {
    return invoke<WorkspaceEntry>("remote_workspace_rename", {
      input: { connectionId, relativePath, newName },
    });
  },
  delete(connectionId: string, relativePath: string) {
    return invoke<void>("remote_workspace_delete", { input: { connectionId, relativePath } });
  },
  search(connectionId: string, query: string) {
    return invoke<WorkspaceSearchResult>("remote_workspace_search", { input: { connectionId, query } });
  },
  gitStatus(connectionId: string, repo?: string) {
    return invoke<RemoteGitStatus>("remote_git_status", {
      input: { connectionId, repo: repo ?? null },
    });
  },
  gitCommit(connectionId: string, message: string, paths: string[], repo?: string) {
    return invoke<RemoteGitCommit>("remote_git_commit", {
      input: { connectionId, message, paths, repo: repo ?? null },
    });
  },
  /// Dépôts Git de l'espace de travail (racine + sous-dossiers), pour le sélecteur de l'onglet Git.
  gitRepos(connectionId: string) {
    return invoke<RemoteGitRepo[]>("remote_git_repos", { input: { connectionId } });
  },
};

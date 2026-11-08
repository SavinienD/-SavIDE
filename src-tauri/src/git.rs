use crate::*;
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::ffi::OsString;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Component;
use std::process::Stdio;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitRepositorySnapshot {
    pub(super) git_available: bool,
    pub(super) gh_available: bool,
    pub(super) is_repository: bool,
    pub(super) workspace_path: String,
    pub(super) repo_root: Option<String>,
    pub(super) current_branch: Option<String>,
    pub(super) main_branch: Option<String>,
    pub(super) dirty_count: usize,
    pub(super) status: Vec<GitStatusFile>,
    pub(super) worktrees: Vec<GitWorktree>,
    pub(super) branches: Vec<GitBranch>,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitStatusFile {
    pub(super) path: String,
    pub(super) old_path: Option<String>,
    pub(super) index_status: String,
    pub(super) worktree_status: String,
    pub(super) kind: String,
    pub(super) staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorktree {
    pub(super) name: String,
    pub(super) path: String,
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
    pub(super) is_current: bool,
    pub(super) dirty: bool,
    pub(super) dirty_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitBranch {
    pub(super) name: String,
    pub(super) kind: String,
    pub(super) current: bool,
    pub(super) upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitOperationResult {
    pub(super) message: String,
    pub(super) stdout: Option<String>,
    pub(super) stderr: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCreateWorktreeOutput {
    pub(super) worktree_path: String,
    pub(super) branch: String,
    pub(super) pushed: bool,
    pub(super) message: String,
    pub(super) warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitPullRequestOutput {
    pub(super) url: String,
    pub(super) message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCreateWorktreeInput {
    pub(super) workspace_path: String,
    pub(super) branch_name: String,
    pub(super) base_branch: Option<String>,
    pub(super) push_immediately: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitRemoveWorktreeInput {
    pub(super) workspace_path: String,
    pub(super) target_path: String,
    pub(super) force: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCreateBranchInput {
    pub(super) workspace_path: String,
    pub(super) branch_name: String,
    pub(super) base_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitDeleteBranchInput {
    pub(super) workspace_path: String,
    pub(super) branch_name: String,
    pub(super) force: bool,
    pub(super) delete_remote: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitRenameBranchInput {
    pub(super) workspace_path: String,
    pub(super) old_name: String,
    pub(super) new_name: String,
    pub(super) sync_remote: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCommitInput {
    pub(super) workspace_path: String,
    pub(super) message: String,
    pub(super) paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitCreatePullRequestInput {
    pub(super) workspace_path: String,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) target_branch: String,
}

pub(crate) struct GitCommandOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) success: bool,
}

struct ParsedWorktree {
    path: PathBuf,
    branch: Option<String>,
    head: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BranchUpstream {
    pub(crate) remote: String,
    pub(crate) branch: String,
}

#[tauri::command]
pub(super) async fn git_repository_snapshot_command(
    input: WorkspaceInput,
) -> std::result::Result<GitRepositorySnapshot, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    Ok(repository_snapshot(&workspace_root))
}

#[tauri::command]
pub(super) async fn git_init_command(
    app: AppHandle,
    input: WorkspaceInput,
) -> std::result::Result<GitRepositorySnapshot, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    ensure_git_available().map_err(error_to_string)?;
    git_checked(&workspace_root, &["init"]).map_err(error_to_string)?;
    emit_workspace_file_change(&app, &workspace_root, "");
    Ok(repository_snapshot(&workspace_root))
}

#[tauri::command]
pub(super) async fn git_create_worktree_command(
    input: GitCreateWorktreeInput,
) -> std::result::Result<GitCreateWorktreeOutput, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let branch =
        validate_branch_name_input(&repo_root, &input.branch_name).map_err(error_to_string)?;
    let base_branch = input
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| detect_main_branch(&repo_root).ok().flatten())
        .unwrap_or_else(|| "HEAD".to_string());
    validate_revision_exists(&repo_root, &base_branch).map_err(error_to_string)?;

    let worktree_path = next_worktree_path(&repo_root, &branch).map_err(error_to_string)?;
    let branch_exists = local_branch_exists(&repo_root, &branch).map_err(error_to_string)?;
    let remote_tracking = if branch_exists {
        None
    } else {
        remote_branch_for(&repo_root, &branch).map_err(error_to_string)?
    };

    let mut args = vec!["worktree".to_string(), "add".to_string()];
    if !branch_exists {
        args.push("-b".to_string());
        args.push(branch.clone());
    }
    args.push(worktree_path.display().to_string());
    if branch_exists {
        args.push(branch.clone());
    } else if let Some(remote) = remote_tracking {
        args.push(remote);
    } else {
        args.push(base_branch.clone());
    }
    git_checked_owned(&repo_root, &args).map_err(error_to_string)?;

    let mut pushed = false;
    let mut warning = None;
    if input.push_immediately {
        match git_checked(&worktree_path, &["push", "-u", "origin", &branch]) {
            Ok(_) => pushed = true,
            Err(err) => {
                warning = Some(format!(
                    "Arbre de travail créé, mais la branche n'a pas pu être poussée : {}",
                    err
                ))
            }
        }
    }

    Ok(GitCreateWorktreeOutput {
        worktree_path: worktree_path.display().to_string(),
        branch: branch.clone(),
        pushed,
        message: if pushed {
            format!("Arbre de travail créé pour {branch} et poussé vers origin.")
        } else {
            format!("Arbre de travail créé pour {branch}.")
        },
        warning,
    })
}

#[tauri::command]
pub(super) async fn git_remove_worktree_command(
    input: GitRemoveWorktreeInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let target = PathBuf::from(input.target_path.trim());
    if target.as_os_str().is_empty() {
        return Err("le chemin de l'arbre de travail ne peut pas être vide".into());
    }

    let worktrees = list_worktree_records(&repo_root).map_err(error_to_string)?;
    let current = canonical_or_original(&repo_root);
    let Some(record) = worktrees
        .into_iter()
        .find(|worktree| same_path(&worktree.path, &target))
    else {
        return Err("l'arbre de travail choisi n'appartient pas à ce dépôt".into());
    };
    if same_path(&record.path, &current) {
        return Err("impossible de retirer l'arbre de travail actuellement ouvert".into());
    }

    let dirty_files = status_files(&record.path).map_err(error_to_string)?;
    if !dirty_files.is_empty() && !input.force {
        let preview = dirty_files
            .iter()
            .take(8)
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "l'arbre de travail a {} fichier(s) non validé(s) : {}",
            dirty_files.len(),
            preview
        ));
    }

    let mut args = vec!["worktree".to_string(), "remove".to_string()];
    if input.force {
        args.push("--force".to_string());
    }
    args.push(record.path.display().to_string());
    let output = git_checked_owned(&repo_root, &args).map_err(error_to_string)?;
    Ok(operation_result("Arbre de travail retiré.", output))
}

#[tauri::command]
pub(super) async fn git_create_branch_command(
    input: GitCreateBranchInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let branch =
        validate_branch_name_input(&repo_root, &input.branch_name).map_err(error_to_string)?;
    if local_branch_exists(&repo_root, &branch).map_err(error_to_string)? {
        return Err(format!("la branche « {branch} » existe déjà"));
    }
    let base = input
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("HEAD")
        .to_string();
    validate_revision_exists(&repo_root, &base).map_err(error_to_string)?;
    let output = git_checked(&repo_root, &["branch", &branch, &base]).map_err(error_to_string)?;
    Ok(operation_result(
        format!("Branche {branch} créée."),
        output,
    ))
}

#[tauri::command]
pub(super) async fn git_delete_branch_command(
    input: GitDeleteBranchInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let branch =
        validate_branch_name_input(&repo_root, &input.branch_name).map_err(error_to_string)?;
    if !local_branch_exists(&repo_root, &branch).map_err(error_to_string)? {
        return Err(format!("branche « {branch} » introuvable"));
    }
    ensure_branch_not_checked_out(&repo_root, &branch).map_err(error_to_string)?;

    let upstream = branch_upstream(&repo_root, &branch).map_err(error_to_string)?;
    if input.delete_remote && upstream.is_none() {
        return Err(format!(
            "la branche « {branch} » n'a pas de branche amont distante à supprimer"
        ));
    }
    let output = delete_local_branch(&repo_root, &branch, input.force).map_err(error_to_string)?;
    let mut message = format!("Branche locale {branch} supprimée.");
    let mut stdout_parts = Vec::new();
    let mut stderr_parts = Vec::new();
    collect_command_output(output, &mut stdout_parts, &mut stderr_parts);

    if input.delete_remote {
        let upstream = upstream.expect("upstream is checked before deleting local branch");
        match delete_remote_branch(&repo_root, &upstream) {
            Ok(remote_output) => {
                message = format!(
                    "Branche locale {branch} et branche distante {}/{} supprimées.",
                    upstream.remote, upstream.branch
                );
                collect_command_output(remote_output, &mut stdout_parts, &mut stderr_parts);
            }
            Err(err) => {
                return Err(format!(
                    "La branche locale {branch} a été supprimée, mais pas la branche distante {}/{} : {}",
                    upstream.remote, upstream.branch, err
                ));
            }
        }
    }

    Ok(operation_result_from_parts(
        message,
        stdout_parts,
        stderr_parts,
    ))
}

#[tauri::command]
pub(super) async fn git_rename_branch_command(
    input: GitRenameBranchInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let old_name =
        validate_branch_name_input(&repo_root, &input.old_name).map_err(error_to_string)?;
    let new_name =
        validate_branch_name_input(&repo_root, &input.new_name).map_err(error_to_string)?;
    if old_name == new_name {
        return Err("le nouveau nom de branche doit être différent".into());
    }
    if !local_branch_exists(&repo_root, &old_name).map_err(error_to_string)? {
        return Err(format!("branche « {old_name} » introuvable"));
    }
    if local_branch_exists(&repo_root, &new_name).map_err(error_to_string)? {
        return Err(format!("la branche « {new_name} » existe déjà"));
    }
    ensure_branch_rename_allowed(&repo_root, &old_name).map_err(error_to_string)?;
    let upstream = branch_upstream(&repo_root, &old_name).map_err(error_to_string)?;

    let rename_output =
        rename_local_branch(&repo_root, &old_name, &new_name).map_err(error_to_string)?;
    let mut message = format!("Branche {old_name} renommée en {new_name}.");
    let mut stdout_parts = Vec::new();
    let mut stderr_parts = Vec::new();
    collect_command_output(rename_output, &mut stdout_parts, &mut stderr_parts);

    if input.sync_remote {
        let remote = upstream
            .as_ref()
            .map(|upstream| upstream.remote.clone())
            .unwrap_or_else(|| "origin".to_string());
        match push_branch_to_remote(&repo_root, &remote, &new_name) {
            Ok(push_output) => {
                collect_command_output(push_output, &mut stdout_parts, &mut stderr_parts)
            }
            Err(err) => {
                return Err(format!(
                    "La branche locale a été renommée en {new_name}, mais l'envoi de {new_name} vers {remote} a échoué : {err}"
                ));
            }
        }
        if let Some(upstream) = upstream {
            match delete_remote_branch(&repo_root, &upstream) {
                Ok(delete_output) => {
                    message = format!(
                        "Branche {old_name} renommée en {new_name}, {remote}/{new_name} poussée et {}/{} supprimée.",
                        upstream.remote, upstream.branch
                    );
                    collect_command_output(delete_output, &mut stdout_parts, &mut stderr_parts);
                }
                Err(err) => {
                    return Err(format!(
                        "La branche locale a été renommée en {new_name} et poussée vers {remote}, mais l'ancienne branche distante {}/{} n'a pas pu être supprimée : {}",
                        upstream.remote, upstream.branch, err
                    ));
                }
            }
        } else {
            message =
                format!("Branche {old_name} renommée en {new_name} et {remote}/{new_name} poussée.");
        }
    }

    Ok(operation_result_from_parts(
        message,
        stdout_parts,
        stderr_parts,
    ))
}

#[tauri::command]
pub(super) async fn git_commit_command(
    input: GitCommitInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let message = input.message.trim();
    if message.is_empty() {
        return Err("le message de validation (commit) ne peut pas être vide".into());
    }
    let paths = validate_git_paths(&input.paths).map_err(error_to_string)?;
    if paths.is_empty() {
        return Err("sélectionnez au moins un fichier à valider".into());
    }

    let mut add_args = vec!["add".to_string(), "--".to_string()];
    add_args.extend(paths.iter().cloned());
    git_checked_owned(&repo_root, &add_args).map_err(error_to_string)?;

    let mut commit_args = vec![
        "commit".to_string(),
        "-m".to_string(),
        message.to_string(),
        "--".to_string(),
    ];
    commit_args.extend(paths.iter().cloned());
    let output = git_checked_owned(&repo_root, &commit_args).map_err(error_to_string)?;
    Ok(operation_result("Validation (commit) créée.", output))
}

#[tauri::command]
pub(super) async fn git_push_command(
    input: WorkspaceInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let output = git_checked(&repo_root, &["push"]).map_err(error_to_string)?;
    Ok(operation_result("Poussé vers le dépôt distant.", output))
}

#[tauri::command]
pub(super) async fn git_pull_command(
    app: AppHandle,
    input: WorkspaceInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let output = git_checked(&repo_root, &["pull", "--no-edit"]).map_err(error_to_string)?;
    emit_workspace_file_change(&app, &repo_root, "");
    Ok(operation_result("Récupéré depuis le dépôt distant.", output))
}

#[tauri::command]
pub(super) async fn git_create_pull_request_command(
    input: GitCreatePullRequestInput,
) -> std::result::Result<GitPullRequestOutput, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let gh = ensure_gh_available().map_err(error_to_string)?;

    let title = input.title.trim();
    if title.is_empty() {
        return Err("le titre de la pull request ne peut pas être vide".into());
    }
    let target = input.target_branch.trim();
    if target.is_empty() {
        return Err("la branche cible ne peut pas être vide".into());
    }
    let head = current_branch(&repo_root)
        .map_err(error_to_string)?
        .ok_or_else(|| "impossible de créer une pull request depuis une HEAD détachée".to_string())?;

    let args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--title".to_string(),
        title.to_string(),
        "--body".to_string(),
        input.body,
        "--base".to_string(),
        target.to_string(),
        "--head".to_string(),
        head,
    ];
    let output =
        run_checked_with_program(&gh, "gh", Some(&repo_root), &args).map_err(error_to_string)?;
    let combined = join_output(&output.stdout, &output.stderr);
    let url = extract_url(&combined)
        .ok_or_else(|| "GitHub CLI n'a pas renvoyé l'adresse de la pull request".to_string())?;
    Ok(GitPullRequestOutput {
        url: url.clone(),
        message: format!("Pull request créée : {url}"),
    })
}

// ---------------------------------------------------------------------------
// État de la branche (avance / retard, opération en cours), fetch, modifier le
// dernier commit, poussée forcée sûre (--force-with-lease), abandon d'une
// fusion ou d'un rebase, commit refusé par un hook.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitEtat {
    pub(super) branche: Option<String>,
    /// Branche amont suivie (« origin/main »), si elle existe.
    pub(super) amont: Option<String>,
    /// Commits locaux absents de l'amont (à pousser).
    pub(super) avance: u32,
    /// Commits de l'amont absents d'ici (à récupérer).
    pub(super) retard: u32,
    /// « fusion », « rebase », « am », « cherry-pick » ou « revert ».
    pub(super) operation: Option<String>,
    pub(super) dernier_commit: Option<GitDernierCommit>,
    pub(super) remote_par_defaut: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitDernierCommit {
    pub(super) hash: String,
    pub(super) message: String,
    /// Le commit est déjà sur une branche distante : le modifier oblige à forcer la poussée.
    pub(super) pousse: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitValiderInput {
    pub(super) workspace_path: String,
    pub(super) message: String,
    #[serde(default)]
    pub(super) paths: Vec<String>,
    #[serde(default)]
    pub(super) modifier_dernier: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitValiderResultat {
    pub(super) ok: bool,
    pub(super) message: String,
    pub(super) sortie: Option<String>,
    /// Hooks présents quand le commit est refusé (« pre-commit », « commit-msg »…).
    pub(super) crochet: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitPousserInput {
    pub(super) workspace_path: String,
    #[serde(default)]
    pub(super) forcer: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitPousserResultat {
    pub(super) ok: bool,
    /// Refus du distant (non fast-forward) : la poussée forcée sûre peut être proposée.
    pub(super) rejete: bool,
    pub(super) message: String,
    pub(super) sortie: Option<String>,
}

#[tauri::command]
pub(super) async fn git_etat_command(
    input: WorkspaceInput,
) -> std::result::Result<GitEtat, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    etat_depot(&repo_root).map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn git_fetch_command(
    input: WorkspaceInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    fetch_depot(&repo_root).map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn git_valider_command(
    input: GitValiderInput,
) -> std::result::Result<GitValiderResultat, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    valider(&repo_root, &input.message, &input.paths, input.modifier_dernier)
        .map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn git_pousser_command(
    input: GitPousserInput,
) -> std::result::Result<GitPousserResultat, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    pousser(&repo_root, input.forcer).map_err(error_to_string)
}

#[tauri::command]
pub(super) async fn git_abandonner_command(
    app: AppHandle,
    input: WorkspaceInput,
) -> std::result::Result<GitOperationResult, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo_root = require_repo_root(&workspace_root).map_err(error_to_string)?;
    let resultat = abandonner_operation(&repo_root).map_err(error_to_string)?;
    emit_workspace_file_change(&app, &repo_root, "");
    Ok(resultat)
}

pub(crate) fn etat_depot(repo_root: &Path) -> Result<GitEtat> {
    let branche = current_branch(repo_root)?;
    let remote_par_defaut = remote_par_defaut(repo_root)?;
    let amont = amont_courant(repo_root)?;
    let (avance, retard) = if amont.is_some() {
        avance_retard(repo_root)?
    } else if remote_par_defaut.is_some() && tete_valide(repo_root)? {
        // Branche jamais poussée : les commits absents de toutes les branches distantes.
        (compter(repo_root, &["rev-list", "--count", "HEAD", "--not", "--remotes"])?, 0)
    } else {
        (0, 0)
    };
    Ok(GitEtat {
        branche,
        amont,
        avance,
        retard,
        operation: operation_en_cours(repo_root)?,
        dernier_commit: dernier_commit(repo_root)?,
        remote_par_defaut,
    })
}

fn tete_valide(repo_root: &Path) -> Result<bool> {
    Ok(git_output(repo_root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.success)
}

fn compter(repo_root: &Path, args: &[&str]) -> Result<u32> {
    let out = git_output(repo_root, args)?;
    if !out.success {
        return Ok(0);
    }
    Ok(out.stdout.trim().parse().unwrap_or(0))
}

fn amont_courant(repo_root: &Path) -> Result<Option<String>> {
    let out = git_output(
        repo_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )?;
    let nom = out.stdout.trim();
    Ok((out.success && !nom.is_empty()).then(|| nom.to_string()))
}

fn avance_retard(repo_root: &Path) -> Result<(u32, u32)> {
    let out = git_output(
        repo_root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )?;
    if !out.success {
        return Ok((0, 0));
    }
    let mut cols = out.stdout.split_whitespace().map(|v| v.parse::<u32>().unwrap_or(0));
    Ok((cols.next().unwrap_or(0), cols.next().unwrap_or(0)))
}

pub(crate) fn remote_par_defaut(repo_root: &Path) -> Result<Option<String>> {
    let out = git_output(repo_root, &["remote"])?;
    if !out.success {
        return Ok(None);
    }
    let remotes: Vec<&str> = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if remotes.contains(&"origin") {
        return Ok(Some("origin".into()));
    }
    Ok(remotes.first().map(|r| r.to_string()))
}

fn git_dir(repo_root: &Path) -> Result<Option<PathBuf>> {
    let out = git_output(repo_root, &["rev-parse", "--absolute-git-dir"])?;
    let brut = out.stdout.trim();
    Ok((out.success && !brut.is_empty()).then(|| PathBuf::from(brut)))
}

pub(crate) fn operation_en_cours(repo_root: &Path) -> Result<Option<String>> {
    let Some(dir) = git_dir(repo_root)? else {
        return Ok(None);
    };
    let operation = if dir.join("rebase-apply").join("applying").exists() {
        Some("am")
    } else if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        Some("rebase")
    } else if dir.join("MERGE_HEAD").exists() {
        Some("fusion")
    } else if dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick")
    } else if dir.join("REVERT_HEAD").exists() {
        Some("revert")
    } else {
        None
    };
    Ok(operation.map(ToOwned::to_owned))
}

fn dernier_commit(repo_root: &Path) -> Result<Option<GitDernierCommit>> {
    let out = git_output(repo_root, &["log", "-1", "--format=%h%x00%B"])?;
    if !out.success {
        return Ok(None);
    }
    let Some((hash, message)) = out.stdout.split_once('\0') else {
        return Ok(None);
    };
    let hash = hash.trim();
    if hash.is_empty() {
        return Ok(None);
    }
    let contient = git_output(
        repo_root,
        &["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"],
    )?;
    let pousse = contient.success
        && contient
            .stdout
            .lines()
            .map(str::trim)
            .any(|l| !l.is_empty() && !l.ends_with("/HEAD"));
    Ok(Some(GitDernierCommit {
        hash: hash.to_string(),
        message: message.trim_end().to_string(),
        pousse,
    }))
}

/// Variables des commandes qui parlent au dépôt distant : pas d'invite dans un
/// terminal (aucun n'est attaché) et messages anglais stables (refus reconnu).
const ENV_RESEAU: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("LC_ALL", "C"),
    ("LANG", "C"),
    ("LANGUAGE", "C"),
];

pub(crate) fn fetch_depot(repo_root: &Path) -> Result<GitOperationResult> {
    let args = ["fetch", "--all", "--prune"].map(String::from);
    let out = run_git_env(repo_root, &args, ENV_RESEAU)?;
    if !out.success {
        anyhow::bail!(format_command_error("git", &args, &out));
    }
    let (avance, retard) = if amont_courant(repo_root)?.is_some() {
        avance_retard(repo_root)?
    } else {
        (0, 0)
    };
    let message = match (avance, retard) {
        (0, 0) => "Branches distantes à jour.".to_string(),
        (a, 0) => format!("Branches distantes à jour : {a} commit(s) à pousser."),
        (0, r) => format!("Branches distantes à jour : {r} commit(s) à récupérer."),
        (a, r) => format!("Branches distantes à jour : {a} à pousser, {r} à récupérer."),
    };
    Ok(operation_result(message, out))
}

/// Erreurs de git qui ne viennent pas d'un hook (le commit n'a pas commencé).
fn erreur_hors_hook(sortie: &str) -> bool {
    let bas = sortie.to_ascii_lowercase();
    [
        "nothing to commit",
        "no changes added to commit",
        "did not match any file",
        "please tell me who you are",
        "unable to auto-detect email",
        "cannot do a partial commit during a merge",
        "you have nothing to amend",
        "empty commit message",
        "index.lock",
    ]
    .iter()
    .any(|motif| bas.contains(motif))
}

/// Hooks de commit installés (core.hooksPath compris), sans les « .sample ».
pub(crate) fn hooks_de_commit(repo_root: &Path) -> Result<Vec<String>> {
    let configure = git_output(repo_root, &["config", "--get", "core.hooksPath"])?;
    let dossier = if configure.success && !configure.stdout.trim().is_empty() {
        let brut = PathBuf::from(configure.stdout.trim());
        if brut.is_absolute() {
            brut
        } else {
            repo_root.join(brut)
        }
    } else {
        match git_dir(repo_root)? {
            Some(dir) => {
                // Un worktree lié partage les hooks du dépôt principal.
                let commun = git_output(repo_root, &["rev-parse", "--git-common-dir"])?;
                let commun = commun.stdout.trim();
                if commun.is_empty() {
                    dir.join("hooks")
                } else {
                    let chemin = PathBuf::from(commun);
                    if chemin.is_absolute() {
                        chemin.join("hooks")
                    } else {
                        repo_root.join(chemin).join("hooks")
                    }
                }
            }
            None => return Ok(Vec::new()),
        }
    };
    Ok(["pre-commit", "prepare-commit-msg", "commit-msg"]
        .iter()
        .filter(|nom| dossier.join(nom).is_file())
        .map(|nom| nom.to_string())
        .collect())
}

pub(crate) fn valider(
    repo_root: &Path,
    message: &str,
    paths: &[String],
    modifier_dernier: bool,
) -> Result<GitValiderResultat> {
    let message = message.trim();
    if message.is_empty() {
        anyhow::bail!("le message de validation (commit) ne peut pas être vide");
    }
    let paths = validate_git_paths(paths)?;
    if paths.is_empty() && !modifier_dernier {
        anyhow::bail!("sélectionnez au moins un fichier à valider");
    }
    if modifier_dernier && !tete_valide(repo_root)? {
        anyhow::bail!("aucun commit à modifier : le dépôt est vide");
    }
    if !paths.is_empty() {
        let mut add_args = vec!["add".to_string(), "--".to_string()];
        add_args.extend(paths.iter().cloned());
        git_checked_owned(repo_root, &add_args)?;
    }
    // Fusion, cherry-pick ou revert en cours : le commit prend tout l'index (git refuse
    // un commit partiel pendant une fusion), les fichiers choisis viennent d'y être ajoutés.
    let commit_complet = !modifier_dernier
        && matches!(
            operation_en_cours(repo_root)?.as_deref(),
            Some("fusion" | "cherry-pick" | "revert")
        );
    let mut args = vec!["commit".to_string()];
    if modifier_dernier {
        args.push("--amend".into());
        if paths.is_empty() {
            // Seulement le message : ce qui est indexé ne part pas dans le commit.
            args.push("--only".into());
        }
    }
    args.push("-m".into());
    args.push(message.to_string());
    if !paths.is_empty() && !commit_complet {
        args.push("--".into());
        args.extend(paths.iter().cloned());
    }
    let out = run_output("git", Some(repo_root), &args)?;
    let sortie = optional_output(join_output(&out.stdout, &out.stderr));
    if out.success {
        return Ok(GitValiderResultat {
            ok: true,
            message: if modifier_dernier {
                "Dernier commit modifié.".into()
            } else {
                "Validation (commit) créée.".into()
            },
            sortie,
            crochet: None,
        });
    }
    let texte = sortie.clone().unwrap_or_default();
    let hooks = hooks_de_commit(repo_root)?;
    let crochet = (!hooks.is_empty() && !erreur_hors_hook(&texte)).then(|| hooks.join(", "));
    Ok(GitValiderResultat {
        ok: false,
        message: match &crochet {
            Some(nom) => format!("Commit refusé par le hook {nom}."),
            None => "Le commit a échoué.".into(),
        },
        sortie,
        crochet,
    })
}

fn sortie_rejet(sortie: &str) -> bool {
    let bas = sortie.to_ascii_lowercase();
    bas.contains("[rejected]")
        || bas.contains("non-fast-forward")
        || bas.contains("fetch first")
        || bas.contains("stale info")
        || bas.contains("updates were rejected")
}

pub(crate) fn pousser(repo_root: &Path, forcer: bool) -> Result<GitPousserResultat> {
    let branche = current_branch(repo_root)?
        .ok_or_else(|| anyhow::anyhow!("impossible de pousser une HEAD détachée"))?;
    let amont = branch_upstream(repo_root, &branche)?;
    let mut args = vec!["push".to_string()];
    let (cible, force) = match &amont {
        Some(up) => {
            if forcer {
                args.push("--force-with-lease".into());
            }
            args.push(up.remote.clone());
            args.push(format!("{branche}:{}", up.branch));
            (format!("{}/{}", up.remote, up.branch), forcer)
        }
        None => {
            // Première poussée : la branche amont est créée (rien à forcer).
            let remote = remote_par_defaut(repo_root)?.ok_or_else(|| {
                anyhow::anyhow!("aucun dépôt distant configuré : ajoutez-en un (git remote add origin <adresse>)")
            })?;
            args.push("-u".into());
            args.push(remote.clone());
            args.push(branche.clone());
            (format!("{remote}/{branche}"), false)
        }
    };
    let out = run_git_env(repo_root, &args, ENV_RESEAU)?;
    let sortie = optional_output(join_output(&out.stderr, &out.stdout));
    if out.success {
        return Ok(GitPousserResultat {
            ok: true,
            rejete: false,
            message: if force {
                format!("Poussé en forçant vers {cible} (--force-with-lease).")
            } else {
                format!("Poussé vers {cible}.")
            },
            sortie,
        });
    }
    let texte = sortie.clone().unwrap_or_default();
    let rejete = sortie_rejet(&texte);
    Ok(GitPousserResultat {
        ok: false,
        rejete,
        message: if rejete && force {
            format!("{cible} a changé depuis votre dernier fetch : la poussée forcée est refusée. Faites un fetch et vérifiez avant de forcer.")
        } else if rejete {
            format!("{cible} contient des commits que vous n'avez pas : récupérez-les, ou forcez si vous avez réécrit l'historique.")
        } else {
            format!("La poussée vers {cible} a échoué.")
        },
        sortie,
    })
}

pub(crate) fn abandonner_operation(repo_root: &Path) -> Result<GitOperationResult> {
    let operation = operation_en_cours(repo_root)?
        .ok_or_else(|| anyhow::anyhow!("aucune fusion ni aucun rebase en cours"))?;
    let (commande, message) = match operation.as_str() {
        "rebase" => ("rebase", "Rebase abandonné."),
        "am" => ("am", "Application de patchs abandonnée."),
        "fusion" => ("merge", "Fusion abandonnée."),
        "cherry-pick" => ("cherry-pick", "Cherry-pick abandonné."),
        "revert" => ("revert", "Revert abandonné."),
        autre => anyhow::bail!("opération inconnue : {autre}"),
    };
    let out = git_checked(repo_root, &[commande, "--abort"])?;
    Ok(operation_result(message, out))
}

fn run_git_env(repo: &Path, args: &[String], env: &[(&str, &str)]) -> Result<GitCommandOutput> {
    let path = resolve_executable("git")
        .ok_or_else(|| anyhow::anyhow!("exécutable « git » introuvable"))?;
    let mut command = Command::new(path);
    hide_windows_console(&mut command);
    command.arg("-C").arg(repo);
    for arg in args {
        command.arg(OsStr::new(arg));
    }
    for (cle, valeur) in env {
        command.env(cle, valeur);
    }
    command.stdin(Stdio::null());
    let output = command.output().context("impossible de lancer git")?;
    Ok(GitCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

fn repository_snapshot(workspace_root: &Path) -> GitRepositorySnapshot {
    let workspace_path = workspace_root.display().to_string();
    let git_available = command_available("git");
    let gh_available = command_available("gh");
    if !git_available {
        return GitRepositorySnapshot {
            git_available,
            gh_available,
            is_repository: false,
            workspace_path,
            repo_root: None,
            current_branch: None,
            main_branch: None,
            dirty_count: 0,
            status: Vec::new(),
            worktrees: Vec::new(),
            branches: Vec::new(),
            error: Some(
                "Git n'est pas installé ou reste introuvable dans le PATH et les dossiers d'installation habituels."
                    .into(),
            ),
        };
    }

    let repo_root = match repo_root(workspace_root) {
        Ok(root) => root,
        Err(err) => {
            let message = err.to_string();
            return GitRepositorySnapshot {
                git_available,
                gh_available,
                is_repository: false,
                workspace_path,
                repo_root: None,
                current_branch: None,
                main_branch: None,
                dirty_count: 0,
                status: Vec::new(),
                worktrees: Vec::new(),
                branches: Vec::new(),
                error: if is_not_git_repository_error(&message) {
                    None
                } else {
                    Some(message)
                },
            };
        }
    };

    match repository_snapshot_for_repo(workspace_root, &repo_root, git_available, gh_available) {
        Ok(snapshot) => snapshot,
        Err(err) => GitRepositorySnapshot {
            git_available,
            gh_available,
            is_repository: true,
            workspace_path,
            repo_root: Some(repo_root.display().to_string()),
            current_branch: None,
            main_branch: None,
            dirty_count: 0,
            status: Vec::new(),
            worktrees: Vec::new(),
            branches: Vec::new(),
            error: Some(err.to_string()),
        },
    }
}

fn repository_snapshot_for_repo(
    workspace_root: &Path,
    repo_root: &Path,
    git_available: bool,
    gh_available: bool,
) -> Result<GitRepositorySnapshot> {
    let status = status_files(repo_root)?;
    let dirty_count = status.len();
    let current_branch = current_branch(repo_root)?;
    let branches = list_branches(repo_root, current_branch.as_deref())?;
    let main_branch =
        detect_main_branch_from_branches(repo_root, &branches, current_branch.as_deref())?;
    let worktrees = list_worktrees(repo_root, workspace_root)?;

    Ok(GitRepositorySnapshot {
        git_available,
        gh_available,
        is_repository: true,
        workspace_path: workspace_root.display().to_string(),
        repo_root: Some(repo_root.display().to_string()),
        current_branch,
        main_branch,
        dirty_count,
        status,
        worktrees,
        branches,
        error: None,
    })
}

fn ensure_git_available() -> Result<PathBuf> {
    resolve_executable("git").ok_or_else(|| {
        anyhow::anyhow!(
            "Git n'est pas installé ou reste introuvable. Installez Git puis redémarrez SavIDE."
        )
    })
}

fn ensure_gh_available() -> Result<PathBuf> {
    resolve_executable("gh").ok_or_else(|| {
        anyhow::anyhow!(
            "GitHub CLI (`gh`) n'est pas installé ou reste introuvable. Installez-le depuis https://cli.github.com/ pour créer des pull requests."
        )
    })
}

fn command_available(program: &str) -> bool {
    resolve_executable(program).is_some()
}

pub(crate) fn resolve_executable(program: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(program);
    if direct.components().count() > 1 {
        if let Some(candidate) = find_working_executable(&direct) {
            return Some(candidate);
        }
    }

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if let Some(candidate) = find_working_executable(&dir.join(program)) {
                return Some(candidate);
            }
        }
    }

    for dir in fallback_executable_dirs(program) {
        if let Some(candidate) = find_working_executable(&dir.join(program)) {
            return Some(candidate);
        }
    }

    None
}

fn find_working_executable(base: &Path) -> Option<PathBuf> {
    executable_candidates(base)
        .into_iter()
        .find(|candidate| executable_works(candidate))
}

#[cfg(target_os = "windows")]
fn executable_candidates(base: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![base.to_path_buf()];
    if base.extension().is_some() {
        return candidates;
    }

    let Some(file_name) = base.file_name() else {
        return candidates;
    };

    for extension in windows_executable_extensions() {
        let mut name = OsString::from(file_name);
        name.push(OsStr::new(&extension));
        candidates.push(base.with_file_name(name));
    }
    candidates
}

#[cfg(not(target_os = "windows"))]
fn executable_candidates(base: &Path) -> Vec<PathBuf> {
    vec![base.to_path_buf()]
}

#[cfg(target_os = "windows")]
fn windows_executable_extensions() -> Vec<String> {
    let mut extensions = Vec::new();
    for extension in [".exe", ".cmd", ".bat", ".com"] {
        push_unique_extension(&mut extensions, extension);
    }
    if let Some(path_ext) = std::env::var_os("PATHEXT") {
        for extension in path_ext.to_string_lossy().split(';') {
            push_unique_extension(&mut extensions, extension);
        }
    }
    extensions
}

#[cfg(target_os = "windows")]
fn push_unique_extension(extensions: &mut Vec<String>, raw: &str) {
    let extension = raw.trim().trim_matches('"');
    if extension.is_empty() {
        return;
    }
    let extension = if extension.starts_with('.') {
        extension.to_string()
    } else {
        format!(".{extension}")
    };
    if !extensions
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&extension))
    {
        extensions.push(extension);
    }
}

fn fallback_executable_dirs(_program: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if _program.eq_ignore_ascii_case("git") {
            append_windows_git_dirs(&mut dirs);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
        if let Some(home) = home_dir() {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join("bin"));
        }
    }

    dirs
}

#[cfg(target_os = "windows")]
fn append_windows_git_dirs(dirs: &mut Vec<PathBuf>) {
    let mut roots = vec![
        PathBuf::from(r"C:\Program Files\Git"),
        PathBuf::from(r"C:\Program Files (x86)\Git"),
    ];
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("Git"));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86).join("Git"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data).join("Programs").join("Git"));
    }

    for root in roots {
        dirs.push(root.join("cmd"));
        dirs.push(root.join("bin"));
    }
}

fn executable_works(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let mut command = Command::new(path);
    hide_windows_console(&mut command);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn repo_root(path: &Path) -> Result<PathBuf> {
    let output = git_checked(path, &["rev-parse", "--show-toplevel"])?;
    let raw = output.stdout.trim();
    if raw.is_empty() {
        anyhow::bail!("racine du dépôt Git introuvable");
    }
    let path = PathBuf::from(raw);
    Ok(canonical_or_original(&path))
}

pub(crate) fn require_repo_root(path: &Path) -> Result<PathBuf> {
    ensure_git_available()?;
    repo_root(path)
}

pub(crate) fn current_branch(repo_root: &Path) -> Result<Option<String>> {
    let output = git_output(repo_root, &["branch", "--show-current"])?;
    if !output.success {
        return Ok(None);
    }
    let branch = output.stdout.trim();
    if branch.is_empty() {
        Ok(None)
    } else {
        Ok(Some(branch.to_string()))
    }
}

pub(crate) fn detect_main_branch(repo_root: &Path) -> Result<Option<String>> {
    let branches = list_branches(repo_root, None)?;
    let current = current_branch(repo_root)?;
    detect_main_branch_from_branches(repo_root, &branches, current.as_deref())
}

fn detect_main_branch_from_branches(
    repo_root: &Path,
    branches: &[GitBranch],
    current_branch: Option<&str>,
) -> Result<Option<String>> {
    let origin_head = git_output(
        repo_root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )?;
    if origin_head.success {
        let trimmed = origin_head.stdout.trim();
        if let Some((_, name)) = trimmed.split_once('/') {
            if !name.trim().is_empty() {
                return Ok(Some(name.trim().to_string()));
            }
        }
    }

    for candidate in ["main", "master", "trunk"] {
        if branches
            .iter()
            .any(|branch| branch.kind == "local" && branch.name == candidate)
        {
            return Ok(Some(candidate.to_string()));
        }
    }

    if let Some(current) = current_branch {
        if !current.trim().is_empty() {
            return Ok(Some(current.to_string()));
        }
    }

    Ok(branches
        .iter()
        .find(|branch| branch.kind == "local")
        .map(|branch| branch.name.clone()))
}

pub(crate) fn status_files(repo_root: &Path) -> Result<Vec<GitStatusFile>> {
    let output = git_checked(
        repo_root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    Ok(parse_status(&output.stdout))
}

fn parse_status(raw: &str) -> Vec<GitStatusFile> {
    let mut files = Vec::new();
    let mut parts = raw.split('\0').filter(|part| !part.is_empty()).peekable();
    while let Some(entry) = parts.next() {
        let bytes = entry.as_bytes();
        if bytes.len() < 4 {
            continue;
        }
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        let path = entry[3..].to_string();
        let old_path = if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
            parts.next().map(ToOwned::to_owned)
        } else {
            None
        };
        files.push(GitStatusFile {
            path,
            old_path,
            index_status: status_char(index),
            worktree_status: status_char(worktree),
            kind: status_kind(index, worktree),
            staged: index != ' ' && index != '?',
        });
    }
    files
}

fn status_char(value: char) -> String {
    if value == ' ' {
        " ".to_string()
    } else {
        value.to_string()
    }
}

fn status_kind(index: char, worktree: char) -> String {
    if index == '?' && worktree == '?' {
        return "untracked".into();
    }
    if matches!(index, 'U' | 'A' | 'D') && matches!(worktree, 'U' | 'A' | 'D') {
        if index == 'U' || worktree == 'U' || index != worktree {
            return "conflicted".into();
        }
    }
    if matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C') {
        return "renamed".into();
    }
    if index == 'A' || worktree == 'A' {
        return "added".into();
    }
    if index == 'D' || worktree == 'D' {
        return "deleted".into();
    }
    "modified".into()
}

fn list_worktrees(repository_root: &Path, workspace_root: &Path) -> Result<Vec<GitWorktree>> {
    let records = list_worktree_records(repository_root)?;
    let current_repo = repo_root(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
    let mut worktrees = Vec::new();
    for record in records {
        let statuses = status_files(&record.path).unwrap_or_default();
        let dirty_count = statuses.len();
        let name = record
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| record.path.display().to_string());
        worktrees.push(GitWorktree {
            name,
            path: record.path.display().to_string(),
            branch: record.branch,
            head: record.head,
            is_current: same_path(&record.path, &current_repo),
            dirty: dirty_count > 0,
            dirty_count,
        });
    }
    Ok(worktrees)
}

fn list_worktree_records(repo_root: &Path) -> Result<Vec<ParsedWorktree>> {
    let output = git_checked(repo_root, &["worktree", "list", "--porcelain"])?;
    let mut records = Vec::new();
    let mut current_path: Option<PathBuf> = None;
    let mut branch: Option<String> = None;
    let mut head: Option<String> = None;

    for line in output.stdout.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            if let Some(path) = current_path.take() {
                records.push(ParsedWorktree { path, branch, head });
            }
            branch = None;
            head = None;
            continue;
        }
        if let Some(value) = line.strip_prefix("worktree ") {
            if let Some(path) = current_path.take() {
                records.push(ParsedWorktree { path, branch, head });
                branch = None;
                head = None;
            }
            current_path = Some(canonical_or_original(Path::new(value.trim())));
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(strip_branch_ref(value.trim()).to_string());
        }
    }
    if let Some(path) = current_path.take() {
        records.push(ParsedWorktree { path, branch, head });
    }
    Ok(records)
}

fn strip_branch_ref(value: &str) -> &str {
    value
        .strip_prefix("refs/heads/")
        .or_else(|| value.strip_prefix("refs/remotes/"))
        .unwrap_or(value)
}

fn list_branches(repo_root: &Path, current_branch: Option<&str>) -> Result<Vec<GitBranch>> {
    let output = git_checked(
        repo_root,
        &[
            "branch",
            "--all",
            "--format=%(refname:short)%09%(refname)%09%(upstream:short)%09%(HEAD)",
        ],
    )?;
    let mut branches = Vec::new();
    for line in output.stdout.lines() {
        let mut cols = line.split('\t');
        let Some(short) = cols.next().map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        if short.contains("HEAD ->") || short.ends_with("/HEAD") {
            continue;
        }
        let refname = cols.next().unwrap_or("").trim();
        if refname.ends_with("/HEAD") {
            continue;
        }
        let upstream = cols
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let head = cols.next().unwrap_or("").trim() == "*";
        let kind = if refname.starts_with("refs/remotes/") {
            "remote"
        } else {
            "local"
        };
        branches.push(GitBranch {
            name: short.to_string(),
            kind: kind.to_string(),
            current: head || current_branch == Some(short),
            upstream,
        });
    }
    branches.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    Ok(branches)
}

fn validate_branch_name_input(repo_root: &Path, branch_name: &str) -> Result<String> {
    let branch = branch_name.trim();
    if branch.is_empty() {
        anyhow::bail!("le nom de branche ne peut pas être vide");
    }
    let output = git_output(repo_root, &["check-ref-format", "--branch", branch])?;
    if !output.success {
        anyhow::bail!("nom de branche invalide : « {branch} »");
    }
    Ok(branch.to_string())
}

fn validate_revision_exists(repo_root: &Path, revision: &str) -> Result<()> {
    if revision == "HEAD" {
        let output = git_output(repo_root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
        if output.success {
            return Ok(());
        }
        anyhow::bail!("le dépôt n'a encore aucun commit : créez d'abord une validation initiale");
    }
    let spec = format!("{revision}^{{commit}}");
    let output = git_output(repo_root, &["rev-parse", "--verify", &spec])?;
    if output.success {
        Ok(())
    } else {
        anyhow::bail!("branche ou révision de départ « {revision} » introuvable")
    }
}

fn local_branch_exists(repo_root: &Path, branch: &str) -> Result<bool> {
    let refname = format!("refs/heads/{branch}");
    Ok(git_output(repo_root, &["show-ref", "--verify", "--quiet", &refname])?.success)
}

pub(crate) fn branch_upstream(repo_root: &Path, branch: &str) -> Result<Option<BranchUpstream>> {
    let remote_key = format!("branch.{branch}.remote");
    let merge_key = format!("branch.{branch}.merge");
    let remote = git_output(repo_root, &["config", "--get", &remote_key])?;
    if !remote.success {
        return Ok(None);
    }
    let remote = remote.stdout.trim();
    if remote.is_empty() || remote == "." {
        return Ok(None);
    }
    let merge = git_output(repo_root, &["config", "--get", &merge_key])?;
    if !merge.success {
        return Ok(None);
    }
    let branch_name = merge.stdout.trim();
    let Some(branch_name) = branch_name.strip_prefix("refs/heads/") else {
        return Ok(None);
    };
    if branch_name.is_empty() {
        return Ok(None);
    }
    Ok(Some(BranchUpstream {
        remote: remote.to_string(),
        branch: branch_name.to_string(),
    }))
}

fn ensure_branch_not_checked_out(repo_root: &Path, branch: &str) -> Result<()> {
    if let Some(worktree) = worktree_using_branch(repo_root, branch)? {
        anyhow::bail!(
            "la branche « {branch} » est extraite dans l'arbre de travail {}",
            worktree.display()
        );
    }
    Ok(())
}

fn ensure_branch_rename_allowed(repo_root: &Path, branch: &str) -> Result<()> {
    if let Some(worktree) = worktree_using_branch(repo_root, branch)? {
        let current = canonical_or_original(repo_root);
        if !same_path(&worktree, &current) {
            anyhow::bail!(
                "la branche « {branch} » est extraite dans l'arbre de travail {}",
                worktree.display()
            );
        }
    }
    Ok(())
}

fn worktree_using_branch(repo_root: &Path, branch: &str) -> Result<Option<PathBuf>> {
    Ok(list_worktree_records(repo_root)?
        .into_iter()
        .find(|record| record.branch.as_deref() == Some(branch))
        .map(|record| record.path))
}

fn delete_local_branch(repo_root: &Path, branch: &str, force: bool) -> Result<GitCommandOutput> {
    let mode = if force { "-D" } else { "-d" };
    git_checked(repo_root, &["branch", mode, "--", branch])
}

fn rename_local_branch(
    repo_root: &Path,
    old_name: &str,
    new_name: &str,
) -> Result<GitCommandOutput> {
    git_checked(repo_root, &["branch", "-m", "--", old_name, new_name])
}

fn push_branch_to_remote(repo_root: &Path, remote: &str, branch: &str) -> Result<GitCommandOutput> {
    git_checked(repo_root, &["push", "-u", remote, branch])
}

fn delete_remote_branch(repo_root: &Path, upstream: &BranchUpstream) -> Result<GitCommandOutput> {
    git_checked(
        repo_root,
        &["push", &upstream.remote, "--delete", &upstream.branch],
    )
}

fn remote_branch_for(repo_root: &Path, branch: &str) -> Result<Option<String>> {
    let explicit_remote_ref = format!("refs/remotes/{branch}");
    if git_output(
        repo_root,
        &["show-ref", "--verify", "--quiet", &explicit_remote_ref],
    )?
    .success
    {
        return Ok(Some(branch.to_string()));
    }

    let origin_ref = format!("refs/remotes/origin/{branch}");
    if git_output(repo_root, &["show-ref", "--verify", "--quiet", &origin_ref])?.success {
        return Ok(Some(format!("origin/{branch}")));
    }
    Ok(None)
}

fn next_worktree_path(repo_root: &Path, branch: &str) -> Result<PathBuf> {
    let records = list_worktree_records(repo_root)?;
    let main_path = records
        .first()
        .map(|record| record.path.clone())
        .unwrap_or_else(|| repo_root.to_path_buf());
    let parent = main_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("le dépôt n'a pas de dossier parent"))?;
    let repo_name = main_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    let slug = slugify_branch(branch);
    let base_name = format!("{repo_name}-{slug}");
    for suffix in 0..1000 {
        let candidate = if suffix == 0 {
            parent.join(&base_name)
        } else {
            parent.join(format!("{base_name}-{suffix}"))
        };
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    anyhow::bail!("aucun nom de dossier libre pour l'arbre de travail")
}

fn slugify_branch(branch: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in branch.chars() {
        let valid = ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-');
        if valid {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "branch".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn validate_git_paths(paths: &[String]) -> Result<Vec<String>> {
    let mut clean = Vec::new();
    for raw in paths {
        let path = raw.trim();
        if path.is_empty() {
            continue;
        }
        let path_obj = Path::new(path);
        if path_obj.is_absolute()
            || path_obj.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            anyhow::bail!("chemin Git invalide : « {path} »");
        }
        if !clean.iter().any(|existing| existing == path) {
            clean.push(path.to_string());
        }
    }
    Ok(clean)
}

fn operation_result(message: impl Into<String>, output: GitCommandOutput) -> GitOperationResult {
    GitOperationResult {
        message: message.into(),
        stdout: optional_output(output.stdout),
        stderr: optional_output(output.stderr),
    }
}

fn operation_result_from_parts(
    message: impl Into<String>,
    stdout_parts: Vec<String>,
    stderr_parts: Vec<String>,
) -> GitOperationResult {
    GitOperationResult {
        message: message.into(),
        stdout: optional_output(stdout_parts.join("\n")),
        stderr: optional_output(stderr_parts.join("\n")),
    }
}

fn collect_command_output(
    output: GitCommandOutput,
    stdout_parts: &mut Vec<String>,
    stderr_parts: &mut Vec<String>,
) {
    if let Some(stdout) = optional_output(output.stdout) {
        stdout_parts.push(stdout);
    }
    if let Some(stderr) = optional_output(output.stderr) {
        stderr_parts.push(stderr);
    }
}

fn optional_output(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn git_checked(repo: &Path, args: &[&str]) -> Result<GitCommandOutput> {
    let owned = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    git_checked_owned(repo, &owned)
}

fn git_checked_owned(repo: &Path, args: &[String]) -> Result<GitCommandOutput> {
    run_checked("git", Some(repo), args)
}

pub(crate) fn git_output(repo: &Path, args: &[&str]) -> Result<GitCommandOutput> {
    let owned = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    run_output("git", Some(repo), &owned)
}

fn run_checked(program: &str, cwd: Option<&Path>, args: &[String]) -> Result<GitCommandOutput> {
    let path = resolve_executable(program)
        .ok_or_else(|| anyhow::anyhow!("exécutable « {program} » introuvable"))?;
    run_checked_with_program(&path, program, cwd, args)
}

fn run_checked_with_program(
    program_path: &Path,
    program_label: &str,
    cwd: Option<&Path>,
    args: &[String],
) -> Result<GitCommandOutput> {
    let output = run_output_with_program(program_path, program_label, cwd, args)?;
    if output.success {
        Ok(output)
    } else {
        anyhow::bail!(format_command_error(program_label, args, &output))
    }
}

fn run_output(program: &str, cwd: Option<&Path>, args: &[String]) -> Result<GitCommandOutput> {
    let path = resolve_executable(program)
        .ok_or_else(|| anyhow::anyhow!("exécutable « {program} » introuvable"))?;
    run_output_with_program(&path, program, cwd, args)
}

fn run_output_with_program(
    program_path: &Path,
    program_label: &str,
    cwd: Option<&Path>,
    args: &[String],
) -> Result<GitCommandOutput> {
    let mut command = Command::new(program_path);
    hide_windows_console(&mut command);
    if let Some(cwd) = cwd {
        if program_label == "git" {
            command.arg("-C").arg(cwd);
        } else {
            command.current_dir(cwd);
        }
    }
    for arg in args {
        command.arg(OsStr::new(arg));
    }
    command.stdin(Stdio::null());
    let output = command
        .output()
        .with_context(|| format!("impossible de lancer {program_label}"))?;
    Ok(GitCommandOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

#[cfg(target_os = "windows")]
fn hide_windows_console(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_windows_console(_command: &mut Command) {}

fn format_command_error(program: &str, args: &[String], output: &GitCommandOutput) -> String {
    let detail = join_output(&output.stderr, &output.stdout);
    let detail = detail.trim();
    let rendered_args = args.join(" ");
    if detail.is_empty() {
        format!("échec de {program} {rendered_args}")
    } else {
        format!("échec de {program} {rendered_args} : {detail}")
    }
}

fn join_output(primary: &str, secondary: &str) -> String {
    let primary = primary.trim();
    let secondary = secondary.trim();
    match (primary.is_empty(), secondary.is_empty()) {
        (true, true) => String::new(),
        (false, true) => primary.to_string(),
        (true, false) => secondary.to_string(),
        (false, false) => format!("{primary}\n{secondary}"),
    }
}

fn extract_url(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .find(|part| part.starts_with("https://") || part.starts_with("http://"))
        .map(|part| {
            part.trim_matches(|ch: char| matches!(ch, ')' | ']' | ',' | '.'))
                .to_string()
        })
}

fn is_not_git_repository_error(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("not a git repository") || lowered.contains("not a git repo")
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(left: &Path, right: &Path) -> bool {
    canonical_or_original(left) == canonical_or_original(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn executable_candidates_keep_unix_name_unchanged() {
        assert_eq!(
            executable_candidates(Path::new("git")),
            vec![PathBuf::from("git")]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn executable_candidates_add_windows_extensions() {
        let candidates = executable_candidates(Path::new("git"));

        assert!(candidates.contains(&PathBuf::from("git.exe")));
        assert!(candidates.contains(&PathBuf::from("git.cmd")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn fallback_dirs_include_git_for_windows_locations() {
        let dirs = fallback_executable_dirs("git");

        assert!(dirs.contains(&PathBuf::from(r"C:\Program Files\Git\cmd")));
        assert!(dirs.contains(&PathBuf::from(r"C:\Program Files\Git\bin")));
    }

    #[test]
    fn branch_upstream_reads_remote_and_merge_config() {
        let repo = init_test_repo("upstream");
        run_test_git(&repo, &["branch", "feature"]);
        run_test_git(&repo, &["config", "branch.feature.remote", "origin"]);
        run_test_git(
            &repo,
            &["config", "branch.feature.merge", "refs/heads/feature"],
        );

        let upstream = branch_upstream(&repo, "feature")
            .expect("read upstream")
            .expect("upstream exists");

        assert_eq!(upstream.remote, "origin");
        assert_eq!(upstream.branch, "feature");
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn deleting_checked_out_branch_is_rejected() {
        let repo = init_test_repo("delete-checked-out");
        let err = ensure_branch_not_checked_out(&repo, "main").unwrap_err();

        assert!(err.to_string().contains("extraite dans l'arbre de travail"));
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn rename_allows_current_worktree_branch() {
        let repo = init_test_repo("rename-current");

        ensure_branch_rename_allowed(&repo, "main").expect("current branch may be renamed locally");
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn delete_local_branch_uses_force_flag() {
        let repo = init_test_repo("delete-force");
        run_test_git(&repo, &["branch", "feature"]);

        delete_local_branch(&repo, "feature", true).expect("force delete branch");

        assert!(!local_branch_exists(&repo, "feature").expect("check deleted branch"));
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn rename_local_branch_changes_ref() {
        let repo = init_test_repo("rename-local");
        run_test_git(&repo, &["branch", "old"]);

        rename_local_branch(&repo, "old", "new").expect("rename branch");

        assert!(!local_branch_exists(&repo, "old").expect("old branch missing"));
        assert!(local_branch_exists(&repo, "new").expect("new branch exists"));
        fs::remove_dir_all(repo).ok();
    }

    // ---- État, fetch, amend, poussée forcée sûre, abandon, hooks ----

    fn depot_avec_distant(nom: &str) -> (PathBuf, PathBuf) {
        if !command_available("git") {
            panic!("git is required for git.rs tests");
        }
        let base = unique_temp_dir(nom);
        fs::create_dir_all(&base).expect("create test dir");
        let distant = base.join("distant.git");
        run_test_git(&base, &["init", "--bare", distant.to_str().unwrap()]);
        run_test_git(&distant, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let local = cloner(&base, "local");
        fs::write(local.join("README.md"), "test\n").expect("write test file");
        run_test_git(&local, &["add", "README.md"]);
        run_test_git(&local, &["commit", "-m", "initial"]);
        run_test_git(&local, &["push", "-u", "origin", "main"]);
        (canonical_or_original(&base), local)
    }

    fn cloner(base: &Path, nom: &str) -> PathBuf {
        let distant = base.join("distant.git");
        let dossier = base.join(nom);
        run_test_git(base, &["clone", distant.to_str().unwrap(), dossier.to_str().unwrap()]);
        run_test_git(&dossier, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        run_test_git(&dossier, &["config", "user.email", "test@example.com"]);
        run_test_git(&dossier, &["config", "user.name", "Test"]);
        canonical_or_original(&dossier)
    }

    fn commit_fichier(repo: &Path, fichier: &str, contenu: &str, message: &str) {
        fs::write(repo.join(fichier), contenu).expect("write file");
        run_test_git(repo, &["add", fichier]);
        run_test_git(repo, &["commit", "-m", message]);
    }

    fn message_tete(repo: &Path) -> String {
        git_checked(repo, &["log", "-1", "--format=%s"]).expect("log").stdout.trim().to_string()
    }

    #[test]
    fn etat_compte_l_avance_et_le_retard_apres_fetch() {
        let (base, local) = depot_avec_distant("etat");
        commit_fichier(&local, "a.txt", "a\n", "local");
        let etat = etat_depot(&local).expect("etat");
        assert_eq!(etat.amont.as_deref(), Some("origin/main"));
        assert_eq!((etat.avance, etat.retard), (1, 0));
        assert!(!etat.dernier_commit.as_ref().expect("dernier commit").pousse);
        assert_eq!(etat.operation, None);

        let autre = cloner(&base, "autre");
        commit_fichier(&autre, "b.txt", "b\n", "distant");
        run_test_git(&autre, &["push", "origin", "main"]);

        let fetch = fetch_depot(&local).expect("fetch");
        assert!(fetch.message.contains("1 à pousser, 1 à récupérer"), "{}", fetch.message);
        let etat = etat_depot(&local).expect("etat");
        assert_eq!((etat.avance, etat.retard), (1, 1));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn branche_jamais_poussee_compte_ses_commits_et_pousse_avec_amont() {
        let (base, local) = depot_avec_distant("premiere-poussee");
        run_test_git(&local, &["checkout", "-b", "fonction"]);
        commit_fichier(&local, "f.txt", "f\n", "fonction");
        let etat = etat_depot(&local).expect("etat");
        assert_eq!(etat.amont, None);
        assert_eq!(etat.avance, 1);
        let poussee = pousser(&local, false).expect("pousser");
        assert!(poussee.ok, "{:?}", poussee.sortie);
        assert_eq!(etat_depot(&local).expect("etat").amont.as_deref(), Some("origin/fonction"));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn modifier_le_dernier_commit_puis_pousser_en_forcant() {
        let (base, local) = depot_avec_distant("amend");
        commit_fichier(&local, "a.txt", "a\n", "premier jet");
        assert!(pousser(&local, false).expect("pousser").ok);
        assert!(etat_depot(&local).expect("etat").dernier_commit.expect("commit").pousse);

        let r = valider(&local, "premier jet corrigé", &[], true).expect("amend");
        assert!(r.ok, "{:?}", r.sortie);
        assert_eq!(message_tete(&local), "premier jet corrigé");
        let etat = etat_depot(&local).expect("etat");
        assert_eq!((etat.avance, etat.retard), (1, 1));

        let refus = pousser(&local, false).expect("pousser");
        assert!(!refus.ok && refus.rejete, "{:?}", refus.sortie);
        let force = pousser(&local, true).expect("pousser en forçant");
        assert!(force.ok, "{:?}", force.sortie);
        assert!(force.message.contains("--force-with-lease"));
        let distant = base.join("distant.git");
        assert_eq!(message_tete(&distant), "premier jet corrigé");
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn force_with_lease_refuse_si_le_distant_a_change_sans_fetch() {
        let (base, local) = depot_avec_distant("lease");
        commit_fichier(&local, "a.txt", "a\n", "a");
        assert!(pousser(&local, false).expect("pousser").ok);
        let autre = cloner(&base, "autre");
        commit_fichier(&autre, "b.txt", "b\n", "travail d'un collègue");
        run_test_git(&autre, &["push", "origin", "main"]);

        assert!(valider(&local, "a réécrit", &[], true).expect("amend").ok);
        let r = pousser(&local, true).expect("pousser en forçant");
        assert!(!r.ok && r.rejete, "{:?}", r.sortie);
        let distant = base.join("distant.git");
        assert_eq!(message_tete(&distant), "travail d'un collègue");
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn modifier_le_dernier_commit_avec_des_fichiers() {
        let repo = init_test_repo("amend-fichiers");
        fs::write(repo.join("README.md"), "test modifié\n").expect("write");
        let r = valider(&repo, "initial complété", &["README.md".to_string()], true).expect("amend");
        assert!(r.ok, "{:?}", r.sortie);
        let compte = git_checked(&repo, &["rev-list", "--count", "HEAD"]).expect("count");
        assert_eq!(compte.stdout.trim(), "1");
        assert!(status_files(&repo).expect("status").is_empty());
        fs::remove_dir_all(repo).ok();
    }

    fn conflit(repo: &Path) {
        run_test_git(repo, &["checkout", "-b", "autre"]);
        commit_fichier(repo, "README.md", "version autre\n", "autre");
        run_test_git(repo, &["checkout", "main"]);
        commit_fichier(repo, "README.md", "version main\n", "main");
        let fusion = git_output(repo, &["merge", "autre"]).expect("merge");
        assert!(!fusion.success, "la fusion doit être en conflit");
    }

    #[test]
    fn abandonner_une_fusion_en_conflit() {
        let repo = init_test_repo("abandon-fusion");
        conflit(&repo);
        assert_eq!(operation_en_cours(&repo).expect("operation").as_deref(), Some("fusion"));
        let r = abandonner_operation(&repo).expect("abandon");
        assert_eq!(r.message, "Fusion abandonnée.");
        assert_eq!(operation_en_cours(&repo).expect("operation"), None);
        assert_eq!(fs::read_to_string(repo.join("README.md")).expect("read"), "version main\n");
        assert!(abandonner_operation(&repo).is_err());
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn abandonner_un_rebase_en_conflit() {
        let repo = init_test_repo("abandon-rebase");
        run_test_git(&repo, &["checkout", "-b", "autre"]);
        commit_fichier(&repo, "README.md", "version autre\n", "autre");
        run_test_git(&repo, &["checkout", "main"]);
        commit_fichier(&repo, "README.md", "version main\n", "main");
        run_test_git(&repo, &["checkout", "autre"]);
        assert!(!git_output(&repo, &["rebase", "main"]).expect("rebase").success);
        assert_eq!(operation_en_cours(&repo).expect("operation").as_deref(), Some("rebase"));
        assert_eq!(abandonner_operation(&repo).expect("abandon").message, "Rebase abandonné.");
        assert_eq!(operation_en_cours(&repo).expect("operation"), None);
        assert_eq!(current_branch(&repo).expect("branche").as_deref(), Some("autre"));
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn valider_la_resolution_d_une_fusion() {
        let repo = init_test_repo("fusion-resolue");
        conflit(&repo);
        fs::write(repo.join("README.md"), "version résolue\n").expect("write");
        let r = valider(&repo, "Fusion de autre", &["README.md".to_string()], false).expect("valider");
        assert!(r.ok, "{:?}", r.sortie);
        assert_eq!(operation_en_cours(&repo).expect("operation"), None);
        let parents = git_checked(&repo, &["log", "-1", "--format=%P"]).expect("log");
        assert_eq!(parents.stdout.split_whitespace().count(), 2);
        fs::remove_dir_all(repo).ok();
    }

    #[cfg(unix)]
    #[test]
    fn commit_refuse_par_un_hook_est_signale() {
        use std::os::unix::fs::PermissionsExt;
        let repo = init_test_repo("hook");
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        fs::create_dir_all(hook.parent().unwrap()).expect("hooks dir");
        fs::write(&hook, "#!/bin/sh\necho 'lint : point-virgule manquant (src/a.ts:3)' >&2\nexit 1\n")
            .expect("write hook");
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("chmod");
        fs::write(repo.join("a.ts"), "let a = 1\n").expect("write");
        let r = valider(&repo, "ajout", &["a.ts".to_string()], false).expect("valider");
        assert!(!r.ok);
        assert_eq!(r.crochet.as_deref(), Some("pre-commit"));
        assert_eq!(r.message, "Commit refusé par le hook pre-commit.");
        assert!(r.sortie.unwrap_or_default().contains("point-virgule manquant"));
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn echec_sans_hook_n_accuse_pas_de_hook() {
        let repo = init_test_repo("sans-hook");
        let r = valider(&repo, "rien", &["absent.txt".to_string()], false);
        // `git add` échoue avant le commit : erreur simple, aucun hook mis en cause.
        assert!(r.is_err());
        // Rien de choisi et pas de « modifier le dernier commit » : refus avant git.
        assert!(valider(&repo, "x", &[], false).is_err());
        fs::remove_dir_all(repo).ok();
    }

    fn init_test_repo(name: &str) -> PathBuf {
        if !command_available("git") {
            panic!("git is required for git.rs tests");
        }
        let root = unique_temp_dir(name);
        fs::create_dir_all(&root).expect("create git test repo");
        run_test_git(&root, &["init", "-b", "main"]);
        run_test_git(&root, &["config", "user.email", "test@example.com"]);
        run_test_git(&root, &["config", "user.name", "SavIDE Test"]);
        fs::write(root.join("README.md"), "test\n").expect("write test file");
        run_test_git(&root, &["add", "README.md"]);
        run_test_git(&root, &["commit", "-m", "initial"]);
        canonical_or_original(&root)
    }

    fn run_test_git(repo: &Path, args: &[&str]) {
        git_checked(repo, args)
            .unwrap_or_else(|err| panic!("git {} failed: {err}", args.join(" ")));
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        static NEXT_TEMP_ID: AtomicUsize = AtomicUsize::new(0);
        let counter = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "axecode-git-test-{name}-{}-{counter}-{nanos}",
            std::process::id()
        ))
    }
}

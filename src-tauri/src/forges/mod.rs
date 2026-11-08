//! Panneau Git : rédaction IA (contexte du diff, secrets masqués) et forges (GitHub,
//! Forgejo / Gitea) : PR, checks, revues, commentaires, issues.

pub(crate) mod api;
pub(crate) mod commandes;
pub(crate) mod contexte;
pub(crate) mod detection;
pub(crate) mod gitlab;
pub(crate) mod http;
pub(crate) mod jetons;
pub(crate) mod masque;
pub(crate) mod modele;
#[cfg(test)]
mod tests;

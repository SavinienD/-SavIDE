//! axe:gemini-web — Gemini through the gemini.google.com web app (cookies of a
//! dedicated browser profile), with text-emulated tool calls. Gives access to
//! the models of the user's Google AI subscription that the official APIs do
//! not expose to it (Gemini 4 Argon with Google AI Pro).

pub mod browser;
pub mod client;
pub mod cookies;
pub mod host;
pub mod prompt;
pub mod protocol;

pub use client::{login, logout, status, GeminiWebModelInfo, GeminiWebProvider, GeminiWebStatus, DEFAULT_MODEL, PROVIDER_ID};

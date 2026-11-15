//! Library target so integration tests (TestBackend snapshots, protocol,
//! cursor mapping) can exercise the same modules the `dsh-ask-ui` binary uses.
//!
//! The fd3/fd4 wire contract and the module split are documented in
//! `docs/architecture.md`.

pub mod app;
pub mod cli;
pub mod input;
pub mod ipc;
pub mod protocol;
pub mod render;
pub mod text;

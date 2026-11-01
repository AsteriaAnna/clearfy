//! Clarify core domain: time/clock, event model, SQLite store.
//!
//! 设计口径见 docs/03-domain-model.md 与 docs/05-contracts/storage-schema.md。
//! 该 crate 不依赖 Tauri，可用 `cargo +stable-x86_64-pc-windows-gnu test` 独立测试。

pub mod clock;
pub mod model;
pub mod store;

pub use clock::{Clock, FixedClock, SystemClock};
pub use model::{NewEvent, Event, CoreError};
pub use store::{Store, PurgeResult};

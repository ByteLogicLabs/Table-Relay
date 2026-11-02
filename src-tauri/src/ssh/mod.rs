//! Host-side SSH module. Owns the SQLite-backed `KnownHostsStore`
//! implementation used by adapter factories. The tunnel types
//! themselves live in `adapter-mysql` — adapters keep their own SSH
//! concerns so the host doesn't have to know per-adapter.

pub mod known_hosts;

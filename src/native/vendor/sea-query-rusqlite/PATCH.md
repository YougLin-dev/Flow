# sea-query-rusqlite 0.8.0 with rusqlite 0.43

This is `sea-query-rusqlite` 0.8.0 from crates.io. Its only source change is
none: `src/lib.rs` is byte-for-byte upstream. `Cargo.toml` raises the
`rusqlite` requirement from 0.38 to 0.43 and the package's `rust-version`
from 1.88.0 to 1.89.0.

## Why

`sea-orm-sync 2.0.4` and `sea-schema-sync 0.18.1` depend on
`sea-query-rusqlite 0.8.0`, which pins `rusqlite 0.38`. That resolves
`libsqlite3-sys 0.36.0`, bundled SQLite 3.51.1. SQLite 3.51.1 can invert the
unix VFS's `unixBigLock` and per-inode `pLockMutex` during concurrent WAL
opens and closes, which can permanently hang the native test suite.

`rusqlite 0.43.0` resolves `libsqlite3-sys 0.40.0`, bundled SQLite 3.54.1,
which contains the fix. The adapter's public API is unchanged; Flow's native
crate and SeaORM 2.0.4 compile and all native tests pass with this change.

## Removal

Delete this directory and the `[patch.crates-io] sea-query-rusqlite` entry
when SeaQL publishes an adapter release that accepts `rusqlite >= 0.43` (or
another release that resolves a fixed SQLite). Upstream tracking:
https://github.com/SeaQL/sea-query/issues/1130

# ADR 0008: The zip crate for zipped package import

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Flow maintainers

## Context

Project import accepts an unpacked package folder or a `.zip` of one. The
archive is untrusted input: it may be a shared backup, a file from another
machine or a crafted archive. The importer must read it in the Rust document
core (TSX never touches package files), enforce a strict allowlist
(`project.db` and `assets/<sha256>`, stored or deflated, optional one wrapper
directory), bound the work before extraction, and leave no staging tree
behind on failure.

The repository requires an ADR before a new runtime dependency, covering
need, license, maintenance, runtime and bundle cost, and why an existing
package is insufficient ([standards.md](../standards.md), "New dependency").

## Decision

Use the `zip` crate, version 9.6 (MIT), as the only archive parser, in
`src/native/src/project/archive.rs`. The resolved version is pinned by
`src/native/Cargo.lock`.

- **Minimum feature set.** `default-features = false` with
  `deflate-flate2-zlib-rs`: stored and deflate entries only, and the
  pure-Rust zlib-rs flate2 backend selected explicitly rather than inherited
  from another crate's default features. The default feature set would add
  AES/ZipCrypto, bzip2, zstd, lzma, ppmd, xz and zopfli — codecs and crypto
  the importer refuses anyway.
- **No system dependency.** zlib-rs is pure Rust; the bundled-SQLite build
  stays the only native component, and Windows, macOS and Linux need no
  extra toolchain or DLL.
- **Defense in depth in our code.** The footer must contain exactly one
  end-record signature in a window larger than the crate's own scan, the
  central directory must abut that record, and the record's declared entry
  count and central-directory size are checked before `ZipArchive::new` sizes
  its eager parse. Duplicate central-directory names, encryption, symlinks,
  other compression methods, unsafe names and every size cap are refused;
  ZIP64 archives are refused rather than followed, which caps the importer at
  65,534 entries. The archive is extracted into an owner-only temp directory
  through the allowlist and then passed to the same read-only folder import
  that a plain directory takes.
- **Conservative shapes.** An archive with a second end-record signature in
  its last 256 KiB (for example a stored nested zip or an archive comment
  containing those bytes), prepended data, or a central directory that does
  not end at the record is refused rather than parsed. The folder import is
  the fallback for such a package; tolerance here would require mirroring the
  crate's footer selection, which this ADR prefers not to duplicate.

## Consequences

- One new runtime dependency tree: `zip` plus `crc32fast`, `flate2` (with
  `zlib-rs` and `miniz_oxide`), `constant_time_eq`, `getrandom`, `indexmap`,
  `memchr`, `typed-path`, `zeroize`, platform helpers (`nix` on macOS/BSD,
  `windows-sys` on Windows, `libc` on Unix) and their small proc-macro/build
  dependencies. All are permissively licensed (MIT/Apache-2.0/Zlib/CC0).
  `src/native/Cargo.lock` is the exact record; upgrading `zip` or its
  features is reviewed as a dependency change.
- The binary grows by the ZIP reader and the zlib-rs deflate implementation;
  there is no runtime service, daemon or extra process, and no per-import FFI
  beyond the existing one store call.
- The crate's parser is treated as untrusted regardless of its reputation:
  caps are enforced before allocation, and the allowlist, not the parser,
  decides what can become a file.
- The importer stays in Rust; the TSX dialog only passes a path, so a future
  archive format does not touch the UI.
- If `zip` stops being maintained or a security advisory lands with no prompt
  upgrade, this ADR is superseded and the parser replaced; the folder import
  and the staging contract remain the seam.

## Alternatives considered

| Option                                              | Why it fits                                                                           | Why it does not                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **`zip` 9.6 (chosen)**                              | Maintained Rust ZIP implementation, sync `Read + Seek` API, feature-gated codecs, MIT | Broad default feature set, so the dependency must pin its features and caps                                          |
| **`async_zip`**                                     | Async, feature-gated codecs                                                           | Pulls an async runtime into a synchronous worker command; the core is deliberately sync                              |
| **`rc-zip`**                                        | Streaming reader, no C                                                                | Smaller ecosystem and a different correctness/maintenance risk for the same job                                      |
| **`miniz_oxide` plus our own headers**              | Only a deflate decoder to trust                                                       | We would own central-directory, ZIP64, name and CRC parsing; that is precisely the security-sensitive part           |
| **OS shell-out (`unzip`, `Expand-Archive`, `tar`)** | No dependency                                                                         | Not portable across the three desktop targets, extraction precedes our allowlist, and output/cleanup is not reliable |
| **Full-feature `zip`**                              | One line, every format                                                                | Adds crypto and codecs the importer rejects; larger attack surface and binary for no behavior                        |

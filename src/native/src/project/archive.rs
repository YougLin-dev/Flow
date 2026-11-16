//! Reading a zipped project package.
//!
//! An archive is the one untrusted parser the project layer accepts. It is
//! extracted into an owner-only staging directory through a strict allowlist
//! — exactly `project.db` and `assets/<sha256>`, optionally under one wrapper
//! directory — and only then handed to the ordinary directory import, which
//! validates the identity, the assets and the snapshot. Nothing from the
//! archive is ever written under the managed root except through that
//! pipeline, and no stored name is used as a path.
//!
//! The limits apply before the parser allocates: the footer must contain
//! exactly one end-record signature, the central directory must abut that
//! record, and the record's declared entry count and central-directory size
//! are checked, because the crate sizes its eager parse from them. A second
//! signature could point the crate at an unchecked record; ZIP64 archives are
//! refused. These are deliberately conservative shapes: an archive with a
//! stored nested zip or an end-record signature inside its comment is
//! refused, and the folder import remains the fallback. Duplicate
//! central-directory names are refused too, since the crate would otherwise
//! silently keep only the last payload.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use zip::CompressionMethod;
use zip::ZipArchive;

use crate::asset;
use crate::project::paths;

/// The production import limits. Tests narrow them to exercise each check.
struct Limits {
    archive_bytes: u64,
    uncompressed_bytes: u64,
    entry_bytes: u64,
    entries: usize,
    /// The most central-directory metadata the entry cap can describe. A
    /// header is at least 46 bytes plus its name; a larger directory only
    /// comes from a crafted count, so refusing it keeps the eager parse
    /// bounded before individual entries are inspected.
    directory_bytes: u64,
}

const LIMITS: Limits = Limits {
    archive_bytes: 1024 * 1024 * 1024,
    uncompressed_bytes: 2 * 1024 * 1024 * 1024,
    entry_bytes: 512 * 1024 * 1024,
    // The classic end record stores the count in 16 bits. A saturated count
    // means ZIP64, which the importer refuses, so this is the real maximum.
    entries: u16::MAX as usize - 1,
    directory_bytes: 64 * 1024 * 1024,
};
/// Abandoned staging trees older than a day are removed with the other
/// residue; a live import never takes that long.
const STAGING_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

/// The extracted package directory; removing it on drop keeps a failed or
/// completed import from leaving a staging tree behind.
#[derive(Debug)]
pub(crate) struct Extracted {
    path: PathBuf,
}

impl Extracted {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Extracted {
    fn drop(&mut self) {
        let _ = crate::fsutil::remove_dir_all(&self.path);
    }
}

/// Extracts a `.zip` project package into a fresh temp directory. The result
/// is a flat package (`project.db` and optional `assets/`) that the directory
/// import can read.
pub(crate) fn extract(source: &Path) -> Result<Extracted, String> {
    extract_with(source, &LIMITS, &std::env::temp_dir())
}

fn extract_with(source: &Path, limits: &Limits, staging_root: &Path) -> Result<Extracted, String> {
    let mut file = fs::File::open(source)
        .map_err(|error| format!("the project archive could not be read: {error}"))?;
    // Validate the opened handle, not a path that could be swapped between
    // the stat and the open.
    let metadata = file
        .metadata()
        .map_err(|error| format!("the project archive could not be read: {error}"))?;
    if !metadata.is_file() {
        return Err("the project archive is not a file".to_owned());
    }
    if metadata.len() > limits.archive_bytes {
        return Err("the project archive is too large".to_owned());
    }
    check_end_record(&mut file, limits)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("the project archive could not be read: {error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|_| invalid_archive())?;
    if archive.has_duplicate_names() {
        return Err("the project archive contains duplicate entries".to_owned());
    }
    if archive.len() > limits.entries {
        return Err("the project archive has too many entries".to_owned());
    }

    let staging = staging_dir(staging_root)?;
    let extracted = Extracted { path: staging };
    extract_into(&mut archive, extracted.path(), limits)?;
    Ok(extracted)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Layout {
    Flat,
    Wrapped(String),
}

enum Target {
    Database,
    Asset(String),
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Database => "project.db".to_owned(),
            Target::Asset(hash) => format!("assets/{hash}"),
        }
    }

    fn path(&self) -> PathBuf {
        match self {
            Target::Database => PathBuf::from(paths::DATABASE_FILE),
            Target::Asset(hash) => Path::new(paths::ASSETS_DIR).join(hash),
        }
    }

    fn is_database(&self) -> bool {
        matches!(self, Target::Database)
    }
}

fn extract_into(
    archive: &mut ZipArchive<fs::File>,
    root: &Path,
    limits: &Limits,
) -> Result<(), String> {
    // First pass: names, kinds and declared sizes only. It fixes the layout
    // before any file is written, so a mixed or wrapped archive cannot
    // half-extract. Metadata comes from the central directory, so encrypted
    // and unsupported entries are refused before any reader is created.
    let mut files: Vec<(usize, Vec<String>, u64)> = Vec::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_data(index)
            .map_err(|_| invalid_archive())?;
        let name = entry
            .name()
            .map_err(|_| "the project archive contains an invalid file name".to_owned())?;
        let parts = split_name(&name)?;
        if entry.is_dir() {
            continue;
        }
        if entry.encrypted() {
            return Err("the project archive is encrypted".to_owned());
        }
        if entry.is_symlink() {
            return Err("the project archive contains a symbolic link".to_owned());
        }
        match entry.compression() {
            CompressionMethod::Stored | CompressionMethod::Deflated => {}
            _ => {
                return Err("the project archive uses an unsupported compression method".to_owned());
            }
        }
        let declared = entry.size();
        if declared > limits.entry_bytes {
            return Err("a file in the project archive is too large".to_owned());
        }
        total = total
            .checked_add(declared)
            .ok_or_else(|| "the project archive is too large".to_owned())?;
        if total > limits.uncompressed_bytes {
            return Err("the project archive is too large".to_owned());
        }
        files.push((index, parts, declared));
    }
    let layout = layout_of(&files)?;

    let mut written = HashSet::new();
    let mut database = false;
    for (index, parts, declared) in files {
        let target = target_of(&layout, &parts)?;
        if !written.insert(target.key()) {
            return Err("the project archive contains duplicate entries".to_owned());
        }
        let destination = root.join(target.path());
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("the project archive could not be unpacked: {error}"))?;
        }
        let mut output = fs::File::create(&destination)
            .map_err(|error| format!("the project archive could not be unpacked: {error}"))?;
        let file = archive.by_index(index).map_err(|_| invalid_archive())?;
        // Read one byte past the declared size: a lying header must not let
        // an entry exceed the limits the total was checked against.
        let read = io::copy(&mut file.take(declared.saturating_add(1)), &mut output)
            .map_err(|error| format!("the project archive could not be unpacked: {error}"))?;
        if read != declared {
            return Err("the project archive is corrupt".to_owned());
        }
        database |= target.is_database();
    }

    if !database {
        return Err("the project archive does not contain a project database".to_owned());
    }
    Ok(())
}

/// The archive's file names as safe path components. Backslashes are treated
/// as separators because some Windows writers emit them; anything that could
/// leave the target directory is refused before it reaches a path.
fn split_name(name: &str) -> Result<Vec<String>, String> {
    if name.contains('\0') {
        return Err(unsafe_entry());
    }
    let normalized = name.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(unsafe_entry());
        }
        parts.push(part.to_owned());
    }
    Ok(parts)
}

/// The one layout every file entry agrees on: flat, or under one wrapper
/// directory (what Explorer's Compress folder produces).
fn layout_of(files: &[(usize, Vec<String>, u64)]) -> Result<Layout, String> {
    let mut layout: Option<Layout> = None;
    for (_, parts, _) in files {
        let candidate = match parts.as_slice() {
            [database] if database == paths::DATABASE_FILE => Layout::Flat,
            [assets, _] if assets == paths::ASSETS_DIR => Layout::Flat,
            [wrapper, database]
                if database == paths::DATABASE_FILE && wrapper != paths::ASSETS_DIR =>
            {
                Layout::Wrapped(wrapper.clone())
            }
            [wrapper, assets, _] if assets == paths::ASSETS_DIR && wrapper != paths::ASSETS_DIR => {
                Layout::Wrapped(wrapper.clone())
            }
            _ => return Err(unsafe_entry()),
        };
        match &layout {
            None => layout = Some(candidate),
            Some(existing) if *existing == candidate => {}
            Some(_) => return Err("the project archive mixes package layouts".to_owned()),
        }
    }
    layout.ok_or_else(|| "the project archive does not contain a project database".to_owned())
}

fn target_of(layout: &Layout, parts: &[String]) -> Result<Target, String> {
    let rest = match layout {
        Layout::Flat => parts,
        Layout::Wrapped(wrapper) => {
            if parts.first() != Some(wrapper) {
                return Err(unsafe_entry());
            }
            &parts[1..]
        }
    };
    match rest {
        [database] if database == paths::DATABASE_FILE => Ok(Target::Database),
        [assets, hash] if assets == paths::ASSETS_DIR && asset::is_sha256_hex(hash) => {
            Ok(Target::Asset(hash.clone()))
        }
        _ => Err(unsafe_entry()),
    }
}

fn unsafe_entry() -> String {
    "the project archive contains an unsafe entry".to_owned()
}

fn invalid_archive() -> String {
    "the project archive is not a valid zip file".to_owned()
}

/// Bounds the one end record the zip crate may use. The crate scans only
/// about the last 64 KiB, tolerates trailing bytes after the comment and
/// falls back to earlier signatures, so the window here is much larger and a
/// second signature is refused outright: without mirroring the crate's
/// selection rule, that is the only way to be sure the record it sizes its
/// eager parse from is the one checked here. ZIP64 is refused rather than
/// followed: the importer's entry cap is below the classic 16-bit count, and
/// matching the crate's EOCD64 selection would duplicate a version-specific
/// rule.
fn check_end_record(file: &mut fs::File, limits: &Limits) -> Result<(), String> {
    const EOCD: [u8; 4] = *b"PK\x05\x06";
    const EOCD_LEN: usize = 22;
    // The crate's window is the size of its EOCD struct (about 32 bytes)
    // plus a 64 KiB comment search; this is several times larger.
    const WINDOW: usize = 256 * 1024;

    let length = file
        .metadata()
        .map_err(|error| format!("the project archive could not be read: {error}"))?
        .len();
    if length < EOCD_LEN as u64 {
        return Err(invalid_archive());
    }
    let tail_len = length.min(WINDOW as u64) as usize;
    let mut tail = vec![0u8; tail_len];
    file.seek(SeekFrom::Start(length - tail_len as u64))
        .and_then(|_| file.read_exact(&mut tail))
        .map_err(|error| format!("the project archive could not be read: {error}"))?;
    let mut end = None;
    for index in 0..=tail.len() - EOCD_LEN {
        if tail[index..index + 4] != EOCD[..] {
            continue;
        }
        if end.is_some() {
            return Err("the project archive has more than one end record".to_owned());
        }
        end = Some(index);
    }
    let end = end.ok_or_else(invalid_archive)?;
    let comment = usize::from(read_u16(&tail[end + 20..]));
    if end + EOCD_LEN + comment > tail.len() {
        return Err(invalid_archive());
    }
    let disk = read_u16(&tail[end + 4..]);
    let directory_disk = read_u16(&tail[end + 6..]);
    let on_disk = read_u16(&tail[end + 8..]);
    let entries = read_u16(&tail[end + 10..]);
    let size = read_u32(&tail[end + 12..]);
    let offset = read_u32(&tail[end + 16..]);
    if entries == u16::MAX || size == u32::MAX || offset == u32::MAX {
        return Err("the project archive uses ZIP64, which is not supported".to_owned());
    }
    // The crate only uses a single-disk record whose on-disk count equals
    // the total; checking both here makes the allocation bound independent
    // of its selection rules.
    if disk != 0 || directory_disk != 0 || on_disk != entries {
        return Err(invalid_archive());
    }
    if usize::from(entries) > limits.entries {
        return Err("the project archive has too many entries".to_owned());
    }
    if u64::from(size) > limits.directory_bytes {
        return Err("the project archive is too large".to_owned());
    }
    // The central directory must end at the record, and begin with a header.
    // Besides rejecting malformed layouts, this makes the crate's abutting
    // probe succeed, so it never scans the file for a first CDFH and caches
    // every signature position it finds.
    let end_offset = length - tail_len as u64 + end as u64;
    let directory_offset = u64::from(offset);
    let directory_size = u64::from(size);
    if directory_offset.checked_add(directory_size) != Some(end_offset) {
        return Err(invalid_archive());
    }
    if entries > 0 {
        if directory_offset + 4 > length {
            return Err(invalid_archive());
        }
        let mut magic = [0u8; 4];
        file.seek(SeekFrom::Start(directory_offset))
            .and_then(|_| file.read_exact(&mut magic))
            .map_err(|error| format!("the project archive could not be read: {error}"))?;
        if magic != *b"PK\x01\x02" {
            return Err(invalid_archive());
        }
    }
    Ok(())
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// A fresh staging directory the current user alone can enter. The name
/// carries 64 bits from the process's randomized hasher, so another local
/// user cannot predict or pre-create it.
fn staging_dir(parent: &Path) -> Result<PathBuf, String> {
    use std::hash::{BuildHasher, Hasher};

    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write(paths::unique_suffix().as_bytes());
    let path = parent.join(format!("flow-import-{:016x}", hasher.finish()));
    create_private_dir(&path)
        .map_err(|error| format!("the project archive could not be unpacked: {error}"))?;
    Ok(path)
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
    }
}

/// Removes abandoned `flow-import-*` staging trees older than a day. Called
/// with the other residue sweeps; the temp directory belongs to the OS, so
/// only our prefix and only old trees are touched.
pub(crate) fn sweep_staging() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = crate::clock::now_ms();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("flow-import-") {
            continue;
        }
        let path = entry.path();
        let old = fs::symlink_metadata(&path)
            .map(|metadata| {
                metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && metadata
                        .modified()
                        .ok()
                        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                        .map(|modified| now - modified.as_millis() as i64 > STAGING_MAX_AGE_MS)
                        .unwrap_or(false)
            })
            .unwrap_or(false);
        if old {
            let _ = crate::fsutil::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::project::test_support::TempRoot;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn entry(name: &str, bytes: &'static [u8]) -> (String, &'static [u8], CompressionMethod) {
        (name.to_owned(), bytes, CompressionMethod::Stored)
    }

    fn write_zip(
        label: &str,
        entries: &[(String, &'static [u8], CompressionMethod)],
    ) -> (TempRoot, PathBuf) {
        let temp = TempRoot::new(label);
        let path = temp.path().join("package.zip");
        let file = fs::File::create(&path).expect("create zip");
        let mut writer = ZipWriter::new(file);
        for (name, bytes, method) in entries {
            let options = SimpleFileOptions::default().compression_method(*method);
            writer
                .start_file(name.as_str(), options)
                .expect("start entry");
            writer.write_all(bytes).expect("write entry");
        }
        writer.finish().expect("finish zip");
        (temp, path)
    }

    fn default_limits() -> Limits {
        Limits {
            archive_bytes: LIMITS.archive_bytes,
            uncompressed_bytes: LIMITS.uncompressed_bytes,
            entry_bytes: LIMITS.entry_bytes,
            entries: LIMITS.entries,
            directory_bytes: LIMITS.directory_bytes,
        }
    }

    fn signatures(bytes: &[u8], signature: &[u8; 4]) -> Vec<usize> {
        bytes
            .windows(4)
            .enumerate()
            .filter(|(_, window)| **window == signature[..])
            .map(|(index, _)| index)
            .collect()
    }

    /// Rewrites the archive in place so a test can craft a header the writer
    /// never produces.
    fn patch_zip(path: &Path, patch: impl FnOnce(&mut Vec<u8>)) {
        let mut bytes = fs::read(path).expect("read zip");
        patch(&mut bytes);
        fs::write(path, bytes).expect("write zip");
    }

    fn write_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn extracts_a_flat_package() {
        let (_temp, path) = write_zip(
            "archive-flat",
            &[
                entry("project.db", b"database"),
                entry(&format!("assets/{HASH}"), b"image"),
            ],
        );
        let extracted = extract(&path).expect("extract");
        assert_eq!(
            fs::read(extracted.path().join("project.db")).expect("database"),
            b"database"
        );
        assert_eq!(
            fs::read(extracted.path().join("assets").join(HASH)).expect("asset"),
            b"image"
        );
    }

    #[test]
    fn extracts_a_wrapped_package_with_directory_entries() {
        let temp = TempRoot::new("archive-wrapped");
        let path = temp.path().join("package.zip");
        let file = fs::File::create(&path).expect("create zip");
        let mut writer = ZipWriter::new(file);
        writer
            .add_directory("My Project/", SimpleFileOptions::default())
            .expect("wrapper directory");
        writer
            .add_directory("My Project/assets/", SimpleFileOptions::default())
            .expect("assets directory");
        writer
            .start_file("My Project/project.db", SimpleFileOptions::default())
            .expect("database entry");
        writer.write_all(b"database").expect("database");
        writer
            .start_file(
                format!("My Project/assets/{HASH}"),
                SimpleFileOptions::default(),
            )
            .expect("asset entry");
        writer.write_all(b"image").expect("asset");
        writer.finish().expect("finish zip");

        let extracted = extract(&path).expect("extract");
        assert_eq!(
            fs::read(extracted.path().join("project.db")).expect("database"),
            b"database"
        );
        assert!(extracted.path().join("assets").join(HASH).is_file());
    }

    #[test]
    fn accepts_deflate_entries() {
        let (_temp, path) = write_zip(
            "archive-deflate",
            &[(
                "project.db".to_owned(),
                b"database",
                CompressionMethod::Deflated,
            )],
        );
        let extracted = extract(&path).expect("extract");
        assert_eq!(
            fs::read(extracted.path().join("project.db")).expect("database"),
            b"database"
        );
    }

    #[test]
    fn rejects_unsafe_entries() {
        for (label, entries) in [
            ("traversal", vec![entry("../project.db", b"db")]),
            ("absolute", vec![entry("/project.db", b"db")]),
            (
                "extra",
                vec![entry("project.db", b"db"), entry("notes.txt", b"x")],
            ),
            (
                "bad asset",
                vec![entry("project.db", b"db"), entry("assets/not-a-hash", b"x")],
            ),
            (
                "nested asset",
                vec![
                    entry("project.db", b"db"),
                    entry(&format!("assets/{HASH}/extra"), b"x"),
                ],
            ),
            (
                "mixed layouts",
                vec![
                    entry("package/project.db", b"db"),
                    entry(&format!("other/assets/{HASH}"), b"x"),
                ],
            ),
            ("no database", vec![entry(&format!("assets/{HASH}"), b"x")]),
        ] {
            let (_temp, path) = write_zip(label, &entries);
            let error = extract(&path).expect_err(label);
            assert!(error.starts_with("the project archive"), "{label}: {error}");
        }
    }

    #[test]
    fn rejects_a_backslash_alias_of_a_written_target() {
        let (_temp, path) = write_zip(
            "archive-backslash",
            &[
                entry("project.db", b"db"),
                entry(&format!("assets/{HASH}"), b"one"),
                entry(&format!("assets\\{HASH}"), b"two"),
            ],
        );
        assert_eq!(
            extract(&path).err(),
            Some("the project archive contains duplicate entries".to_owned())
        );
    }

    #[test]
    fn rejects_duplicate_central_directory_names() {
        let (_temp, path) = write_zip(
            "archive-duplicates",
            &[entry("project.db", b"db"), entry("project.dx", b"other")],
        );
        patch_zip(&path, |bytes| {
            let central = signatures(bytes, b"PK\x01\x02");
            assert_eq!(central.len(), 2, "two central headers");
            bytes[central[1] + 46..central[1] + 56].copy_from_slice(b"project.db");
        });
        assert_eq!(
            extract(&path).err(),
            Some("the project archive contains duplicate entries".to_owned())
        );
    }

    #[test]
    fn rejects_an_encrypted_entry() {
        let (_temp, path) = write_zip("archive-encrypted", &[entry("project.db", b"db")]);
        patch_zip(&path, |bytes| {
            let central = signatures(bytes, b"PK\x01\x02")[0];
            let flags = read_u16(&bytes[central + 8..]) | 1;
            write_u16(bytes, central + 8, flags);
            let local = signatures(bytes, b"PK\x03\x04")[0];
            let flags = read_u16(&bytes[local + 6..]) | 1;
            write_u16(bytes, local + 6, flags);
        });
        assert_eq!(
            extract(&path).err(),
            Some("the project archive is encrypted".to_owned())
        );
    }

    #[test]
    fn rejects_a_symbolic_link_entry() {
        let temp = TempRoot::new("archive-symlink");
        let path = temp.path().join("package.zip");
        let file = fs::File::create(&path).expect("create zip");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .system(zip::System::Unix)
            .external_attributes(0o120777 << 16);
        writer.start_file("project.db", options).expect("entry");
        writer.write_all(b"target").expect("data");
        writer.finish().expect("finish zip");
        assert_eq!(
            extract(&path).err(),
            Some("the project archive contains a symbolic link".to_owned())
        );
    }

    #[test]
    fn rejects_an_unsupported_compression_method() {
        let (_temp, path) = write_zip("archive-method", &[entry("project.db", b"db")]);
        patch_zip(&path, |bytes| {
            let central = signatures(bytes, b"PK\x01\x02")[0];
            write_u16(bytes, central + 10, 12); // Bzip2
            let local = signatures(bytes, b"PK\x03\x04")[0];
            write_u16(bytes, local + 8, 12);
        });
        assert_eq!(
            extract(&path).err(),
            Some("the project archive uses an unsupported compression method".to_owned())
        );
    }

    #[test]
    fn refuses_an_archive_over_the_size_limit() {
        let (_temp, path) = write_zip("archive-size", &[entry("project.db", b"database")]);
        let limits = Limits {
            archive_bytes: 10,
            ..default_limits()
        };
        let staging = TempRoot::new("archive-size-staging");
        assert_eq!(
            extract_with(&path, &limits, staging.path()).err(),
            Some("the project archive is too large".to_owned())
        );
    }

    #[test]
    fn refuses_more_entries_than_the_limit() {
        let (_temp, path) = write_zip(
            "archive-count",
            &[
                entry("project.db", b"db"),
                entry(&format!("assets/{HASH}"), b"x"),
            ],
        );
        let limits = Limits {
            entries: 1,
            ..default_limits()
        };
        let staging = TempRoot::new("archive-count-staging");
        assert_eq!(
            extract_with(&path, &limits, staging.path()).err(),
            Some("the project archive has too many entries".to_owned())
        );
    }

    #[test]
    fn refuses_an_oversized_directory() {
        let (_temp, path) = write_zip("archive-directory", &[entry("project.db", b"db")]);
        let limits = Limits {
            directory_bytes: 10,
            ..default_limits()
        };
        let staging = TempRoot::new("archive-directory-staging");
        assert_eq!(
            extract_with(&path, &limits, staging.path()).err(),
            Some("the project archive is too large".to_owned())
        );
    }

    #[test]
    fn refuses_an_entry_over_the_entry_limit() {
        let (_temp, path) = write_zip("archive-entry", &[entry("project.db", b"0123456789")]);
        let limits = Limits {
            entry_bytes: 5,
            ..default_limits()
        };
        let staging = TempRoot::new("archive-entry-staging");
        assert_eq!(
            extract_with(&path, &limits, staging.path()).err(),
            Some("a file in the project archive is too large".to_owned())
        );
    }

    #[test]
    fn refuses_a_total_over_the_uncompressed_limit() {
        let (_temp, path) = write_zip(
            "archive-total",
            &[
                entry("project.db", b"0123456789"),
                entry(&format!("assets/{HASH}"), b"abcdefghij"),
            ],
        );
        let limits = Limits {
            uncompressed_bytes: 15,
            ..default_limits()
        };
        let staging = TempRoot::new("archive-total-staging");
        assert_eq!(
            extract_with(&path, &limits, staging.path()).err(),
            Some("the project archive is too large".to_owned())
        );
    }

    #[test]
    fn refuses_a_lying_entry_size() {
        let (_temp, path) = write_zip("archive-lying", &[entry("project.db", b"0123456789")]);
        patch_zip(&path, |bytes| {
            let central = signatures(bytes, b"PK\x01\x02")[0];
            write_u32(bytes, central + 24, 100); // declared uncompressed size
        });
        let staging = TempRoot::new("archive-lying-staging");
        assert_eq!(
            extract_with(&path, &default_limits(), staging.path()).err(),
            Some("the project archive is corrupt".to_owned())
        );
        assert_eq!(
            fs::read_dir(staging.path()).expect("staging root").count(),
            0,
            "a failed extraction removes its staging tree"
        );
    }

    #[test]
    fn refuses_every_zip64_saturation() {
        for (label, field, width) in [
            ("entries", 10usize, 2usize),
            ("size", 12, 4),
            ("offset", 16, 4),
        ] {
            let (_temp, path) = write_zip(label, &[entry("project.db", b"db")]);
            patch_zip(&path, |bytes| {
                let end = *signatures(bytes, b"PK\x05\x06").last().expect("end record");
                if width == 2 {
                    write_u16(bytes, end + 8, u16::MAX);
                    write_u16(bytes, end + field, u16::MAX);
                } else {
                    write_u32(bytes, end + field, u32::MAX);
                }
            });
            assert_eq!(
                extract(&path).err(),
                Some("the project archive uses ZIP64, which is not supported".to_owned()),
                "{label}"
            );
        }
    }

    #[test]
    fn refuses_more_than_one_end_record() {
        let (_temp, path) = write_zip("archive-decoy", &[entry("project.db", b"db")]);
        patch_zip(&path, |bytes| {
            let end = *signatures(bytes, b"PK\x05\x06").last().expect("end record");
            let mut decoy = [0u8; 22];
            decoy[..4].copy_from_slice(b"PK\x05\x06");
            decoy[10..12].copy_from_slice(&200u16.to_le_bytes());
            write_u16(bytes, end + 20, 22);
            bytes.extend_from_slice(&decoy);
        });
        assert_eq!(
            extract(&path).err(),
            Some("the project archive has more than one end record".to_owned())
        );
    }

    #[test]
    fn refuses_a_decoy_after_a_far_end_record() {
        let (_temp, path) = write_zip("archive-far-decoy", &[entry("project.db", b"db")]);
        let mut bytes = fs::read(&path).expect("read zip");
        let length = bytes.len();
        bytes.resize(length + 65_538, 0);
        let mut decoy = [0u8; 22];
        decoy[..4].copy_from_slice(b"PK\x05\x06");
        decoy[8..10].copy_from_slice(&1u16.to_le_bytes());
        decoy[10..12].copy_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&decoy);
        fs::write(&path, bytes).expect("write zip");
        assert_eq!(
            extract(&path).err(),
            Some("the project archive has more than one end record".to_owned())
        );
    }

    #[test]
    fn refuses_a_central_directory_that_does_not_abut_the_end_record() {
        let (_temp, path) = write_zip("archive-abut", &[entry("project.db", b"db")]);
        patch_zip(&path, |bytes| {
            let end = *signatures(bytes, b"PK\x05\x06").last().expect("end record");
            write_u32(bytes, end + 16, 0);
        });
        assert_eq!(extract(&path).err(), Some(invalid_archive()));
    }

    #[test]
    fn accepts_an_archive_comment() {
        let temp = TempRoot::new("archive-comment");
        let path = temp.path().join("package.zip");
        let file = fs::File::create(&path).expect("create zip");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("project.db", SimpleFileOptions::default())
            .expect("entry");
        writer.write_all(b"database").expect("data");
        writer.set_comment("a plain note").expect("comment");
        writer.finish().expect("finish zip");
        let extracted = extract(&path).expect("extract the archive");
        assert_eq!(
            fs::read(extracted.path().join("project.db")).expect("database"),
            b"database"
        );
    }

    #[test]
    fn accepts_trailing_bytes_after_the_end_record() {
        let (_temp, path) = write_zip("archive-trailing", &[entry("project.db", b"database")]);
        let mut bytes = fs::read(&path).expect("read zip");
        bytes.extend_from_slice(b"trailing bytes");
        fs::write(&path, bytes).expect("write zip");
        let extracted = extract(&path).expect("extract the archive");
        assert_eq!(
            fs::read(extracted.path().join("project.db")).expect("database"),
            b"database"
        );
    }

    #[test]
    fn accepts_many_trailing_bytes_after_the_end_record() {
        let (_temp, path) = write_zip("archive-far-trailing", &[entry("project.db", b"database")]);
        let mut bytes = fs::read(&path).expect("read zip");
        // Places the end record beyond a 64 KiB tail but inside the crate's
        // own scan window: the case a too-narrow pre-check would miss.
        let length = bytes.len();
        bytes.resize(length + 65_538, 0);
        fs::write(&path, bytes).expect("write zip");
        let extracted = extract(&path).expect("extract the archive");
        assert_eq!(
            fs::read(extracted.path().join("project.db")).expect("database"),
            b"database"
        );
    }

    #[test]
    fn rejects_a_file_that_is_not_a_zip() {
        let temp = TempRoot::new("archive-bad");
        let path = temp.path().join("bad.zip");
        fs::write(&path, b"not an archive").expect("write");
        assert_eq!(extract(&path).err(), Some(invalid_archive()));
    }

    #[test]
    fn removes_the_staging_directory_on_drop() {
        let (_temp, path) = write_zip("archive-cleanup", &[entry("project.db", b"db")]);
        let extracted = extract(&path).expect("extract");
        let staging = extracted.path().to_owned();
        assert!(staging.is_dir());
        drop(extracted);
        assert!(!staging.exists(), "the staging directory is removed");
    }

    #[test]
    fn keeps_a_fresh_staging_tree() {
        let path = std::env::temp_dir().join(format!("flow-import-{}", paths::unique_suffix()));
        fs::create_dir(&path).expect("staging");
        sweep_staging();
        assert!(path.is_dir(), "a live import is not swept");
        let _ = fs::remove_dir_all(&path);
    }
}

//! The 100k fixture seeder and the release benchmark.
//!
//! The seeder writes the package the host smoke reads (`FLOW_BENCH_DB`); the
//! benchmark seeds and reads back its own temporary fixture. Both are ignored
//! by default.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::clock::now_ms;

fn benchmark_nodes(chunk: usize) -> Vec<NodeInput> {
    (0..1000)
        .map(|offset| {
            let i = chunk * 1000 + offset;
            node(
                &format!("n{i}"),
                &format!("Node {i} image generator"),
                if i.is_multiple_of(2) {
                    "A panel that turns text into an image."
                } else {
                    "一个把文本变成图片的生成器。"
                },
                &["generated", "flow"],
                (i % 100) as f64 * 220.0,
                (i / 100) as f64 * 140.0,
            )
        })
        .collect()
}

/// The fixture's revision. Comparisons across revisions are invalid; a
/// later change to the grid, edges or images must pick a new label.
const FIXTURE_VERSION: &str = "100k-grid-edges-images-v2-typed-ports";
const GRID_NODES: u32 = 100_000;
const GRID_ROWS: u32 = 1_000;
const ROW_NODES: u32 = 100;
const IMAGE_STRIDE: u32 = 50;
const IMAGE_NODES: u32 = GRID_NODES / IMAGE_STRIDE;
const IMAGE_ITEMS: usize = 4;
const SCENE_SAMPLES: usize = 5;
const MOVE_SAMPLES: usize = 3;
const SEARCH_COMMON_SAMPLES: usize = 20;
const SEARCH_SAMPLES: usize = 5;
const RECOVERY_ITERATIONS: u32 = 2;

/// An explicitly owned temporary directory for the timed fixture. It
/// only ever removes the directory it created; a failed cleanup leaves
/// the path in the output for inspection.
struct BenchmarkTempDir {
    path: PathBuf,
}

impl BenchmarkTempDir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "flow-bench-{FIXTURE_VERSION}-{}-{}-{}",
            std::process::id(),
            now_ms(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create benchmark temp directory");
        Self { path }
    }

    fn database_path(&self) -> String {
        self.path
            .join("flow-100k.db")
            .to_string_lossy()
            .into_owned()
    }

    fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for BenchmarkTempDir {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.path) {
            println!(
                "100k fixture cleanup left {} for inspection: {error}",
                self.path.display()
            );
        }
    }
}

/// What the seeder actually built. `include_images=false` leaves the
/// designated image nodes as text and stores no batches: the smoke
/// shares only the node/edge graph with the release benchmark.
struct BenchmarkFixture {
    version: &'static str,
    nodes: u32,
    edges: u32,
    images: u32,
    batches: u32,
    items: u32,
    assets: u32,
    path: String,
}

fn print_fixture(fixture: &BenchmarkFixture, include_images: bool) {
    println!(
        "100k fixture version={} include_images={include_images} nodes={} edges={} image_nodes={} image_batches={} image_items={} image_assets={} db={}",
        fixture.version,
        fixture.nodes,
        fixture.edges,
        fixture.images,
        fixture.batches,
        fixture.items,
        fixture.assets,
        fixture.path
    );
    if !include_images {
        println!(
            "100k fixture note: the release benchmark uses include_images=true with {IMAGE_NODES} image nodes, {IMAGE_NODES} four-item batches and {IMAGE_NODES} assets"
        );
    }
}

fn image_node_ids() -> Vec<String> {
    (0..IMAGE_NODES)
        .map(|k| format!("n{}", k * IMAGE_STRIDE))
        .collect()
}

/// The row-end text nodes used as outstanding runs: neither a running nor
/// a successful batch can mark a downstream neighbor stale. The grid has
/// 1,000 rows and therefore 1,000 row ends (`n99`, `n199`, ...); every
/// tenth one, starting at `n99`, gives 100 sinks spread over the whole
/// document.
fn sink_node_ids() -> Vec<String> {
    (0..100u32)
        .map(|k| format!("n{}", 99 + k * 1_000))
        .collect()
}

/// The one fixture builder. Seeding history is cleared so mutation
/// timings start from an empty stack.
fn seed_grid(db: &Database, include_images: bool, path: &str) -> BenchmarkFixture {
    for chunk in 0..(GRID_NODES / 1_000) as usize {
        let mut nodes = benchmark_nodes(chunk);
        if include_images {
            for (offset, node) in nodes.iter_mut().enumerate() {
                let i = (chunk * 1_000 + offset) as u32;
                if i.is_multiple_of(IMAGE_STRIDE) {
                    node.kind = "image".to_owned();
                }
            }
        }
        db.insert_nodes(nodes).expect("insert benchmark nodes");
    }

    // Each row has 99 right-neighbor connectors; the last card has none.
    for chunk in 0..(GRID_NODES / 1_000) as usize {
        let mut edges = Vec::with_capacity(1_000);
        for offset in 0..1_000usize {
            let i = chunk * 1_000 + offset;
            if i % ROW_NODES as usize == (ROW_NODES - 1) as usize {
                continue;
            }
            edges.push(EdgeInput {
                id: format!("e{i}"),
                from_id: format!("n{i}"),
                to_id: format!("n{}", i + 1),
                from_port: "text".to_owned(),
                to_port: "prompt".to_owned(),
                port_kind: "text".to_owned(),
                from_offset: 42.0,
                to_offset: 28.0,
                kind: "flow".to_owned(),
                data_json: None,
            });
        }
        db.insert_edges(edges).expect("insert benchmark edges");
    }

    let mut fixture = BenchmarkFixture {
        version: FIXTURE_VERSION,
        nodes: GRID_NODES,
        edges: GRID_NODES - GRID_ROWS,
        images: 0,
        batches: 0,
        items: 0,
        assets: 0,
        path: path.to_owned(),
    };

    if include_images {
        for k in 0..IMAGE_NODES {
            let image_index = k * IMAGE_STRIDE;
            let asset_id = format!("bench-asset-{image_index}");
            db.import_asset(AssetInput {
                id: asset_id.clone(),
                kind: "image".to_owned(),
                name: format!("bench-image-{image_index}.png"),
                mime: "image/png".to_owned(),
                bytes: benchmark_png(image_index),
                meta_json: Some(format!(r#"{{"image_index":{image_index}}}"#)),
            })
            .expect("import benchmark image asset");

            let batch_id = format!("bench-batch-{image_index}");
            let items = (0..IMAGE_ITEMS)
                .map(|position| ResultItemInput {
                    id: format!("bench-item-{image_index}-{position}"),
                    position: position as f64,
                    port_id: "out".to_owned(),
                    kind: "image".to_owned(),
                    text: format!("Image {image_index} variant {position}"),
                    asset_id: Some(asset_id.clone()),
                    meta_json: Some(format!(
                        r#"{{"image_index":{image_index},"variant":{position}}}"#
                    )),
                })
                .collect();
            db.save_run(
                ResultBatchInput {
                    id: batch_id,
                    node_id: format!("n{image_index}"),
                    trigger: "run".to_owned(),
                    provider: "mock-image".to_owned(),
                    model: "mock-image".to_owned(),
                    params_json: "{}".to_owned(),
                    status: "done".to_owned(),
                    error: None,
                },
                items,
            )
            .expect("save benchmark image batch");

            fixture.images += 1;
            fixture.batches += 1;
            fixture.items += IMAGE_ITEMS as u32;
            fixture.assets += 1;
        }
    }

    db.clear_history().expect("clear seed history");
    fixture
}

fn verify_fixture(db: &Database, fixture: &BenchmarkFixture, include_images: bool) {
    assert_eq!(
        db.count().expect("count fixture nodes"),
        fixture.nodes,
        "fixture node count"
    );
    assert_eq!(
        db.edge_count().expect("count fixture edges"),
        fixture.edges,
        "fixture edge count"
    );

    let ids = image_node_ids();
    assert_eq!(ids.len(), IMAGE_NODES as usize, "fixture image id count");
    let previews = db.previews(ids.clone()).expect("read fixture previews");
    if include_images {
        let (rows, items, assets) = validate_previews(&previews, &ids, "fixture");
        assert_eq!(rows, IMAGE_NODES as usize, "fixture image preview rows");
        assert_eq!(
            items,
            (IMAGE_NODES * IMAGE_ITEMS as u32) as usize,
            "fixture image item rows"
        );
        assert_eq!(
            assets, IMAGE_NODES as usize,
            "fixture distinct image assets"
        );
        let bytes = db
            .asset_bytes("bench-asset-0".to_owned())
            .expect("read fixture asset bytes");
        assert_eq!(bytes, benchmark_png(0), "fixture asset bytes round-trip");
    } else {
        assert!(
            previews.is_empty(),
            "the no-image fixture must return zero preview rows"
        );
        assert_eq!(fixture.images, 0, "no-image fixture image nodes");
        assert_eq!(fixture.batches, 0, "no-image fixture image batches");
    }
}

/// Checks the preview shape the card views rely on and returns the
/// preview row, item row and distinct asset counts.
fn validate_previews(
    previews: &[NodePreview],
    requested: &[String],
    label: &str,
) -> (usize, usize, usize) {
    assert_eq!(
        previews.len(),
        requested.len(),
        "{label}: returned preview rows"
    );
    let mut missing: BTreeSet<&str> = requested.iter().map(String::as_str).collect();
    let mut item_rows = 0;
    let mut asset_ids = BTreeSet::new();
    for preview in previews {
        assert_eq!(
            preview.item_count, IMAGE_ITEMS as f64,
            "{label}: {} item_count",
            preview.node_id
        );
        assert_eq!(
            preview.items.len(),
            IMAGE_ITEMS,
            "{label}: {} preview item rows",
            preview.node_id
        );
        assert!(
            missing.remove(preview.node_id.as_str()),
            "{label}: unexpected or repeated preview {}",
            preview.node_id
        );
        for item in &preview.items {
            assert_eq!(
                item.kind, "image",
                "{label}: {} item {} kind",
                preview.node_id, item.id
            );
            let asset_id = item.asset_id.as_ref().unwrap_or_else(|| {
                panic!("{label}: {} item {} asset id", preview.node_id, item.id)
            });
            let asset = item.asset.as_ref().unwrap_or_else(|| {
                panic!(
                    "{label}: {} item {} asset metadata",
                    preview.node_id, item.id
                )
            });
            assert_eq!(
                &asset.id, asset_id,
                "{label}: {} item {} asset link",
                preview.node_id, item.id
            );
            item_rows += 1;
            asset_ids.insert(asset.id.clone());
        }
    }
    assert!(
        missing.is_empty(),
        "{label}: missing requested image ids {missing:?}"
    );
    (previews.len(), item_rows, asset_ids.len())
}

struct Stats {
    avg_ms: f64,
    p95_ms: f64,
    max_ms: f64,
}

/// Nearest-rank p95: `ceil(0.95 * n)` as the one-based rank.
fn stats(samples: &mut [f64]) -> Stats {
    assert!(!samples.is_empty(), "a scenario needs at least one sample");
    samples.sort_by(f64::total_cmp);
    let count = samples.len();
    // Nearest rank is ceil(0.95 * n); the one-based rank minus one indexes
    // the sorted samples. `count >= 1` keeps the result in range.
    let p95_index = (count * 95).div_ceil(100).saturating_sub(1).min(count - 1);
    Stats {
        avg_ms: samples.iter().sum::<f64>() / count as f64,
        p95_ms: samples[p95_index],
        max_ms: samples[count - 1],
    }
}

fn print_stats(label: &str, samples: &mut [f64], detail: &str) {
    let count = samples.len();
    let stats = stats(samples);
    println!(
        "{label}: n={count} avg={:.2}ms p95={:.2}ms max={:.2}ms{detail}",
        stats.avg_ms, stats.p95_ms, stats.max_ms
    );
}

fn elapsed_ms(started: std::time::Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// Mirrors `camera.fit` in `src/flow/canvas/model/camera.ts`: 48 points of padding on
/// a 1920x1080 stage, capped at 1 and clamped to the 0.05 minimum.
fn fit_scale(bounds: &Viewport) -> (f64, f64) {
    let available_width = (1920.0f64 - 48.0 * 2.0).max(1.0);
    let available_height = (1080.0f64 - 48.0 * 2.0).max(1.0);
    let raw = (available_width / bounds.width).min(available_height / bounds.height);
    (raw.clamp(0.05, 1.0), raw)
}

/// The world rectangle a centered Fit camera shows, expanded by the same
/// `max(width, height) * 0.25` margin as the TSX viewport controller.
fn scene_request(bounds: &Viewport, scale: f64) -> (Viewport, f64) {
    let padding = 48.0;
    let camera_x = 960.0 - (bounds.x + bounds.width / 2.0) * scale;
    let camera_y = 540.0 - (bounds.y + bounds.height / 2.0) * scale;
    let x = (-padding - camera_x) / scale;
    let y = (-padding - camera_y) / scale;
    let width = (1920.0 + padding - camera_x) / scale - x;
    let height = (1080.0 + padding - camera_y) / scale - y;
    let margin = width.max(height) * 0.25;
    (
        Viewport {
            x,
            y,
            width,
            height,
        },
        margin,
    )
}

fn measure_viewport(
    db: &Database,
    label: &str,
    rect: &Viewport,
    margin: f64,
    samples: usize,
) -> usize {
    let warmup = db.viewport(rect.clone(), margin).expect("viewport warmup");
    assert!(
        !warmup.is_empty(),
        "{label}: the viewport returned no nodes"
    );
    let rows = warmup.len();
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = std::time::Instant::now();
        let found = db.viewport(rect.clone(), margin).expect("viewport sample");
        times.push(elapsed_ms(started));
        assert_eq!(
            found.len(),
            rows,
            "{label}: node rows changed between identical reads"
        );
    }
    print_stats(
        label,
        &mut times,
        &format!(
            " rect=({:.1},{:.1},{:.1},{:.1}) margin={margin:.1} nodes={rows}",
            rect.x, rect.y, rect.width, rect.height
        ),
    );
    rows
}

fn measure_scene(
    db: &Database,
    label: &str,
    rect: &Viewport,
    margin: f64,
    scale: f64,
    samples: usize,
) -> (usize, usize) {
    // The same card budget the canvas passes at this camera scale.
    let max_cards = if scale < 0.15 {
        300
    } else if scale < 0.4 {
        800
    } else {
        2_000
    };
    let warmup = db
        .scene(rect.clone(), margin, max_cards)
        .expect("scene warmup");
    assert!(
        !warmup.nodes.is_empty(),
        "{label}: the scene returned no nodes"
    );
    let (nodes, edges) = (warmup.nodes.len(), warmup.edges.len());
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = std::time::Instant::now();
        let snapshot = db
            .scene(rect.clone(), margin, max_cards)
            .expect("scene sample");
        times.push(elapsed_ms(started));
        assert_eq!(
            snapshot.nodes.len(),
            nodes,
            "{label}: node rows changed between identical reads"
        );
        assert_eq!(
            snapshot.edges.len(),
            edges,
            "{label}: edge rows changed between identical reads"
        );
    }
    print_stats(
        label,
        &mut times,
        &format!(
            " scale={scale:.4} rect=({:.1},{:.1},{:.1},{:.1}) margin={margin:.1} nodes={nodes} edges={edges}",
            rect.x, rect.y, rect.width, rect.height
        ),
    );
    (nodes, edges)
}

fn measure_previews(db: &Database, ids: &[String], samples: usize) -> (usize, usize, usize) {
    let label = format!("previews images={}", ids.len());
    let warmup = db.previews(ids.to_vec()).expect("preview warmup");
    let (rows, items, assets) = validate_previews(&warmup, ids, &label);
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = std::time::Instant::now();
        let previews = db.previews(ids.to_vec()).expect("preview sample");
        times.push(elapsed_ms(started));
        let (sampled_rows, sampled_items, sampled_assets) =
            validate_previews(&previews, ids, &label);
        assert_eq!(
            (sampled_rows, sampled_items, sampled_assets),
            (rows, items, assets),
            "{label}: preview shape changed between identical reads"
        );
    }
    print_stats(
        &label,
        &mut times,
        &format!(" rows={rows} items={items} assets={assets}"),
    );
    (rows, items, assets)
}

/// Paired before/after read of one preview request on the same unchanged
/// database; the pre-bounded reader is the result oracle.
fn measure_preview_readers(db: &Database, ids: &[String], samples: usize) {
    let expected = db
        .run({
            let ids = ids.to_vec();
            move |conn| detail::previews_reference(conn, ids)
        })
        .expect("reference preview warmup");
    let (rows, items, assets) = validate_previews(&expected, ids, "preview readers");
    assert_eq!(
        db.previews(ids.to_vec()).expect("bounded preview warmup"),
        expected,
        "the bounded preview reader changed the result"
    );

    let mut old_times = Vec::with_capacity(samples);
    let mut new_times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = std::time::Instant::now();
        let old = db
            .run({
                let ids = ids.to_vec();
                move |conn| detail::previews_reference(conn, ids)
            })
            .expect("reference preview sample");
        old_times.push(elapsed_ms(started));
        assert_eq!(old, expected, "the reference preview reader is stable");

        let started = std::time::Instant::now();
        let bounded = db.previews(ids.to_vec()).expect("bounded preview sample");
        new_times.push(elapsed_ms(started));
        assert_eq!(bounded, expected, "the bounded preview reader is stable");
    }
    let detail = format!(
        " images={} rows={rows} items={items} assets={assets}",
        ids.len()
    );
    print_stats("old_preview_reader", &mut old_times, &detail);
    print_stats("bounded_preview_reader", &mut new_times, &detail);
}

/// Both startup emptiness predicates on the same unchanged database. The
/// historical count pair is the reference; `is_empty` is one worker call
/// with two existence reads.
fn measure_startup_empty(db: &Database, samples: usize) -> bool {
    let nodes = db.count().expect("startup node count");
    let edges = db.edge_count().expect("startup edge count");
    let detail = format!(" fixture nodes={nodes} edges={edges} unchanged");
    let mut count_times = Vec::with_capacity(samples);
    let mut empty_times = Vec::with_capacity(samples);
    let mut historical = false;
    let mut current = false;
    for _ in 0..samples {
        let started = std::time::Instant::now();
        historical = db.count().expect("startup count") == 0
            && db.edge_count().expect("startup edge count") == 0;
        count_times.push(elapsed_ms(started));

        let started = std::time::Instant::now();
        current = db.is_empty().expect("startup emptiness");
        empty_times.push(elapsed_ms(started));
    }
    assert_eq!(
        historical, current,
        "the count pair and is_empty disagree about startup emptiness"
    );
    print_stats(
        "startup emptiness count reference",
        &mut count_times,
        &detail,
    );
    print_stats("startup emptiness is_empty", &mut empty_times, &detail);
    current
}

fn node_bounds(db: &Database, id: &str) -> NodeBounds {
    let summary = db
        .get_node(id.to_owned())
        .expect("read node bounds")
        .expect("the node exists");
    NodeBounds {
        id: summary.id,
        x: summary.x,
        y: summary.y,
        width: summary.width,
        height: summary.height,
    }
}

fn shifted(bounds: &NodeBounds, dx: f64, dy: f64) -> NodeBounds {
    NodeBounds {
        id: bounds.id.clone(),
        x: bounds.x + dx,
        y: bounds.y + dy,
        width: bounds.width,
        height: bounds.height,
    }
}

fn assert_bounds(db: &Database, expected: &[NodeBounds], context: &str) {
    for bounds in expected {
        assert_eq!(
            node_bounds(db, &bounds.id),
            *bounds,
            "{context}: {}",
            bounds.id
        );
    }
}

/// Runs the evidence pass outside the timed section: an interior edge has
/// two moved ports, and the two boundary edges keep their far ports where
/// they were. The mutation's own `edges_changed` is deliberately empty.
fn validate_moved_connectors(
    db: &Database,
    target: &[NodeBounds],
    far_before: &[NodeBounds],
    cycle: usize,
) {
    let moved = |id: &str| -> NodeBounds {
        target
            .iter()
            .find(|bounds| bounds.id == id)
            .expect("moved node")
            .clone()
    };
    let far = |id: &str| -> NodeBounds {
        far_before
            .iter()
            .find(|bounds| bounds.id == id)
            .expect("unmoved node")
            .clone()
    };

    let row = db
        .scene(
            Viewport {
                x: -100.0,
                y: 68_500.0,
                width: 1_000.0,
                height: 600.0,
            },
            0.0,
            viewport::NODE_LIMIT,
        )
        .expect("scene over the moved row");
    let interior = row
        .edges
        .iter()
        .find(|edge| edge.id == "e49001")
        .expect("interior edge e49001");
    let from = moved("n49001");
    let to = moved("n49002");
    assert_eq!(
        interior.from_point,
        Some(EdgePoint::output(
            from.x,
            from.y,
            from.width,
            from.height / 2.0
        )),
        "cycle {cycle}: interior from port"
    );
    assert_eq!(
        interior.to_point,
        Some(EdgePoint::input(to.x, to.y, to.height / 3.0)),
        "cycle {cycle}: interior to port"
    );

    let crossing = row
        .edges
        .iter()
        .find(|edge| edge.id == "e49000")
        .expect("boundary edge e49000");
    let far_from = far("n49000");
    let moved_to = moved("n49001");
    assert_eq!(
        crossing.from_point,
        Some(EdgePoint::output(
            far_from.x,
            far_from.y,
            far_from.width,
            far_from.height / 2.0
        )),
        "cycle {cycle}: boundary far from port"
    );
    assert_eq!(
        crossing.to_point,
        Some(EdgePoint::input(
            moved_to.x,
            moved_to.y,
            moved_to.height / 3.0
        )),
        "cycle {cycle}: boundary moved to port"
    );

    let end = db
        .scene(
            Viewport {
                x: -100.0,
                y: 69_900.0,
                width: 1_000.0,
                height: 600.0,
            },
            0.0,
            viewport::NODE_LIMIT,
        )
        .expect("scene over the last moved row");
    let boundary = end
        .edges
        .iter()
        .find(|edge| edge.id == "e50000")
        .expect("boundary edge e50000");
    let moved_from = moved("n50000");
    let far_to = far("n50001");
    assert_eq!(
        boundary.from_point,
        Some(EdgePoint::output(
            moved_from.x,
            moved_from.y,
            moved_from.width,
            moved_from.height / 2.0
        )),
        "cycle {cycle}: boundary moved from port"
    );
    assert_eq!(
        boundary.to_point,
        Some(EdgePoint::input(far_to.x, far_to.y, far_to.height / 3.0)),
        "cycle {cycle}: boundary far to port"
    );

    assert_bounds(db, far_before, &format!("cycle {cycle} far endpoints"));
}

fn run_move_cycles(db: &Database) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    // Offset by one card from a row start so both the first and last
    // cards have a connector to an unmoved neighbor.
    let ids: Vec<String> = (49_001..=50_000).map(|i| format!("n{i}")).collect();
    let far_ids = ["n49000", "n50001"];

    let warm_before: Vec<NodeBounds> = ids.iter().map(|id| node_bounds(db, id)).collect();
    let warm_target: Vec<NodeBounds> = warm_before
        .iter()
        .map(|bounds| shifted(bounds, 10.0, 10.0))
        .collect();
    db.set_node_bounds(warm_target).expect("warm move");
    db.undo().expect("warm undo");
    assert_bounds(db, &warm_before, "warmup undo");
    db.clear_history().expect("clear warmup history");
    println!("setNodeBounds moved=1000: one warmup on (+10,+10), undone, history cleared");

    let mut move_times = Vec::with_capacity(MOVE_SAMPLES);
    let mut undo_times = Vec::with_capacity(MOVE_SAMPLES);
    let mut redo_times = Vec::with_capacity(MOVE_SAMPLES);
    for cycle in 0..MOVE_SAMPLES {
        let before: Vec<NodeBounds> = ids.iter().map(|id| node_bounds(db, id)).collect();
        let far_before: Vec<NodeBounds> = far_ids.iter().map(|id| node_bounds(db, id)).collect();
        let dx = 31.0 + cycle as f64;
        let dy = 20.0;
        let target: Vec<NodeBounds> = before
            .iter()
            .map(|bounds| shifted(bounds, dx, dy))
            .collect();

        let started = std::time::Instant::now();
        let moved = db.set_node_bounds(target.clone()).expect("move bounds");
        move_times.push(elapsed_ms(started));
        assert_eq!(
            moved.changes.changed.len(),
            ids.len(),
            "cycle {cycle}: moved summaries"
        );
        for (actual, expected) in moved.changes.changed.iter().zip(target.iter()) {
            assert_eq!(actual.id, expected.id, "cycle {cycle}: moved id");
            assert_eq!(
                (actual.x, actual.y, actual.width, actual.height),
                (expected.x, expected.y, expected.width, expected.height),
                "cycle {cycle}: moved geometry {}",
                expected.id
            );
        }
        validate_moved_connectors(db, &target, &far_before, cycle);

        let started = std::time::Instant::now();
        let undone = db.undo().expect("undo move");
        undo_times.push(elapsed_ms(started));
        assert_eq!(
            undone.changed.len(),
            ids.len(),
            "cycle {cycle}: undone summaries"
        );
        assert_bounds(db, &before, &format!("cycle {cycle} undo"));

        let started = std::time::Instant::now();
        let redone = db.redo().expect("redo move");
        redo_times.push(elapsed_ms(started));
        assert_eq!(
            redone.changed.len(),
            ids.len(),
            "cycle {cycle}: redone summaries"
        );
        assert_bounds(db, &target, &format!("cycle {cycle} redo"));

        // Reset outside the timed section, then drop the reset's own
        // history entry so every cycle starts with exactly one move on
        // the stack.
        db.set_node_bounds(before.clone()).expect("reset bounds");
        db.clear_history().expect("clear reset history");
        println!(
            "setNodeBounds moved=1000 cycle={cycle} offset=({dx:.0},{dy:.0}) move={:.2}ms undo={:.2}ms redo={:.2}ms",
            move_times[cycle], undo_times[cycle], redo_times[cycle]
        );
    }
    (move_times, undo_times, redo_times)
}

fn measure_search(db: &Database, label: &str, query: &str, samples: usize) -> usize {
    let warmup = db
        .search(query.to_owned(), SearchFilters::default(), 20)
        .expect("search warmup");
    let hits = warmup.len();
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = std::time::Instant::now();
        let found = db
            .search(query.to_owned(), SearchFilters::default(), 20)
            .expect("search sample");
        times.push(elapsed_ms(started));
        assert_eq!(
            found.len(),
            hits,
            "{label}: result count changed between identical queries"
        );
    }
    print_stats(label, &mut times, &format!(" hits={hits} query={query}"));
    hits
}

fn mark_running(db: &Database, iteration: u32, ids: &[String]) {
    for (k, id) in ids.iter().enumerate() {
        let batch_id = format!("bench-recover-{iteration}-{k}");
        db.save_run(
            ResultBatchInput {
                id: batch_id.clone(),
                node_id: id.clone(),
                trigger: "run".to_owned(),
                provider: "mock-text".to_owned(),
                model: "mock-text".to_owned(),
                params_json: "{}".to_owned(),
                status: "running".to_owned(),
                error: None,
            },
            Vec::new(),
        )
        .expect("mark a sink node running");
        let detail = db
            .node_detail(id.clone())
            .expect("read the running node")
            .expect("the running node exists");
        assert_eq!(
            detail.node.status, "running",
            "recovery {iteration}: {id} status before reopen"
        );
        let latest = detail.latest_batch.expect("the running batch exists");
        assert_eq!(
            latest.id, batch_id,
            "recovery {iteration}: {id} latest batch id"
        );
        assert_eq!(
            latest.status, "running",
            "recovery {iteration}: {id} latest batch status"
        );
    }
}

fn verify_recovered(db: &Database, ids: &[String], iteration: u32) {
    for id in ids {
        let detail = db
            .node_detail(id.clone())
            .expect("read the recovered node")
            .expect("the recovered node exists");
        assert_eq!(
            detail.node.status, "interrupted",
            "recovery {iteration}: {id} node status"
        );
        let latest = detail.latest_batch.expect("the recovered batch exists");
        assert_eq!(
            latest.status, "interrupted",
            "recovery {iteration}: {id} batch status"
        );
    }
}

#[test]
fn benchmark_stats_use_nearest_rank_p95() {
    let mut five = [1.0, 2.0, 3.0, 4.0, 100.0];
    let summary = stats(&mut five);
    assert_eq!(summary.avg_ms, 22.0);
    assert_eq!(summary.p95_ms, 100.0);
    assert_eq!(summary.max_ms, 100.0);

    let mut twenty: Vec<f64> = (1..=20).map(f64::from).collect();
    let summary = stats(&mut twenty);
    assert_eq!(summary.avg_ms, 10.5);
    assert_eq!(summary.p95_ms, 19.0);
    assert_eq!(summary.max_ms, 20.0);
}

#[test]
fn benchmark_png_is_a_deterministic_2x2_rgba_png() {
    let png = benchmark_png(0);
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(&png[12..16], b"IHDR");
    assert_eq!(
        u32::from_be_bytes(png[16..20].try_into().expect("IHDR width")),
        2
    );
    assert_eq!(
        u32::from_be_bytes(png[20..24].try_into().expect("IHDR height")),
        2
    );
    assert_eq!(png[24], 8, "bit depth");
    assert_eq!(png[25], 6, "colour type RGBA");
    assert_eq!(crc32(b"IEND"), 0xAE42_6082, "known CRC32 vector");
    assert_eq!(png, benchmark_png(0), "deterministic bytes");
    assert_ne!(png, benchmark_png(50), "distinct image indices");
}

#[test]
#[ignore = "writes the 100k UI fixture; set FLOW_BENCH_DB=<path>"]
fn seed_benchmark_database() {
    let Ok(path) = std::env::var("FLOW_BENCH_DB") else {
        println!("FLOW_BENCH_DB is not set; skipping the 100k fixture");
        return;
    };
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).expect("create parent directory");
    }
    // Destructive re-seed for the dedicated benchmark database only: the
    // smoke recreates it on every run. Never point FLOW_BENCH_DB at an
    // ordinary FLOW_DB_PATH document.
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{path}{suffix}"));
    }

    let db = Database::open(&path).expect("open benchmark database");
    let fixture = seed_grid(&db, false, &path);
    verify_fixture(&db, &fixture, false);
    print_fixture(&fixture, false);
    println!(
        "100k fixture seed: the smoke shares the {} node / {} edge text graph but leaves image nodes as text",
        fixture.nodes, fixture.edges
    );
}

#[test]
#[ignore = "100k enriched benchmark; run with --release -- --ignored --nocapture --test-threads=1"]
fn hundred_thousand_nodes_benchmark() {
    let temp = BenchmarkTempDir::new();
    let path = temp.database_path();

    let seed_started = std::time::Instant::now();
    let fixture = {
        let db = Database::open(&path).expect("open the fixture database");
        let fixture = seed_grid(&db, true, &path);
        verify_fixture(&db, &fixture, true);
        fixture
    };
    let seed_ms = elapsed_ms(seed_started);
    print_fixture(&fixture, true);
    println!("100k fixture seed (open+insert+assets+batches)={seed_ms:.2}ms");

    let mut db = Database::open(&path).expect("reopen the seeded fixture");
    assert_eq!(
        db.count().expect("reopened node count"),
        GRID_NODES,
        "reopened fixture node count"
    );
    assert_eq!(
        db.edge_count().expect("reopened edge count"),
        GRID_NODES - GRID_ROWS,
        "reopened fixture edge count"
    );
    assert!(
        !measure_startup_empty(&db, SCENE_SAMPLES),
        "the seeded fixture is not empty"
    );

    let bounds_started = std::time::Instant::now();
    let bounds = db.bounds().expect("measure document bounds");
    let bounds_ms = elapsed_ms(bounds_started);
    assert!(bounds.width > 0.0 && bounds.height > 0.0);
    println!("bounds (Fit source): {bounds:?} read={bounds_ms:.2}ms");

    // The startup order: Fit reads the bounds, then the minimap's overview
    // at the same revision reuses them and reads the capped sample.
    let overview_started = std::time::Instant::now();
    let overview = db.overview().expect("measure document overview");
    let overview_ms = elapsed_ms(overview_started);
    assert_eq!(overview.cards.len() as u64, crate::scene::OVERVIEW_LIMIT);
    println!(
        "overview (minimap, bounds cached): cards={} read={overview_ms:.2}ms",
        overview.cards.len()
    );

    let legacy_rect = Viewport {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    measure_viewport(
        &db,
        "legacy viewport scale=1.0000 (reference; edges and images present)",
        &legacy_rect,
        120.0,
        SCENE_SAMPLES,
    );
    measure_scene(
        &db,
        "legacy scene scale=1.0000 (reference; edges and images present)",
        &legacy_rect,
        120.0,
        1.0,
        SCENE_SAMPLES,
    );

    let (fit, fit_raw) = fit_scale(&bounds);
    println!(
        "camera fit: raw={fit_raw:.6} scale={fit:.6} clamp={}",
        if fit_raw < 0.05 {
            "MIN_SCALE 0.05"
        } else if fit_raw > 1.0 {
            "MAX_SCALE 1.0"
        } else {
            "none"
        }
    );
    let scales = [
        (format!("scene fit={fit:.4}"), fit),
        ("scene scale=0.15".to_owned(), 0.15),
        ("scene scale=0.40".to_owned(), 0.40),
    ];
    for (label, scale) in scales {
        let (rect, margin) = scene_request(&bounds, scale);
        measure_scene(&db, &label, &rect, margin, scale, SCENE_SAMPLES);
    }

    let image_ids = image_node_ids();
    measure_previews(&db, &image_ids, SCENE_SAMPLES);
    measure_preview_readers(&db, &image_ids, SCENE_SAMPLES);

    db.clear_history()
        .expect("clear history before move timing");
    println!("setNodeBounds moved=1000: history cleared immediately before timing");
    let (mut move_times, mut undo_times, mut redo_times) = run_move_cycles(&db);
    print_stats(
        "setNodeBounds moved=1000",
        &mut move_times,
        " nodes=1000 samples=3",
    );
    print_stats("undo moved=1000", &mut undo_times, " nodes=1000 samples=3");
    print_stats("redo moved=1000", &mut redo_times, " nodes=1000 samples=3");

    assert!(measure_search(&db, "search generator", "generator", SEARCH_COMMON_SAMPLES) > 0);
    assert!(measure_search(&db, "search Node 99999", "Node 99999", SEARCH_SAMPLES) > 0);
    assert!(measure_search(&db, "search 图片", "图片", SEARCH_SAMPLES) > 0);
    assert!(measure_search(&db, "search 生成器", "生成器", SEARCH_SAMPLES) > 0);

    let sinks = sink_node_ids();
    assert_eq!(sinks.len(), 100, "recovery sink count");
    for id in &sinks {
        let summary = db
            .get_node(id.clone())
            .expect("read recovery sink")
            .expect("the recovery sink exists");
        assert_eq!(summary.kind, "text", "recovery sink {id} kind");
        assert!(id.ends_with("99"), "recovery sink {id} is a row end");
    }
    println!(
        "recovery sinks: {} row-end text nodes first={} last={} (every tenth row; the grid ends at n99999)",
        sinks.len(),
        sinks.first().expect("the first sink"),
        sinks.last().expect("the last sink")
    );

    let mut recover_times = Vec::with_capacity(RECOVERY_ITERATIONS as usize);
    for iteration in 0..RECOVERY_ITERATIONS {
        mark_running(&db, iteration, &sinks);
        drop(db);

        let open_started = std::time::Instant::now();
        db = Database::open(&path).expect("reopen for recovery");
        let open_ms = elapsed_ms(open_started);

        let recover_started = std::time::Instant::now();
        let recovered = db.recover_runs().expect("recover running nodes");
        let recover_ms = elapsed_ms(recover_started);
        recover_times.push(recover_ms);
        assert_eq!(
            recovered,
            sinks.len() as u32,
            "recovery iteration {iteration}: recovered rows"
        );
        verify_recovered(&db, &sinks, iteration);
        let second = db.recover_runs().expect("second recovery");
        assert_eq!(
            second, 0,
            "recovery iteration {iteration}: second recovery finds no running rows"
        );
        println!(
            "recovery iteration={iteration} batch_prefix=bench-recover-{iteration}- open/migrate only={open_ms:.2}ms recover_runs={recover_ms:.2}ms open+recover={:.2}ms recovered={recovered} second={second}",
            open_ms + recover_ms
        );
    }
    print_stats(
        "recover_runs populated-running",
        &mut recover_times,
        " 100 row-end nodes marked running before each fresh reopen; the clean second call is not compared",
    );

    drop(db);
    let db = Database::open(&path).expect("final clean reopen");
    assert_eq!(
        db.count().expect("final reopen node count"),
        GRID_NODES,
        "final reopen node count"
    );
    assert_eq!(
        db.edge_count().expect("final reopen edge count"),
        GRID_NODES - GRID_ROWS,
        "final reopen edge count"
    );
    let previews = db
        .previews(image_ids.clone())
        .expect("final reopen previews");
    assert_eq!(
        previews.len(),
        IMAGE_NODES as usize,
        "final reopen image previews"
    );
    assert_eq!(
        db.recover_runs().expect("final recovery"),
        0,
        "final reopen has no running rows"
    );
    let gc_started = std::time::Instant::now();
    let report = db.gc().expect("package collection");
    println!(
        "maintenance gc: elapsed={:.2}ms batches={:.0} items={:.0} assets={:.0} files={:.0}",
        gc_started.elapsed().as_secs_f64() * 1000.0,
        report.batches,
        report.items,
        report.assets,
        report.files
    );
    let compact_started = std::time::Instant::now();
    db.compact_bounds().expect("bounds compaction");
    println!(
        "maintenance compactBounds: elapsed={:.2}ms",
        compact_started.elapsed().as_secs_f64() * 1000.0
    );
    drop(db);

    let cleaned = temp.path_string();
    drop(temp);
    println!("100k fixture cleanup: removed {cleaned}");
}

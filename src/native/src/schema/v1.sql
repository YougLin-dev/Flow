-- Flow release schema v1, frozen. The opener sets PRAGMA application_id =
-- 1179406167 and PRAGMA user_version = 1 inside the same transaction that
-- executes this script.

CREATE TABLE document (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  project_id     TEXT    NOT NULL UNIQUE
                 CHECK (length(project_id) = 32
                        AND project_id NOT GLOB '*[^0-9a-f]*'),
  title          TEXT    NOT NULL DEFAULT 'Flow'
                 CHECK (length(trim(title, ' ' || char(9) || char(10) || char(13))) > 0),
  rev            INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  node_count     INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  edge_count     INTEGER NOT NULL DEFAULT 0 CHECK (edge_count >= 0),
  demo_seeded    INTEGER NOT NULL DEFAULT 0 CHECK (demo_seeded IN (0, 1)),
  clean_shutdown INTEGER NOT NULL DEFAULT 0 CHECK (clean_shutdown IN (0, 1)),
  min_x          REAL,
  max_x          REAL,
  min_y          REAL,
  max_y          REAL,
  bounds_exact   INTEGER NOT NULL DEFAULT 1 CHECK (bounds_exact IN (0, 1)),
  camera_x       REAL    NOT NULL DEFAULT 0.0
                 CHECK (camera_x >= -1.0e308 AND camera_x <= 1.0e308),
  camera_y       REAL    NOT NULL DEFAULT 0.0
                 CHECK (camera_y >= -1.0e308 AND camera_y <= 1.0e308),
  camera_zoom    REAL    NOT NULL DEFAULT 1.0
                 CHECK (camera_zoom > 0.0 AND camera_zoom < 1.0e308),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK ((min_x IS NULL AND max_x IS NULL AND min_y IS NULL AND max_y IS NULL)
      OR (min_x <= max_x AND min_y <= max_y)),
  CHECK (node_count > 0 OR (min_x IS NULL AND max_x IS NULL
                            AND min_y IS NULL AND max_y IS NULL))
) STRICT;

CREATE TABLE assets (
  id         TEXT PRIMARY KEY CHECK (length(id) > 0),
  hash       TEXT NOT NULL UNIQUE
             CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  kind       TEXT NOT NULL CHECK (length(kind) > 0),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL CHECK (length(mime) > 0),
  size       INTEGER NOT NULL CHECK (size >= 0),
  meta_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE result_batches (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  node_id      TEXT NOT NULL CHECK (length(node_id) > 0),
  node_seq     INTEGER NOT NULL CHECK (node_seq > 0),
  trigger      TEXT NOT NULL CHECK (trigger IN ('run', 'manual', 'upload')),
  provider     TEXT NOT NULL DEFAULT '' CHECK (length(provider) <= 128),
  model        TEXT NOT NULL DEFAULT '' CHECK (length(model) <= 128),
  params_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  status       TEXT NOT NULL
               CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'interrupted')),
  error        TEXT CHECK (error IS NULL OR length(error) <= 16384),
  item_count   INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  UNIQUE (id, node_id, node_seq),
  CHECK ((status = 'running' AND finished_at IS NULL)
      OR (status <> 'running' AND finished_at IS NOT NULL))
) STRICT;

CREATE TABLE nodes (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  kind            TEXT NOT NULL CHECK (length(kind) > 0),
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT ''
                  CHECK (tags = '' OR (substr(tags, 1, 1) <> char(10)
                    AND substr(tags, -1, 1) <> char(10)
                    AND instr(tags, char(10) || char(10)) = 0)),
  x               REAL NOT NULL
                  CHECK (x >= -10000000.0 AND x + width <= 10000000.0),
  y               REAL NOT NULL
                  CHECK (y >= -10000000.0 AND y + height <= 10000000.0),
  width           REAL NOT NULL CHECK (width > 0.0 AND width <= 1000000.0),
  height          REAL NOT NULL CHECK (height > 0.0 AND height <= 1000000.0),
  z               REAL NOT NULL CHECK (z >= -1000000.0 AND z <= 1000000.0),
  data_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  settings_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  status          TEXT NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle', 'stale', 'running', 'done',
                                    'failed', 'cancelled', 'interrupted')),
  output_batch_id TEXT,
  rev             INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK (status NOT IN ('done', 'stale') OR output_batch_id IS NOT NULL),
  CHECK (status <> 'idle' OR output_batch_id IS NULL),
  FOREIGN KEY (output_batch_id, id, seq)
    REFERENCES result_batches (id, node_id, node_seq)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE edges (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  from_id     TEXT NOT NULL CHECK (length(from_id) > 0),
  to_id       TEXT NOT NULL CHECK (length(to_id) > 0),
  from_port   TEXT NOT NULL CHECK (length(from_port) > 0),
  to_port     TEXT NOT NULL CHECK (length(to_port) > 0),
  port_kind   TEXT NOT NULL CHECK (length(port_kind) > 0),
  from_offset REAL NOT NULL CHECK (from_offset >= 0.0 AND from_offset <= 1000000.0),
  to_offset   REAL NOT NULL CHECK (to_offset >= 0.0 AND to_offset <= 1000000.0),
  kind        TEXT NOT NULL DEFAULT 'flow' CHECK (length(kind) > 0),
  data_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  CHECK (from_id <> to_id),
  FOREIGN KEY (from_id) REFERENCES nodes (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (to_id) REFERENCES nodes (id) ON DELETE CASCADE ON UPDATE CASCADE
) STRICT;

CREATE TABLE result_items (
  id        TEXT PRIMARY KEY CHECK (length(id) > 0),
  batch_id  TEXT NOT NULL,
  position  INTEGER NOT NULL CHECK (position >= 0),
  port_id   TEXT NOT NULL CHECK (length(port_id) > 0),
  kind      TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  text      TEXT NOT NULL DEFAULT '',
  asset_id  TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  UNIQUE (batch_id, port_id, position),
  FOREIGN KEY (batch_id) REFERENCES result_batches (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (kind <> 'image' OR asset_id IS NOT NULL)
) STRICT;

CREATE TABLE node_inputs (
  id         TEXT PRIMARY KEY CHECK (length(id) > 0),
  node_id    TEXT NOT NULL,
  port_id    TEXT NOT NULL CHECK (length(port_id) > 0),
  position   INTEGER NOT NULL CHECK (position >= 0),
  kind       TEXT NOT NULL CHECK (kind IN ('text', 'image')),
  origin     TEXT NOT NULL CHECK (origin IN ('edge', 'local')),
  edge_id    TEXT,
  item_id    TEXT,
  asset_id   TEXT,
  text       TEXT NOT NULL DEFAULT '',
  meta_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (node_id, port_id, position),
  FOREIGN KEY (node_id) REFERENCES nodes (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (edge_id) REFERENCES edges (id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (item_id) REFERENCES result_items (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((origin = 'edge' AND edge_id IS NOT NULL AND item_id IS NOT NULL)
      OR (origin = 'local' AND edge_id IS NULL AND item_id IS NULL AND asset_id IS NOT NULL)),
  CHECK (kind <> 'image' OR asset_id IS NOT NULL)
) STRICT;

CREATE TABLE nodes_geometry_dirty (node_id TEXT PRIMARY KEY) STRICT;

CREATE VIRTUAL TABLE nodes_rtree USING rtree (id, min_x, max_x, min_y, max_y);
CREATE VIRTUAL TABLE edges_rtree USING rtree (id, min_x, max_x, min_y, max_y);

CREATE VIRTUAL TABLE nodes_fts USING fts5 (
  title,
  body,
  tags,
  content = 'nodes',
  content_rowid = 'seq',
  tokenize = 'trigram'
);

-- The box of the cubic exactly as the canvas draws it: the port centres are
-- PORT_CENTER_GAP (14) outside the card edges, and EDGE_PADDING (4) covers the
-- stroke. The Rust connection_bounds oracle must mirror this definition.
CREATE VIEW edge_boxes AS
WITH ports AS (
  SELECT e.seq AS id,
         f.x + f.width + 14.0 AS from_x,
         f.y + e.from_offset AS from_y,
         t.x - 14.0 AS to_x,
         t.y + e.to_offset AS to_y,
         min(max(abs((t.x - 14.0) - (f.x + f.width + 14.0)) * 0.5
                 + abs((t.y + e.to_offset) - (f.y + e.from_offset)) * 0.15,
                 60.0), 260.0) AS reach
    FROM edges AS e
    JOIN nodes AS f ON f.id = e.from_id
    JOIN nodes AS t ON t.id = e.to_id
)
SELECT id,
       min(from_x, from_x + reach, to_x - reach, to_x) - 4.0 AS min_x,
       max(from_x, from_x + reach, to_x - reach, to_x) + 4.0 AS max_x,
       min(from_y, to_y) - 4.0 AS min_y,
       max(from_y, to_y) + 4.0 AS max_y
  FROM ports;

CREATE INDEX nodes_sample
  ON nodes (((seq % 2147483647) * 2654435761) % 2147483647, id);
CREATE INDEX nodes_running ON nodes (status) WHERE status = 'running';
CREATE INDEX nodes_output
  ON nodes (output_batch_id, id, seq) WHERE output_batch_id IS NOT NULL;

CREATE UNIQUE INDEX edges_port_pair
  ON edges (from_id, from_port, to_id, to_port);
CREATE INDEX edges_to ON edges (to_id, to_port);

CREATE INDEX result_batches_node ON result_batches (node_id, seq);
CREATE INDEX result_batches_latest ON result_batches (node_seq, seq);
CREATE INDEX result_batches_running
  ON result_batches (status) WHERE status = 'running';

CREATE INDEX result_items_asset
  ON result_items (asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX node_inputs_edge ON node_inputs (edge_id) WHERE edge_id IS NOT NULL;
CREATE INDEX node_inputs_item ON node_inputs (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX node_inputs_asset ON node_inputs (asset_id) WHERE asset_id IS NOT NULL;

CREATE TRIGGER document_no_delete BEFORE DELETE ON document
BEGIN
  SELECT RAISE(ABORT, 'the document row cannot be deleted');
END;

CREATE TRIGGER document_rev_monotonic BEFORE UPDATE OF rev ON document
WHEN NEW.rev <= OLD.rev
BEGIN
  SELECT RAISE(ABORT, 'document.rev must strictly increase');
END;

CREATE TRIGGER document_project_id_immutable BEFORE UPDATE OF project_id ON document
WHEN NEW.project_id <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'document.project_id is immutable');
END;

CREATE TRIGGER document_no_replace BEFORE INSERT ON document
WHEN EXISTS (SELECT 1 FROM document WHERE id = NEW.id OR project_id = NEW.project_id)
BEGIN
  SELECT RAISE(ABORT, 'document: use UPDATE, not REPLACE');
END;

CREATE TRIGGER nodes_no_replace BEFORE INSERT ON nodes
WHEN EXISTS (SELECT 1 FROM nodes WHERE id = NEW.id OR seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'nodes: use UPDATE, not REPLACE');
END;

CREATE TRIGGER nodes_identity_immutable BEFORE UPDATE OF id, seq ON nodes
WHEN NEW.id <> OLD.id OR NEW.seq <> OLD.seq
BEGIN
  SELECT RAISE(ABORT, 'nodes identity is immutable');
END;

CREATE TRIGGER edges_no_replace BEFORE INSERT ON edges
WHEN EXISTS (
  SELECT 1 FROM edges
   WHERE id = NEW.id
      OR seq = NEW.seq
      OR (from_id = NEW.from_id AND from_port = NEW.from_port
          AND to_id = NEW.to_id AND to_port = NEW.to_port)
)
BEGIN
  SELECT RAISE(ABORT, 'edges: use UPDATE, not REPLACE');
END;

CREATE TRIGGER edges_identity_immutable BEFORE UPDATE OF id, seq ON edges
WHEN NEW.id <> OLD.id OR NEW.seq <> OLD.seq
BEGIN
  SELECT RAISE(ABORT, 'edges identity is immutable');
END;

CREATE TRIGGER edges_no_duplicate_update
BEFORE UPDATE OF from_id, from_port, to_id, to_port ON edges
WHEN EXISTS (
  SELECT 1 FROM edges
   WHERE seq <> OLD.seq
     AND from_id = NEW.from_id AND from_port = NEW.from_port
     AND to_id = NEW.to_id AND to_port = NEW.to_port
)
BEGIN
  SELECT RAISE(ABORT, 'edges: duplicate port pair');
END;

CREATE TRIGGER nodes_rev_monotonic BEFORE UPDATE OF rev ON nodes
WHEN NEW.rev <= OLD.rev
BEGIN
  SELECT RAISE(ABORT, 'nodes.rev must strictly increase');
END;

CREATE TRIGGER nodes_output_done_bi BEFORE INSERT ON nodes
WHEN NEW.output_batch_id IS NOT NULL
 AND (SELECT status FROM result_batches WHERE id = NEW.output_batch_id) IS NOT 'done'
BEGIN
  SELECT RAISE(ABORT, 'the current output must be a done batch');
END;

CREATE TRIGGER nodes_output_done_bu BEFORE UPDATE OF output_batch_id ON nodes
WHEN NEW.output_batch_id IS NOT NULL
 AND (SELECT status FROM result_batches WHERE id = NEW.output_batch_id) IS NOT 'done'
BEGIN
  SELECT RAISE(ABORT, 'the current output must be a done batch');
END;

CREATE TRIGGER result_batches_owner_bi BEFORE INSERT ON result_batches
WHEN NOT EXISTS (SELECT 1 FROM nodes WHERE id = NEW.node_id AND seq = NEW.node_seq)
BEGIN
  SELECT RAISE(ABORT, 'a batch must belong to a live node incarnation');
END;

CREATE TRIGGER result_batches_insert_running BEFORE INSERT ON result_batches
WHEN NEW.status <> 'running'
BEGIN
  SELECT RAISE(ABORT, 'a batch must be inserted running');
END;

CREATE TRIGGER result_batches_done_item BEFORE UPDATE OF status ON result_batches
WHEN NEW.status = 'done' AND NEW.item_count = 0
BEGIN
  SELECT RAISE(ABORT, 'a done batch must contain at least one item');
END;

CREATE TRIGGER result_batches_terminal_immutable BEFORE UPDATE ON result_batches
WHEN OLD.status <> 'running'
 AND (NEW.seq IS NOT OLD.seq
   OR NEW.id IS NOT OLD.id
   OR NEW.node_id IS NOT OLD.node_id
   OR NEW.node_seq IS NOT OLD.node_seq
   OR NEW.trigger IS NOT OLD.trigger
   OR NEW.provider IS NOT OLD.provider
   OR NEW.model IS NOT OLD.model
   OR NEW.params_json IS NOT OLD.params_json
   OR NEW.status IS NOT OLD.status
   OR NEW.error IS NOT OLD.error
   OR NEW.created_at IS NOT OLD.created_at
   OR NEW.finished_at IS NOT OLD.finished_at)
BEGIN
  SELECT RAISE(ABORT, 'a settled result batch is immutable');
END;

CREATE TRIGGER result_batches_running_delete BEFORE DELETE ON result_batches
WHEN OLD.status = 'running'
BEGIN
  SELECT RAISE(ABORT, 'a running batch must be settled, not deleted');
END;

CREATE TRIGGER result_batches_item_count_consistent
BEFORE UPDATE OF item_count ON result_batches
WHEN NEW.item_count IS NOT (SELECT count(*) FROM result_items WHERE batch_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'result_batches.item_count is derived from result_items');
END;

CREATE TRIGGER result_items_running_only BEFORE INSERT ON result_items
WHEN (SELECT status FROM result_batches WHERE id = NEW.batch_id) IS NOT 'running'
BEGIN
  SELECT RAISE(ABORT, 'items can only be added to a running batch');
END;

CREATE TRIGGER result_items_no_update BEFORE UPDATE ON result_items
BEGIN
  SELECT RAISE(ABORT, 'result items are immutable');
END;

CREATE TRIGGER result_items_delete_guard BEFORE DELETE ON result_items
WHEN EXISTS (SELECT 1 FROM result_batches WHERE id = OLD.batch_id)
BEGIN
  SELECT RAISE(ABORT, 'a settled result item cannot be deleted directly');
END;

CREATE TRIGGER result_items_count_ai AFTER INSERT ON result_items
BEGIN
  UPDATE result_batches SET item_count = item_count + 1 WHERE id = NEW.batch_id;
END;

CREATE TRIGGER result_items_count_ad AFTER DELETE ON result_items
BEGIN
  UPDATE result_batches SET item_count = max(item_count - 1, 0) WHERE id = OLD.batch_id;
END;

CREATE TRIGGER node_inputs_edge_shape_bi BEFORE INSERT ON node_inputs
WHEN NEW.origin = 'edge'
 AND NOT EXISTS (
   SELECT 1
     FROM edges AS e
     JOIN result_items AS ri ON ri.id = NEW.item_id
     JOIN result_batches AS b ON b.id = ri.batch_id
     JOIN nodes AS src ON src.id = e.from_id
    WHERE e.id = NEW.edge_id
      AND e.to_id = NEW.node_id
      AND e.to_port = NEW.port_id
      AND ri.port_id = e.from_port
      AND ri.kind = NEW.kind
      AND b.node_id = e.from_id
      AND b.node_seq = src.seq
      AND b.status = 'done'
      AND ri.text = NEW.text
      AND ri.asset_id IS NEW.asset_id
      AND ri.meta_json = NEW.meta_json
 )
BEGIN
  SELECT RAISE(ABORT, 'edge input does not match its source producer');
END;

CREATE TRIGGER node_inputs_edge_shape_bu
BEFORE UPDATE OF node_id, port_id, edge_id, item_id, kind, text, asset_id, meta_json
ON node_inputs
WHEN NEW.origin = 'edge'
 AND NOT EXISTS (
   SELECT 1
     FROM edges AS e
     JOIN result_items AS ri ON ri.id = NEW.item_id
     JOIN result_batches AS b ON b.id = ri.batch_id
     JOIN nodes AS src ON src.id = e.from_id
    WHERE e.id = NEW.edge_id
      AND e.to_id = NEW.node_id
      AND e.to_port = NEW.port_id
      AND ri.port_id = e.from_port
      AND ri.kind = NEW.kind
      AND b.node_id = e.from_id
      AND b.node_seq = src.seq
      AND b.status = 'done'
      AND ri.text = NEW.text
      AND ri.asset_id IS NEW.asset_id
      AND ri.meta_json = NEW.meta_json
 )
BEGIN
  SELECT RAISE(ABORT, 'edge input does not match its source producer');
END;

CREATE TRIGGER nodes_count_bounds_ai AFTER INSERT ON nodes
BEGIN
  UPDATE document
     SET node_count = node_count + 1,
         min_x = min(coalesce(min_x, NEW.x), NEW.x),
         max_x = max(coalesce(max_x, NEW.x + NEW.width), NEW.x + NEW.width),
         min_y = min(coalesce(min_y, NEW.y), NEW.y),
         max_y = max(coalesce(max_y, NEW.y + NEW.height), NEW.y + NEW.height)
   WHERE id = 1;
END;

CREATE TRIGGER nodes_count_bounds_ad AFTER DELETE ON nodes
BEGIN
  UPDATE document
     SET node_count = max(node_count - 1, 0),
         bounds_exact = CASE WHEN node_count = 1 THEN 1 ELSE 0 END,
         min_x = CASE WHEN node_count = 1 THEN NULL ELSE min_x END,
         max_x = CASE WHEN node_count = 1 THEN NULL ELSE max_x END,
         min_y = CASE WHEN node_count = 1 THEN NULL ELSE min_y END,
         max_y = CASE WHEN node_count = 1 THEN NULL ELSE max_y END
   WHERE id = 1;
END;

CREATE TRIGGER nodes_bounds_au AFTER UPDATE OF x, y, width, height ON nodes
BEGIN
  UPDATE document
     SET bounds_exact = CASE
           WHEN (OLD.x = min_x AND NEW.x > OLD.x)
             OR (OLD.x + OLD.width = max_x AND NEW.x + NEW.width < OLD.x + OLD.width)
             OR (OLD.y = min_y AND NEW.y > OLD.y)
             OR (OLD.y + OLD.height = max_y AND NEW.y + NEW.height < OLD.y + OLD.height)
           THEN 0 ELSE bounds_exact END,
         min_x = min(coalesce(min_x, NEW.x), NEW.x),
         max_x = max(coalesce(max_x, NEW.x + NEW.width), NEW.x + NEW.width),
         min_y = min(coalesce(min_y, NEW.y), NEW.y),
         max_y = max(coalesce(max_y, NEW.y + NEW.height), NEW.y + NEW.height)
   WHERE id = 1;
END;

CREATE TRIGGER edges_count_ai AFTER INSERT ON edges
BEGIN
  UPDATE document SET edge_count = edge_count + 1 WHERE id = 1;
END;

CREATE TRIGGER edges_count_ad AFTER DELETE ON edges
BEGIN
  UPDATE document SET edge_count = max(edge_count - 1, 0) WHERE id = 1;
END;

CREATE TRIGGER nodes_rtree_ai AFTER INSERT ON nodes
BEGIN
  INSERT INTO nodes_rtree (id, min_x, max_x, min_y, max_y)
  VALUES (NEW.seq, NEW.x - 2.0, NEW.x + NEW.width + 2.0,
          NEW.y - 2.0, NEW.y + NEW.height + 2.0);
END;

CREATE TRIGGER nodes_rtree_au AFTER UPDATE OF x, y, width, height ON nodes
BEGIN
  UPDATE nodes_rtree
     SET min_x = NEW.x - 2.0,
         max_x = NEW.x + NEW.width + 2.0,
         min_y = NEW.y - 2.0,
         max_y = NEW.y + NEW.height + 2.0
   WHERE id = NEW.seq;
END;

CREATE TRIGGER nodes_rtree_ad AFTER DELETE ON nodes
BEGIN
  DELETE FROM nodes_rtree WHERE id = OLD.seq;
END;

CREATE TRIGGER nodes_geometry_dirty_au
AFTER UPDATE OF x, y, width, height ON nodes
BEGIN
  INSERT INTO nodes_geometry_dirty (node_id) VALUES (NEW.id)
  ON CONFLICT (node_id) DO NOTHING;
END;

CREATE TRIGGER nodes_geometry_dirty_ad AFTER DELETE ON nodes
BEGIN
  DELETE FROM nodes_geometry_dirty WHERE node_id = OLD.id;
END;

CREATE TRIGGER edges_rtree_ai AFTER INSERT ON edges
BEGIN
  INSERT INTO edges_rtree (id, min_x, max_x, min_y, max_y)
  SELECT id, min_x, max_x, min_y, max_y FROM edge_boxes WHERE id = NEW.seq;
END;

CREATE TRIGGER edges_rtree_au
AFTER UPDATE OF from_id, to_id, from_port, to_port, from_offset, to_offset ON edges
BEGIN
  DELETE FROM edges_rtree WHERE id = NEW.seq;
  INSERT INTO edges_rtree (id, min_x, max_x, min_y, max_y)
  SELECT id, min_x, max_x, min_y, max_y FROM edge_boxes WHERE id = NEW.seq;
END;

CREATE TRIGGER edges_rtree_ad AFTER DELETE ON edges
BEGIN
  DELETE FROM edges_rtree WHERE id = OLD.seq;
END;

CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes
BEGIN
  INSERT INTO nodes_fts (rowid, title, body, tags)
  VALUES (NEW.seq, NEW.title, NEW.body, NEW.tags);
END;

CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes
BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, title, body, tags)
  VALUES ('delete', OLD.seq, OLD.title, OLD.body, OLD.tags);
END;

CREATE TRIGGER nodes_fts_au AFTER UPDATE OF title, body, tags ON nodes
BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, title, body, tags)
  VALUES ('delete', OLD.seq, OLD.title, OLD.body, OLD.tags);
  INSERT INTO nodes_fts (rowid, title, body, tags)
  VALUES (NEW.seq, NEW.title, NEW.body, NEW.tags);
END;

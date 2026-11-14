# Code organization and architecture standard

- **Status:** Accepted 2026-11-14; Phases 0–1d are implemented and Phase 2
  is in progress on stacked branches (standard and tooling, shared kernel and
  first reuse, composer shell, AsyncDrain core, connector layer, leaf area
  moves).
- **Scope:** `src/` (TSX app) and `src/native/` (Rust document core).
- **Related:** [standards](../standards.md), [architecture](../architecture.md),
  [conventions](../conventions.md), [testing](../testing.md),
  [node editor](../node-editor.md), [ADR 0004](../adr/0004-native-view-canvas.md).
- **Reading guide:** §3–§7 and §10–§11 are the normative standard and
  migration; §2 is the external research annex; §16 is the cross-review log;
  Appendices A/B are the execution maps. A reviewer approving the standard
  reads §0, §3–§7, §10–§11 and the appendices.

## 0. Summary (中文摘要)

当前问题不是“文件多”，而是**分层目录被当成了唯一目录**：`components/`
29 个文件、`flow/` 51 个文件全部平铺；`flow/` 同时装着纯几何、场景模型、
手势控制器、文档会话、节点领域模型和种子数据五种东西；`FlowPage` 直接
依赖 35 个模块，`FlowCanvas` 依赖 16 个，`FlowCard` 依赖 11 个；组件之间
（TextComposer/NodeComposer）有约 68 行逐行重复，三套 single-flight 读循环
和六处 Result DTO 手工构造也是重复逻辑；`FlowScene`(684)、
`CanvasController`(643)、`FlowPage`(573)、`NodeSession`(539) 都是职责过多的
“上帝对象”。Rust 侧 `mutation.rs` 2,205 行混装六类命令，`db.rs` 4,978 行中
4,409 行是测试。

本方案保留现有分层路径，补上缺失的两个维度：

1. **层（layer）** 不变：`App.tsx → pages → components/store → flow/native`。
2. **功能域（area）**：每层内部按产品能力建子目录，如
   `components/canvas`、`components/composer`、`flow/canvas`、`flow/document`。
   同名功能在两层中对应；视图与模型是两个 `area`，但属于同一个功能。
3. **段（segment）**：功能内部按职责分 `geometry/ model/ interaction/ test/`；
   组件内部按“画什么/做什么”分 `world/ selection/ editing/ controls/ feedback/
   context-menu/`；禁止 `utils/ helpers/ common/ data/ types/` 垃圾抽屉。
4. **门面（facade）**：每个 **area** 一个 `index.ts`，只导出其他功能真正需要的
   表面；同一功能跨层（`components/canvas` ↔ `flow/canvas`）可以直接深入，
   不同功能必须走门面；`pages/` 是组合根，可以直接深入。
5. **依赖矩阵 + 结构检查**：扩展 `lint/boundaries.js`，新增
   `lint/structure-map.js` 与 `scripts/structure.mjs`，把“哪个功能可以依赖
   哪个功能”“跨功能必须走门面”“根目录不许再平铺模块”变成可执行规则。

方案分阶段执行：先落地共享内核与小步去重（独立 PR，行为测试先行；不把
Composer/AsyncDrain 说成“零风险”），再按功能迁移 `flow/`，迁移
`components/`，最后拆 `FlowPage` 并打开强制检查；Rust 核心的拆分独立并行。
每个阶段都以 `bun run check` + `bun run test` 为门禁，禁止行为变化。完整的
旧路径 → 新路径映射见附录 A/B。

---

## 1. Why the current structure hurts

### 1.1 Measurements

Taken from the tree at the proposal date (excluding `.nsh/` and `target/`):

| Measure                              | Value                                 |
| ------------------------------------ | ------------------------------------- |
| Non-test TS/TSX modules              | 84                                    |
| Test files                           | 51 (10,301 lines)                     |
| `src/flow/`                          | 51 modules, 7,615 lines, **all flat** |
| `src/components/`                    | 29 modules, 3,572 lines, **all flat** |
| `src/pages/`                         | 1 module, 573 lines                   |
| `FlowPage.tsx` imports               | 35 project modules                    |
| `FlowCanvas.tsx` imports             | 16 project modules                    |
| `FlowCard.tsx` imports               | 11 project modules                    |
| `components → flow` import edges     | 74                                    |
| Duplicated 8-line windows (non-test) | 89                                    |

Fan-in confirms a second problem: a handful of modules carry almost every
concept (`node-kinds` 25 importers, `scene` 24, `connection` 22, `camera` 20),
while the rest are leaf files. That is a shape produced by a flat namespace,
not by a designed module graph.

### 1.2 One foundation directory holds five layers

`src/flow/` is classified as one "foundation" layer, but it contains at least:

- pure geometry and math: `connection.ts`, `selection.ts`, `edge-clip.ts`,
  `grid.ts`, `preview-grid.ts`, `tooltip.ts`, `view-culling.ts`;
- retained canvas model: `scene.ts`, `scene-ports.ts`, `camera.ts`,
  `record-equality.ts`, `group-ports.ts`;
- interaction state machines: `canvas-controller.ts`, `edge-gestures.ts`,
  `connection-gesture.ts`, `right-gesture.ts`, `resize-handles.ts`,
  `frame-surface.ts`, `context-menu.ts`;
- node domain: `node-kinds.ts`, `port-visuals.ts`;
- application/document services: `document-session.ts`, `node-session.ts`,
  `inline-editor.ts`, `node-commands.ts`, `upload-source.ts`, `execution.ts`,
  `asset-urls.ts`, `previews.ts`, `preview-loader.ts`, `viewport-controller.ts`,
  `minimap-loader.ts`;
- page orchestration that leaked down: `bindings.ts`, `page-chrome.ts`,
  `search-navigation.ts`, `database-path.ts`;
- seed data: `data.ts`.

Because they share one directory, the boundary rule cannot see the real
dependency direction. A page helper is imported by components
(`flow/page-chrome.ts` exports `keepsWheel`, used by three composer/view
modules), a geometry helper imports a controller type
(`flow/resize-handles.ts` imports `CanvasCursor` from
`flow/canvas-controller.ts`), and the scene model calls its consumer
(`flow/scene.ts` calls `edgePortOffsets(this, edge)` from
`flow/scene-ports.ts`). These are not style issues; they make the layer graph
misleading and prevent reuse.

### 1.3 A flat component bucket hides feature families

`components/` mixes canvas world views, canvas chrome, selection overlays,
composer UI, app chrome, generic primitives and test probes in one namespace.
The consequences are visible:

- **Duplicated composer shells.** `TextComposer.tsx` and `NodeComposer.tsx`
  share an identical props interface and roughly 68 duplicated lines: sheet
  root, attachment row, close button, prompt input, error line, send/cancel
  buttons and model select. Only the counter row, the image settings popover
  and the count select are genuinely image-specific. `TextComposer.tsx:147`
  is also an orphaned doc comment for a function that no longer exists.
- **Duplicated canvas layers.** `FlowEdges.tsx` and `FlowPreviews.tsx`
  duplicate cubic tracing, port-color resolution and the absolute canvas box.
- **Duplicated chrome recipes.** The floating-panel recipe appears in six
  components; the tooltip pill appears twice; menu rows repeat seven times.
- **Test code in production modules.** `ImageLoadProbe`/`imageProbeText` live
  in `FlowCard.tsx`; `ZoomProbe` lives in `ZoomControls.tsx`; `CanvasProbe`
  is its own flat file; `app-test-harness.ts` and `node-session-harness.ts`
  are production-path files used only by tests.

### 1.4 God objects are the result, not the cause

| Object                  | Lines | Distinct responsibilities                                                                                                     |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `FlowPage.tsx`          | 573   | document lifecycle, runner, viewport, previews, minimap, composer policy, context menu, keyboard, selection effects, render   |
| `FlowScene.ts`          | 684   | records, overrides, per-id rect signals, selection/ranks/z, hit testing, edge endpoints, previews, connection preview, caches |
| `CanvasController.ts`   | 643   | gesture state machine, hit priority, drag/resize, marquee, hover/cursor, edge routing, right gesture                          |
| `NodeSession.ts`        | 539   | composer lifecycle, detail loads, assets, runs, inputs, uploads, inline editor, node/edge commands                            |
| `ViewportController.ts` | 281   | single-flight drain, revision fence, fit policy, camera gestures, zoom RAF, resize                                            |

The line counts above are raw lines, not the `max-lines` metric (which skips
blank and comment lines). `scene.ts`, `canvas-controller.ts` and `flow-page.ts`
pass the 500-code-line rule today; the problem is cohesion, not a lint
failure. Do not use the cap as the justification for splitting; use the
distinct responsibilities in the table.

Splitting these before the folder structure exists would just move the mess.
The folder standard comes first; the internal splits then have obvious homes.

### 1.5 Duplicated logic (not just duplicated text)

The block detector finds 89 duplicated 8-line windows. The important ones are
logical:

- **Single-flight drain.** `ViewportController` and `PreviewLoader` implement
  the same "publish the drain before starting it / dirty flag / pending
  resolvers / one follow-up" state machine; `MinimapLoader` is a third reduced
  copy.
- **Result DTO construction.** Six sites hand-build `ResultBatchInput` /
  `ResultItemInput` (`data.ts`, `inline-editor.ts`, `execution.ts`,
  `upload-source.ts`, `node-commands.ts`).
- **Rect / screen conversion.** `resize-handles.ts`, `frame-surface.ts`,
  `overlay.ts` each recompute `toScreen + size * camera.scale`.
- **Equality and clamp helpers.** Ten variants of `sameRect`, `samePoint`,
  `sameBox`, `sameBounds`, `samePosition/Size`, plus two `clamp`
  implementations. Tolerant and exact comparisons are deliberately different;
  the problem is that the names do not say which is which.
- **Port stroke/color.** `FlowEdges.tsx` and `FlowPreviews.tsx` inline the same
  `token(portVisual(isPortKind(kind) ? kind : "text").token)` expression.
- **Wheel conversion.** `wheelNotches(event.delta.y, event.deltaMode,
  platform.os)` is copied in `FlowCanvas`, `MiniMap`, `MinimapDragOverlay`
  and `flow/page-chrome.ts`.

### 1.6 Rust core has the same disease in one file

`src/native/src/db.rs` is 4,978 lines, but only 569 are production code; the
rest is one 4,409-line inline test module (57 tests plus the 100k benchmark
apparatus). `mutation.rs` is 2,205 lines and contains node, edge, input, run,
replay and low-level transaction helpers in one namespace. The audit found 21
transaction wrappers, 19 `ChangeSet` literals, 22 `bump_document_rev` calls,
six result-DTO construction sites and three copies of stale-propagation logic.
The single-worker / single-transaction design is correct; the file layout is
not.

### 1.7 Root cause: layers were mistaken for folders

The documented layer table (`src/components/**`, `src/flow/`) is correct, and
the lint rule already classifies nested paths (`layerOf` uses `startsWith`).
The failure is that the docs gave no **inside-the-layer** vocabulary, and one
sentence in `docs/standards.md` §3.3 ("a small directory such as `flow/` or
`components/` is imported module by module") reads as "keep it flat."
Contributors therefore treated each layer as a single bucket. The fix is not a
new layer graph; it is an explicit area/segment vocabulary, examples, and
enforcement inside each layer.

---

## 2. What other systems do

### 2.1 Feature-Sliced Design (FSD)

FSD organizes an app into layers (app, pages, widgets, features, entities,
shared), **slices** inside layers (one per product capability), and
**segments** inside slices (`ui`, `api`, `model`, `lib`, `config`). Imports
only go downward; slices on the same layer do not import each other; every
slice has a public API (`index.ts`). The useful ideas are the slice/segment
vocabulary and the public-API rule. We do **not** adopt FSD's full top-level
rename: this app has one page, NSH already prescribes `pages/` and
`components/`, and a wholesale rename would add migration risk without adding
a capability. We adopt the slice/segment/public-API ideas **inside** the
existing layers.
([FSD overview](https://feature-sliced.design/docs/get-started/overview),
[slices and segments](https://feature-sliced.design/docs/reference/slices-segments))

**Revisit trigger:** if a second page, a package extraction or multi-document
support arrives, re-evaluate full feature-first slices (`features/composer/
{ui,model}`) rather than the two-root area model. The migration is incremental
enough to defer.

### 2.2 Bulletproof React

Its core rule is a unidirectional flow `shared → features → app`: each feature
owns its components, hooks, stores, types and utils; shared code lives outside
features; cross-feature imports are not allowed; the app layer composes
features. It enforces this with `import/no-restricted-paths`. We adopt the
feature-owned folders, the shared-kernel rule and the lint enforcement. We
keep our page/component/foundation layers as the outer graph, so "feature"
here means a named subdirectory, not a new top-level layer.
([Bulletproof React architecture](https://deepwiki.com/alan2207/bulletproof-react/2-architecture-principles))

### 2.3 VS Code

VS Code's core is layered `base → platform → editor → workbench → code`, and
each layer may only import lower layers. Inside the workbench, `contrib/`
holds features; outside code may not reach into a contribution, and
cross-contribution dependencies use a single common API. This is the closest
large-system analogue to our need: a small set of foundational layers, many
feature folders, one public seam per feature, and strict downward imports.
([VS Code source organization](https://github.com/microsoft/vscode/blob/main/.github/instructions/source-code-organization.instructions.md),
[VS Code wiki](https://raw.githubusercontent.com/wiki/microsoft/vscode/Source-Code-Organization.md))

### 2.4 tldraw and Excalidraw

tldraw splits the framework-agnostic editor (`@tldraw/editor`: store, camera,
managers, shape/binding/tool base classes, geometry primitives) from the
product package (`@tldraw/tldraw`: default shapes, tools, UI). Excalidraw
separates the element model, `Scene`, `Store`, `History`, `ActionManager` and
the renderer; actions and pointer handling are distinct subsystems. Both
confirm the same decomposition we need for the canvas: **pure geometry**,
**scene/domain model**, **interaction**, **views**, and **application
services** must not share one namespace.
([tldraw package layout](https://factory.com/open-source-wikis/tldraw?page=packages%2Feditor.md),
[tldraw shapes and tools](https://factory.com/open-source-wikis/tldraw?page=features%2Fshapes-and-tools.md),
[Excalidraw architecture](https://deepwiki.com/excalidraw/excalidraw/2-architecture))

### 2.5 NSH's own component library

`nsh-base` is the most directly applicable precedent: each substantial
component is a folder with a `mod.rs` facade and internal modules named by
job — `data_table/{controller,data,parts,selection,view}.rs`,
`diff/{controller,geometry,layout,model,parts,view}.rs`,
`editor/{buffer,commands,controller,view,...}.rs`. The facade is the only
public seam; internals are private modules. NSH's coding guide also states
that "a module named after a component owns its public seam; split its state,
parts and tests into files without changing what others import." Our
`index.ts` facade per area is the TSX equivalent.
([NSH coding guides](https://github.com/longbridge/nsh/blob/main/website/docs/coding-guides.md),
[`nsh-base` tree](https://github.com/longbridge/nsh/tree/main/crates/nsh-base/src))

### 2.6 Rust visibility and module rules

Rust's standard advice — private modules by default, `pub use` at a focused
facade, one canonical public path per item, `pub(crate)` for internal
boundaries, no `utils`/`helpers` junk drawers — is the same facade discipline.
The Rust core should expose stable module paths to `lib.rs` only; everything
else stays `pub(crate)` or private.
([Rust visibility reference](https://doc.rust-lang.org/stable/reference/visibility-and-privacy.html),
[Rust module guidance](https://github.com/fabro-sh/fabro/blob/main/.fabro/skills/rust-style-guide/guidelines/modules-visibility-and-re-exports.md))

### 2.7 What we adopt, and what we reject

| Adopt                                                                     | Reject                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Feature-named subdirectories inside each existing layer                   | A wholesale top-level `features/entities/shared` rename         |
| Segment vocabulary (`geometry`, `model`, `interaction`, `test`)           | Technical buckets such as `controllers/`, `services/`, `utils/` |
| One facade per **area**; same-feature deep imports                        | Barrel files inside every folder; `export *` everywhere         |
| Strict downward dependency matrix, enforced by lint                       | Unenforced "please follow the diagram" conventions              |
| Shared kernel (`flow/shared`, `components/primitives`) with a rule-of-two | Over-eager abstraction of one-off code                          |
| Component part folders that own their public seam (NSH pattern)           | One component per file with no folder even when it grows parts  |
| Rust module facades and `pub(crate)` internals                            | A second FFI surface or a second database layer                 |

---

## 3. Design principles

1. **Layers are horizontal; areas are vertical.** A path answers two
   questions: which layer (`pages`, `components`, `flow`) and which product
   capability (`canvas`, `composer`, `minimap`, `document`, `execution`,
   `nodes`, `shared`).
2. **An area is named after what it does, not what it is made of.** No
   `misc`, `common`, `utils`, `helpers`, `data`, `types` folders. `data.ts`
   becomes `seed.ts`.
3. **One concept has one owner.** Camera mapping, node-kind/ports, edge
   geometry, rectangle equality, result batches and wheel conversion each get
   exactly one module.
4. **Cross-area access goes through a facade; same-feature access does not.**
   `components/canvas` and `flow/canvas` are one feature split by layer, so
   they may deep-import each other's internals. Different features use the
   area `index.ts`. `pages/` is the composition root and may deep-import any
   area.
5. **Dependencies point down a named matrix.** `flow/shared` < `flow/nodes` <
   `flow/canvas` < `flow/execution`/`flow/composer`/`flow/document`;
   components may use foundations; pages compose everything. The matrix is
   linted.
6. **Pure math is separate from state, and state from views.** Geometry
   imports no state; models import no views; interaction imports no document
   service; views import no document/service/store.
7. **Compose, don't fork.** A second copy of a non-trivial block is the
   threshold to extract it to the lowest shared layer, not a third copy.
8. **An area folder owns its seam.** A complex component becomes a folder
   with the main view, its parts and its tests; other code imports the area
   facade or the component folder's own exports.
9. **State has one owner and is mutated through methods.** Signals are
   exposed read-only; the page/session class owns lifecycle; effects and
   key bindings live in the mounted owner.
10. **Every rule has a gate.** If a convention matters, a lint rule, a
    structure check or a test proves it; otherwise it is a comment that will
    rot.

---

## 4. Target structure

### 4.1 Top level stays

```
src/
  App.tsx                 NSH entry: TitleBar + FlowPage
  nsh.json, theme.json, assets/
  store.ts                app-shared chrome state (zoom label, selection count, pin)
  pages/                  composition roots
  components/             views (presentational)
  flow/                   foundations (headless models, geometry, services)
  native/                 Rust document core
  test-support/           fixtures and harnesses imported only by tests
```

`pages/`, `components/`, `flow/` and `native/` keep their current meaning.
What changes is that **none of them may contain app modules at its root**:
every module lives in a named area subdirectory.

### 4.2 The layer × area matrix

| Area        | `pages/`              | `components/`                                                                     | `flow/`                                                                  |
| ----------- | --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `canvas`    | `pages/flow` composes | `components/canvas` (world, selection, editing, controls, feedback, context menu) | `flow/canvas` (geometry, model, interaction)                             |
| `composer`  | —                     | `components/composer` (sheet, text/image variants, attachments, footer)           | `flow/composer` (draft state, placement)                                 |
| `minimap`   | —                     | `components/minimap`                                                              | `flow/minimap` (mapping, drag controller)                                |
| `document`  | —                     | —                                                                                 | `flow/document` (lifecycle, sessions, commands, assets, viewport)        |
| `execution` | —                     | —                                                                                 | `flow/execution` (run lifecycle, providers)                              |
| `nodes`     | —                     | (node visuals live in `components/canvas`)                                        | `flow/nodes` (node kinds, ports, settings)                               |
| `shared`    | —                     | `components/primitives` (Icon, buttons, menu item, panel recipe)                  | `flow/shared` (geometry, equality, async drain, flags, wheel, shortcuts) |
| `app`       | `App.tsx`             | `components/app` (title bar, brand, FPS meter)                                    | —                                                                        |
| `search`    | —                     | `components/search` (palette, button, filters)                                    | — (a future search session may add `flow/search`)                        |
| `probes`    | —                     | `components/probes` (test/development probes)                                     | —                                                                        |

An area folder is created in a layer only when that layer has code for it.
The **name is shared across layers**: `components/composer` and
`flow/composer` are two halves of one capability. If a capability exists only
as a view, it lives only in `components/`; if it later needs state, it gains
`flow/<name>/`, not a new `services/` bucket.

### 4.3 Area, segment and folder vocabulary

These terms are normative:

- **Area**: the first directory under a layer (`flow/canvas`,
  `components/composer`, `pages/flow`). An area has one `index.ts` facade.
  Areas are the unit of the dependency matrix.
- **Segment**: a reserved internal folder inside an area with a fixed meaning
  (`geometry/`, `model/`, `interaction/`, `test/`). Segments do **not** have
  facades; they are internal.
- **Part folder**: any other internal folder, named after what it draws or
  does (`world/`, `selection/`, `editing/`, `controls/`, `feedback/`,
  `context-menu/`). No facade.
- **Facade**: an area's `index.ts`, a curated public surface, not a barrel.
  It exports only what other areas need. No `export *`.

Reserved segments and their rules:

| Segment        | Meaning                                                                 | May import                                        |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| `geometry/`    | Feature-specific pure math; no signals, no stateful classes             | `flow/shared`, same-area `geometry`               |
| `model/`       | Retained state, signals, domain rules, domain mapping, sessions/loaders | `geometry/`, `flow/shared`, lower areas           |
| `interaction/` | Pointer/keyboard state machines and hit routing                         | `model/`, `geometry/`, `flow/shared`, lower areas |
| `test/`        | Fixtures, harnesses, fakes; never imported by production                | anything (exempt)                                 |

Forbidden folder names: `utils`, `helpers`, `common`, `misc`, `data`,
`types`. A module that would need one is not understood yet; name its job.

### 4.4 The facade rule

- Every **area** has an `index.ts`; segments and part folders do not.
- Code in a **different area** imports only the target area's `index.ts`.
  Deep cross-area imports are a lint error.
- Code in the **same feature** across layers (`components/canvas` and
  `flow/canvas`) may import the other layer's files directly; they are one
  slice. `components/composer` ↔ `flow/composer`, `components/minimap` ↔
  `flow/minimap` behave the same way. This is a deliberate tradeoff: it keeps
  view/model cohesion without a giant facade, while the area matrix still
  prevents cross-feature leakage.
- `pages/` is the composition root and may deep-import any area. `App.tsx`
  imports pages, `components/app` and `store.ts`.
- A facade is curated: export the model/geometry surface other features need,
  not everything. For example, `flow/canvas/index.ts` exports `FlowScene`,
  `CanvasCamera`, `portOffset`, the scene-port queries (`capacityOf`,
  `hasPortEdge`, `incomingEdgeCount`, `portOffsetAt`, `portCenterWorld`), the
  `ConnectionPair` type that `flow/document` needs and `CardImageEvent`
  (defined in `flow/canvas/model/cards/card-image.ts`) for
  `components/probes`; it does **not** export `CanvasController`, which only
  the page and the canvas views need.
- A facade uses explicit named re-exports:
  `export { FlowScene } from "./model/scene/scene";`
  `export type { BoxGeometry } from "../shared";`
- A one-module area still gets `index.ts` so it can grow without changing
  call sites.

### 4.5 Full target tree

```
src/
├── App.tsx
├── store.ts
├── pages/
│   └── flow/
│       ├── index.ts
│       ├── FlowPage.tsx
│       └── workspace/
│           ├── flow-workspace.ts      composition root: construct/dispose, applyChanges
│           ├── flow-actions.ts        add/delete/undo/redo/fit/zoom/selection commands
│           ├── flow-effects.ts        selection→composer, draft sync, menu dismissal
│           ├── bindings.ts            keymap commands
│           ├── page-chrome.ts         page-root pointer/wheel forwarding
│           └── search-navigation.ts   reveal a search hit
├── components/
│   ├── primitives/
│   │   ├── index.ts
│   │   ├── Icon.tsx
│   │   ├── icon-shape.ts
│   │   ├── IconButton.tsx
│   │   ├── MenuItem.tsx
│   │   ├── TooltipPill.tsx
│   │   └── panel.ts                   shared chrome class recipe
│   ├── app/
│   │   ├── index.ts
│   │   ├── TitleBar.tsx
│   │   ├── BrandCard.tsx
│   │   └── FrameRate.tsx
│   ├── probes/
│   │   ├── index.ts
│   │   ├── CanvasProbe.tsx
│   │   ├── ImageLoadProbe.tsx
│   │   └── ZoomProbe.tsx
│   ├── canvas/
│   │   ├── index.ts
│   │   ├── FlowCanvas.tsx
│   │   ├── port-visuals.ts            typed-port icon + token
│   │   ├── world/
│   │   │   ├── FlowCard.tsx
│   │   │   ├── CardTitle.tsx
│   │   │   ├── CardBody.tsx
│   │   │   ├── status-visual.ts
│   │   │   ├── Port.tsx
│   │   │   ├── FlowEdges.tsx
│   │   │   ├── FlowPreviews.tsx
│   │   │   ├── GridBackground.tsx
│   │   │   ├── connector-layer.ts
│   │   │   └── ConnectorCanvas.tsx
│   │   ├── selection/
│   │   │   ├── SelectionFrame.tsx
│   │   │   ├── SelectionOverlay.tsx
│   │   │   ├── SelectionPorts.tsx
│   │   │   └── selection-visuals.ts
│   │   ├── editing/
│   │   │   ├── InlineTextEditor.tsx
│   │   │   └── UploadButton.tsx
│   │   ├── controls/
│   │   │   ├── NodeToolbar.tsx
│   │   │   └── ZoomControls.tsx
│   │   ├── feedback/
│   │   │   └── PortTooltip.tsx
│   │   └── context-menu/
│   │       ├── CanvasContextMenu.tsx
│   │       ├── CanvasMenuLayer.tsx
│   │       └── menu-items.ts
│   ├── composer/
│   │   ├── index.ts
│   │   ├── ComposerSheet.tsx
│   │   ├── ComposerAttachments.tsx
│   │   ├── ComposerFooter.tsx
│   │   ├── TextComposer.tsx
│   │   ├── ImageComposer.tsx
│   │   ├── ComposerInputTile.tsx
│   │   ├── ComposerModelSelect.tsx
│   │   └── detail-view.ts
│   ├── minimap/
│   │   ├── index.ts
│   │   ├── MiniMap.tsx
│   │   └── MinimapDragOverlay.tsx
│   └── search/
│       ├── index.ts
│       ├── SearchPalette.tsx
│       ├── SearchButton.tsx
│       └── search-filters.ts
├── flow/
│   ├── shared/
│   │   ├── index.ts
│   │   ├── geometry.ts                Point/Box/Size, containsPoint, overlaps, mergeBounds
│   │   ├── equality.ts                exact vs tolerant comparators, named explicitly
│   │   ├── async-drain.ts             shared in-flight/resolver core (loaders migrate one per PR)
│   │   ├── keyed-flags.ts
│   │   ├── wheel.ts                   wheelNotches / wheelNotchesOf / wheelZoomFactor
│   │   ├── shortcuts.ts               key names and labels
│   │   ├── native-types.ts            the one type-only re-export of @flow/native
│   │   └── result-inputs.ts           result batch/item factories (pure DTO shape)
│   ├── nodes/
│   │   ├── index.ts
│   │   └── node-kinds.ts
│   ├── minimap/
│   │   ├── index.ts
│   │   ├── minimap.ts                 pure world↔panel mapping
│   │   └── minimap-controller.ts      drag state
│   ├── canvas/
│   │   ├── index.ts
│   │   ├── geometry/
│   │   │   ├── connection.ts          port anchors, cubic, bounds, hit distance
│   │   │   ├── selection.ts           marquee/resize math
│   │   │   ├── edge-clip.ts
│   │   │   ├── grid.ts
│   │   │   ├── preview-grid.ts
│   │   │   ├── tooltip.ts
│   │   │   └── view-culling.ts
│   │   ├── model/
│   │   │   ├── camera.ts
│   │   │   ├── cursor.ts
│   │   │   ├── screen-rect.ts         camera-aware world→screen rect
│   │   │   ├── edge-layer.ts
│   │   │   ├── scene/
│   │   │   │   ├── scene.ts           FlowScene facade
│   │   │   │   ├── scene-types.ts     SceneReader, PreviewView, ConnectionPreview
│   │   │   │   ├── scene-hits.ts
│   │   │   │   ├── scene-selection.ts
│   │   │   │   ├── scene-records.ts
│   │   │   │   ├── scene-overrides.ts
│   │   │   │   ├── scene-ports.ts
│   │   │   │   ├── group-ports.ts
│   │   │   │   └── record-equality.ts
│   │   │   └── cards/
│   │   │       ├── card-layout.ts
│   │   │       ├── card-content.ts
│   │   │       ├── card-geometry.ts
│   │   │       ├── card-image.ts
│   │   │       └── inline-body.ts
│   │   └── interaction/
│   │       ├── canvas-controller.ts
│   │       ├── canvas-input.ts        pressed/pinch/suppress state machine
│   │       ├── edge-gestures.ts
│   │       ├── connection-gesture.ts
│   │       ├── right-gesture.ts
│   │       ├── resize-handles.ts
│   │       ├── frame-surface.ts
│   │       ├── hover-flags.ts
│   │       └── context-menu.ts
│   ├── composer/
│   │   ├── index.ts
│   │   ├── composer-state.ts
│   │   └── placement.ts
│   ├── execution/
│   │   ├── index.ts
│   │   ├── runner.ts
│   │   └── providers.ts
│   └── document/
│       ├── index.ts
│       ├── lifecycle/
│       │   ├── document-session.ts
│       │   ├── database-path.ts
│       │   └── seed.ts
│       ├── session/
│       │   ├── node-session.ts         facade over the sessions below
│       │   ├── composer-session.ts
│       │   ├── inline-session.ts
│       │   ├── inline-editor.ts
│       │   ├── asset-session.ts
│       │   └── composer-detail.ts       reload policy only
│       ├── commands/
│       │   ├── node-commands.ts
│       │   └── upload-source.ts
│       ├── assets/
│       │   ├── asset-urls.ts
│       │   ├── previews.ts
│       │   ├── preview-loader.ts
│       │   └── minimap-loader.ts
│       ├── viewport/
│       │   └── viewport-controller.ts
│       └── test/
│           └── node-session-harness.ts
├── test-support/
│   └── app.ts
└── native/
    └── ...
```

### 4.6 Dependency matrix

Rows are importing areas; columns are allowed target areas. "Facade" means
the target area's `index.ts`. "Same feature" means the matching area in the
other layer (`components/canvas` ↔ `flow/canvas`), where deep imports are
allowed.

| Importer                | Allowed targets                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `flow/shared`           | external packages; `@flow/native` type-only in `native-types.ts`                                                               |
| `flow/nodes`            | `flow/shared` (facade)                                                                                                         |
| `flow/minimap`          | `flow/shared` (facade)                                                                                                         |
| `flow/canvas`           | `flow/shared`, `flow/nodes` (facades)                                                                                          |
| `flow/execution`        | `flow/shared`, `flow/nodes` (facades)                                                                                          |
| `flow/composer`         | `flow/shared`, `flow/nodes`, `flow/canvas` (facades)                                                                           |
| `flow/document`         | `flow/shared`, `flow/nodes`, `flow/canvas`, `flow/execution` (facades)                                                         |
| `components/primitives` | `flow/shared` (facade)                                                                                                         |
| `components/app`        | `components/primitives`, `flow/shared` (facades)                                                                               |
| `components/probes`     | `components/primitives`, `flow/canvas` (facades)                                                                               |
| `components/canvas`     | `components/primitives`, `flow/shared`, `flow/nodes`, `flow/canvas` (facades; `flow/canvas` is same feature, deep allowed)     |
| `components/composer`   | `components/primitives`, `flow/shared`, `flow/nodes`, `flow/composer` (facades; `flow/composer` is same feature, deep allowed) |
| `components/minimap`    | `components/primitives`, `flow/shared`, `flow/canvas`, `flow/minimap` (facades; `flow/minimap` is same feature, deep allowed)  |
| `components/search`     | `components/primitives`, `flow/shared` (facades)                                                                               |
| `pages/flow`            | any area (deep imports allowed as the composition root)                                                                        |
| `store.ts`              | `flow/shared` only if a pure helper is needed                                                                                  |
| `App.tsx`               | `pages/flow`, `components/app`, `store.ts`                                                                                     |

Cross-feature component imports (for example `components/canvas` importing
`components/composer`) are not allowed; pages compose them. The matrix
governs area-to-area imports: a pair not in the table is a lint error, while
asset imports (for example a PNG in `TitleBar`) and external packages are not
area imports. Outside `flow/document`, all `@flow/native` **type** imports go
through `flow/shared/native-types.ts` (re-exported from the `flow/shared`
facade); `flow/document` and tests may import types directly, and only
`flow/document` may import `@flow/native` at runtime. This makes the native
boundary enforceable without depending on an Oxlint `importKind` flag.

### 4.7 Placement decision tree

When adding a file, answer in order:

1. Is it a view? → `components/<area>/...`.
2. Does it own retained state, signals or domain rules? →
   `flow/<area>/model/...`.
3. Is it pure coordinate math? → `flow/<area>/geometry/...` (feature-specific)
   or `flow/shared/geometry.ts` (generic).
4. Is it a pointer/keyboard state machine? → `flow/<area>/interaction/...`.
5. Does it call the native document, picker or asset store? →
   `flow/document/...`, the only area allowed to call `@flow/native` at
   runtime. The runner in `flow/execution` reaches the document through
   callbacks supplied by the page, not by importing the native module.
6. Does it create/dispose page objects, bind keys or create effects? →
   `pages/flow/workspace/...`.
7. Is it a fixture, fake or probe? → `test/`, `test-support/` or
   `components/probes/`.
8. Is it generic UI used by more than one feature? → `components/primitives/`.
9. None of the above? Stop. Do not create `utils.ts`; name the job and put it
   in the owning area.

### 4.8 Glossary

| Term            | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| **Node**        | The persisted document entity (`NodeSummary`, `node-kinds`).            |
| **Card**        | The native view of a node (`FlowCard`, `card-*`).                       |
| **Edge**        | The persisted directed relation (`EdgeSummary`).                        |
| **Connector**   | The drawn cubic and the connection gesture for an edge.                 |
| **Port**        | A typed input/output handle on a node.                                  |
| **Composer**    | The panel that edits a node's settings, inputs and run.                 |
| **Sheet**       | The composer's chat-style visual shell (`ComposerSheet`).               |
| **Scene**       | The visible subset model (`FlowScene`), not the whole document.         |
| **Camera**      | The world↔screen mapping (`CanvasCamera`).                              |
| **Viewport**    | The visible rectangle and its throttled read loop.                      |
| **Document**    | The Rust-owned data plus document-backed services (`flow/document`).    |
| **Workspace**   | The mounted page runtime (`pages/flow/workspace`).                      |
| **Area**        | A first-level feature directory with a facade.                          |
| **Segment**     | A reserved internal folder: `geometry`, `model`, `interaction`, `test`. |
| **Part folder** | Any other internal folder, named after what it draws/does.              |

### 4.9 Adding a new area

1. Name the capability with a domain noun.
2. Add it to `lint/structure-map.js` (layer, allowed imports, facade path)
   and to `docs/code-map.md`.
3. Create `flow/<name>/index.ts` if it has state, and/or
   `components/<name>/index.ts` if it has views. Each facade starts with a
   doc comment: purpose, invariants, what it may import.
4. Add segments only as needed (`geometry/`, `model/`, `interaction/`,
   `test/`).
5. Add lint tests for an allowed and a disallowed direction.
6. If it has app-wide state, decide explicitly between `store.ts` (App/chrome
   shared) and `flow/<name>/model` (feature-local).
7. If it is a page, add `pages/<name>/`.

**Recipes:**

- **New node kind** — kind/ports/settings in `flow/nodes/node-kinds.ts`;
  provider in `flow/execution/providers.ts`; card body in
  `components/canvas/world/CardBody.tsx`; editor in
  `components/composer/<Kind>Composer.tsx`; Rust stores `kind` and
  `settings_json` opaquely.
- **New canvas gesture** — math in `flow/canvas/geometry/`; retained state in
  `flow/canvas/model/`; routing in `flow/canvas/interaction/`; document
  command hookup in `pages/flow/workspace/flow-actions.ts`; view in
  `components/canvas/`.
- **New settings panel** — `components/settings/` if it is app chrome; a
  `flow/settings/model/` only if it owns persistent state; otherwise local
  component state or `store.ts`.
- **New native command** — Rust `mutation/<family>.rs`; TS wrapper in
  `flow/document/commands/`; no separate `api/` layer.

**Part folders.** Inside an area, a part folder is named after what it draws
or does (`world/`, `selection/`, `editing/`, `controls/`, `feedback/`,
`context-menu/`, `scene/`, `cards/`). It has no `index.ts`; files inside
import each other directly, and the area facade decides what leaves the area.
A component becomes a folder when it has two independently useful parts or
grows past ~300 code lines; keep the main view as the entry and put the parts
beside it. If a part needs its own public seam for other areas, that is a sign
it is an area, not a part.

**New top-level layer.** A new layer (a new top-level directory beside
`pages/`, `components/`, `flow/`) requires an ADR, a manifest entry, a lint
matrix row and a migration plan. New capabilities become **areas inside an
existing layer**, not new layers.

---

## 5. The canvas, explicitly layered

The canvas was designed in layers; the target makes those layers physical.

```
geometry/      pure math: points, boxes, camera transform, port anchors,
               cubic curves, clipping, grid tiles, culling
   ↑
model/         retained state: FlowScene records, selection, overrides,
               camera, stacking, equality gates, previews
   ↑
interaction/   gesture state machines: drag/resize/marquee/pan/connect/menu,
               hit priority, hover/cursor
   ↑
components/    native views: world, cards, ports, connector canvases,
               selection overlays, composer/inline overlays
   ↑
pages/flow     orchestration: document session, viewport reads, previews,
               composer policy, search reveal, key bindings
```

Rules that make this more than a diagram:

- A `geometry` file may not import a class with signals, a component, or a
  document service. It may import types from `flow/shared` and pure helpers.
- A `model` file may not import a component or a document service. It may
  import geometry and node kinds.
- An `interaction` file may not import a component or a document service. It
  receives commands through a `CanvasHost` interface, exactly as
  `CanvasController` does today.
- A view may not write a model directly except through model methods or
  controller actions; it receives accessors, not snapshots.
- Only the page creates/disposes the scene, camera, controller, session,
  viewport reader and loaders; only the page binds keys and creates effects.
- One batch per pointer event or command remains owned by the outermost
  controller/page entry point; helper modules never open a batch.
- Hit testing stays in the scene/controller; views never compute it from
  pixels.

**Breaking the two cycles.** `scene-ports.ts`, `group-ports.ts`,
`frame-surface.ts` and `record-equality.ts` currently import `FlowScene`
from `scene.ts`, while `scene.ts` calls them. Introduce `SceneReader` in
`scene-types.ts` (the read surface: `node`, `cardRect`, `nodes`, `edges`,
`nodeAt`, `cardDepth`, `incomingByPort`, `edgePorts`). The query modules take
`SceneReader`; `FlowScene` satisfies it implicitly. In parallel,
`resize-handles.ts` imports `CanvasCursor` from `canvas-controller.ts`; move
`CanvasCursor` to `model/cursor.ts`. These are type-level changes only.

`FlowScene` stays the single state owner. Internal helpers (`scene-hits`,
`scene-selection`, `scene-records`, `scene-overrides`) operate on an explicit
reader/state slice and do not own signals. This gets the layering without the
risk of splitting a reactive graph across objects.

**Camera types.** `CameraSize` and `CameraBounds` are structural aliases of
the shared `Size` and `BoxGeometry`; `tooltip.ts` and `view-culling.ts` import
the shared types, not the camera module. This keeps the geometry segment rule
true without a type-only exception. `CameraView` (the camera's own state
shape) stays in `model/camera.ts`.

---

## 6. Component and reuse standard

### 6.1 Taxonomy

| Kind         | Home                       | Rule                                                                       |
| ------------ | -------------------------- | -------------------------------------------------------------------------- |
| Primitive    | `components/primitives`    | Generic, product-agnostic, used by ≥2 areas                                |
| App chrome   | `components/app`           | Window chrome and brand; no canvas/model imports                           |
| Feature view | `components/<area>`        | One capability; may import its own flow model and primitives               |
| Part         | `components/<area>/<part>` | A sub-view of one feature; not exported outside the area unless via facade |
| Probe        | `components/probes`        | Test/development only; mounted behind `host.params`                        |
| Composition  | `pages/flow`               | Wires features; owns lifecycle and effects                                 |

### 6.2 Component composition rules

- One main component per file, named after the export. Helper functions that
  only it uses stay in the file; a second view that is independently useful
  becomes a part file or a sibling.
- A component's area owns its public seam: `components/canvas/index.ts`,
  `components/composer/index.ts`. External areas import the facade; the
  feature's own files import each other directly.
- Props are accessors for reactive values and callbacks for actions
  (`selected: () => boolean`, `onRun: () => void`), never destructured in the
  body (NSH runs the body once).
- A view never imports the store, a document session, a runner or a loader.
  The page binds those to props.
- Do not pass a wide bag of unrelated callbacks. Pass a small feature model
  (readonly accessors + actions) when a view genuinely needs many operations;
  `CanvasContextMenu` becomes `items` + `onSelect` rather than 12 callbacks.

### 6.3 Reuse threshold

- **Rule of two:** the second non-trivial duplication is the point to extract,
  not the third. Trivial literals and one-line class strings may repeat.
- **Lowest shared layer:** a helper used by two uses inside one feature stays
  in that feature; the second **feature** promotes it to `flow/shared` or
  `components/primitives`.
- **No premature abstraction:** a one-use component stays in its feature.
  A generic `panel` recipe must earn its place by removing duplicated,
  non-trivial chrome from at least two features.
- **One concept, one owner:** `PortKind`, `NodeSettings`, `BoxGeometry`,
  `CameraView`, `ResultBatchInput` factories, `sameRect` variants, wheel
  conversion and shortcut names each exist once.

### 6.4 Specific extractions (first wave)

| Duplication                                                                | Extraction                                                                                                                | Home                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| TextComposer/NodeComposer shell (~68 lines)                                | `ComposerSheet` + `ComposerAttachments` + `ComposerFooter`                                                                | `components/composer`                                          |
| Single-flight drains (3 copies)                                            | shared in-flight/resolver core; migrate one loader per PR with its existing test as the oracle                            | `flow/shared/async-drain.ts`                                   |
| Result batch/item construction (6 sites)                                   | `resultBatch`, `textResultItem`, `imageResultItem`, `manualTextResult`                                                    | `flow/shared/result-inputs.ts`                                 |
| Rect/screen conversion (3 copies)                                          | `containsPoint`, `overlaps`, `mergeBounds` in `geometry.ts`; `screenRectOf` in `flow/canvas/model/screen-rect.ts`         | `flow/shared` + canvas model                                   |
| Equality helpers (~10 variants)                                            | `sameRect`, `sameRectWithin`, `samePoint`, `sameBox`, `sameBounds`                                                        | `flow/shared/equality.ts`                                      |
| Port color/type visuals (2+ copies)                                        | `portVisual(kind)` / `connectorColor(kind)`                                                                               | `components/canvas/port-visuals.ts`                            |
| Wheel conversion (4 copies)                                                | `wheelNotchesOf(event)`                                                                                                   | `flow/shared/wheel.ts`                                         |
| Connector canvas box/trace/style (2 layers)                                | `connectorLayerBounds` (pure) + `connectorLayerBox` (accessor), `traceCubic`, `ConnectorCanvas`                           | `flow/canvas/model/edge-layer.ts` + `components/canvas/world/` |
| Floating panels (6), menu rows (7), tooltip pills (2), icon buttons (many) | `panel.ts` class recipe, `MenuItem`, `TooltipPill`, `IconButton`                                                          | `components/primitives`                                        |
| Selection frame look (world/screen twins)                                  | `selection-visuals.ts` class recipe                                                                                       | `components/canvas/selection`                                  |
| Status dot/text tables in FlowCard                                         | `status-visual.ts`                                                                                                        | `components/canvas/world`                                      |
| Shortcut names in bindings + controls                                      | `shortcuts.ts` constants; page binds callbacks                                                                            | `flow/shared` + page                                           |
| Composer detail reload vs view helpers                                     | reload policy in `flow/document/session/composer-detail.ts`; `errorOf`/`inputUrl` in `components/composer/detail-view.ts` | both                                                           |
| Minimap loader in the wrong feature                                        | `minimap-loader.ts` and its overview comparison move to `flow/document/assets`; mapping/drag stay `flow/minimap`          | both                                                           |
| `ViewportController` imports the seed's `CONTENT`                          | `ViewportHost.fallbackBounds` supplied by the page; no fixture dependency in the read loop                                | `flow/document/viewport`                                       |
| `@flow/native` types imported from many modules                            | one type-only re-export seam                                                                                              | `flow/shared/native-types.ts`                                  |
| `SearchFilter` declared in palette and filters                             | one type in `search-filters.ts`                                                                                           | `components/search`                                            |
| `CameraSize`/`CameraBounds`/`MinimapSize`/`MinimapRect`/`StageSize`        | structural aliases of shared `Size`/`BoxGeometry`; keep domain names as aliases                                           | `flow/shared/geometry.ts`                                      |

Each row above becomes a ticket-sized issue with acceptance evidence: the
detector's duplicate pair disappears, the existing behavior test stays green,
and the area owner in `docs/code-map.md` signs off. Do not open one mega-issue
for the table.

### 6.5 What must not be split

- `FlowCard`'s many accessor props are deliberate: they keep a viewport read
  from waking every card. Do not replace them with one `node()` object read in
  the card body, and do not put `camera.scale` reads inside every card.
- `FlowCanvas`'s pointer handlers and touch-responder state must stay on the
  same mounted view. If state moves, it moves into a page-owned input class
  (`flow/canvas/interaction/canvas-input.ts`), not into conditionally
  mounted children.
- `FlowScene`'s per-id rect signals and keyed flags stay per-id. Do not merge
  them into a single map signal for "cleanliness."
- `CanvasController` stays the one press router. Extracting hit-priority
  helpers is fine; adding a second press path is forbidden.
- `NodeSession`'s generation counters and disposal guards stay in one logical
  owner per async operation; split by operation, not within one operation.

### 6.6 Probe policy

Declared probes are allowed only in `components/probes`, mounted behind
`host.params`, and carry no production logic. `FlowCard` keeps an optional
`imageEvent` observation callback; the probe component and its formatting move
to `components/probes/ImageLoadProbe.tsx`. The standards' anti-pattern is
narrowed from "probe in `src/`" to "undocumented probe or test-only code
outside `components/probes`/`test/`."

---

## 7. State, lifecycle and performance invariants

1. **Signal ownership.** Signals live in the class/closure that owns the
   state. Read-only accessors are exported; writes go through methods. No
   module-level mutable state except `store.ts`.
2. **One owner per lifecycle.** `pages/flow/workspace/flow-workspace.ts`
   constructs and disposes the document, assets, runner, scene, camera,
   controller, session, viewport reader, preview loader and minimap loader.
   Disposal is reverse creation order and idempotent. A lazy `applyChanges`
   closure may reference `viewport` before it is assigned; keep that pattern
   explicit.
3. **Effects and keys belong to the page or a mounted dialog.** No foundation
   area may create an `effect` or bind a key. `dismissContextMenuOnChange`
   moves to the page; `keepsWheel` stays a pure event policy in
   `flow/shared/wheel.ts`.
4. **One update round per input.** The outermost entry point batches. Helper
   modules never batch. This applies to pointer events, command results and
   selection changes.
5. **Equality gates stay.** Record equality, per-id rect signals, keyed flags,
   `CardGeometry`, `CardContent` and `sameBounds` exist to keep viewport reads
   and camera ticks from waking every card. A refactor must preserve the
   object-identity behavior these rely on.
6. **Coarse FFI.** `@flow/native` is called only from `flow/document` at
   runtime; outside `flow/document`, type imports go through
   `flow/shared/native-types.ts`. No per-node or per-frame calls. The canvas never imports a document service
   except through page-supplied callbacks.
7. **Viewport budget.** `FlowScene` reconciles only `scene(rect, margin)` and
   keeps the card budget, throttled reads and selected-card pinning. Moving
   files must not introduce a whole-document read.
8. **No second canvas/render loop.** Connectors stay in one native `Canvas`
   layer; cards stay native views; geometry stays in `flow/canvas/geometry`.

---

## 8. Testing and test-support organization

- Tests move with their subject: `flow/canvas/model/scene/scene.test.ts`,
  `flow/canvas/interaction/canvas-controller.test.ts`,
  `flow/document/session/node-session.native.test.ts`.
- `*.host.test.tsx` stays reserved for real-platform tests. `App.test.tsx`,
  `App.composer.test.tsx`, `App.pan.test.tsx` and `App.host.test.tsx` stay at
  the app root because they mount `./App.tsx`; their helpers move to
  `src/test-support/`.
- `app-test-harness.ts` → `src/test-support/app.ts`. `open(entry)` is resolved
  **relative to the test file**, not the module that calls it, so the harness
  keeps `open("./App.tsx")`; the `App*.test.tsx` files stay at the app root.
  `node-session-harness.ts` →
  `flow/document/test/node-session-harness.ts`.
- `NodeSession`'s native tests subclass it and override `protected
  nodeDetail`; when the class is split in Phase 7, preserve that seam or
  update the harness and its tests in the same PR.
- Test support modules are exempt from the area matrix but must not be
  imported by production code; classify `test-support` and `test/` in the
  manifest in the same PR that creates them, and turn on
  `test-support-in-production` immediately (not in Phase 5).
- When a module splits, split its test file by the same behavior boundaries
  (`scene.test.ts` → `scene-reads`, `scene-selection`, `scene-hits`,
  `scene-overrides`). Do not keep a 600-line test for a 200-line module. The
  existing `scene-hit.test.ts` is renamed `scene-hits.test.ts` in the same
  PR, so one hit suite remains.
- Keep the levels: pure unit tests for geometry, headless model tests for
  scene/controller/session, `App.test.tsx` for mounted flows, host tests for
  platform behavior. No sleeps; use `app.waitUntil`.
- Add lint tests for every new area/facade/segment rule, the same way
  `lint/boundaries.test.js` tests the layer map.

Non-obvious test moves:

| Current test                                                                                                                                 | New home                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `flow/scene*.test.ts` (including `scene-hit`, `scene-preview-stacking`)                                                                      | `flow/canvas/model/scene/` (`scene-hit.test.ts` → `scene-hits.test.ts`)           |
| `flow/camera.test.ts`                                                                                                                        | `flow/canvas/model/camera.test.ts`                                                |
| `flow/asset-urls.test.ts`                                                                                                                    | `flow/document/assets/`                                                           |
| `flow/icon-shape.test.ts`                                                                                                                    | `components/primitives/`                                                          |
| `flow/canvas-controller*.test.ts`, `canvas-connection`, `frame-connection`, `right-gesture`, `context-menu`, `resize-handles`, `hover-flags` | `flow/canvas/interaction/`                                                        |
| `flow/connection`, `selection`, `edge-clip`, `grid`, `preview-grid`, `tooltip`, `view-culling`                                               | `flow/canvas/geometry/`                                                           |
| `flow/card-content`, `card-geometry`                                                                                                         | `flow/canvas/model/cards/`                                                        |
| `flow/record-equality`                                                                                                                       | `flow/canvas/model/scene/record-equality.test.ts`                                 |
| `flow/edge-layer`                                                                                                                            | `flow/canvas/model/edge-layer.test.ts`                                            |
| `flow/composer-state`                                                                                                                        | `flow/composer/`                                                                  |
| `flow/node-kinds`                                                                                                                            | `flow/nodes/`                                                                     |
| `flow/minimap*`                                                                                                                              | `flow/minimap/`                                                                   |
| `flow/node-session*`                                                                                                                         | `flow/document/session/`                                                          |
| `flow/upload-source`                                                                                                                         | `flow/document/commands/`                                                         |
| `flow/preview-loader`                                                                                                                        | `flow/document/assets/`                                                           |
| `flow/database-path`, `flow/data`                                                                                                            | `flow/document/lifecycle/`                                                        |
| `flow/page-chrome`, `search-navigation`                                                                                                      | `pages/flow/workspace/`                                                           |
| `flow/keyed-flags`                                                                                                                           | `flow/shared/`                                                                    |
| `flow/overlay`                                                                                                                               | `flow/composer/placement.test.ts` + `flow/canvas/model/cards/inline-body.test.ts` |
| `store.test.ts`, `native.test.ts`, `App*.test.tsx`                                                                                           | stay                                                                              |

---

## 9. Rust core organization

The current behavior and FFI surface are correct; this is a file-layout change.

```
src/native/src/
├── lib.rs                  FFI seam; unchanged method names/signatures
├── db/
│   ├── mod.rs              Database handle, job dispatch, run/run_mutation
│   ├── worker.rs           worker loop, open_connection, sqlite_url/URI/config
│   ├── startup.rs          open_connection; calls migrate + store::document::ensure_document
│   ├── undo.rs             undo/redo, empty_change, lock_history
│   └── tests/
│       ├── mod.rs          fixtures/shared helpers
│       ├── nodes.rs, edges.rs, inputs.rs, runs.rs
│       ├── scene.rs, search.rs, assets.rs, history.rs
│       ├── startup.rs      reopen/path/schema/persistence tests
│       └── benchmark.rs    the 100k apparatus (keep #[ignore])
├── mutation/
│   ├── mod.rs              facade: Mutation + public commands
│   ├── nodes.rs            insert/move/bounds/text/settings/delete
│   ├── edges.rs            insert/delete/connect/update
│   ├── inputs.rs           add/remove/reorder/sync
│   ├── runs.rs             manual text/upload, save run, status, recover
│   ├── apply.rs            apply_ops (history replay)
│   ├── support.rs          pure ChangeSet assembly/conversions
│   └── tx/
│       ├── nodes.rs, edges.rs, inputs.rs, indexes.rs, rows.rs
├── reads/
│   ├── mod.rs              pub(crate) mod / pub(crate) use for db
│   ├── viewport.rs
│   ├── scene.rs
│   ├── detail.rs
│   ├── search.rs
│   └── metadata.rs         counts, bounds cache, is_empty
├── store/
│   ├── mod.rs
│   ├── schema.rs
│   ├── edge_index.rs
│   ├── document.rs         ensure_document, bump_document_rev, current_rev
│   ├── queries.rs          shared find/lookup helpers
│   └── rows.rs             Model → Summary conversions
├── history.rs              History/HistoryOp + row snapshots
├── asset.rs                metadata + bytes
├── entity/                 one file per table (unchanged)
├── types.rs
├── clock.rs
└── constants.rs             DOCUMENT_ID, SCHEMA_VERSION
```

Rules:

- Runtime dependency graph: `lib.rs → db → {mutation, reads, store, asset,
  history} → entity/types`. `mutation` and `reads` are peers, not a chain;
  `mutation` uses `store`/`history`/`entity`, `reads` uses `store`/`entity`.
  `store/schema` defines virtual tables; `store/edge_index` is used by both.
  `#[cfg(test)]` schema tests may call `mutation`/`reads`; that is the one
  test exemption.
- `mutation/mod.rs` re-exports the public command functions so every
  `db.rs` call path stays stable during migration.
- `reads/mod.rs` must expose what `db` calls (`pub(crate) mod viewport;` or
  `pub(crate) use`), or `db` cannot see the read functions.
- Visibility in `mutation/tx/`: a helper used by a sibling command family is
  `pub(in crate::mutation)` (or `pub(crate)`), not `pub(super)`; `pub(super)`
  only reaches the `tx` parent, not `mutation::nodes`/`mutation::edges`.
- Keep one transaction per command, one worker job per command, and
  `apply_ops` as the only replay path. `apply_ops` may call only `tx/*` and
  `support`; calling a command would nest a transaction and double-bump the
  revision.
- `sync_inputs` stays separate from the connect snapshot helper: it rebuilds
  positions from 0 per port; connect uses `max_input_position_tx` and
  `input-{edge}-{item}` ids.
- Keep the `db` wrappers that distinguish history vs non-history commands
  (`run_mutation` vs `run`); do not "simplify" all commands into one runner.
- Keep the `#[cfg(test)] pub fn apply_ops` wrapper on `Database`.

### 9.1 Deduplication, with safety notes

Safe extractions:

- `From<&Model>` conversions for `NodeSummary`/`EdgeSummary`/`AssetSummary`
  (keep the `tags_json` `unwrap_or_default` fallback).
- Tag serialization helper (preserve the error text).
- Snapshot extraction for connect/update only.
- `stale_summaries_tx` (order: self then descendants).
- FTS refresh for update/replace paths only; insert paths have no `Model`,
  only `last_insert_id`.
- `Mutation::commit` as a pure assembler; it does **not** absorb
  `bump_document_rev` (`recover_runs` bumps conditionally).
- `ChangeSet::empty(rev)` must take the revision; a default `0` would break
  the TSX revision fence.

Risky; parameterize, do not collapse:

- `delete_inputs_for_edge_tx`: `apply_ops` deletes **all rows by `edge_id`**
  because run-time sync can change item ids; `delete_edges`/`update_edge`
  delete captured rows. Parameterize the mode.
- Node insert: `insert_node_tx` and `insert_row_tx` differ in rev, status,
  output pointer and timestamps; replay must restore historical values. Use a
  parameterized `ActiveModel` builder, not one collapsed function.

### 9.2 Test migration specifics

- Edition 2024: `db/tests/mod.rs` with `mod nodes;` resolves correctly; no
  `#[path]`.
- `db::tests` is a descendant of `db`, so `Database::run`/`run_mutation`, the
  `assets_dir` field and the test `apply_ops` wrapper stay visible. Helpers
  that move to `db/worker.rs` (`sqlite_url`, `open_connection`) use
  `pub(super)`; helpers in `reads/metadata.rs` (`has_nodes`, `has_edges`) need
  `pub(crate)`, because `pub(super)` there reaches only `reads`. Reuse the
  visibility rather than an unused re-export, because `clippy -D warnings`
  fails on unused imports.
- Keep fixtures (`node`, `connect`, `scene_between`, `preview_*`) in
  `db/tests/mod.rs`; child modules use `use super::*`. Benchmark-only imports
  (`AtomicU64`, `fs`, `Path`, `PathBuf`, `now_ms`, `OVERVIEW_LIMIT`,
  `NODE_LIMIT`) must be imported explicitly in `benchmark.rs`; keep
  `mod benchmark;` in `tests/mod.rs` or the ignored tests disappear.
- Do **not** move the reference oracles in `detail.rs`/`viewport.rs` into
  `db/tests/`: they intentionally share private production builders so the
  oracle cannot drift. Move only test data.
- Add `startup.rs` for `persists_across_reopen`, path-with-spaces, schema
  cascade and recovery-query tests.
- The benchmark test paths change to `db::tests::benchmark::*`; update
  `scripts/smoke-100k.mjs`, `docs/testing.md` and `docs/plans/rust-core.md`
  in the same Phase 6 PR, or the 100k filter silently matches nothing.

### 9.3 Unassigned items and schema debt

- `document.rs::current_rev` → `store/document.rs`.
- `db.rs::empty_change`, `db.rs::lock_history` → `db/undo.rs`.
- `bump_document_rev` → `store/document.rs` (it is defined in `mutation.rs`
  today).
- `history.rs` keeps `History`/`HistoryOp` **and** the `NodeRow`/`EdgeRow`/
  `InputRow` snapshots that `HistoryOp` references; conversions go in
  `store/rows.rs`.
- `assets_fts` is created but never populated or searched. Decide in Phase 6:
  implement indexing or drop it with migration 6 (`DROP TABLE`, remove from
  `VIRTUAL_TABLES`/`RESET_TABLES`, delete the entity, bump
  `SCHEMA_VERSION`). Removing it from the lists alone leaves dead tables.
- `store/schema.rs` is the only virtual-table DDL owner; correct the comment
  in `entity/mod.rs` that says DDL lives in `search.rs`/`edge_index.rs`.

---

## 10. Enforcement

### 10.1 The manifest and lint

Extract the pure classification/manifest into `lint/structure-map.js` (no
`vite-plus` import), consumed by both `lint/boundaries.js` and
`scripts/structure.mjs`:

- Coarse `LAYERS` (shell/page/component/store/foundation/test/asset).
- `AREAS` table from §4.6, including facade path and allowed imports.
- `areaOf(file)`, `segmentOf(file)`, `featureOf(area)`, `isFacade(file)`.
- `STRUCTURE_EXCEPTIONS` for documented folder-budget exceptions.

`lint/boundaries.js` keeps the existing upward/cycle/fail-closed behavior and
adds:

- `deep-cross-feature`: an import from another area that does not resolve to
  that area's `index.ts`.
- `forbidden-area`: an area pair not in the matrix (same feature and `pages/`
  are the only deep-import exceptions).
- `segment-direction`: within a `flow` area, `geometry/` may import only
  same-area `geometry/` and `flow/shared`; `model/` may not import
  `interaction/` or a view; `interaction/` may not import a view or a
  document service. Files at the area root (the facade) are exempt. Add
  fixtures for each direction.
- `test-support-in-production`: production code importing `test/` or
  `test-support/`.
- `native-outside-seam`: the `@flow/native` specifier outside
  `flow/shared/native-types.ts`, `flow/document/**` and tests. Outside
  `flow/document`, types go through `flow/shared/native-types.ts`; runtime
  calls are document-only.
- `unclassified-source`: a file not matched by the manifest.
- Tests and `test/` folders remain exempt.

Implement resolution, not string matching: the rule must resolve a relative
specifier to an existing file, trying `specifier.ts`, `specifier.tsx` and
`specifier/index.ts`, so it can distinguish an area facade from a deep import.
Add tests for file and bare-directory spellings (the existing
`lint/boundaries.test.js` already tests the layer map; extend it with nested
areas and facades). Verify the Oxlint JS plugin exposes `importKind` only if a
future rule needs it; the native seam above does not depend on it.

Every new area/segment must be added to the manifest and to
`lint/boundaries.test.js` with an allowed and a disallowed direction.

### 10.2 Structure check

Add `scripts/structure.mjs` and a `check:structure` package script, run from
`bun run check`. Scope the TSX checks to `.ts`/`.tsx` under `src/`, ignoring
`.nsh/**`, `target/**`, `node_modules` and `src/assets/**`; item 7 is a
reporting-only Rust layout check over `.rs` files:

1. Every non-test file under `src` is classified by the manifest; an
   unclassified file fails.
2. `src/components/`, `src/flow/` and `src/pages/` roots contain no app
   modules (only area folders; a root `index.ts` fails like any other root
   module).
3. Every **area** has `index.ts`; segments and part folders
   (`model/`, `geometry/`, `interaction/`, `test/`, `world/`, `selection/`,
   `editing/`, `controls/`, `feedback/`, `context-menu/`, `cards/`, `scene/`,
   etc.) do not.
4. Forbidden folder names fail only under app source, not under
   `src/native/**`, `.nsh/**` or `src/assets/**`; a `data.test.ts` file is not a
   `data/` folder.
5. Direct-entry budget: an area with more than 12 direct non-test
   modules/entries without subfolders prints a report; more than 20 fails
   unless listed in `STRUCTURE_EXCEPTIONS` with a reason and owner. The
   revised tree keeps `flow/canvas/model` at 6 direct entries and
   `flow/document` at 6 (facade + five segments; `test/` is exempt), so no
   exception is needed for them.
6. Test-support modules are not imported by production modules.
7. Rust layout: `mutation/`, `reads/`, `store/` files are consistent with
   their `mod` declarations; no app module at the crate root except the
   declared files. This is a reporting check; the compiler and clippy are the
   gate.

Add `scripts/structure.test.mjs` fixtures for the script itself: a root
module, an unclassified file, a missing facade, a deep cross-feature import,
a production import of `test-support`, and a budget exception. The script is
a gate; it needs the same tests as the lint plugin.

### 10.3 Documentation updates (same PRs as the code)

The single source of truth is the machine-readable manifest
(`lint/structure-map.js`); `docs/code-map.md` is generated or verified from
it. Normative rules live once:

| Document                             | What it owns                                           | What it must not duplicate         |
| ------------------------------------ | ------------------------------------------------------ | ---------------------------------- |
| `docs/standards.md`                  | normative rules (MUST/SHOULD), enforcement matrix      | per-file enumerations              |
| `docs/architecture.md`               | rationale, canvas layering, data flow                  | the full file tree                 |
| `docs/conventions.md`                | placement decision tree, glossary, naming, facade rule | layer rationale                    |
| `docs/testing.md`                    | test levels, naming, evidence                          | per-file coverage lists that drift |
| `docs/code-map.md`                   | area table, facade, may import, owner                  | rationale                          |
| `CLAUDE.md`                          | short rule list and gate                               | full standard                      |
| `docs/adr/0007-code-organization.md` | the decision and alternatives                          | implementation steps               |

Every move PR updates the docs it invalidates; Phase 5 is the final sweep,
not the first update. `CLAUDE.md` and `docs/conventions.md` change in Phase 0
so contributors see the rule while the migration runs.

Explicitly update:

- `docs/standards.md`: §3.2 layer table, §3.3 delete the "imported module by
  module" sentence, §4 folder/area rules, §6.2 per-id signals/keyed flags,
  §7 canvas paths, §8.4/§11/§14 probe exception, §9 test paths, §12
  enforcement matrix, §13 recipe paths; remove the stale `src/tool.ts`/
  `src/lib` layer entries.
- `docs/architecture.md`: replace file enumerations with the area map;
  update "State", "The canvas" and "Extending" recipes.
- `docs/conventions.md`: add the glossary and placement tree; update the Rust
  file map.
- `docs/testing.md`: fix the nonexistent `flow/edge-flow.test.ts`; update
  every path reference (about 65 occurrences on 38 lines); update the 100k
  benchmark filter name after Phase 6.
- `docs/node-editor.md`: update every path reference (about 30 occurrences
  on 26 lines).
- `docs/plans/rust-core.md`: update the benchmark filter names after Phase 6.
- `scripts/smoke-100k.mjs`: update the benchmark filter name after Phase 6.
- `CLAUDE.md`: remove `src/tool.ts`, update canvas paths, add the area rule.
- `docs/adr/0007-code-organization.md`: new ADR.
- `docs/code-map.md`: new area/ownership table.

### 10.4 Review checklist

Every change that adds or moves a file answers:

1. Which layer and area? Is the area in the manifest?
2. Does the import cross an area? Does it use the facade (or the same-feature
   exception)?
3. Did you search for an existing helper/primitive before writing a new one?
4. Does a view import the store, a document service or a loader? Move the
   binding to the page.
5. Are signals private and mutated only through methods?
6. Does the change preserve batching, equality gates and per-id signals?
7. Are lifecycle, disposal and async guards correct?
8. Is the test at the lowest level that can catch the bug, beside its subject?
9. Were docs/ADR/CLAUDE.md/code map updated?
10. Does the area still have one job? If not, find the seam; do not create
    `utils.ts`.

### 10.5 Phase 0 immediate rule

Even before the moves, the structure script runs with a legacy allow-list of
today's flat files. Any **new** file at the root of `components/`, `flow/`
or `pages/` fails. This stops the bucket from growing during the migration.
In the same Phase 0 PR, classify `test-support/` and `**/test/**` in the
manifest and turn on `test-support-in-production`, so the test seam is never
an unclassified hole.

### 10.6 Ownership

A standard without owners is a suggestion. Before Phase 1:

- Fill the Owner column in `docs/code-map.md`: one maintainer per area
  (`flow/canvas`, `flow/document`, `components/canvas`, `components/composer`,
  `flow/execution`, `flow/shared`, etc.). The owner reviews changes to that
  area's facade and its invariants.
- Add `.github/CODEOWNERS` entries for the areas. The owner is the first
  reviewer; cross-area changes need the lower area's owner too.
- Name an owner and an effort estimate (S/M/L) for each migration phase in
  §11. A phase with no owner does not start.
- `STRUCTURE_EXCEPTIONS` entries name an owner and an expiry; an exception
  without both is a review failure.
- A new **top-level layer** requires an ADR; a new **area** requires the
  manifest row, code-map row and lint fixtures.

---

## 11. Migration plan

Each phase is a separate PR (or a small stack), does not change behavior, and
ends with `bun run check` and `bun run test`. Host tests run after phases 3 and
4; the 100k benchmark runs if any hot path is touched. Each phase names an
owner and an effort (S/M/L) before it starts; rollback is reverting the PR.
There are no data or schema changes in Phases 0–5; the optional `assets_fts`
migration in Phase 6 is the one exception and is reversible by keeping the
table.

| Phase | Scope                                | Owner          | Effort |
| ----- | ------------------------------------ | -------------- | ------ |
| 0     | Docs, ownership, report-only tooling | `@YougLin-dev` | S      |
| 1a    | Shared kernel and first reuse        | `@YougLin-dev` | M      |
| 1b    | Composer shell                       | `@YougLin-dev` | M      |
| 1c    | AsyncDrain core + PreviewLoader      | `@YougLin-dev` | S      |
| 1d    | Connector layer and primitives       | `@YougLin-dev` | M      |
| 2     | `flow/` areas (8 PRs)                | `@YougLin-dev` | L      |
| 3     | `components/` areas                  | `@YougLin-dev` | L      |
| 4     | Page decomposition                   | `@YougLin-dev` | M      |
| 5     | Enforce the matrix                   | `@YougLin-dev` | S      |
| 6     | Rust core split (parallel)           | `@YougLin-dev` | L      |
| 7     | Internal splits (optional)           | `@YougLin-dev` | L      |

The repository has one maintainer today, so every phase names that owner.
Split the rows when a second owner joins; the phase does not start without an
owner and an effort estimate.

### Phase 0 — Decide and document (no code moves)

- Write ADR 0007, update standards/architecture/conventions/CLAUDE.md with
  the rules, add `docs/code-map.md`.
- Add `lint/structure-map.js` and `scripts/structure.mjs` in report-only mode
  with the legacy allow-list; fail only on new flat modules.
- Cross-review this proposal; record dispositions in §16.

### Phase 1 — Shared kernel and extractions (small, separate PRs)

Do **not** treat Phase 1 as one low-risk PR. The three riskiest refactors
(ComposerSheet, AsyncDrain, equality unification) get their own PR and their
existing behavior tests first.

1a. **Low-risk shared kernel.** Add `flow/shared/{geometry,equality,wheel,
shortcuts,native-types}`; route `sameBounds`/`sameBox`/`samePoint`/`sameRect`
call sites through the named comparators (exact vs tolerant stays explicit);
move the shortcut constants out of `flow/bindings.ts` and `keepsWheel` out of
`flow/page-chrome.ts` (four component imports), so no component ever imports
a page module. Add `connectorColor` in the view layer and
`result-inputs.ts` in `flow/shared`, and route the six construction sites.
Add `native-types.ts` and route `@flow/native` **type** imports through it.
Add `components/primitives/Icon` + `icon-shape`, and move
`flow/port-visuals.ts` to `components/canvas`; these are the only file moves
in 1a, and `port-visuals`' last flow dependency (`icon-shape`) moves with
it. Add tests for the pure helpers.

Execution decision (Phase 1a): `result-inputs.ts` lives in `flow/shared`,
not `flow/document/commands`, because `flow/execution` may not import
`flow/document` (§4.6) and both areas construct batches; the factories are
`resultBatch`, `textResultItem`, `imageResultItem`, `manualTextResult` plus
the generic `resultItem` for copies. The `portStroke`/`connectorColor`
concept is the single `connectorColor` helper in
`components/canvas/port-visuals.ts`. The plan's earlier six-site note also
named `node-commands.ts`, which builds batches through the same factories.
1b. **Composer shell.** Extract `ComposerSheet`/`ComposerAttachments`/
`ComposerFooter`; rewrite `TextComposer`/`ImageComposer` (renamed from
`NodeComposer`) as configurations. Preserve the `<If when={detail}>` mount
boundary, `settingsOpen`, `settingsLabel`, every `testID` and the existing
app tests; add a test for the shared shell.
1c. **AsyncDrain core.** Add `flow/shared/async-drain.ts` and migrate
`PreviewLoader` in the same PR, using `preview-loader.test.ts` as the oracle.
Migrate `ViewportController` and `MinimapLoader` one per PR in Phase 7; their
scheduling, revision fences and retry rules differ, so do not batch them.
1d. **Connector and primitive reuse.** Extract `connector-layer.ts` and
`ConnectorCanvas` for `FlowEdges`/`FlowPreviews`; keep the computed layer
box per mounted layer, keep `token()` calls inside `draw` so theme switches
repaint, and keep `sameBox`/64-step trim semantics. Add
`IconButton`/`MenuItem`/`panel.ts`/`TooltipPill` only where at least two
real consumers justify them.

Each sub-PR deletes only the code it replaces and keeps the orphaned
`TextComposer` comment cleanup in 1b.

### Phase 2 — `flow/` areas

Order (each step is one PR):

1. `flow/shared` and `flow/nodes` (leaf moves; facades).
2. `flow/canvas/geometry` (pure math; facades; update imports).
3. `flow/canvas/model` (scene, camera, ports, card helpers; add
   `scene-types.ts`, `cursor.ts` and `cards/card-image.ts` to break the two
   cycles and own `CardImageEvent`; extract `cards/inline-body.ts` from
   `overlay.ts` here, leaving the `placement.ts` half for step 6; no behavior
   split).
4. `flow/canvas/interaction` (controller, gestures; add `canvas-input.ts`
   only if it is a behavior-preserving extraction).
5. `flow/minimap` (mapping + controller).
6. `flow/composer` (state + the `placement.ts` half of `overlay.ts`).
7. `flow/execution` (split `runner.ts`/`providers.ts`; move only).
8. `flow/document` lifecycle/session/commands/assets/viewport; move files
   as-is and keep the `NodeSession` class intact. Move the reload policy of
   `composer-detail.ts` to `session/composer-detail.ts`; `errorOf`/`inputUrl`
   stay in the old module until Phase 3 step 5. The composer/inline/asset
   session split is Phase 7, not this PR; the native tests override
   `protected nodeDetail`, so preserve it until the harness is updated.

Keep each PR to one area and roughly the standards' small-change size. A
16-module `flow/document` move plus four native test moves plus a session
split is too large for one review.

Mechanics: create the area `index.ts` first and point external imports at
it, then `git mv` internals and update the facade; tests can keep deep imports
during the move and follow their subject in the same PR. A naive codemod that
rewrites every internal import to the facade creates self-imports and cycles;
rewrite only cross-area imports, use explicit `export type` re-exports under
`verbatimModuleSyntax`, and run `nsh check` after each move map. No
compatibility shims after a phase.

### Phase 3 — `components/` areas

1. `components/app` (TitleBar/BrandCard/FrameRate).
2. `components/canvas` move as-is into world/selection/editing/controls/
   feedback/context-menu. Extract `selection-visuals.ts` and `menu-items.ts`
   only where two views share the recipe. Split this into at least two PRs:
   the world/parts move, then the overlays/controls/context-menu move.
3. **Optional** FlowCard parts (`CardTitle`, `CardBody`, `status-visual`):
   pass the existing `CardGeometry`/`CardContent` instances and accessors
   down; never read `node()` or `camera.scale` in a part; keep
   `card-geometry.test.ts`/`card-content.test.ts` green and add an app test.
4. **Optional** `canvas-input.ts`: instantiate it once, synchronously, in the
   always-mounted `FlowCanvas` body or the page; never inside a conditionally
   mounted surface. Run `test:host` and the touch/pan app tests.
5. `components/composer` (sheet, variants and `detail-view.ts` with the
   `errorOf`/`inputUrl` half of today's `flow/composer-detail.ts`),
   `components/minimap`, `components/search`.
6. `components/probes`; move `ImageLoadProbe`/`ZoomProbe`/`CanvasProbe` out of
   production views; keep `imageEvent` as an optional observation seam.
7. Update the page to import facades; run host tests.

### Phase 4 — Page decomposition

- Move `pages/FlowPage.tsx` → `pages/flow/FlowPage.tsx`; add
  `pages/flow/index.ts`.
- Add `pages/flow/workspace/flow-workspace.ts` as the composition root and
  `flow-actions.ts`/`flow-effects.ts` for the rest.
- Move bindings/page-chrome/search-navigation/menu dismissal.
- Target `FlowPage.tsx` under ~250 lines; the page keeps only construction,
  effects, cleanup and render.
- Preserve creation order, lazy `applyChanges` capture, the `sized`/`opening`
  guards and cleanup order (previews/minimap/viewport before
  document/session).
- Call the workspace/effects helpers exactly once, synchronously, in the
  `FlowPage` body. Do not construct a workspace after an `await` or from
  `onSize`; an ownerless effect would never dispose. Keep `bindFlowKeys` and
  `dismissContextMenuOnChange` in the page owner.

### Phase 5 — Turn on enforcement

- Flip `lint/boundaries.js` to the new matrix; add the new reports and tests.
- Make `scripts/structure.mjs` fail on violations; remove the legacy
  allow-list.
- Update `bun run check` to run it; update all docs and the code map.
- Remove the report-only mode.

### Phase 6 — Rust core split (parallel with phases 2–5)

1. Move `db.rs` tests to `db/tests/*`; add visibility (`pub(super)`/
   `pub(crate)`) for relocated private helpers; move only test data, not the
   reference oracles. Keep `mod benchmark;`.
2. Split `db.rs` into `db/{mod,worker,startup,undo}.rs`; move counts/bounds/
   is_empty to `reads/metadata.rs`; move `ensure_document`/`current_rev` to
   `store/document.rs` (`db/startup.rs` keeps `open_connection` and calls
   `schema::migrate` + `store::document::ensure_document`); move
   `empty_change`/`lock_history` to `db/undo.rs`. `bump_document_rev` is
   defined in `mutation.rs` and moves with the mutation split (step 3).
3. Split `mutation.rs` behind the existing facade, one command family per
   commit; extract `support.rs` and `tx/*` first; fix `reads/mod.rs`
   visibility.
4. Deduplicate with the safety notes in §9.1; run the ignored 100k benchmark.
5. Update `scripts/smoke-100k.mjs`, `docs/testing.md` and
   `docs/plans/rust-core.md` for the new `db::tests::benchmark::*` filter
   names; update the ownership comments; decide `assets_fts`.

### Phase 7 — Internal splits (incremental, after enforcement)

- `FlowScene` pure helpers (`scene-hits`, `scene-selection`,
  `scene-records`, `scene-overrides`) behind the existing class.
- `CanvasController` hit-priority/drag-resize/marquee/hover helpers; one
  batch remains in the class.
- Migrate `ViewportController` and `MinimapLoader` to `AsyncDrain` one per
  PR, each with its existing test as the oracle. Do not treat them as one
  identical state machine: their scheduling, revision fences and retry rules
  differ. (`PreviewLoader` migrates with the core in Phase 1c.) When they
  migrate, have each loader check its own disposed flag at the top of its
  step: a join that lands in the drain's settlement gap can force one
  follow-up after `dispose()` starts, and the current app avoids it only
  because the page marks the host disposed first.
- `NodeSession` split into composer/inline/asset/command sessions behind the
  facade; preserve `protected nodeDetail`, generation fencing and
  `copyNodeWithDrafts`/`deleteNodeWithDrafts`, or update the harness and its
  tests in the same PR.
- `FlowPage`/`flow-workspace` further extraction only if it is still too
  large.
- Optional: move `MiniMap`'s touch/drag state into `MinimapController`,
  keeping the responders on the mounted panel.
- Split the largest tests by behavior.
- Optional: a short `README.md` in `flow/canvas` and `flow/document` with
  invariants.

### Migration mechanics that keep the gate green

- **Strangler facades:** create `area/index.ts` re-exporting today's modules;
  point external imports at it; then move internals and update the facade.
  External call sites change once.
- **One area per PR.** Do not mix a move with a behavior change.
- **`git mv`**, not copy/delete, so history follows the file.
- **Codemod:** a one-off script can rewrite relative specifiers from a
  `{ oldPath: newPath }` map; run `nsh check` after each map. The map is the
  appendix A table.
- **Directory imports:** NSH resolves a bare directory to its `index.ts` (the
  bundler's `shared_sources_and_external_themes_are_watched` test uses
  `import { label } from '../ui'`), so facades are safe.
- **Tests move with subjects**; update `docs/testing.md` paths in the same
  PR.
- **App harness:** `src/test-support/app.ts` keeps `open("./App.tsx")`
  because `open` resolves relative to the test file; keep the `App*.test.tsx`
  files at the app root and run the app tests after the move.
- **No shims at the end of a phase.**

**Minimum viable standard:** Phases 0–5 deliver the folders, facades,
matrix, reuse and page decomposition. Phase 6 is independent. Phase 7 is
quality follow-up and can slip.

---

## 12. Risks and mitigations

| Risk                                                      | Why it matters                                                                  | Mitigation                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Splitting a component moves state into a remounting child | NSH runs bodies once; gesture state would reset                                 | Keep state in the page-owned class or the same mounted view; split render parts only                             |
| Facades create cycles                                     | `import/no-cycle` fails the gate                                                | Never import your own facade; keep shared types in lower areas; run lint each PR                                 |
| Perf regression from "cleaner" props                      | FlowCard's accessors are load-bearing                                           | Keep accessor props; no `camera.scale` read per card; benchmark after Phase 3                                    |
| Batching lost in extracted gestures                       | One event would become several update rounds                                    | Only the facade opens `batch`; helpers are pure                                                                  |
| A page-only helper is imported by a component             | Components→pages is forbidden                                                   | Split pure policies (`wheel`, `shortcuts`) into `flow/shared` first; pass callbacks as props                     |
| Phase 1 is treated as behavior-free                       | ComposerSheet, AsyncDrain and equality unification change real behavior         | Split into 1a–1d; existing tests first; migrate loaders one per PR                                               |
| FlowCard parts re-create reactive graphs                  | A part reading `node()` or `camera.scale` rebuilds every card or stops updating | Pass the existing `CardGeometry`/`CardContent` instances and accessors; keep the two unit tests plus an app test |
| FlowCanvas input state remounts                           | Press/pinch/suppress state resets                                               | Instantiate the input class once in the always-mounted body or page; run host/touch tests                        |
| Lint cannot resolve facades                               | String matching cannot tell an area facade from a deep import                   | fs-based resolution with `.ts`/`.tsx`/`index.ts`; native types through `flow/shared/native-types`                |
| Test harness `open("./App.tsx")` breaks after the move    | False: `open` is relative to the test file, not the caller                      | Keep `open("./App.tsx")`; no change                                                                              |
| Migration PRs are too large                               | Review risk and standards' small-change rule                                    | One area per PR; split document, canvas and session work                                                         |
| Migration churn breaks tests/docs                         | 100+ import paths change                                                        | Strangler facades, one area per PR, codemod + gate                                                               |
| Over-abstraction (`panel`, `utils`)                       | Indirection without reuse                                                       | Rule of two; no generic primitive until two real features; no `utils`                                            |
| Folder standard becomes bureaucracy                       | Contributors work around it                                                     | Manifest in code, one structure script, documented exceptions                                                    |
| Rust split changes behavior                               | Commands/history are subtle                                                     | Mechanical moves first, tests split first, one family per PR, FFI unchanged, benchmark                           |
| Docs drift                                                | Paths appear in 6 docs                                                          | Manifest is SSOT; code map verified; per-phase updates                                                           |

---

## 13. Alternatives considered

| Option                                                          | Why it fits                                                                         | Why it does not                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Keep flat layers, add discipline only**                       | Zero migration                                                                      | The flat namespace is the problem; 51/29 files cannot be navigated by convention                                               |
| **Technical buckets (`controllers/`, `services/`, `helpers/`)** | Familiar, quick                                                                     | Scatters one feature across many buckets; the FSD/Bulletproof/VS Code evidence is against it                                   |
| **Full FSD top level (`features/entities/shared`)**             | Strongest cohesion and public-API rule                                              | Large rename; duplicates NSH's page/component guidance; one-page app does not need the full hierarchy                          |
| **Feature-first areas in each layer (chosen)**                  | Keeps the documented layer graph; fixes cohesion; mechanical migration; enforceable | Still two roots per feature (view/model); acceptable because that is the layer seam                                            |
| **Flow-only first, components later**                           | Smaller early diff                                                                  | Leaves the 29-file component bucket and the composer duplication untouched; we do Phase 1 reuse first, then both areas         |
| **Monorepo packages (`canvas-engine`, `app`)**                  | Physical boundary and independent testing                                           | Overkill for one app; adds build/release complexity; revisit if the canvas is extracted or collaboration arrives               |
| **Rename `flow/` to `canvas/` + `workspace/`**                  | Screaming names                                                                     | `flow` is the documented foundation name and appears in many docs/tests; the area subfolders solve the ambiguity at lower cost |

---

## 14. Success criteria

1. `bun run check` and `bun run test` pass at every phase; `test:host` after
   Phases 3–4.
2. Every non-test module under `src/flow` and `src/components` lives in an
   area folder with an `index.ts`; no app modules at those roots.
3. The lint matrix and `scripts/structure.mjs` pass; the structure script
   fails on an unclassified, deep-cross-feature or test-support-in-production
   import.
4. `FlowPage.tsx` is under ~250 lines and imports facades, not 35 modules.
5. The duplication list in §6.4 is removed or explicitly justified; the
   block detector's top pairs are gone.
6. `FlowScene`, `CanvasController`, `NodeSession` and `ViewportController`
   have clear seams (the `max-lines` rule counts code lines, so raw-line size
   is not the acceptance test). They may keep their public facade while pure
   helpers are extracted; the class remains the one state/batch owner.
7. Rust: `mutation.rs` split by command family; `db.rs` production code and
   tests separated; all tests and benchmarks still pass; FFI unchanged.
8. A newcomer can place a new file by §4.7 and §4.9 without asking; a
   reviewer can point to the rule that decides a placement question.
9. One machine-readable map (`lint/structure-map.js`), one verified code map
   (`docs/code-map.md`), and standards that state rules rather than
   enumerating files.

---

## 15. Questions for cross-review

1. Is keeping the `components/` + `flow/` split right, or should the composer
   view and model merge into a top-level `features/composer`? (We recommend
   keeping the layers now; revisit on a second page/package/collaboration.)
2. Is `flow/document` the right home for sessions/assets/viewport, or should
   assets/viewport be separate areas? (We grouped them as segments inside
   `document`; execution is its own area.)
3. Are facades per area worth the indirection at this size? (We believe yes:
   the area count is ~13, and same-feature deep imports remove the worst
   friction.)
4. Is splitting `FlowScene` into pure helpers safe without changing signal
   ownership? (We propose helpers over a `SceneReader`, keeping the class.)
5. What is the right folder budget? (We propose 12 direct entries as a
   report, 20 as a failure with a documented exception.)
6. Should the Rust `db.rs` become `db/mod.rs`? (We propose yes for a clear
   facade; `db.rs` + `db/tests/` also works until the split.)
7. What should be the first PR after approval? (We recommend **Phase 1a**:
   geometry/equality/portStroke/result-inputs + the test-support
   classification and the harness `open("./App.tsx")` check. No loader or
   composer rewrite in the first PR.)

---

## 16. Cross-review log

Four initial reviewers covered architecture, implementation risk, DX/reuse
and the Rust core; two final reviewers covered consistency and goal fit.
Their findings and dispositions:

| Lens                | Verdict                           | Main findings                                                                                                                                                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture        | Sound model; adopt                | Bindings move breaks layer graph; `flow/document → flow/composer` missing; document too broad; geometry imports camera types; facades too coarse; `port-visuals`/`minimap-loader` in wrong layer; alternatives incomplete                                                                                                                                                                       | Accepted: bindings split to `flow/shared/shortcuts`; composer-detail split; document segmented + execution area; `Size` in shared; curated facades + same-feature deep imports; port visuals to components; minimap loader to document; FSD-lite/flow-only alternatives added |
| DX/reuse            | Teachable, needs fixes            | Area vs segment undefined; model folders exceed budget; `StageSize`/overlay mapping; new-feature procedure missing; docs/SSOT drift; test moves/phase boundaries; `FloatingPanel` too broad; status classes in model                                                                                                                                                                            | Accepted: area/segment/part vocabulary; nested model folders; `StageSize` in `flow/shared`; new-area recipe; SSOT manifest; test map; panel recipe scoped; status visual to components                                                                                        |
| Rust core           | Direction safe, needs amendments  | Reads visibility; `current_rev`/`empty_change`/`lock_history` unassigned; test visibility and benchmark imports; `tx` cross-deps; risky dedups; oracles must stay; `assets_fts` migration; wrong dependency arrow                                                                                                                                                                               | Accepted: §9 rewritten with visibility, assignments, peer graph, parameterized dedups, oracle rule, migration 6 note, benchmark step                                                                                                                                          |
| Implementation risk | see §16.1                         |                                                                                                                                                                                                                                                                                                                                                                                                 |                                                                                                                                                                                                                                                                               |
| Goal fit            | Solves the complaint; conditional | Segment direction stated but unenforced; ownership nominal; native type-import contradiction; part-folder procedure; structure-script tests; document volume                                                                                                                                                                                                                                    | Accepted: `segment-direction` lint; §10.6 ownership/CODEOWNERS; §4.6 native seam; §4.9 part folders; §10.2 script fixtures; reading guide                                                                                                                                     |
| Consistency         | Needs fixes; integrated           | Phase 2 step 9 duplicated Phase 4; `ensure_document` double home; `reads` visibility; stale `mutation/tx/document.rs`; `constants` comment; `connectorColor` dual home; geometry names; Appendix splits; missing harness bullet; `CardImageEvent` home; unassigned tree modules; native type scope; Rust structure scope; `pages/` check; matrix scope; test-map gaps; doc counts; measurements | Accepted: step 9 removed; startup/store ownership fixed; `pub(crate)` for reads; stale paths removed; one naming set; appendix/new-module lists corrected; phases assigned; prose scoped; checks separated; test map completed; counts and measurements refreshed             |

### 16.1 Implementation-risk review

| Severity | Finding                                                                 | Disposition                                                                                                                   |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| BLOCKER  | `bindings` move makes `ZoomControls` import a page                      | Key constants move to `flow/shared/shortcuts.ts`; only `bindFlowKeys` stays in the page                                       |
| BLOCKER  | `StageSize` had no legal home                                           | `Size`/`StageSize` in `flow/shared/geometry.ts`; no component→composer edge                                                   |
| BLOCKER  | `composer-detail` created a document→composer edge                      | Reload policy stays `flow/document/session`; view helpers move to `components/composer/detail-view.ts`                        |
| BLOCKER  | Geometry imported camera model types                                    | `Size`/`BoxGeometry` move to `flow/shared`; `tooltip`/`view-culling` use them                                                 |
| BLOCKER  | Harness `open("./App.tsx")` breaks after the move                       | False: `open` is relative to the test file; the path stays                                                                    |
| MAJOR    | `AsyncDrain` is not one identical state machine                         | Add the core and migrate `PreviewLoader` in 1c; migrate viewport/minimap one per PR in Phase 7 with their tests as oracles    |
| MAJOR    | FlowCard parts can duplicate reactive graphs                            | Pass existing `CardGeometry`/`CardContent` instances/accessors; never read `node()`/`camera.scale` in a part; add an app test |
| MAJOR    | FlowCanvas input state ownership                                        | Instantiate once in the always-mounted body or page; no conditional mount; run host/touch tests                               |
| MAJOR    | NodeSession split in the move PR breaks `protected nodeDetail` tests    | Move the class intact in Phase 2; split in Phase 7 with harness updates                                                       |
| MAJOR    | Workspace/effects created after `await` or in `onSize`                  | Construct once synchronously in the `FlowPage` body; keep key/menu effects in the page owner                                  |
| MAJOR    | Lint string matching cannot verify facades                              | fs-based resolution (`.ts`, `.tsx`, `index.ts`); native types through `flow/shared/native-types`                              |
| MAJOR    | Structure script false positives                                        | Scope `.ts/.tsx`, ignore `.nsh`/`target`/`assets`/`native`, require indexes only on areas, document budget exceptions         |
| MAJOR    | Docs update deferred to Phase 5                                         | Per-phase doc updates; `CLAUDE.md`/conventions in Phase 0; benchmark filter names in Phase 6                                  |
| MAJOR    | Phase 1 was described as behavior-free                                  | Split into 1a–1d; Composer and AsyncDrain get their own PRs and behavior tests                                                |
| MINOR    | Comparators must keep call-site semantics                               | Name exact vs tolerant; do not switch `computed({ equals })` to tolerant; enumerate in the PR                                 |
| MINOR    | Connector layer caching depends on one computed and `token()` in `draw` | Keep the computed per mounted layer and color reads inside `draw`                                                             |
| MINOR    | Composer rewrite can change mount/test behavior                         | Preserve the `<If when={detail}>` boundary, `settingsOpen`, every `testID`, and the existing app tests                        |
| MINOR    | `statusVisual` returning palette classes from the model                 | Return semantic keys from the model; map to class recipes in `components/canvas/world`                                        |
| MINOR    | `test-support` classification delayed                                   | Classify it and enable `test-support-in-production` in the PR that creates it                                                 |
| NIT      | God-object line counts were used as urgency                             | Raw lines are a signal; the `max-lines` metric passes today. The case is cohesion                                             |

The reviewer's main over/underestimates are reflected above: Phase 1 is not
behavior-free; god-object size is cohesion, not a cap violation; a naive
codemod can create self-imports/cycles; cross-feature type seams
(`StageSize`, `composer-detail`, key constants, camera types) are design
decisions; the test harness and `NodeSession` protected seam need explicit
handling; and Phase 2/3 PRs must be split by area. The first PR is **Phase
1a**, with no loader or composer rewrite.

### 16.2 Phase 0 implementation review

Three independent reviewers checked the Phase 0 commit
(`chore: establish the area structure standard`): architecture/correctness,
tests/reuse and risk/rollback. All three returned **CHANGES REQUESTED**; the
findings below were closed in the follow-up commit before Phase 1a.

| Lens          | Main findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture  | `areaOf("src/App.tsx")` was null so the shell row was dead; `isFacade` missed the store; geometry could import `flow/nodes` or a same-area root file; the structure report did not walk imports; standards recipes still told readers to add root modules; code-map listed the stale Type layer; page/shell allowed test imports; native docs did not state the seam; native rule missed export/import forms; root `index.ts` was rejected; plan status stale; `edge-flow.test.ts` missing; dead `type` branch; conventions command table stale | Fixed: `App` classifies as shell and `isFacade` compares the manifest facade; geometry allows only `flow/shared` and same-area `geometry/`; `checkAreaImports` reports deep/forbidden/segment/native findings and Phase 5 gates each flag; §13 recipes use area paths; code-map mirrors `LAYERS`; Test rows list `TEST_SUPPORT_FILES`; native docs and rule forms align; the layer-root `index.ts` exemption added in that round later conflicted with the standard and was removed (below); plan status accepted; testing/conventions updated |
| Tests/reuse   | `test-support-in-production` missed `TEST_SUPPORT_FILES`; `check:structure` was not in `check`; tests did not prove the exact failure set, budget exception or export/dynamic forms; geometry under-enforced; resolver logic duplicated and partly untested; `readImports` regex read comments; `isFacade` store; missing allowed-direction fixtures; duplicate `withTree`                                                                                                                                                                      | Fixed: one `isTestSupportTarget` predicate in both detectors; `check:structure` is part of `check`; exact failure-set, 13/21-entry budget and owner+expiry exception tests; geometry allowed/disallowed fixtures; shared `lint/import-resolver.js` with `.ts/.tsx/.js/.jsx/index` tests; `Bun.Transpiler.scanImports` replaces the regex; shell/area allowed-direction tests; `lint/test-tree.js` shared helper                                                                                                                                |
| Risk/rollback | `check` omitted the structure guard; standards §13 contradicted the placement rule; code-map Type layer; `isFacade` store; native rule export forms; stale `LEGACY_FLAT` entries undetected; plan status stale; conventions described the end state as current                                                                                                                                                                                                                                                                                  | Fixed: guard wired into `check`/`check:fix`; recipes rewritten; code-map mirror corrected; `isFacade` fixed; native rule covers import/export/dynamic; `checkLegacyAllowList` reports stale entries and fails in Phase 5; plan status and conventions wording updated                                                                                                                                                                                                                                                                          |

A verification pass re-checked the fixes. It found two remaining test-coverage
gaps (the import fixture did not distinguish static/re-export/dynamic forms;
forbidden/segment/Phase 5 gating had no fixture) and two report/rule issues
(`Bun.Transpiler.scanImports` erases type-only imports; the model/document
segment clause fired on same-area `flow/document` imports). They were closed
in `test: strengthen the Phase 0 structure fixtures` and
`fix: preserve type-only imports in the structure report`.

Both verification reviewers then re-checked the final tree and returned
**APPROVE** with no BLOCKER/MAJOR findings at `473af8a` (the `dbd2183`
status note is docs-only). Their one non-blocking note — architecture,
conventions and standards stated the `flow/shared/native-types.ts` seam
descriptively in the present tense, before Phase 1a creates it — is closed
by phrasing the seam as a rule.

A delayed structural re-check ran against `dbd2183` and found three latent
issues the earlier lenses missed: the interaction segment clause repeated the
same-area `flow/document` false positive just fixed for the model clause;
`areaOf` classified the legacy flat `flow/minimap.ts` and `flow/execution.ts`
as their future areas, so the Phase 2 moves would have produced false area
findings; and the layer-root `index.ts` exemption that §10.2 item 2 allowed
contradicted the standard's "no new root module" rule. All three are closed:
both segment clauses guard same-area targets, `areaOf` returns null for
`LEGACY_FLAT` paths, and §10.2 plus the tooling now reject every root module,
`index.ts` included; `readImports` also now asserts its duplicate-specifier
dedupe; and the walk returns early on a forbidden area pair exactly like the
lint rule, so both surfaces emit one finding instead of two. The same report
repeated the already-fixed type-only finding — current `check:structure`
emits the 32 type-only/value native-seam reports — so no change was needed
there.

After the fixes: `bun run check` (including `check:structure`), `bun run test`
(520 tests, 518 passed, 2 skipped) and `bun run check:structure` are green.
`check:structure` reports the native seam debt (32 type-only/value imports
outside `flow/document`) as the Phase 1a worklist. No source file moved;
`LEGACY_FLAT` still matches the 81 flat modules exactly. Phase 0 is complete;
Phase 1a is the next PR.

Phase 1a routed every production `@flow/native` type import through the
seam; `check:structure` now reports only `src/flow/document-session.ts`'s
runtime import, which moves with its area in Phase 2. `LEGACY_FLAT` is down
to 78 modules; the shared kernel, `components/primitives`,
`components/canvas` and `src/test-support/app.ts` are in place.

Phase 1b extracted the composer shell into `components/composer`
(`ComposerSheet`, `ComposerAttachments`, `ComposerFooter`) with
`TextComposer` and `ImageComposer` as configurations; the
`<If when={detail}>` mount boundary, `settingsOpen`, `settingsLabel`, every
testID and the existing app tests are preserved, and `App.composer.test.tsx`
pins the shared shell for both variants. `LEGACY_FLAT` is down to 76.

Phase 1c extracted `flow/shared/async-drain.ts` (join/settle, one follow-up,
racing starts) and migrated `PreviewLoader` onto it; `preview-loader.test.ts`
stayed the oracle and passes unchanged. `ViewportController` and
`MinimapLoader` keep their own drains until Phase 7, as their scheduling,
revision fences and retry rules differ.

Phase 1d extracted `components/canvas/world/{connector-layer,ConnectorCanvas}`
for `FlowEdges`/`FlowPreviews`: the per-mounted-layer computed box, the
64-step trim and the draw-time `token()` reads stay where they were, and the
canvas view now shares its position/size/padding mapping and the world-origin
`traceCubic`. The primitive survey found the floating-panel recipe met the
"at least two real consumers"
gate — four components use the base card chrome and two use its pill — so
`components/primitives/panel.ts` now owns `PANEL`/`PANEL_PILL`. The
context-menu rows live in one component, the two tooltip implementations use
different mechanisms, and the icon-only buttons carry distinct sizes and
colors; those wait for the Phase 3 area moves.

Phase 2 step 1 moved the leaf modules: `flow/nodes/node-kinds.ts` (the kind
registry) now leaves through the `flow/nodes` facade, and `KeyedFlags` lives
in `flow/shared/keyed-flags.ts` behind the shared kernel's facade. Every
cross-area importer names the facade, and the moved tests stayed beside their
subjects. `LEGACY_FLAT` is down to 74 modules.

Phase 2 step 2 moved the pure-math modules to `flow/canvas/geometry`
(`connection`, `edge-clip`, `grid`, `preview-grid`, `selection`, `tooltip`,
`view-culling`) behind a curated `flow/canvas` facade. `BoxGeometry`,
`overlaps`, `mergeBounds` and `containsPoint` now live in
`flow/shared/geometry.ts` (the §6.4 home), so the geometry segment imports no
model: `tooltip`/`view-culling` take shared `Size`/`BoxGeometry` instead of
camera types. The extracted helpers gained direct tests in
`flow/shared/geometry.test.ts`. `LEGACY_FLAT` is down to 67 modules.

Phase 2 step 3 moved the canvas model to `flow/canvas/model` (camera, scene,
scene ports, record equality, group ports, edge layer, card content/geometry/
layout) and extracted `scene-types.ts` (`SceneReader`, `PreviewView`,
`ConnectionPreview`), `cursor.ts`, `cards/card-image.ts` and
`cards/inline-body.ts`; the scene ↔ helper and controller ↔ handle cycles are
gone. `CameraSize`/`CameraBounds` are now aliases of the shared `Size`/
`BoxGeometry`. The inline-editor test moved beside `inline-body.ts`. The
scene's internal split (and the `scene-hits.test.ts` rename) stays in Phase 7
because §11 step 3 forbids a behavior split. Accepted ADRs keep their
historical module paths, per `docs/adr/README.md`'s immutability rule.
`LEGACY_FLAT` is down to 58 modules.

Phase 2 step 4 moved the interaction modules to `flow/canvas/interaction`
(controller, connection/edge/hover/right gestures, context menu, frame
surface, resize handles). The facade gained `ConnectionPair` for
`flow/document`; `CanvasController` stays unexported for the page and canvas
views. Execution decision: `canvas-input.ts` is not extracted — §11 marks it
optional and the touch responder state must stay on the always-mounted view,
so no behavior change was made. `LEGACY_FLAT` is down to 50 modules.

Phase 2 step 5 moved the minimap mapping and drag state to `flow/minimap`
behind the area facade. `minimap-loader.ts` stays at the flow root until the
document step moves it to `flow/document/assets` (§6.4 keeps the loader in
the document feature). `LEGACY_FLAT` is down to 48 modules.

Phase 2 step 6 moved `composer-state.ts` and the placement half of
`overlay.ts` to `flow/composer` (`placement.ts`); the inline-body half moved
in step 3. `composer-detail.ts` stays for the document step. `LEGACY_FLAT` is
down to 46 modules.

Phase 2 step 7 split `flow/execution.ts` into `runner.ts` (the run lifecycle
and cancellation) and `providers.ts` (the mock text/image providers and the
wait/cancel primitives) behind the area facade. The split is a move only: the
bodies are copied unchanged and `NodeRunner` is the only external export.
`LEGACY_FLAT` is down to 45 modules.

Phase 2 step 8 moved the document lifecycle, sessions, commands, assets,
viewport and the native-test harness under `flow/document/`. The composer
reload policy split into `session/composer-detail.ts` (`errorOf`/`inputUrl`
stay in the root `composer-detail.ts` for Phase 3 step 5), `sameOverview`
moved with the minimap loader, and `ViewportHost.fallbackBounds` replaced the
viewport controller's seed import. The structure walker now skips only
`src/assets/`; skipping every `assets/` folder would have hidden the new
area-owned segment. `LEGACY_FLAT` is down to 32 modules and the native-seam
report is clear (the runtime import lives inside `flow/document`).

---

## Appendix A — TSX placement map (non-test)

`→` means the final home after the internal splits. Tests follow their
subject; see §8.

| Current                              | Target                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `components/BrandCard.tsx`           | `components/app/BrandCard.tsx`                                                                                   |
| `components/CanvasContextMenu.tsx`   | `components/canvas/context-menu/CanvasContextMenu.tsx`                                                           |
| `components/CanvasMenuLayer.tsx`     | `components/canvas/context-menu/CanvasMenuLayer.tsx`                                                             |
| `components/CanvasProbe.tsx`         | `components/probes/CanvasProbe.tsx`                                                                              |
| `components/ComposerInputTile.tsx`   | `components/composer/ComposerInputTile.tsx`                                                                      |
| `components/ComposerModelSelect.tsx` | `components/composer/ComposerModelSelect.tsx`                                                                    |
| `components/FlowCanvas.tsx`          | `components/canvas/FlowCanvas.tsx` (+ optional `world/` parts)                                                   |
| `components/FlowCard.tsx`            | `components/canvas/world/FlowCard.tsx` (+ `CardTitle`, `CardBody`, `status-visual`)                              |
| `components/FlowEdges.tsx`           | `components/canvas/world/FlowEdges.tsx`                                                                          |
| `components/FlowPreviews.tsx`        | `components/canvas/world/FlowPreviews.tsx`                                                                       |
| `components/FrameRate.tsx`           | `components/app/FrameRate.tsx`                                                                                   |
| `components/GridBackground.tsx`      | `components/canvas/world/GridBackground.tsx`                                                                     |
| `components/Icon.tsx`                | `components/primitives/Icon.tsx`                                                                                 |
| `components/InlineTextEditor.tsx`    | `components/canvas/editing/InlineTextEditor.tsx`                                                                 |
| `components/MiniMap.tsx`             | `components/minimap/MiniMap.tsx`                                                                                 |
| `components/MinimapDragOverlay.tsx`  | `components/minimap/MinimapDragOverlay.tsx`                                                                      |
| `components/NodeComposer.tsx`        | `components/composer/ImageComposer.tsx`                                                                          |
| `components/NodeToolbar.tsx`         | `components/canvas/controls/NodeToolbar.tsx`                                                                     |
| `components/Port.tsx`                | `components/canvas/world/Port.tsx`                                                                               |
| `components/PortTooltip.tsx`         | `components/canvas/feedback/PortTooltip.tsx`                                                                     |
| `components/SearchButton.tsx`        | `components/search/SearchButton.tsx`                                                                             |
| `components/SearchPalette.tsx`       | `components/search/SearchPalette.tsx`                                                                            |
| `components/SelectionFrame.tsx`      | `components/canvas/selection/SelectionFrame.tsx`                                                                 |
| `components/SelectionOverlay.tsx`    | `components/canvas/selection/SelectionOverlay.tsx`                                                               |
| `components/SelectionPorts.tsx`      | `components/canvas/selection/SelectionPorts.tsx`                                                                 |
| `components/TextComposer.tsx`        | `components/composer/TextComposer.tsx`                                                                           |
| `components/TitleBar.tsx`            | `components/app/TitleBar.tsx`                                                                                    |
| `components/UploadButton.tsx`        | `components/canvas/editing/UploadButton.tsx`                                                                     |
| `components/ZoomControls.tsx`        | `components/canvas/controls/ZoomControls.tsx`                                                                    |
| `pages/FlowPage.tsx`                 | `pages/flow/FlowPage.tsx` (+ `workspace/*`)                                                                      |
| `flow/asset-urls.ts`                 | `flow/document/assets/asset-urls.ts`                                                                             |
| `flow/bindings.ts`                   | `flow/shared/shortcuts.ts` + `pages/flow/workspace/bindings.ts`                                                  |
| `flow/camera.ts`                     | `flow/canvas/model/camera.ts` + `flow/shared/{geometry,equality,wheel}.ts`                                       |
| `flow/canvas-controller.ts`          | `flow/canvas/interaction/canvas-controller.ts`                                                                   |
| `flow/card-content.ts`               | `flow/canvas/model/cards/card-content.ts`                                                                        |
| `flow/card-geometry.ts`              | `flow/canvas/model/cards/card-geometry.ts`                                                                       |
| `flow/card-layout.ts`                | `flow/canvas/model/cards/card-layout.ts`                                                                         |
| `flow/composer-detail.ts`            | `flow/document/session/composer-detail.ts` (reload policy) + `components/composer/detail-view.ts` (view helpers) |
| `flow/composer-state.ts`             | `flow/composer/composer-state.ts`                                                                                |
| `flow/connection-gesture.ts`         | `flow/canvas/interaction/connection-gesture.ts`                                                                  |
| `flow/connection.ts`                 | `flow/canvas/geometry/connection.ts` + `flow/shared/geometry.ts`                                                 |
| `flow/context-menu.ts`               | `flow/canvas/interaction/context-menu.ts` + `pages/flow/workspace/flow-effects.ts`                               |
| `flow/data.ts`                       | `flow/document/lifecycle/seed.ts`                                                                                |
| `flow/database-path.ts`              | `flow/document/lifecycle/database-path.ts`                                                                       |
| `flow/document-session.ts`           | `flow/document/lifecycle/document-session.ts`                                                                    |
| `flow/edge-clip.ts`                  | `flow/canvas/geometry/edge-clip.ts`                                                                              |
| `flow/edge-gestures.ts`              | `flow/canvas/interaction/edge-gestures.ts`                                                                       |
| `flow/edge-layer.ts`                 | `flow/canvas/model/edge-layer.ts`                                                                                |
| `flow/execution.ts`                  | `flow/execution/runner.ts` + `flow/execution/providers.ts`                                                       |
| `flow/frame-surface.ts`              | `flow/canvas/interaction/frame-surface.ts`                                                                       |
| `flow/grid.ts`                       | `flow/canvas/geometry/grid.ts`                                                                                   |
| `flow/group-ports.ts`                | `flow/canvas/model/scene/group-ports.ts`                                                                         |
| `flow/hover-flags.ts`                | `flow/canvas/interaction/hover-flags.ts`                                                                         |
| `flow/icon-shape.ts`                 | `components/primitives/icon-shape.ts`                                                                            |
| `flow/inline-editor.ts`              | `flow/document/session/inline-editor.ts`                                                                         |
| `flow/keyed-flags.ts`                | `flow/shared/keyed-flags.ts`                                                                                     |
| `flow/minimap-controller.ts`         | `flow/minimap/minimap-controller.ts`                                                                             |
| `flow/minimap-loader.ts`             | `flow/document/assets/minimap-loader.ts`                                                                         |
| `flow/minimap.ts`                    | `flow/minimap/minimap.ts`                                                                                        |
| `flow/node-commands.ts`              | `flow/document/commands/node-commands.ts`                                                                        |
| `flow/node-kinds.ts`                 | `flow/nodes/node-kinds.ts`                                                                                       |
| `flow/node-session.ts`               | `flow/document/session/node-session.ts` (+ sessions)                                                             |
| `flow/overlay.ts`                    | `flow/composer/placement.ts` + `flow/canvas/model/cards/inline-body.ts`; `StageSize` → `flow/shared/geometry.ts` |
| `flow/page-chrome.ts`                | `pages/flow/workspace/page-chrome.ts` + `flow/shared/wheel.ts` (`keepsWheel`)                                    |
| `flow/port-visuals.ts`               | `components/canvas/port-visuals.ts`                                                                              |
| `flow/preview-grid.ts`               | `flow/canvas/geometry/preview-grid.ts`                                                                           |
| `flow/preview-loader.ts`             | `flow/document/assets/preview-loader.ts`                                                                         |
| `flow/previews.ts`                   | `flow/document/assets/previews.ts`                                                                               |
| `flow/record-equality.ts`            | `flow/canvas/model/scene/record-equality.ts`                                                                     |
| `flow/resize-handles.ts`             | `flow/canvas/interaction/resize-handles.ts`                                                                      |
| `flow/right-gesture.ts`              | `flow/canvas/interaction/right-gesture.ts`                                                                       |
| `flow/scene-ports.ts`                | `flow/canvas/model/scene/scene-ports.ts`                                                                         |
| `flow/scene.ts`                      | `flow/canvas/model/scene/scene.ts` (+ helpers)                                                                   |
| `flow/search-filters.ts`             | `components/search/search-filters.ts`                                                                            |
| `flow/search-navigation.ts`          | `pages/flow/workspace/search-navigation.ts`                                                                      |
| `flow/selection.ts`                  | `flow/canvas/geometry/selection.ts`                                                                              |
| `flow/tooltip.ts`                    | `flow/canvas/geometry/tooltip.ts`                                                                                |
| `flow/upload-source.ts`              | `flow/document/commands/upload-source.ts`                                                                        |
| `flow/view-culling.ts`               | `flow/canvas/geometry/view-culling.ts`                                                                           |
| `flow/viewport-controller.ts`        | `flow/document/viewport/viewport-controller.ts`                                                                  |
| `flow/node-session-harness.ts`       | `flow/document/test/node-session-harness.ts`                                                                     |
| `app-test-harness.ts`                | `test-support/app.ts`                                                                                            |

New modules introduced by the plan: `flow/shared/{index,geometry,equality,
async-drain,keyed-flags,wheel,shortcuts,native-types,result-inputs}.ts`,
`flow/canvas/model/{cursor,screen-rect}.ts`,
`flow/canvas/model/scene/{scene-types,scene-hits,scene-selection,
scene-records,scene-overrides}.ts`, `flow/canvas/model/cards/{card-image,
inline-body}.ts`, `flow/canvas/interaction/canvas-input.ts`,
`flow/document/session/{composer-session,inline-session,asset-session}.ts`,
`flow/execution/{runner,providers}.ts`,
`components/canvas/world/{CardTitle,CardBody}.tsx`,
`components/canvas/world/{status-visual,connector-layer}.ts`,
`components/canvas/world/ConnectorCanvas.tsx`,
`components/canvas/selection/selection-visuals.ts`,
`components/canvas/context-menu/menu-items.ts`,
`components/canvas/port-visuals.ts`, `components/composer/{ComposerSheet,
ComposerAttachments,ComposerFooter,ImageComposer}.tsx`,
`components/composer/detail-view.ts`,
`components/primitives/{icon-shape.ts,IconButton,MenuItem,TooltipPill,
panel.ts}`, `components/probes/{ImageLoadProbe,ZoomProbe}.tsx`,
`components/search/search-filters.ts`, `pages/flow/workspace/*`.

## Appendix B — Rust placement map

| Current                             | Target                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `db.rs` production                  | `db/{mod,worker,startup,undo}.rs`                                                                                     |
| `db.rs` tests (line 570+)           | `db/tests/{mod,nodes,edges,inputs,runs,scene,search,assets,history,startup,benchmark}.rs` (fixtures live in `mod.rs`) |
| `mutation.rs` `Mutation`            | `mutation/mod.rs`                                                                                                     |
| `mutation.rs` nodes                 | `mutation/nodes.rs`                                                                                                   |
| `mutation.rs` edges                 | `mutation/edges.rs`                                                                                                   |
| `mutation.rs` inputs                | `mutation/inputs.rs`                                                                                                  |
| `mutation.rs` manual/runs           | `mutation/runs.rs`                                                                                                    |
| `mutation.rs` `apply_ops`           | `mutation/apply.rs`                                                                                                   |
| `mutation.rs` pure helpers          | `mutation/support.rs`                                                                                                 |
| `mutation.rs` tx helpers            | `mutation/tx/{nodes,edges,inputs,indexes,rows}.rs`                                                                    |
| `db.rs` counts/bounds/is_empty      | `reads/metadata.rs`                                                                                                   |
| `db.rs` ensure_document             | `store/document.rs`                                                                                                   |
| `db.rs` empty_change/lock_history   | `db/undo.rs`                                                                                                          |
| `mutation.rs` bump_document_rev     | `store/document.rs`                                                                                                   |
| `document.rs` current_rev           | `store/document.rs`                                                                                                   |
| `viewport.rs`                       | `reads/viewport.rs`                                                                                                   |
| `scene.rs`                          | `reads/scene.rs`                                                                                                      |
| `detail.rs`                         | `reads/detail.rs`                                                                                                     |
| `search.rs`                         | `reads/search.rs`                                                                                                     |
| `schema.rs`                         | `store/schema.rs`                                                                                                     |
| `edge_index.rs`                     | `store/edge_index.rs`                                                                                                 |
| `history.rs` row snapshots          | stay in `history.rs` (referenced by `HistoryOp`)                                                                      |
| `detail.rs`/`viewport.rs` test data | `db/tests/*`; keep reference oracles in place                                                                         |
| `entity/mod.rs` ownership comment   | update to `store/schema.rs`                                                                                           |

## Appendix C — References

- Feature-Sliced Design:
  [overview](https://feature-sliced.design/docs/get-started/overview),
  [slices and segments](https://feature-sliced.design/docs/reference/slices-segments)
- Bulletproof React:
  [architecture principles](https://deepwiki.com/alan2207/bulletproof-react/2-architecture-principles)
- VS Code:
  [source organization](https://github.com/microsoft/vscode/blob/main/.github/instructions/source-code-organization.instructions.md),
  [wiki](https://raw.githubusercontent.com/wiki/microsoft/vscode/Source-Code-Organization.md)
- tldraw:
  [editor package](https://factory.com/open-source-wikis/tldraw?page=packages%2Feditor.md),
  [shapes and tools](https://factory.com/open-source-wikis/tldraw?page=features%2Fshapes-and-tools.md)
- Excalidraw:
  [architecture](https://deepwiki.com/excalidraw/excalidraw/2-architecture)
- NSH:
  [project structure](https://nsh.dev/docs/project-structure),
  [coding guides](https://github.com/longbridge/nsh/blob/main/website/docs/coding-guides.md),
  [`nsh-base` source](https://github.com/longbridge/nsh/tree/main/crates/nsh-base/src)
- Rust:
  [visibility and privacy](https://doc.rust-lang.org/stable/reference/visibility-and-privacy.html)

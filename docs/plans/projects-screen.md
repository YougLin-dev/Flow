# Projects screen

Status: implemented — the project list, create, rename, duplicate, delete,
import, open, back to the list and quit. The catalog refreshes on action, on a
refusal, on return, and on a foreground return or wake, with no filesystem
watcher; a cached readable row is re-read only when its package stamp
changed, while fallback and identity-mismatched rows are re-read on every
list.
Importing a zipped package, backup/restore and renaming an open project are
later slices.

The data model and the store live in
[database-design.md](database-design.md) §8.7. This page records the screen's
product decisions, composition and motion; it is the design reference the code
and tests refer to.

## Task

- **Primary task:** open an existing project.
- **Secondary tasks:** create a new project (an empty canvas), rename one,
  duplicate one, delete one, and import an unzipped package folder from
  outside the managed root.
- **Object:** one self-contained project package (`project.db` + `assets/`).
- **Always available:** the project list, `New project`, `Import project…`,
  and for the open project a way back to the list.
- **Decisions the list must support:** how recently a project was opened or
  updated; whether it is open in another window; whether its files can be read.
- **States:** loading the list; no projects; the store could not load (with
  Retry); the project can't open (unreadable, open elsewhere, unknown error);
  creating, renaming and duplicating (busy, invalid/refused title); deleting
  (busy, refused while open elsewhere; allowed for an unreadable package);
  importing (busy, folder missing or not a package); closing the canvas
  failed.
- **Keyboard, touch and screen reader:** rows are buttons in list order, each
  followed by its actions button; Tab reaches both, Enter/Space opens a row,
  the actions button opens its menu (whose items take the keyboard focus), the
  name and folder dialogs focus their field, Enter submits, Escape dismisses,
  and every icon-only or status element has a text or accessibility name.
  Touch targets keep the row and 32pt-control sizes; the app's desktop target
  is the reference today.
- **Where:** the app's own window. The layout holds from the 420pt test width
  up; it is a centered single column with the action at the header's end.

## Composition

- `pages/projects/ProjectsPage.tsx` — the screen: header, action error, list,
  menus and dialogs. It owns which action is open and which row's menu is
  open (by project id, never in a cell); the home owns the store call.
- `pages/projects/projects-home.ts` — the app-lifetime state: the FFI store,
  the loaded list, loading/error, and the project the shell currently shows.
  The shell creates one home; the canvas's lease and document stay owned by
  the flow workspace. Every list mutation invalidates an in-flight list read,
  so a snapshot from before the action cannot drop or resurrect a row.
- `pages/projects/ProjectDialogShell.tsx` — the shared dialog surface: focus
  trap, Escape/backdrop dismissal, heading, description, error line and an
  actions row. `ProjectNameDialog` (create, rename, duplicate),
  `DeleteProjectDialog` and `ImportProjectDialog` supply their fields and
  buttons.
- `flow/projects/project-list.ts` — the frozen order, status copy, title for
  an unreadable fallback row, and relative time. These are pure and tested
  beside the area.
- `components/app/TitleBar.tsx` — names the open project instead of the
  tagline. `components/search/SearchButton.tsx` no longer positions itself;
  `pages/flow` owns the canvas's top-left control row, where the leading
  `Projects` pill and the search pill share one line.
- Rows are `List` cells: an open `Button` whose accessible name carries the
  title, subtitle and open/unreadable status (an explicit label wins over the
  row's text for a screen reader), followed by an icon-only actions button
  named `Actions for <title>` that opens a semantic `Menu`. The menu offers
  Rename…, Duplicate…, Delete…; the key is `projectId`. No row state lives in
  the cell: the menu's open flag is the page's, keyed by project id, and a
  scroll closes it so a recycled cell cannot reopen it. A fallback row hides
  Rename… and Duplicate… (the store's identity guard would refuse both) but
  keeps Delete…; its subtitle and control name carry the first bytes of the
  package identity, so two damaged packages stay distinguishable before a
  destructive action.
- Rename and duplicate open the name dialog prefilled (rename with the title,
  duplicate with `<title> copy`); delete opens a confirmation that names the
  project and says it cannot be undone. Import opens a folder-path field:
  NSH has no folder picker, and the file picker returns bytes rather than a
  path, while the store imports an unzipped package directory from a path.
- The dialogs are the semantic `Dialog`: they take focus, trap it, and
  dismiss on Escape, the backdrop or Cancel at any time. A write in flight is
  committed by the store, so the page ignores a late success (its row update
  still reaches the list; nothing opens or switches) and reports a late
  failure above the list; while the dialog is open it shows the failure in
  place. An app-level Escape binding also serves the headless runner, which
  does not deliver Escape to the native dialog.
- Closing a project (the Projects control or quitting) saves the open
  editors' drafts before the document closes: the composer's settings write
  is enqueued first and the inline editor's commit is awaited, so the FIFO
  worker lands both ahead of the close job.

## Startup

The app starts on the project list when it has a managed root:

1. an explicit document path (`host.params.databasePath` or `FLOW_DB_PATH`)
   keeps the legacy single-document canvas for that launch;
2. otherwise `host.params.projectsRoot`, `FLOW_PROJECTS_ROOT`, then
   `<dataDir>/projects`;
3. without any of those (a host with no data directory) the legacy canvas
   keeps its in-memory document.

`bun run dev` points `FLOW_PROJECTS_ROOT` at `.nsh/dev/projects`; setting
`FLOW_DB_PATH` keeps the legacy document for that run. Host tests and the
100k smoke name their document path the same way.

## Motion inventory

| Change                                         | Motion                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover / press on rows, pills, dialog buttons   | Background wash (`hover:bg-muted`, `active:bg-accent`) immediately; the app's control family has no transition tokens yet                     |
| A row's actions menu appears / leaves          | The `Menu` popup: the platform's own popup placement and native dismissal; the app adds no transition tokens yet                              |
| Name / delete / import dialog appears / leaves | `Dialog` `animation="fade"`; the platform's reduced-motion setting decides whether it animates                                                |
| Projects → canvas, canvas → projects           | None: a whole workspace swap; the canvas mounts native views and fits the camera, and a cross-fade would animate the work area                |
| A row arrives or leaves after an action        | None: the list is the action's result applied as a snapshot and re-sorted in the frozen order; a renamed row can move, a row leaves on delete |
| Busy action, close failure, action error       | In place, no motion; the control's disabled style and the error text carry the state                                                          |
| Open-elsewhere / unreadable status             | Text and a neutral badge, no motion or color-only signal                                                                                      |

App-wide motion tokens (durations, easings, press scales) and the styled `ui`
layer are still missing from the app; this screen matches its existing
controls. Establishing both is part of the code-organization follow-up, and
this screen should move onto them then.

## Verification

- Headless: `src/App.projects.test.tsx` creates a project through the dialog,
  opens it, closes it back to the list, reopens it (which proves the lease was
  released), renames, duplicates and deletes it through the row's actions
  menu, imports an unzipped package folder by path and keeps a failed import
  in its dialog, closes a row menu by scrolling, dismisses the dialog with
  Escape, and shows a project held by another window as labelled and
  non-opening. `projects-home.test.ts` covers load failure/retry, create
  (which adds its row without opening it, including past a stale in-flight
  list read), the dismissed action's error report, rename, duplicate, delete
  (a read that started before the delete cannot resurrect its row), import
  (an empty or quoted-copied path), open refusals, the open-error mapping,
  and the quiet re-read after a refusal (shallow: fallback rows and lock
  status) or after a failed open or a failed rename/duplicate (deep: every
  package is reopened, so a package damaged after it was cached lists as
  unavailable; delete’s refusal re-read stays shallow). A deep read that a
  later action or list read superseded runs again instead of being dropped.
  `ProjectsPage.test.tsx` mounts the page over a fixed damaged package (a
  test-support entry) and checks that its menu offers only delete and that
  the confirmation names the package by its short identity; a second
  test-support entry proves that a foreground return and a wake each run a
  quiet list read. `projects-home-foreground.test.ts` proves the quiet
  failure keeps the visible list, a return recovers a failed load, and a
  return during an in-flight load is ignored.
  `project-action-run.test.ts`
  pins the dismissal rule: a dismissed run starts no write, applies no
  result, and reports its failure to the list. `project-list.test.ts` covers
  ordering, copy, the fallback row's short identity and relative time.
  `workspace/save-drafts.test.ts` pins the close-time draft save order and
  its wait for the inline write. Rust: the catalog keeps an explicit fallback
  flag (with tests for a readable package titled like its directory and for
  strict version 2 parsing), readable rows carry a database+WAL stamp whose
  mismatch re-reads the package while preserving its open order, a version 1
  catalog rebuilds once, and `entry_view` maps the flag to `unreadable` on
  both sides.
- Visual, on the real Windows host at 960×640 and 420×760 in light and dark:
  the list, the empty state, the row actions menu, the rename, duplicate,
  delete and import dialogs, and the canvas chrome (title bar with the project
  name, the `Projects`/`Search` control row) were inspected from host
  screenshots. At 420 the header wraps its two actions under the title, the
  menu stays inside the window, and the dialog keeps its margins.
- Not verified in this environment: a larger system text size (the host has no
  test control for the font scale), reduced motion with the dialog fade, and
  the fallback row's look on a real host (the visual run had no damaged
  package; `ProjectsPage.test.tsx` covers its behavior and names).

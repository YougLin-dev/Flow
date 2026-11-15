# Projects screen

Status: first slice implemented — the project list, create, open, back to the
list and quit. Rename, duplicate, delete and import from the list are the next
slice; the catalog refreshes on action, on a refusal and on return, with no
watcher.

The data model and the store live in
[database-design.md](database-design.md) §8.7. This page records the screen's
product decisions, composition and motion; it is the design reference the code
and tests refer to.

## Task

- **Primary task:** open an existing project.
- **Secondary task:** create a new project (an empty canvas).
- **Object:** one self-contained project package (`project.db` + `assets/`).
- **Always available:** the project list, `New project`, and for the open
  project a way back to the list.
- **Decisions the list must support:** how recently a project was opened or
  updated; whether it is open in another window; whether its files can be read.
- **States:** loading the list; no projects; the store could not load (with
  Retry); the project can't open (unreadable, open elsewhere, unknown error);
  creating (busy, invalid/refused title); closing the canvas failed.
- **Keyboard, touch and screen reader:** rows are buttons in list order, Tab
  reaches each, Enter/Space opens, the create dialog focuses its name field,
  Enter submits, Escape dismisses, and every icon-only or status element has a
  text or accessibility name. Touch targets keep the row and 32pt-control
  sizes; the app's desktop target is the reference today.
- **Where:** the app's own window. The layout holds from the 420pt test width
  up; it is a centered single column with the action at the header's end.

## Composition

- `pages/projects/ProjectsPage.tsx` — the screen: header, action error, list,
  create dialog. It owns only the dialog's open flag.
- `pages/projects/projects-home.ts` — the app-lifetime state: the FFI store,
  the loaded list, loading/error, and the project the shell currently shows.
  The shell creates one home; the canvas's lease and document stay owned by
  the flow workspace.
- `flow/projects/project-list.ts` — the frozen order, status copy, title for
  an unreadable fallback row, and relative time. These are pure and tested
  beside the area.
- `components/app/TitleBar.tsx` — names the open project instead of the
  tagline. `components/search/SearchButton.tsx` no longer positions itself;
  `pages/flow` owns the canvas's top-left control row, where the leading
  `Projects` pill and the search pill share one line.
- Rows are `List` cells: a `Button` whose accessible name carries the title,
  subtitle and open/unreadable status (an explicit label wins over the row's
  text for a screen reader); the key is `projectId`. No row state lives in
  the cell.
- The create dialog is the semantic `Dialog`: it takes focus, traps it, and
  dismisses on Escape, the backdrop or Cancel at any time. A create in flight
  is committed by the store, so the page ignores a late success (the row
  still joins the list) and reports a late failure above the list; while the
  dialog is open it shows the failure in place. An app-level Escape binding
  also serves the headless runner, which does not deliver Escape to the
  native dialog.
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

| Change                                       | Motion                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Hover / press on rows, pills, dialog buttons | Background wash (`hover:bg-muted`, `active:bg-accent`) immediately; the app's control family has no transition tokens yet      |
| Create dialog appears / leaves               | `Dialog` `animation="fade"`; the platform's reduced-motion setting decides whether it animates                                 |
| Projects → canvas, canvas → projects         | None: a whole workspace swap; the canvas mounts native views and fits the camera, and a cross-fade would animate the work area |
| A project row arrives after create / return  | None: the list is a snapshot rebuilt on return, so the user does not watch rows arrive                                         |
| Busy create, close failure, action error     | In place, no motion; the control's disabled style and the error text carry the state                                           |
| Open-elsewhere / unreadable status           | Text and a neutral badge, no motion or color-only signal                                                                       |

App-wide motion tokens (durations, easings, press scales) and the styled `ui`
layer are still missing from the app; this screen matches its existing
controls. Establishing both is part of the code-organization follow-up, and
this screen should move onto them then.

## Verification

- Headless: `src/App.projects.test.tsx` creates a project through the dialog,
  opens it, closes it back to the list, reopens it (which proves the lease was
  released), dismisses the dialog with Escape, and shows a project held by
  another window as labelled and non-opening. `projects-home.test.ts` covers
  load failure/retry, create (which adds its row without opening it, including
  past a stale in-flight list read), the dismissed create's error report, open
  refusals, the open-error mapping, and the quiet re-read after a refusal or a
  failed open (each package is reopened there, so a package damaged after it
  was cached lists as unavailable); `project-list.test.ts` covers ordering,
  copy and relative time. `workspace/save-drafts.test.ts` pins the close-time
  draft save order and its wait for the inline write. Rust: the catalog keeps
  an explicit fallback flag (with tests for a readable package titled like its
  directory and for both branches of the pre-flag inference), and `entry_view`
  maps it to `unreadable` on both sides.
- Visual, on the real Windows host at 960×640 and 420×760 in light and dark:
  the list, the empty state, the create dialog and the canvas chrome (title bar
  with the project name, the `Projects`/`Search` control row) were inspected
  from host screenshots.
- Not verified in this environment: a larger system text size (the host has no
  test control for the font scale) and reduced motion with the dialog fade.

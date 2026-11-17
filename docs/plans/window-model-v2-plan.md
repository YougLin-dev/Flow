# Plan: NSH 窗口模型 v2 与 Flow 迁移（任务、验收、评审）

Status: detailed implementation plan, delivered locally on 2026-11-18. The
short agent-facing goal is [`window-model-v2-goal.md`](window-model-v2-goal.md);
this document is the authoritative task/acceptance/review reference it points
to; the review gate record is
[`window-model-v2-review.md`](window-model-v2-review.md).

Delivery note (2026-11-17): the plan's push/pin preconditions do not apply to
this delivery — the task forbids pushing NSH or opening an upstream PR. The
window model is committed locally on `feat/window-model-v2` in
`E:\code\mine\nsh-pr`; Flow depends on that checkout by path
(`src/native/Cargo.toml`) and its CLI/types come from the same tree. Turning
that into a commit pin is a release step once NSH is pushed.

## 这是一个完整交付，不是分阶段交接

本计划 包含 **Part A（NSH 窗口模型 v2）** 和 **Part B（Flow 迁移）**，两部分都要完成。
不要在完成 Part A 后停下来问“是否继续 Part B”，也不要把 Part B 留给下一次任务；
只有在遇到无法解决的阻塞时才停止，并给出具体问题、证据和需要用户决定的事项。

可以按阶段提交、按阶段跑测试，但最终交付必须是完整的：

- NSH：app host + N 个一等窗口的完整模型，三个桌面后端和 headless 都覆盖；
- Flow：完整迁移到该模型，Projects / 项目窗口 / Settings / 启动 / 退出 / 多项目窗口
  全部可用；
- NSH pin、CLI shim、Flow 类型重新生成，完整 gate 通过。

如果某个平台无法在本机验证，实现后标注“待平台验证”并继续，不要因为一个平台
停下整个任务。

## Review gates：每个大步骤必须多人交叉复核

每个大步骤结束、进入下一步之前，必须经过独立 review。作者不能 review 自己的
改动；至少两名独立 reviewer（独立子 agent 或人工）使用不同视角，其中一人负责
交叉复核另一人的发现和作者的修复。没有 sign-off 的阶段不得提交为“完成”，也不得
开始下一步。

### 每个 gate 的流程

1. **冻结**：作者停止该阶段的新改动，写出变更摘要、测试命令与结果、已知风险、
   未覆盖项，以及需要 reviewer 重点看的文件/行为。
2. **双人独立 review**：Reviewer A 看正确性/生命周期/状态；Reviewer B 看
   平台/API/测试/兼容。两人各自独立审 diff、测试、文档和必要的运行时行为，
   给出 blocker / major / minor 和 file:line 或测试证据。不得只看作者摘要。
3. **修复**：作者修复 blocker 和 major；minor 要么修复，要么记录接受理由。
   修复过程中不得悄悄扩大范围。
4. **交叉复核**：由另一名 reviewer（A 或 B，或第三名）检查修复是否真正解决
   原问题、是否引入新问题，并交叉验证另一名 reviewer 的结论。不能由作者自己
   宣布通过。
5. **Sign-off**：所有 blocker/major 关闭、相关测试通过、review 记录写入阶段
   报告后，reviewer 才能 sign-off；作者才能提交该阶段并进入下一步。
6. **分歧升级**：reviewer 之间或 reviewer 与作者无法达成一致时，停下来把
   具体问题、证据和可选方案交给 goal owner 决定，不要用“先继续”绕过。

Review 记录至少包含：reviewer 视角、发现清单、severity、修复/接受理由、
交叉复核结论、sign-off。最终报告要汇总每个 gate 的结论和未解决项。

### Gate 表

| Gate            | 覆盖阶段                                | Reviewer 视角（至少两人）             |
| --------------- | --------------------------------------- | ------------------------------------- |
| A-Core          | Phase A2 core app host / window roots   | 生命周期/状态 + window roots/平台契约 |
| A-API           | Phase A3 JS/Rust API / entry / keymap   | API/类型 + 测试/兼容                  |
| A-Menus         | Phase A4 menus / focus                  | 平台菜单/role + keymap/focus          |
| A-macOS         | Phase A5 macOS backend                  | macOS 生命周期 + 跨平台契约           |
| A-Windows       | Phase A6 Windows backend                | Windows 生命周期 + 跨平台契约         |
| A-Linux         | Phase A7 Linux backend                  | Linux 生命周期 + 跨平台契约           |
| A-Headless      | Phase A8 headless / docs / types        | 测试/兼容 + 文档/API                  |
| B-AppRoot       | Phase B2 Flow app root / windows        | Flow 架构 + 生命周期/状态             |
| B-Projects      | Phase B3 Projects / window interactions | UX/平台 + state/lease                 |
| B-ProjectWindow | Phase B4 project window / workspace     | document/lease + 平台 chrome          |
| B-Settings      | Phase B5 settings / startup / session   | 启动/session + 测试                   |
| B-StateQuit     | Phase B6 state / keymap / quit          | quit/生命周期 + keymap/focus          |
| Final           | Part A + Part B integration             | 两名独立 reviewer + 交叉复核          |

## 停止条件与决策请求

不是所有困难都要停。普通的 bug、测试失败、文档缺失、单个平台无法本机验证，
继续解决或标注“待平台验证”即可，不要拿这些当停止理由。

只有以下情况必须停下来，不得猜着继续：

1. **设计冲突**：RFC/plan 与现有架构或平台能力矛盾，且没有不改变产品行为的解法。
2. **产品决策**：需要选择窗口行为、默认值、生命周期、迁移策略、兼容策略等，
   plan 没有给出答案。
3. **平台能力缺失**：NSH 或平台 API 无法实现某个验收项，需要新的框架能力、
   替代方案或降低验收标准。
4. **数据安全/破坏性风险**：lease、保存、退出、迁移可能导致数据丢失、双写、
   项目损坏或不可恢复状态。
5. **Review 死锁**：reviewer 之间或 reviewer 与作者无法达成一致，blocker
   无法关闭，且没有安全的默认方案。
6. **验收冲突**：两个验收项无法同时满足，或实现需要改变 scope/兼容策略。
7. **未授权操作**：需要 push、安装新依赖、访问外部平台、修改用户环境或
   其他本 goal 未授权的动作。

停下来时不要只写“卡住了”。输出一个可决策的请求：

- **阻塞点**：哪一步、哪个验收项、哪个文件/行为；
- **证据**：测试输出、代码位置、平台行为、review 结论；
- **已尝试**：做过什么，为什么不够；
- **选项**：至少 2 个可行方案，标明推荐项；
- **影响**：每个选项对产品行为、平台、兼容性、测试、工作量的影响；
- **需要用户决定什么**：一句话说清要选哪个。

在用户答复前，不继续该阻塞步骤；其他不依赖它的工作可以继续，但不要把
未决问题偷偷用默认值绕过。

## 仓库与基线

- NSH：`E:\code\mine\nsh-pr`，`main` 已同步到 upstream `a12df1d6c`
  （2026-11-17）。设计文档在 `docs/dev/window-model.md`，索引在
  `docs/dev/README.md`；文档当前未提交，Part A 第一笔提交先提交它。
- Flow：`E:\code\mine\oflow` 主工作区（有 projects 功能），当前 `main` 在
  `f2c0206`。**不要用 Delta worktree 里的旧 Flow 代码做迁移。**
- 不要 push 到任何 remote；不要开 upstream PR。各自开本地分支
  （建议 `feat/window-model-v2`），用 conventional commits 分阶段提交。
- **提交信息、PR 描述不得出现 Claude / AI 生成署名。**

## 开工前必读

NSH：

- `AGENTS.md`、`CONTRIBUTING.md`
- `docs/dev/README.md`、`docs/dev/window-model.md`
- `docs/dev/architecture.md`、`docs/dev/js-modules.md`
- `docs/dev/macos.md`、`docs/dev/windows.md`、`docs/dev/linux.md`
- `docs/dev/compatibility.md`、`docs/dev/api-naming.md`、`docs/dev/commands.md`

NSH 源码重点：

- `crates/nsh-core/src/core/mod.rs`（`Core`、`ROOT_ID`、layout/commit）
- `crates/nsh-core/src/desktop/window.rs`、`window_state.rs`
- `crates/nsh-core/src/element/desktop.rs`（`Window` element、`WindowRef`）
- `crates/nsh-js/src/window.rs`、`keymap.rs`、`desktop.rs`
- `crates/nsh-platform-macos/src/{app.rs,window.rs,chrome.rs}`
- `crates/nsh-platform-windows/src/{app.rs,app_window.rs,window.rs,window_close.rs,chrome.rs,keymap.rs}`
- `crates/nsh-platform-linux/src/{app.rs,window.rs,chrome.rs,keymap.rs}`
- `crates/nsh-testing/tests/testing/{windows,hidden-main}`、
  `crates/nsh-testing/src/headless/windows.rs`

Flow：

- `src/App.tsx`、`src/store.ts`
- `src/pages/projects/*`、`src/flow/projects/*`
- `src/pages/flow/FlowPage.tsx`、`src/pages/flow/workspace/*`
- `src/components/app/TitleBar.tsx`
- `docs/architecture.md`、`docs/plans/projects-screen.md`
- `src/nsh.json`、`src/native/Cargo.toml`
- 测试：`src/App.projects.test.tsx`、`src/App.host.test.tsx`、
  `src/ProjectsPage.test.tsx`、`src/store.test.ts`

---

# Part A — NSH 窗口模型 v2

## A0. 目标

在 `E:\code\mine\nsh-pr` 中实现 `docs/dev/window-model.md` 描述的窗口模型 v2：
**app host + N 个一等窗口，没有特权 main window**。

这是一次 NSH 主版本级 breaking change，不是某个应用侧的补丁。不要保留兼容包装，
不要保留“关闭 main 就退出”的特权，也不要在框架里保留隐藏 main 的 workaround。
NSH 的设计文档和应用迁移必须分离：`docs/dev/window-model.md` 只描述 NSH contract，
不得出现某个具体应用的名字或业务规则。

## A1. 已定决策（不要重新讨论）

1. **一个 app JS context + 每个窗口独立的 root view tree / reactive owner。**
   不做 per-window JS VM，不做 Electron 式多进程窗口。
2. **app host 不可见。** 它拥有事件循环、应用生命周期、Storage、应用菜单、
   窗口 registry、quit policy。没有特权 main window。
3. **所有应用显式声明 `<Window>`。** 没有隐式第一窗口，没有兼容包装；
   `mount(App)` 返回普通视图树或没有任何顶层 `<Window>` 时必须报错。
4. **最后窗口关闭策略默认跟随平台。**
   `nsh.json` 的 `"application"` 增加
   `"quitOnLastWindowClosed": "platform" | true | false`；
   `"platform"` 表示 macOS 留下、Windows/Linux 退出。
5. **keymap 默认窗口作用域。**
   `keymap.bind` 在窗口组件内默认只在该窗口生效；应用级快捷键显式
   `{ scope: "app" }`。Rust `on_key` / `on_key_with` 同步。
6. **菜单 role 和焦点按 owning/focused window 解析。**
   macOS 保留全局应用菜单和 Window 菜单；Windows/Linux 提供可选的每窗口
   menu bar。
7. **所有桌面平台和 headless 都覆盖；** iOS/Android/Web 保持单窗口行为。

## A2. 目标模型摘要

```
Application Host (invisible)
├─ event loop, app environment, Storage, capabilities
├─ Application: quit policy, quitRequest/quit, reopen, openFiles,
│                secondInstance, tray, global shortcuts
├─ Application menu (macOS) / default menu (Windows/Linux)
├─ WindowRegistry: id -> AppWindow
│   ├─ Window "main"        normal window: root tree, title bar, key scope
│   ├─ Window "document:a"  normal window: the same
│   └─ Window "settings"    dialog/panel: owned if it has a parent
└─ One app JS context
    ├─ app root: app-level components, signals, effects, menus, scenes
    └─ window roots: one owner + one view tree per window
```

关键点：

- `mount(App)` 渲染 app root；`<Window>` 是顶层 scene，不是普通视图。
- 每个 window root 有独立 layout/commit/mount batch、owner、native window。
- 普通窗口默认无 parent、互相独立；dialog/panel 可显式 parent，随 parent 关闭。
- 关闭窗口只销毁该窗口；最后窗口按 quit policy 退出。
- app root 的 state 在所有窗口关闭后仍存活。
- `currentWindow()` 只在 `<Window>` 内有意义；app root 内抛错，指向
  `focusedWindow()` / `windows()`。
- 窗口 id 稳定；`"main"` 只是约定 id，没有特权。
- `restoreBounds` 每窗口保存 placement；应用自己保存窗口集合和 session。

## A3. 实施阶段

按顺序做；每个阶段先写/改测试，再实现，跑对应测试并提交。阶段可以合并提交，
但不要跳过测试。

### Phase A1 — 设计落地与基线

- 把 `docs/dev/window-model.md` 和 `docs/dev/README.md` 的索引行作为第一笔提交。
- 在 NSH 开分支；确认 `cargo test -p nsh-core`、`cargo test -p nsh-testing`
  基线通过。
- 记录当前 `nsh test` / `--target windows` 的行为，作为对照。

### Phase A2 — Core：app host + window roots

- 把主根变成隐藏的 app host，并把现有 modal roots 提升为窗口根/窗口 registry。
  现有 modal roots 已经是独立 layout root（`Kind::Modal`，有自己的
  reported size / layout / commit），不引入第二套 rendering model。
- 每个 window root 拥有自己的 view tree、layout root、measure/commit 状态；
  owner 由窗口内容创建，窗口关闭时 dispose。
- host 不再是用户窗口：`windows()`、`focusedWindow()`、`Window.get("main")`
  不再把它当作用户窗口；用户窗口的 id 由应用显式声明。
- 普通窗口独立；dialog/panel 保留 parent/owned 语义。
- 关闭窗口销毁其 root；关闭 host 不停止 engine。
- 增加 core unit / headless tests：
  - 零窗口、1 窗口、N 窗口；
  - 关闭任意窗口，包括第一个；
  - 关闭最后一个窗口的 policy；
  - app root 存活；
  - owned dialog 随 parent 关闭；
  - placement/restoreBounds。

### Phase A3 — JS/Rust API：app root、`<Window>`、Application、keymap

- `mount(App)` 渲染 app root；顶层 `<Window>` 是 scene；普通视图在 app root
  报错；没有 `<Window>` 报错。
- `Window.open`、`Window.get`、`windows()`、`focusedWindow()`、
  `currentWindow()` 语义按 RFC；`Window.open` 对已存在 id 聚焦。
- `Application` 保持 imperative module：`setQuitPolicy`、`on("lastWindowClosed")`、
  `on("reopen")`、`on("quitRequest")`、`on("quit")`、`quit()`。
- `keymap.bind` 增加 `scope: "app" | "window"`；默认窗口作用域；核心表给每个
  binding 带 window root。Rust `on_key` 同步。
- 更新 `.nsh/types`、TS 类型、Rust 文档、`website/modules/nsh.md`、
  `docs/dev/architecture.md`、`docs/dev/api-naming.md`。
- 更新 `tests/compat/` 和 headless tests。

### Phase A4 — 菜单与焦点

- macOS：应用菜单属于 app host；Window 菜单由 registry 生成；role 走 key window。
- Windows/Linux：可选的每窗口 menu bar（client-area，原生 popup）；应用级默认
  菜单；role 作用于 owning/focused window；Edit role 作用于该窗口的焦点输入框。
- `Menu.setMenuBar(mode)` 与 per-window items 的命名冲突要解决，按
  `api-naming.md` 记录。

### Phase A5 — macOS backend

- AppDelegate 不再因主窗口关闭停止 engine；每个窗口独立 NSWindow。
- Dock/Finder reopen 调用 `Application.on("reopen")`，不再隐式 show main。
- 全局菜单、Window 菜单、Cmd+W/Cmd+Q、last-window policy。
- 原生测试：独立窗口、关闭第一个、Dock reopen、菜单 role。

### Phase A6 — Windows backend

- message-only host window 承载消息循环；用户窗口全部独立 HWND。
- 关闭用户窗口不再 `PostQuitMessage`；最后窗口按 policy 退出。
- taskbar、client-area menu bar、Alt+F4、WM_QUERYENDSESSION、secondInstance。
- 原生/单元测试覆盖窗口生命周期、菜单 role、last-window policy、键盘 scope。

### Phase A7 — Linux backend

- GtkApplication 持有 app host；N 个独立 GtkWindow；last-window policy。
- `key_window` 作为焦点窗口；每窗口菜单栏；placement best-effort。
- 原生测试/headless 覆盖关闭任意窗口和焦点。

### Phase A8 — Headless model、文档、类型、兼容测试

- headless desktop model 支持零/一/N 窗口，没有 main 特权。
- `app.window(id)` 对任意窗口有效；`pressClose`、state、菜单、keymap。
- 更新 `docs/dev/*`、`website/`、`tests/compat/`、`nsh.json` schema、
  `api-naming.md`。
- 明确 migration notes：没有隐式第一窗口；keymap 默认作用域变化；
  main close 语义变化。

### Phase A9 — Release

- 主版本号、变更记录、迁移指南。
- 更新示例应用（`examples/`）以显式 `<Window>` 形式工作。
- 确认 `nsh package` / `nsh run` / `nsh test --target` 的窗口行为。

## A4. Part A 完成标准

- NSH core/headless tests 全绿；macOS/Windows/Linux 的对应测试按平台可运行；
  不能在本机跑的测试明确标注。
- 以下行为有自动化测试：
  1. macOS/Windows/Linux 两个窗口，关闭任意一个（包括第一个）不影响另一个；
  2. 最后窗口关闭按 `"platform"` 策略；
  3. `keymap.bind` 窗口作用域 vs `scope:"app"`；
  4. 菜单 role 作用于 owning/focused window；
  5. app root state 在窗口关闭后存活；
  6. 没有顶层 `<Window>` 的应用报清晰错误；
  7. 示例 document app：打开/关闭文档、多个窗口、退出、菜单/快捷键。
- 没有兼容包装；没有 main 特权；没有隐藏 main 的 workaround。
- `docs/dev/window-model.md` 与实现一致；发现的偏差要更新 RFC 并报告。
- 按 `docs/dev/commands.md` 跑 format/clippy/test；Windows 上至少跑
  `cargo test -p nsh-platform-windows`。macOS/Linux 不能本机跑的标注清楚。
- 所有 A-* 的 Review gates 已通过：review 记录和 sign-off 完整，
  未解决的 blocker/major 为 0。

## A5. Part A 约束

- 遵循 NSH 的代码风格、模块边界、API 命名和 `AGENTS.md`；不要引入不必要依赖。
- 不要改无关代码；不要顺手重构。
- 不要 push；不要开 upstream PR；不要修改别人的分支。
- 提交信息用 conventional commits；**不要出现 Claude/AI 署名**。
- 每个阶段独立提交；提交前跑该阶段测试。
- 如果发现设计与现有架构冲突，先停下来记录冲突、给出方案，再继续；不要
  偷偷改成另一个模型。
- 如果某个平台无法在本机测试，实现后标注“待平台验证”，不要声称已验证。
- 不要用 `defaultVisible:false` 或其他隐藏 main 的 workaround 绕过 app host。

---

# Part B — Flow 迁移

## B0. 前置条件

- Part A 已完成并合入 `E:\code\mine\nsh-pr` 的 fork main。
- NSH 设计文档：`E:\code\mine\nsh-pr\docs\dev\window-model.md`。
- Flow 当前 `main` 工作区：`E:\code\mine\oflow`（有 projects 功能）。
  **不要用 Delta worktree 里的旧 Flow 代码做迁移。**

Part B 只改 Flow，不改 NSH。如果迁移中发现 NSH API 缺失或行为不对，停下来报告，
不要在本计划 里顺手改 NSH。

## B1. Flow 已定决策（不要重新讨论）

1. **Projects 是普通窗口。** 打开/新建项目后关闭 Projects；关闭最后一个项目
   窗口时重新打开 Projects。
2. **允许多个项目窗口同时打开。** 重复打开同一项目只聚焦已有窗口。
3. **Flow 设置 `Application.setQuitPolicy({ quitOnLastWindowClosed: false })`，**
   自己打开 Projects 并决定何时退出：
   - 没有项目时关闭 Projects：Windows/Linux 调用 `Application.quit()`；
     macOS 留在 Dock，用户可从 Dock 重新打开 Projects。
4. **不做完整菜单栏。** Windows/Linux 用快捷键 + 精简 `⋯` 菜单；
   macOS 使用系统应用菜单和 Window 菜单。
5. **Settings 是独立窗口**，从 `⋯` 菜单或快捷键打开。
6. **项目窗口去掉左上角 Projects 按钮。** 用快捷键 / `⋯` 菜单打开 Projects；
   关闭项目用窗口关闭按钮 / `Cmd/Ctrl+W`。
7. **启动默认 Projects**，设置项可改为直接打开上次项目；
   上次项目不可用时回到 Projects 并提示。
8. **退出**：一个 app-level `quitRequest` 协调器关闭所有项目窗口，
   然后 `Application.quit()`。项目窗口的 `closeOnPress:false` 只用于
   保存草稿/释放 lease，不再用于主窗口生命周期 workaround。
9. **多项目窗口各自独立**：每个项目窗口有自己的 `ProjectStore`/lease、
   document、undo、scene、camera、composer、search。
10. **删除 `src/store.ts` 的模块级 `zoom`/`selected`/`pinned`**；
    迁到窗口/workspace 作用域。`store.ts` 只保留真正的 app 级状态。
11. **keymap 分层**：app root 管全局快捷键；项目窗口管画布快捷键；
    Projects 窗口管列表/对话框快捷键。删除 per-page 的全局绑定。

## B2. 实施阶段

### Phase B1 — Pin、CLI、类型

- 更新 `src/native/Cargo.toml` 的 `nsh-core` pin 到 NSH 新 commit；
  `cargo update -p nsh-core` 更新 lock。
- 重建 NSH release CLI，更新 `C:\Users\Y\.local\bin` 的 shim；
  它必须与 pin 一致（否则会丢新的 capability key）。
- 重新生成 Flow 的 `.nsh/types`。
- 跑一次 `bun run check` / `bun run test` 记录基线。

### Phase B2 — App root 与窗口 registry

- `App.tsx` 变成 app root：
  - ProjectsCatalog、窗口 registry、settings/session、quit coordinator；
  - 顶层 `<Window>`：Projects、每个项目、Settings；
  - `Application.setQuitPolicy({ quitOnLastWindowClosed: false })`；
  - `Application.on("reopen")` 打开/聚焦 Projects。
- 新增 `ProjectsWindow` / `ProjectWindow` / `SettingsWindow`（或等价拆分），
  每个窗口在自己的组件树里创建 workspace/session。
- 删除 main window 的 `hide()` / main `closeOnPress` 生命周期拦截。
- 保留并迁移显式 `FLOW_DB_PATH` / legacy single-document 路径：
  它渲染一个显式窗口，不依赖隐式第一窗口。

### Phase B3 — Projects 页面与窗口交互

- 行点击：已打开 → 聚焦；其他进程持有 → 提示；不可读 → 提示；
  正常 → 关闭 Projects，打开项目窗口。
- 新建：创建后关闭 Projects，打开项目窗口。
- 导入：加入列表，不自动打开。
- 重命名/删除/复制/备份/恢复：对已打开项目禁用或提示
  `Close the project first.`。
- 从画布重命名：更新文档、`currentWindow().set({ title })`、Projects 行。
- 状态文案：`Open` / `Open in another Flow window` / `Unavailable`。

### Phase B4 — 项目窗口与 workspace

- 每个项目窗口拥有自己的 `ProjectStore`/lease、`FlowWorkspace`、
  document、undo、scene、camera、composer、search。
- 窗口关闭：
  - 拦截 `closePress`，等待正在进行的 open；
  - 保存 composer/inline 草稿和 camera；
  - checkpoint、关闭 worker、释放 lease；
  - 关闭窗口；如果是最后一个项目窗口，打开 Projects。
  - 失败：保留窗口和 lease，显示现有错误，允许重试。
- 修掉 post-open lease 泄漏：文档打开后失败要先 `shutdown()` 再报错。
- 窗口标题 = 项目标题；重命名同步 native title。
- 去掉项目窗口的 Projects 按钮；`⋯` 菜单/快捷键打开 Projects。

### Phase B5 — Settings、启动与 session

- `flow.settings.v1` / `flow.session.v1` 的 Storage 读写；
  `decideStartup` 纯函数；generation token 取消 pending auto-open。
- 启动：
  - 默认打开 Projects；
  - 设置为 `lastProject` 且记录 clean 时，直接打开上次项目窗口；
  - 缺失/不可读/被锁/root 不匹配 → Projects + 提示，不循环重试；
  - 崩溃（clean:false）→ Projects + Continue 提示，不自动打开。
- Continue 卡片；设置窗口（Startup radio）。
- 更新 `docs/plans/projects-screen.md` 的启动/交互描述。

### Phase B6 — 状态、keymap 与 quit

- 删除 `src/store.ts` 的 `zoom`/`selected`/`pinned`；
  迁到 workspace/window 组件。
- 应用级快捷键（New、Open Projects、Settings、Quit）在 app root；
  画布快捷键在项目窗口；列表/对话框快捷键在 Projects 窗口。
- 移除 FlowPage 的 per-page 全局 `Application.on("quit")`；
  由 app-level quit coordinator 接管。
- 确保快捷键只在焦点窗口生效，菜单/`⋯` 命令解析 `focusedWindow()`。

### Phase B7 — 测试与平台验证

- Headless（`platform: "windows" | "macos" | "linux"`）：
  - Projects 打开项目后关闭；
  - 项目窗口关闭后 lease 可重新获取；
  - 多项目窗口；
  - 启动默认/上次项目/失败回退；
  - Settings 窗口；
  - 快捷键作用域；
  - quit with N projects。
- Host（`bun run test:host`，Windows）：真实窗口创建/聚焦/关闭/标题；
  多窗口基本流程。
- 手动矩阵：
  - macOS：Dock reopen、系统菜单、Window 菜单、Cmd+W/Q；
  - Windows：任务栏、Alt+F4、关闭最后窗口、注销；
  - Linux：焦点、窗口关闭、last-window policy。
- 跑完整 gate：`bun run check`、`bun run test`、`bun run test:host`。

## B3. Part B 完成标准

- Flow 中没有任何隐式 main / hide workaround；所有窗口显式 `<Window>`。
- Projects 打开项目后关闭；关闭最后一个项目窗口后重新打开 Projects。
- 多项目窗口可同时打开；重复打开聚焦已有窗口。
- 启动默认 Projects；设置可打开上次项目；失败回退正确。
- Settings 独立窗口；项目窗口无 Projects 按钮；Windows/Linux 无完整菜单栏，
  快捷键 + `⋯` 菜单可用。
- 每个项目窗口独立 lease/document/scene/camera；关闭后 lease 可重新获取。
- 退出协调器关闭所有项目窗口并释放 lease；失败路径有提示。
- `bun run check`、`bun run test`、`bun run test:host` 通过。
- 文档/测试 ID/计划文档同步更新。
- 所有 B-* 的 Review gates 已通过：review 记录和 sign-off 完整，
  未解决的 blocker/major 为 0。

## B4. Part B 约束

- 只改 Flow，不改 NSH；缺 API 就报告。
- 用 `E:\code\mine\oflow` 主工作区，不用旧 Delta worktree。
- 不 push；用本地分支和 conventional commits。
- **提交信息不要出现 Claude/AI 署名。**
- Flow 测试遵循：一个行为一个测试、`app.waitUntil`、稳定 testID、
  清理 controller/document session。
- 不要保留 `hide()` / main-close workaround；`closeOnPress:false` 只用于
  保存草稿和释放 lease。
- 发现 NSH API 与 RFC 不一致时，停下来报告并给出最小修正建议，不要在本计划
  里绕过。

---

## 最终报告

用中文报告：

1. Part A / Part B 完成情况；
2. 关键设计决定和与 RFC 的偏差；
3. 改动文件/模块概览；
4. 测试命令与结果（headless/host/平台）；
5. Flow 迁移后的行为、手动验证矩阵；
6. 剩余风险、未验证平台、后续工作；
7. 两个仓库的分支名、commit 列表、pin/CLI 更新情况；
8. 每个 Review gate 的 reviewer 视角、结论、未解决项和 sign-off。

再次强调：这是一个完整任务。不要在中途把 Part B 留到下一次，也不要交付
“只有 NSH 模型、Flow 还没迁”的半成品；只有真正的阻塞才停止并报告。

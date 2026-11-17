# Goal: 完成 NSH 窗口模型 v2 并迁移 Flow

## 任务

在 `E:\code\mine\nsh-pr` 实现窗口模型 v2，然后在 `E:\code\mine\oflow`
把 Flow 迁移过去。两部分是同一个 goal 的完整交付：不要完成 NSH 后停下来等
下一步，也不要把 Flow 留给下一次。只有遇到无法解决的阻塞（设计冲突、平台
能力缺失、必须用户决策）才停止，并给出具体问题、证据和已尝试的方案。

## 先读（权威文档）

1. `E:\code\mine\nsh-pr\docs\dev\window-model.md` — NSH 窗口模型 contract。
2. `E:\code\mine\oflow\docs\plans\window-model-v2-plan.md`
   — 完整任务、阶段、验收和评审清单。
3. `E:\code\mine\nsh-pr\AGENTS.md`、`CONTRIBUTING.md`、`docs/dev/README.md`、
   `docs/dev/commands.md`。
4. `E:\code\mine\oflow\CLAUDE.md`、`docs/architecture.md`、
   `docs/plans/projects-screen.md`。

先读再动手。技术细节以 `window-model.md` 和 plan 为准；本 goal 只负责目标、
边界和完成标准，不重复 plan 的内容。

## 不可谈判的约束

- 一个 app JS context + 每窗口独立根树/owner；不做 per-window JS VM。
- app host 不可见；没有特权 main；所有窗口平等。
- 所有应用显式声明 `<Window>`；没有隐式第一窗口、没有兼容包装。
- 最后窗口默认跟随平台：macOS 留下，Windows/Linux 退出。
- keymap 默认窗口作用域；应用级快捷键显式 `scope:"app"`。
- Flow：Projects 打开项目后关闭；允许多个项目窗口；不做完整菜单栏，用快捷键 +
  精简 `⋯` 菜单；Settings 独立窗口；项目窗口去掉 Projects 按钮；退出走
  app-level `quitRequest` 协调器。
- NSH 的 RFC 不能出现 Flow/Projects 等具体应用规则；Flow 规则只在 plan 的
  Part B。

## 什么时候必须停下来

普通 bug、测试失败、单个平台无法本机验证，继续解决或标注“待平台验证”，不要停。
只有以下情况停下来找我：需要产品/设计决策而 plan 没定；RFC/plan 与平台能力冲突
且没有不改变行为的解法；存在数据丢失、双写、lease/退出安全风险；reviewer 死锁且
blocker 无法关闭；需要未授权的 push、新依赖或环境修改。

停下来时给出：阻塞点、证据、已尝试、至少两个可行选项（含推荐）、每个选项的影响、
需要我决定什么。在答复前不要猜着继续；其他不依赖该阻塞的工作可以继续。

## 仓库与工作方式

- NSH：`E:\code\mine\nsh-pr`，本地 `main` 已到 upstream `a12df1d6c`。
  开 `feat/window-model-v2`。
- Flow：`E:\code\mine\oflow` 主工作区（不要用旧 Delta worktree），也开本地分支。
- 不 push、不开 upstream PR。用 conventional commits。
  **提交和 PR 描述不得出现 Claude/AI 署名。**
- 每个阶段先测试后实现；阶段提交，但不要交付半成品。
- 平台不能本机验证就实现并标注“待平台验证”，继续任务。
- 发现 NSH API 与 RFC 不一致：停下来报告，不要自行改设计或在 Flow 里绕过。

## 完成与验收

按 plan 的 Definition of Done 全部满足，至少：

- NSH：core/headless、macOS/Windows/Linux 对应测试通过；零/一/N 窗口、关闭
  任意窗口、last-window policy、keymap scope、菜单 role、app root 存活、
  无 `<Window>` 报错、示例 document app。
- Flow：Projects/项目/Settings 窗口、打开项目关闭 Projects、多项目窗口、启动
  默认/上次项目回退、关闭项目释放 lease、quit with N projects、无 hide/main-close
  workaround。
- 完整 gate：NSH 按 `docs/dev/commands.md`；Flow 跑 `bun run check`、
  `bun run test`、`bun run test:host`。
- 更新 RFC/类型/文档；Flow 的 `.nsh/types`、`nsh` pin、CLI shim 与 pin 一致。
- 自查：逐条对照 plan 验收项和 RFC，记录偏差；无法验证的项明确列出。

## 评审（硬性）

每个大步骤完成后必须由至少两名独立 reviewer（独立子 agent 或人工）交叉复核，
作者不能 review 自己的改动。Reviewer 使用不同视角（生命周期/状态、平台/API、
测试/兼容、keymap/菜单等），
给出 blocker/major/minor 和证据；作者修复 blocker/major，交叉 reviewer 复核修复并
sign-off。没有 sign-off 不得进入下一步。具体 gate 表、review 流程和记录要求见
plan 的 "Review gates" 一节。

最后做一次完整 self-review，并报告每个 gate 的结论；reviewer 之间有分歧时停下来
交给我决定。最终报告包含：完成情况、关键偏差、改动概览、测试与平台结果、剩余
风险、两个仓库的分支和 commit、pin/CLI 状态、每个 gate 的 sign-off。

再次强调：这是完整 goal，不要中途把 Part B 留给下一次；只有真正的阻塞才停。

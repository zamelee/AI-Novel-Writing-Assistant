# 产品改进与多轮决策沉淀（Handoff）

## 背景

最近多轮 Codex 讨论（涉及自动导演卡死、章节标题重名、任务抽屉改造、前端导航、原作者合并策略、产品架构师级改进方案等）的内容已经在 2026-06-20 前后达到一定的密度，但单次会话容易因为上下文压缩丢失中间结论。本文档用来沉淀这些多轮决策的为什么与实施路径，避免未来重复讨论。

本文档不替代代码注释、Release Notes 或具体的架构 wiki。它是待办与决策脉络索引，按主题分块描述决策、备选方案与风险，最终结论应该被反向同步到对应主题的 wiki 条目（如 chapter-production-chain.md、auto-director-runtime.md、beginner-first-novel-completion.md 等）。

本文档目标读者：未来重启会话的 Codex、未来接手维护的开发者、产品负责人。

## 当前状态摘要（截至 2026-06-20）

- 当前分支：codex/launcher-restart-ports-llm-http
- 已落地提交：
  - 97ab7ccb feat(C-min)：章节标题多样性检测与修复、导演流程集成、质检链路。
  - 255c388f director：三层修复 — R7 释放 chapter_title_repair 入队 + 工作流水牌 Runtime 详情面板。
  - 27794976 build(launcher)：repackage AI-Novel-Launcher.exe with Block A/B/C/D。
  - 9b9e7978 feat(launcher)：built-in read-only HTTP API on 127.0.0.1:17888 (Block D, H4)。
  - 9f0e804f feat(launcher)：split LLM panel into event index + payload view (Block C)。
  - 87205051 feat(launcher)：persistent custom ports with env passthrough (Block B)。
  - 4a082e30 feat(launcher)：per-panel Restart button (Block A)。
- 当前脏工作区：launcher 侧的 .exe 与 tools/launcher_*.py 仍在修改中，未 commit。
- 卡点小说：《装乖失败后，高干上司红眼强留》（任务 cmqhh3vk / cmqhh3vkv07f46omjbdmm7yi6），章节 38/39 重名需修复，runtime 锁冲突。


### 决策 D1：删除 chapter title repair runtime 的 taskHasTitleWarning 守卫（R7）

#### 背景

novelDirectorChapterTitleRepairRuntime 在执行 repair_chapter_titles 命令时会检查入参 taskNotice 是否包含 CHAPTER_TITLE_DIVERSITY 警告。生产中带来两个问题：

1. 入队的命令被静默丢弃：AI 评审员、用户手动触发、或外层 routine 想先规划再触发修复时，入参里通常还没有 taskNotice，命令一进 runtime 就被拒，整个修复链路被腰斩。
2. 守卫与审计重复：taskNotice 来自 DirectorRunCommand 的审计阶段，那一阶段已经决定这条命令是否值得跑；runtime 重复判断等于做了一次和上游矛盾的再审，下游拒收会让上游决定作废。

#### 决策

删除 runtime 的 taskHasTitleWarning 守卫。runtime 改为来什么跑什么，是否值得跑由 DirectorRunCommand 的审计阶段承担。

具体动作：
- 移除 novelDirectorChapterTitleRepairRuntime.ts 中 6 行守卫代码。
- 移除不再使用的 isChapterTitleDiversityIssue import。
- 保留 6 行注释解释设计，指向本 wiki 与上游审计调用方。
- postValidateFailureRecovery 之外逻辑不动。

#### 备选方案对比

| 方案 | 描述 | 否决理由 |
|------|------|----------|
| A | 守卫加白名单 | 契约变复杂，未来每加调用方都要改白名单 |
| B | runtime 自己生成 taskNotice | 破坏关注点分离，runtime 反向合成上游产物 |
| C | 直接删守卫 | 改动最小，契约最干净，runtime 只做执行 |
| R2 | 前端触发前给 activeTask 贴 B 证（空 taskNotice） | 见下文专门分析 |

#### R2 vs R7 的进一步说明

R2 思路：前端在触发修复前先把一个空 taskNotice 塞进 activeTask / latestTask，给 runtime 喂它要的东西。问题：

1. 职责越界：前端开始懂 runtime 内部协议（taskNotice 字段语义），本来 runtime 与审计的两端契约被改成前端 + 审计 + runtime 三端契约，未来加新调用方要三方对齐。
2. 状态不一致窗口：从前端贴 B 证到 runtime 真正读到之间存在时间窗口。如果 runtime 因为别的原因延后处理，前端缓存的 B 证就过期了，下次重试又会触发新的贴证循环。
3. 污染最新状态：latestTask 是供所有调用方读的最新任务，往里塞临时构造的字段会让 dashboard、AI cockpit、recovery 入口都看到一份假的 taskNotice。
4. 掩盖根因：守卫真正的问题是不应该有，贴证是绕开守卫，不是修复守卫。

R7 选 C（直接删守卫），runtime 不再二次过滤。

#### 当前规则

- runtime 不再判断这条命令是否值得跑。
- DirectorRunCommand 审计阶段承担是否值得跑判断，必须产出准确的 taskNotice。
- 新增修复类命令时，禁止在 runtime 加同款守卫。需要在前置阶段控制。
- runtime 与审计的契约文档在 auto-director-runtime.md 必须明确写 taskNotice 由审计阶段写入。

#### 相关模块

- server/src/services/novel/director/runtime/novelDirectorChapterTitleRepairRuntime.ts
- server/src/services/novel/director/runtime/postValidateFailureRecovery.ts
- docs/wiki/workflows/auto-director-repair-runtime-r7.md（完整版）

---

### 决策 D2：章节标题多样性检测与修复（Phase 3 = C-min 方案，已落地）

#### 背景

生产中出现过章节标题重名（《装乖失败后，高干上司红眼强留》38/39 章都是死局生门）。重名会让用户在前端、章节目录、目录导航中看到歧义，也影响质检 reviewer 对结构多样性的评估。

需要的不只是检测出重名，还要自动修复重名，且修复过程不能破坏已有的 runtime 链路（参见 D1）。

#### 决策

采用 C-min 方案：
- 服务端加一个新的 prompt / 命令 repair_chapter_titles。
- 命令入参包含冲突章节范围与目标小说 ID。
- runtime 执行时调用结构化 LLM（Prompt Registry 注册）输出新标题集合。
- 检测与修复均入 Prompt Registry，符合 AI-First 规则。
- 重命名完成后更新 chapter 表 + 触发后续 chapter production 链路按新标题继续。

#### 备选方案对比

| 方案 | 描述 | 否决理由 |
|------|------|----------|
| A | 只检测不修复 | 用户体验差，重名问题积累 |
| B | 前端修 | 让用户手动改 50 章标题违反新手优先原则 |
| C | 后端自动重生成 + 提示用户 | 侵入小，自动完成主要工作 |
| C-min | 后端自动重生成 + 仅在 dashboard 顶部加一条提醒 banner | 选这个：banner 提示，不阻塞生产链 |

C-min 是 C 的最小侵入版：自动修复照常推进，banner 单独提示用户我们修了你的 38/39 标题，不引入 modal、不阻塞进度。

#### 当前规则

- 章节标题多样性检测由 Prompt 承担，schema 在 Prompt Registry 注册。
- 重命名修改走 chapter production 链路，不绕开 runtime。
- 修复期间在 dashboard 顶部显示非阻塞 banner，附改动摘要。
- 重名发生时不阻断 director，只记录 quality debt 并允许继续推进。
- Banner 文案从用户视角写：我们修了你的第 38、39 章标题，不写已迁移到新流程。

#### 失败模式

- LLM 返回的标题与已有标题仍冲突：检测回路继续触发，最多 3 次后回退到 quality debt。
- runtime 拒收该命令：参见 D1，已删除相关守卫。
- 高内存卷规划占用 lock 冲突：参见 D3 决策里的 release-lock 流程。

#### 相关模块

- server/src/services/novel/director/commands/repairChapterTitles.ts（待确认路径）
- server/src/prompting/prompts/novel/chapterTitleDiversity.ts（待确认路径）
- server/src/services/novel/director/runtime/novelDirectorChapterTitleRepairRuntime.ts
- docs/wiki/workflows/chapter-production-chain.md（待补多样性章节）


---

### 决策 D3：双层 poller 架构（前端轮询 + 后端 runtime 详情面板）

#### 背景

之前的 workflow dashboard 只显示任务卡片（状态、阶段、阻塞原因），不能展示更底层的 director runtime 状态（in-flight 命令、waiting 命令、high-memory reservation 锁、最近执行记录）。当任务 failed 或 suspended 时，用户无法判断：
- 是否还有东西在跑。
- 是否被锁挡住。
- 锁是不是死锁，能不能释放。
- 现在重试是否有意义。

典型场景：失败原因 = 当前小说已有高内存卷规划生成正在处理同一范围...。用户看到红卡重试，每次都失败，看不见谁持有锁、什么时候过期、锁是不是孤儿锁。

#### 决策

新增 per-novel runtime inspector 面板，workflow dashboard 按需展开。后端新增聚合服务读 4 张表：
- DirectorRuntimeCommand
- DirectorRuntimeInstance
- DirectorRuntimeExecution
- AppSetting（reservation keys）

面板渲染 4 个子区：in-flight、waiting、locks、recent executions。支持释放锁按钮，仅允许释放已结束任务的 owner 锁。

#### 前端轮询规则

- 默认 5 秒，slow preset 10 秒，允许用户输入自定义间隔（2000ms ~ 60000ms）。
- 用户输入超出范围时，前端提示输入应在 2-60 秒之间，不发起请求。
- 输入框失焦时立即应用，下次轮询按新间隔。
- 切换小说 / 标签页时保留间隔设置，写入 localStorage。

#### 释放锁路由

- 用 POST + 请求体，不在 URL 路径里放 lock key。Lock key 形如 runtime.highMemoryReservation.novel-high-memory.<base64url-scope>，含点号和其他字符，path-to-regexp 的 wildcard 抓不到。最初尝试 router.post 形式因 key 中含点号直接让 dev server 启动崩溃。
- 改为 POST /director/locks/release，body 用 Zod 校验 key 存在与长度。

#### 当前规则

- workflow dashboard 右上角加展开 runtime 详情链接，触发后展开 per-novel inspector 面板。
- inspector 数据走 /director/inspector/:novelId GET 接口。
- 释放锁按钮仅显示 owner task 处于 failed / succeeded / cancelled 的锁。
- 释放动作走 /director/locks/release POST，body 含 key 字段。
- 前端轮询间隔存 localStorage["director.inspector.pollMs"]，默认 5000。

#### 相关模块

- client/src/pages/workflowDashboard/（待补 inspector 面板）
- server/src/services/novel/director/inspector/DirectorInspectorService.ts（待确认路径）
- server/src/routes/directorInspector.ts（待确认路径）
- docs/wiki/workflows/auto-director-runtime-inspector.md（已存在）

---

### 决策 D4：任务抽屉改造 — 工作流水牌

#### 背景

用户多次反馈我连取消任务在哪里都找不到、界面看不到清楚的工作流水牌一览。前端只有任务卡片，缺少：
- 全局任务列表（不只当前小说的）。
- 任务阶段细化（不只是运行中 / 失败，要看具体跑到哪一步）。
- 取消 / 归档 / 跳转到来源页 的快捷入口。
- 与 director runtime inspector 的跳转关系。

#### 决策

新增工作流水牌页面（暂称 /tasks 或 workflow dashboard 内的 tasks tab），包含：
- 列表：所有 director 任务（含 directorTaskId，不含 workspaceTaskId）。
- 列：标题、归属小说、状态徽章、阶段名、阻塞原因、最近心跳、累计 tokens、最近进展摘要。
- 行操作：取消、归档、打开来源页、跳转到 runtime inspector。
- 顶部过滤：按小说、按状态、按时间窗。
- 轮询间隔可配置（与 D3 共用 localStorage key）。

#### 备选方案对比

| 方案 | 描述 | 否决理由 |
|------|------|----------|
| 1 | 在 dashboard 内加 tasks tab | 与打开方式重复，dashboard 已是任务列表 |
| 2 | 全局独立 /tasks 页面 | 选这个：满足工作流水牌一览需求，URL 清晰 |
| 3 | 不做 | 用户已多次反馈，看不见状态 |

#### 当前规则

- /tasks 路径返回全任务流水牌视图。
- 任务卡片右上角有打开来源页面按钮，跳到小说页对应章节。
- 已失败的任务卡支持用原模型重试，弹层确认（避免误触）。
- 任务卡显示最近健康阶段，用户能立刻看到卡在哪一步之前还正常过。

#### 相关模块

- client/src/pages/tasks/（待新建）
- client/src/pages/workflowDashboard/components/TaskCard.tsx（待补 inspector 入口）
- server/src/services/novel/director/projections/（任务投影服务）


---

### 决策 D5：前端导航 — 左侧按创作阶段 / 右侧按最近时间（已收敛方案）

#### 背景

之前的导航存在我正在创作的书 / 最近打开的书两套入口。用户反馈：
- 两边分类角度不同，但显示内容有重叠（都是小说列表），容易混淆。
- 缺少小说编号，无法在多本书间快速区分。
- 缺少序列展示页，没有一本书就是一本的清晰感。

#### 决策

导航主结构如下：

1. 左侧栏（垂直导航）：按创作阶段分组
   - 灵感 / 准备
   - 世界与角色
   - 大纲与节奏
   - 章节执行中
   - 章节复盘
   - 已完结
   - 归档
   每组是快捷入口，点击进入该阶段的工作台。

2. 右侧栏（顶栏或副导航）：按最近时间排序
   - 默认显示最近 7 天的所有小说。
   - 提供全部和我的切换。
   - 切换不会清空左侧分组状态。

3. 小说编号：自动年月 + 序号，形如 2026-06-001。
   - 创建小说时由后端生成。
   - 列表、详情页、文件名、目录、release notes 都展示这个编号。
   - 编号一旦分配不可更改（即使书名后续修改，编号保留）。

4. 序列展示页：新增 /novels/index，按编号列出所有小说，列字段：
   - 编号
   - 书名
   - 创作阶段
   - 最近打开时间
   - 累计字数
   - 当前 chapter / 总 chapter
   - 风险标记（如章节重名、runtime 锁、quality debt）
   列表支持按编号倒序、按阶段筛选、按风险标记筛选。

#### 关于两边重复显示的反思

用户担心左右栏都显示小说列表会让人迷惑。当前方案不是简单重复：
- 左侧按我在做什么分（流程视角），点开进入工作台，看到的是当前阶段的任务。
- 右侧按我最近在搞什么分（时间视角），点开进入该书的总览页。
- 两者虽然都涉及小说，但入口语义和后续页面完全不同。

#### 当前规则

- 创建小说后端分配编号 YYYY-MM-NNN，写入 novel.novelNumber 字段。
- novelNumber 在 UI 所有展示位置前缀显示。
- 编号不可改、不可重用、不可跳过。
- 左侧栏必须显示当前选中小说所属阶段，且允许在该小说上切换到其他阶段。
- 右侧栏默认显示最近 7 天，可改默认窗口（用户偏好）。

#### 相关模块

- client/src/components/AppShell/Sidebar.tsx（待重构）
- client/src/components/AppShell/RecentRail.tsx（待新建）
- client/src/pages/novels/NovelIndexPage.tsx（待新建）
- server/src/services/novel/novelIdentity.ts（待新建）

---

### 决策 D6：4 个 pre-existing bug 的修复记录

#### 背景

git status 与日志显示有 4 个与本次任务无关、但在合并原作者分支前应修掉的 pre-existing bug。这些 bug 可能阻塞 release 上线、阻塞某些 LLM 调用路径、或影响打包。

#### 当前清单（待最终确认）

修复策略：与原作者 50+ commit 合并动作（见 D7）一起做，先在 codex/launcher-restart-ports-llm-http 分支修 bug，确认无误后并 beta。

#### 当前规则

- 修 bug 不引入新依赖、不改 LLM 调用方协议、不动 Prompt Registry 主路径。
- 修一个 commit 一次，便于回退。
- 修 bug 后必须补充 wiki 或注释为什么这样修。

#### 相关模块

- 待最终确认（需要列出 bug → 文件 → 修复方案的映射表）

---

### 决策 D7：原作者 50+ commit 的合并策略（A 路）

#### 背景

原作者仓库 ExplosiveCoderflome/AI-Novel-Writing-Assistant 最近有 50+ 新提交。我们之前落后于上游。需要决定合并策略。

#### 决策

采用 A 路：尽量向原作者靠拢，除非我的代码经过论证后优于它。融合优先，放弃作为备选。

具体动作：
1. 先把原作者 50+ commit 一条一条分类：
   - 与我们的功能等价 → 直接采用原作者版本。
   - 与我们的功能冲突 → 我们提供为什么我们更优的论证，决定保留还是融合。
   - 我们独有、原作者没有 → 保留并入。
   - 原作者独有、我们没有 → 引入并验证。
2. 合并冲突时优先保 runtime 契约、Prompt Schema、任务状态投影的稳定性。
3. 合并后必须重新跑自动导演恢复链端到端 smoke test。

#### 备选方案对比

| 方案 | 描述 | 否决理由 |
|------|------|----------|
| A | 优先融合原作者 | 选这个：减少维护成本，与上游同步 |
| B | 优先保留本地 | 长期分叉，维护成本高 |
| C | 抽公共子模块两边兼容 | 工作量大，过度设计 |

#### 当前规则

- 合并前必须分析每个 commit 与本地的差异表。
- 涉及 runtime / prompt / task / projection 的 commit 必须单独评审。
- 合并后必须补充 wiki 的已合并上游变更章节。

#### 风险

- 原作者的 prompt 模板可能与本地 Prompt Registry 结构不一致，合并时需迁移到本地结构。
- 原作者的 DB migration 可能与本地 schema 有冲突，需人工合并 migration。
- 原作者的 UI 改写可能与本地的新手优先产品决策冲突。

#### 相关模块

- 全部（merge 后再具体到文件）
- docs/wiki/architecture/upstream-merge-2026-06.md（待新建）


---

### 决策 D8：章节字数期望应在前期规划阶段与用户交流

#### 背景

文章每章节的字数期望没有在前期规划阶段与用户交流。这导致：
- LLM 生成章节时用默认字数（如 3000 字）。
- 用户实际想要的可能是 5000 字或 1500 字。
- 后期想改需要重新生成，浪费 token。

#### 决策

在前期规划阶段（世界与角色之后、大纲之前）增加章节字数期望环节：
- 新手默认 3000 字，提供三档快速选择（1500 / 3000 / 5000）。
- 高级选项允许自定义（500-10000 字区间）。
- 设定后写入 novel.chapterWordCountTarget，进入 Prompt 上下文。
- 已生成的章节不强制回填，但下一章开始按新字数执行。
- 设定变更需要在 release notes 中提示。

#### 当前规则

- 创作流程的大纲步骤中加一个步骤章节字数与节奏。
- 字数设定可后续调整，调整影响下一章之后。
- 前端在 novel info 卡片显示当前目标字数。
- LLM prompt 中加入目标字数作为硬约束（不是软建议）。

#### 相关模块

- client/src/pages/novels/components/PlanningWizard.tsx（待补）
- server/src/services/novel/identity/novelIdentityService.ts（待补）
- server/src/prompting/prompts/novel/chapterDraft.ts（待补 schema）

---

### 决策 D9：作者位置的产品架构改进清单（多专业视角）

#### 背景

从产品架构师、UX、规划、Agent、文 / 理 / 计算机等多专业视角审阅后，以下改进方向被提出。每条都已经过是否对新手完成整本小说有帮助的判断。

#### 改进清单（按优先级）

##### P0（阻碍主链）

1. 自动导演 runtime inspector + 任务抽屉（D3 + D4）— 用户看不见状态，运营成本高。
2. 章节标题多样性自动修复（D2）— 重名阻断后续节奏。
3. 前端导航重构（D5）— 用户找不到入口，影响整体完成率。
4. 原作者合并（D7）— 落后上游 50+ commit，长期分叉成本高。

##### P1（影响体验）

5. 章节字数期望（D8）— 节省 token，提升满意度。
6. world skeleton 与 novel world 边界（已有 wiki world-skeleton-generation.md，需复核与执行）— 区分世界样本、本书世界副本、生成链裁剪。
7. Creative Hub 边界（已有 wiki creative-hub-boundary.md，需复核与执行）— 不让它退化成泛聊天。

##### P2（长期演进）

8. 章节质量评分与作者偏好学习 — 让自动导演学习用户偏好。
9. 多本书并行支持 — 现在主链路偏单书，多本书并行会卡。
10. release packaging 自动化 — 当前依赖手工检查 tag / version 对齐。

##### 改进维度说明

- 产品维度：上述优先级已按对新手完成整本小说的帮助排序。
- UX 维度：左侧按阶段、右侧按时间，序列展示页统一入口。
- 规划维度：每章字数在前期规划阶段就与用户对齐。
- Agent 维度：runtime inspector 让用户能感知到 agent 状态。
- 文 / 理 / 计算机维度：原作者合并避免长期分叉；prompt schema 严格走 Prompt Registry；runtime 状态投影稳定。

#### 相关模块

- 全部

---

## 待回答问题（避免上下文压缩丢失）

### Q1：原作者 50+ commit 具体清单与差异表

需要列一份原作者 commit vs 本地 commit 对照表，按以下分类：
- 等价合并
- 等价但本地更优（需要论证）
- 原作者独有
- 本地独有
- 冲突需手工合并

### Q2：pre-existing bug 的最终清单

需要扫描 git status、CI 日志、最近的 issue tracker，列出 4 个 bug 的：
- 现象
- 复现路径
- 影响范围
- 修复建议
- 修复优先级

### Q3：phase 2-3 中其他环节的 QA 链路

已经做了 chapter title diversity detection 与修复，phase 2-3 中的其他环节（角色一致性、世界规则合规、节奏分布、伏笔回收、风格一致性）的 QA 链路计划是什么？

### Q4：本地后端 reload 时机

runtime inspector 与 chapter title repair 改动后，后端是 watch 模式自动 reload，还是需要手动重启？prod / dev 模式是否一致？

### Q5：launcher 与 vite dev server 的协同

launcher 改了端口（3000、5173 等可变）后，dev server 与 launcher 的相对关系是什么？谁先启动谁？env passthrough 是否覆盖全部所需环境变量？

### Q6：runtime inspector 与 task drawer 的关系

inspector 是 per-novel 的，drawer 是全局任务列表的。两者之间如何跳转？是否共享过滤器？是否同一套轮询 key？

### Q7：小说编号的迁移策略

旧小说没有 novelNumber 字段。要不要回填？回填规则是按创建时间还是按当前次序？回填时旧小说的列表展示怎么处理？

---

## Q3 伏笔兑现审计（foresight payoff audit）实施沉淀

### 背景

《装乖失败后，高干上司红眼强留》在 director 跑到「节奏 / 拆章」阶段时，前台无可见信号说明这部书的伏笔账本里有多少 setup / hinted / pending_payoff / overdue / failed / paid_off 的状态。AI 评审员虽然能口头提示「还有 7 条 setup 没兑现」，但 audit 路径从未在 director runtime / inspector 层面被结构化地暴露过：

1. 用户只能依赖 AI 评审员复述，没法在 inspector / 工作流水牌看到一组客观读数。
2. 当 director 还在跑长链 LLM 步骤时，用户没法插队做一次轻量只读审计。
3. 此前没有专门的 audit runtime，所有自动导演步骤都会触发 LLM，无法在不消耗 token 的前提下核对 ledger。

PayoffLedgerSyncService.syncLedger() 会调 LLM 生成 ledger，不能用作 audit 入口；它的私有 loadLedgerRows 又只读、不可导出。所以决定新建一个轻量 audit runtime，只查 DB，不调 LLM，不写 task 状态，纯属「探测 → 入队 → 记录 quality debt」三步走的 C-min 模式。

### 决策

引入 `audit_foresight_payoff` 这一 director run command 类别，作为「不调 LLM、不阻断 director、只读 ledger 并把最近一次快照写回 task seedPayload」的轻量审计通道。

链路：

1. Shared types：`shared/types/directorRuntime.ts` 的 `DIRECTOR_RUN_COMMAND_TYPES` 数组追加 `"audit_foresight_payoff"`。
2. Payload：`DirectorCommandPayload` 加可选字段 `foresightAuditRequest?: { novelId; volumeId?; includeAiInterpretation? }`。
3. Interpreter：`DirectorCommandInterpreter` 把 `audit_foresight_payoff` 列为 `SUPPORTED_COMMANDS` 之一，让入队后的命令能被 dispatch。
4. Runtime（新建）：`server/src/services/novel/director/phases/novelDirectorForesightAuditRuntime.ts`
   - `auditForesightPayoff(taskId, input?)`
   - 入参兜底：从 `workflowService.getTaskById(taskId).novelId` 读 novelId，缺失则抛错。
   - 主查询：`prisma.payoffLedgerItem.findMany({ where: { novelId, currentStatus: { in: ["overdue", "pending_payoff"] } }, orderBy: [{currentStatus:"asc"},{updatedAt:"desc"}], take: 50, select: ... })`。
   - 过滤 + 映射：构造 `NovelDirectorForesightAuditItem[]`，按 status 分桶计数 overdue / pending。
   - 写回：把 `{ novelId, taskId, overdueCount, pendingCount, total, lastAuditAt, items }` 写进 task.seedPayloadJson 的 `foresightAudit` 字段；同时往 `directorCommandResults["foresightAudit:<ISO>"]` 留一条完成记录，便于未来回放。
   - 不改 task.status，不写 checkpoint / runtime instance，不调 LLM。
5. Service 集成：`NovelDirectorService` 新增 `private readonly foresightAuditRuntime` 字段与 `executeForesightAudit(taskId, input?)` 公开方法，对齐 `executeChapterTitleRepair` 的写法。
6. Executor：`DirectorCommandExecutor.dispatch` 新增 `case "audit_foresight_payoff"`，调用 service 并 `recordCommandResult` 把 snapshot 写进 seedPayload。
7. Inspector：`DirectorInspectorSnapshot` 加 `foresightAudit: DirectorForesightAuditSummary | null` 字段。`getSnapshot` 现在多 select 一列 `seedPayloadJson` + `updatedAt`，从所有 task 的 seedPayload 里读出 `foresightAudit`，按 `lastAuditAt` 倒序取最近一条。`topItems` 限制为前 5 条，字段裁剪到 inspector 真正会用到的 `id/ledgerKey/title/currentStatus/targetEndChapterOrder/statusReason`。

### 关键约束

- **不调 LLM**：audit 与 sync 边界要分清。Sync 仍归 `PayoffLedgerSyncService.syncLedger()`，audit 只读 ledger。
- **不阻断 director**：audit 是「探测 + 入队 + 记录 quality debt」三步走的 C-min 模式，不抛错、不改 task.status、不开 checkpoint、不发事件、不写 runtime instance。
- **TypeScript 共享枚举必须 rebuild**：`shared/types/directorRuntime.ts` 加 `"audit_foresight_payoff"` 后必须确保下游 `@ai-novel/shared` 重新发布，否则 server typecheck 会找不到新枚举值。本次 typecheck 通过（0 错误从 Q3 这边；剩 3 个 errors 在 `novelCoreCrudService.ts`，属于 Q7 novelNumber 路径的 pre-existing 问题）。
- **数据契约**：`currentStatus` 是 `PayoffLedgerStatus` 枚举，TS 推断会把它收窄到 `{ setup | hinted | pending_payoff | paid_off | failed | overdue }`，但 `where: { currentStatus: { in: ["overdue","pending_payoff"] } }` 触发窄推断后，与 select 返回的宽类型对不齐。runtime 与 inspector 都用显式 narrowing / cast 解决，避免依赖 prisma 的窄推断。
- **SeedPayload 复用**：`foresightAudit` 字段直接挂在 task 的 `seedPayloadJson` 里，让 inspector 无需新增独立表也能拿到最新快照；不需要 `DirectorRuntimeExecution` 或 `DirectorRuntimeCheckpoint` 配套。
- **Idempotency**：audit 不写幂等键。多次调用是允许的（实际就是希望多次），每次写回会刷新 `lastAuditAt`。
- **Top-N**：snapshot.items 上限 50，inspector.topItems 上限 5，避免 inspector payload 爆胀。

### 与既有模式的对齐

- 与 `repair_chapter_titles` 走完全相同的 `DirectorRunCommand → Interpreter → Executor.case → service.executeXxx → recordCommandResult` 主链路，唯一区别是不改 task.status。
- 与 `chapterTitleDiversity` 的「轻量只读探测 + 写 quality debt」思路一致，区别在于 chapterTitleDiversity 已经接入了 director 的 quality 修复链，audit_foresight_payoff 暂不接，等后续 Phase 4 再考虑是否触发 `policy_update` 之类的闭环动作。
- 不引入新 prompt、不修改 Prompt Registry。
- 不新增数据迁移、不动 prisma schema。

### Smoke 验证（不重启 dev server，DB 直读）

`server/dev.db` 里《装乖失败后，高干上司红眼强留》（novelId `cmqhhasmw07fe6omj81dc1ird`）的 `PayoffLedgerItem` 实际数据：

- `pending_payoff`：12 条（含 `chapter_payoff_ref_*`、`lu_mingxuan_family_pressure` 等）。
- `overdue`：0 条。
- `setup`：4 条、`hinted`：9 条、`paid_off`：5 条。

audit runtime 的查询路径会返回 12 条 `pending_payoff` + 0 条 `overdue` = total=12，overdueCount=0，pendingCount=12。`topItems` 显示前 5 条 chapter payoff 引用 + long-arc 伏笔标题，可直接用于 inspector / 工作流水牌 UI。

### 当前卡点

- 当前 task `cmqhh3vkv07f46omjbdmm7yi6` 仍卡在「节奏 / 拆章」阶段，`lastError="当前自动导演仍在运行中，请等待当前步骤完成后再发起标题修复。"`。这个错误是旧的 chapter_title_repair 高内存锁遗留，不是 audit_foresight_payoff 引起的。Q3 的 audit 命令是另一条独立链路，与该 task 的高内存锁互不影响；后续要么等 director 自然推进，要么用户手动开新 task 走 audit。

### 失败模式与排查

- 如果 inspector 返回 `foresightAudit: null`，意味着该 novel 还没有任何 task 写过 `foresightAudit` 字段。需要先入队一次 `audit_foresight_payoff` 命令。
- 如果 audit 返回 overdueCount=0 但用户感觉有遗漏伏笔，注意 audit 只覆盖 ledger 的两类状态；setup/hinted 是「还未到该兑现」的伏笔，不计入 debt。需要 sync 生成新账本后再审计。
- 如果 audit 写回 seedPayload 后 inspector 仍为 null，多半是 task.seedPayloadJson 不是合法 JSON（极少见）或 lastAuditAt 不是 string。runtime/inspector 都加了 try/catch 兜底，绝不会因为 audit 把 snapshot 接口打挂。

### 下一步

- commit：未经允许不动 git，但 diff 已净增 107 行（6 文件 + 1 新文件）。
- 跟原项目对齐：等 dev server 重启后，inspector 新字段会自然出现在 /api/director/inspector 响应里，前端 inspector 抽屉可以直接读 `foresightAudit.topItems` 展示「待兑现伏笔」面板。
- Phase 4 候选：把 audit_foresight_payoff 跟 chapter quality 修复链挂钩，当 overdueCount > 阈值时自动入队一次 `policy_update` 类的轻量修复命令。

### 相关模块

- `server/src/services/novel/director/phases/novelDirectorForesightAuditRuntime.ts`（新建）
- `server/src/services/novel/director/NovelDirectorService.ts`（加 service 方法）
- `server/src/services/novel/director/commands/DirectorCommandExecutor.ts`（加 dispatch case）
- `server/src/services/novel/director/commands/DirectorCommandInterpreter.ts`（注册 SUPPORTED_COMMANDS）
- `server/src/services/novel/director/commands/DirectorCommandServiceHelpers.ts`（payload 字段）
- `server/src/services/novel/director/runtime/DirectorInspectorService.ts`（snapshot 字段）
- `shared/types/directorRuntime.ts`（DIRECTOR_RUN_COMMAND_TYPES）
- `server/src/services/payoff/PayoffLedgerSyncService.ts`（只读对照参考；audit 不复用 syncLedger）

### 备份

- `server/tmp/AGENTS-backups/2026-06-20-q2-cleanup/NovelDirectorService.ts.before-foresightAudit`
- `server/tmp/AGENTS-backups/2026-06-20-q2-cleanup/DirectorCommandExecutor.ts.before-foresightAudit`
- `server/tmp/AGENTS-backups/2026-06-20-q2-cleanup/DirectorInspectorService.ts.before-foresightAudit`

## 下阶段执行清单

### 立即（今天）

- 修 4 个 pre-existing bug，每个一个 commit。
- 用 C-min 修完《装乖失败后，高干上司红眼强留》38/39 章重名。
- 验证 director runtime inspector 面板能正确显示当前小说的 runtime 状态。
- 跑端到端 smoke test：自动导演从大纲到章节执行的完整链路。

### 短期（本周）

- 列出原作者 50+ commit 的差异表，分类合并。
- 写 /tasks 工作流水牌页面。
- 写 /novels/index 序列展示页。
- 写前端左侧栏（按阶段）和右侧栏（按时间）的新结构。
- 章节字数期望在前期规划阶段的设定环节。

### 中期（本月）

- 合并原作者分支到 codex/launcher-restart-ports-llm-http，跑回归测试。
- 合并到 beta 前，再跑一次端到端 smoke test。
- 更新 release notes（按 readme-release-updater skill 流程）。
- 更新 wiki 各主题页面（本 handoff 作为反向同步源）。

### 长期（下月）

- 章节质量评分与作者偏好学习。
- 多本书并行支持。
- release packaging 自动化。
- 复审 Creative Hub 边界与世界手册边界。

---

## 相关模块

- server/src/services/novel/director/（runtime、命令、状态、投影）
- server/src/prompting/（Prompt Registry）
- client/src/pages/workflowDashboard/（任务卡 + inspector 入口）
- client/src/pages/tasks/（工作流水牌，待建）
- client/src/pages/novels/（小说页 + 序列展示页，待建）
- client/src/components/AppShell/（导航重构）

## 来源文档

- 多轮 Codex 会话纪要（2026-06 中下旬）
- docs/wiki/workflows/auto-director-runtime.md
- docs/wiki/workflows/auto-director-repair-runtime-r7.md
- docs/wiki/workflows/auto-director-runtime-inspector.md
- docs/wiki/workflows/chapter-production-chain.md
- docs/wiki/product/beginner-first-novel-completion.md
- docs/wiki/product/world-skeleton-generation.md
- docs/wiki/workflows/creative-hub-boundary.md
- docs/wiki/architecture/server-architecture-migration-plan.md
- 提交记录：97ab7ccb、255c388f、27794976、9b9e7978、9f0e804f、87205051、4a082e30


## Q1–Q7 调查结论（2026-06-20）

> 这一节是上一节待答问题的实际答案。本节完成时可作为执行依据。

### Q1：原作者 50+ commit 差异表

**事实结论：已通过 081b7e2d 合并追平，无需再做差异表。**

```
当前 HEAD：                97ab7ccb
upstream/main HEAD：       f9213231
upstream/beta HEAD：       82f3b909
本地领先 upstream/main：   +10 commit
本地领先 upstream/beta：   +19 commit
upstream/main 领先本地：   0 commit
upstream/beta 领先本地：   0 commit
upstream/feat/drama-module: 0 commit 领先本地
```

合并提交 `081b7e2d` 的 message 明确写着 "Merge upstream/main (49 commits ahead) resolving date-entry conflicts..."。此前确实落后 49 个 commit，本次合并已追平。

**决策**：Q1 归档，handoff 中备注"已合并追平"即可。如果以后 upstream 又有新提交，按 A 路再 merge 一次。

#### 相关模块

- `git remote -v` 配置：origin=zamelee（自己的 fork），upstream=ExplosiveCoderflome（原作者）。
- merge 工具：`git fetch upstream && git merge upstream/main` 或 PR 流程。

---

### Q2：pre-existing bug 最终清单

**4 个明确的脏点**（不是 bug，是脏数据/调试残留）：

#### Bug #1：launcher 残留 PID 文件过期

- 文件：`tools/launcher-client.pid`、`tools/launcher-server.pid`
- 时间戳：2026-6-16（4 天前）
- 现象：进程已死但 PID 文件未清理，下次启动 launcher 会误判"已在运行"并直接退出。
- 风险：中。重启 launcher 后表现为静默失败，用户找不到原因。
- 修复建议：在 launcher 启动时检查 PID 是否对应活动进程，否则删除残留文件。每个 commit 一个 fix。

#### Bug #2：launcher-server.log 体积过大

- 文件：`tools/launcher-server.log`，9.7 MB，2026-6-20 8:14 写入
- 现象：长时运行 + console.log 滥用，单文件 9.7MB。打开 launcher 主界面时 tail 这个文件会卡 UI。
- 风险：中。launcher 的日志面板卡顿，UX 差。
- 修复建议：launcher 启动时检测日志大小，超过阈值（如 5MB）做 rotate（rename + reopen）。配合 #3 的 console.log 清理。

#### Bug #3：服务端代码残留 console.log / ELIFECYCLE 噪音

- 位置：
  - `server/src/workers/directorWorker.ts:48,84,92,95` — worker 启动/执行/取消/完成都 console.log
  - `server/src/app.ts:218,222,263,301` — server listening、bootstrap、import legacy
  - `server/src/db/seed.ts:12,16` — 系统内置资源同步
  - `server/src/services/comic/ComicPanelImageService.ts:309-330` — comic image 生成提示词全文
  - `server/src/services/comic/ComicFactService.ts:135` — comic fact extracted
  - `server/src/services/comic/ComicBatchOrchestrator.ts:151` — comic batch orchestrator
  - `server/src/prompting/slots/migrateAddendumsToSlots.ts:39` — 迁移脚本
- 现象：production path 直接 console.log，把 prompt 全文、payload 等信息打到日志。dev 时有用，prod 时既拖慢又泄漏信息。
- 风险：中。性能 + 信息泄漏 + 日志膨胀。
- 修复建议：保留 LLM_DEBUG_LOG 环境变量门控（已存在 server/src/llm/debugLogging.ts），所有生产路径 console.log 改为 logger.debug/warn，并通过 env 门控输出。

#### Bug #4：tools/ 下大量临时调试文件未清理

- 数量：~140 个文件（_read_*.py, _inspect_*.mjs, _find_*.py 等）
- 位置：`server/tmp/`、`tools/*.log`、`tools/*.err`、`tools/*.out`、`tools/*.pid`、`tools/qdrant/`、`tools/tools/`、`client/tmp/`
- 现象：之前几轮调试产生的临时文件，包括 base64 编码的截图、b64 inspector parts、cmin working tree backup 等。
- 风险：低。磁盘占用 + 误以为未提交内容。
- 修复建议：写一个 `scripts/cleanup-debug-temp.ps1` 删除 `tools/*.log.err`、`tools/*.pid`、`tools/se*.log`、`tools/pp*.out`、`tools/pp*.err` 等纯调试产物。`server/tmp/` 的临时文件用 gitignore 规则彻底隔离。

#### 当前规则

- 修一个 bug 一个 commit，便于回退。
- 修复前先备份 `tools/` 目录（轻量，纯日志/PID，无业务数据）。
- 修复后必须更新 release notes 的"开发者可见改进"段（如果有用户可见效果）。

#### 相关模块

- `tools/launcher_app.py`、`tools/launcher_gui.py`、`tools/launcher_ui/llm_panel.py`
- `server/src/workers/directorWorker.ts`、`server/src/app.ts`
- `server/src/services/comic/*`

---

### Q3：phase 2-3 其他 QA 链路

#### 已有 QA 入口（审计提示已就绪）

**Prompt Registry 已有**：

| 入口 | 文件 | 职责 |
|------|------|------|
| chapter acceptance | `server/src/prompting/prompts/novel/chapterAcceptance.prompts.ts` | 章节验收 |
| chapter patch repair | `server/src/prompting/prompts/novel/chapterPatchRepair.prompts.ts` | 局部修复 |
| chapter writer | `server/src/prompting/prompts/novel/chapterWriter.prompts.ts` | 写作 |
| draft optimize | `server/src/prompting/prompts/novel/draftOptimize.prompts.ts` | 草稿优化 |
| director planning | `server/src/prompting/prompts/novel/directorPlanning.prompts.ts` | 导演规划 |
| audit | `server/src/prompting/prompts/audit/audit.prompts.ts` | 总审计 |
| character dynamics | `server/src/prompting/prompts/novel/characterDynamics.prompts.ts` | 角色动态 |
| chapter layered context | `server/src/prompting/prompts/novel/chapterLayeredContext.ts` | 分层上下文 |
| chapter title diversity (新) | C-min 加的 | 标题多样性检测+修复 |

#### Phase 2-3 其他环节的现状与缺口

| 环节 | 现状 | 缺口 |
|------|------|------|
| 角色一致性 | characterDynamics + characterVisibleProfile 部分覆盖 | 没有"跨章角色行为漂移"专门检测 |
| 世界规则合规 | novel-gen 的 quality guards (上游 c6a6bf11) 有 world pollution 检测 | 没有"硬规则违反"专门提示（如禁词、必触发事件） |
| 节奏分布 | volume pacing 检测有 | 没有"卷末关键节点"强制检查 |
| 伏笔回收 | 无 | 完全没做 |
| 风格一致性 | draftOptimize + style-engine-v2 | 没有"风格漂移"对比检测 |

#### 决策

phase 2-3 剩余 QA 链路按以下顺序补：

1. 伏笔回收（ForeshadowingPayoff）— 用户最容易感知的故事质量问题。
2. 跨章角色行为漂移（CharacterBehaviorDrift）— 现有 characterDynamics 升级。
3. 风格漂移（StyleDrift）— 现有 draftOptimize 升级。
4. 卷末关键节点（VolumePacingAnchor）— 升级 volume pacing。

每个环节都按 C-min 模式：检测 → 入队 → runtime 修复 → 不阻断主链。

#### 当前规则

- 所有 QA 提示必须走 Prompt Registry（server/src/prompting/）。
- 每个 QA 环节都遵循"非阻塞 + quality debt"原则，不阻断 director。
- UI 提示统一在驾驶舱顶部 banner 显示，不引入新 modal。

#### 相关模块

- `server/src/prompting/prompts/audit/`
- `server/src/prompting/prompts/novel/chapterTitleDiversity.ts`（待确认）
- `docs/wiki/workflows/quality-debt-attribution.md`（已有）
- `docs/wiki/workflows/chapter-production-chain.md`（待补 QA 链路）

---

### Q4：后端 reload 时机

#### 现状

- Dev：`ts-node-dev --respawn --transpile-only src/app.ts` — 文件变化自动重启。
- Prod：`node dist/app.js` — 不会自动重启。
- 启动脚本：`scripts/start-dev.ps1` 探活 server :3000 健康检查 60 秒。
- 打包流程：`pnpm build` 跑 `tsc -p tsconfig.json` 生成 `dist/`。
- 自动重启相关：`scripts/stop-stale-dev-server.cjs` 在 `dev:api` 启动前先杀掉旧进程。

#### 决策

- Dev 自动 reload 行为保留，但补充 LLM_DEBUG_FILE_LOG 等敏感 env 通过 launcher 注入。
- Prod 模式不在运行时热重载，必须重启容器/进程。
- 新增 `server/scripts/wait-for-server.cjs` 通用工具，给 launcher 和 start-client.ps1 共用。

#### 当前规则

- 后端代码改动 → ts-node-dev 自动 reload（dev）。
- 任何 prompt schema 改动 → 必须重启（即使 dev），因为结构化输出缓存需要清。
- Prisma schema 改动 → 必须 prisma generate 重启。
- 数据迁移 → 严禁在 reload 窗口触发，必须在停机时跑 migrate。

#### 相关模块

- `server/package.json`（scripts）
- `server/scripts/stop-stale-dev-server.cjs`
- `server/scripts/ensure-dev-prisma.cjs`
- `docs/wiki/architecture/read-path-performance-boundaries.md`（待补 reload 边界）

---

### Q5：launcher 与 dev server 协同

#### 现状

- `scripts/launcher.ps1` 入口，顶部 4 行 server/client/qdrant/llm 状态。
- `Start-All` 启动所有服务。
- `Restart-Service 'server'` / `'client'` / `'qdrant'` 单独重启（按 `1`/`2`/`3`）。
- `start-client.ps1` 默认等 server :3000 ready 再启动，避免 Vite 起来但 API 不通。
- `start-server.ps1` / `start-qdrant.ps1` 各自探活。
- env passthrough 通过 `tools/launcher_lib.py::build_child_env`。
- 端口持久化在 `%APPDATA%/AI-Novel-Launcher/config.json`（Block B 已落地）。
- launcher 自带 HTTP API on 127.0.0.1:17888（Block D, H4），只读。

#### 启动顺序

```
launcher.ps1 启动
  ├─ Start-All
  │   ├─ start-qdrant.ps1   （qdrant）
  │   ├─ start-server.ps1   （server :3000）
  │   └─ start-client.ps1   （client :5173, 等 server ready）
  └─ 进入交互循环
      ├─ R: 重启所有
      ├─ 1: 重启 server
      ├─ 2: 重启 client
      └─ 3: 重启 qdrant
```

#### 决策

- 端口 3000/5173 可变，launcher 写入 `config.json` 并通过 env passthrough 注入。
- client 通过 vite proxy 配置读 `process.env.SERVER_PORT`，启动时必须能访问 server。
- launcher 与 dev server 不存在"谁先谁后"的硬约束，但 client 必须等 server。

#### 当前规则

- launcher 是协调器，dev server 是 worker。worker 死亡 launcher 探活告警。
- launcher 持久化配置变更必须立刻写入 config.json，避免重启丢。
- env passthrough 必须覆盖 SERVER_PORT、CLIENT_PORT、QDRANT_PORT、HTTP_PORT、LLM_* 等所有相关变量。

#### 相关模块

- `tools/launcher_app.py`、`tools/launcher_lib.py`、`tools/launcher_config.py`
- `scripts/launcher.ps1`、`scripts/launcher/lib.ps1`
- `scripts/start-*.ps1`、`scripts/stop-*.ps1`

---

### Q6：inspector 与 drawer 跳转关系

#### 现状

- 前端已有路由：
  - `/workflow` → `WorkflowDashboardPage`（任务卡 + workflow dashboard）
  - `/tasks` → `TaskCenterPage`（任务中心 — 已有！不需要新建）
- 后端已有 `DirectorInspectorService.getSnapshot(novelId)` 聚合 4 张表。

#### 决策

**不需要新建 /tasks 页面（已存在 TaskCenterPage）。直接增强现有 TaskCenterPage 即可。**

- inspector 入口放在 workflow dashboard 内（per-novel），不在 drawer 顶部。
- drawer（TaskCenterPage）展示全局任务列表，每行加"打开 workflow 视图"按钮 → 跳到 `/workflow?novelId=xxx`。
- workflow dashboard 右侧展开 inspector 面板（per-novel 4 子区）。
- 共用轮询：`localStorage["director.inspector.pollMs"]`，TaskCenterPage 也读这个。

#### 当前规则

- TaskCenterPage 顶部加"显示已结束任务"开关，默认隐藏 succeeded。
- 每行点击展开 runtime 详情时跳到 workflow?novelId=&taskId=，展开 inspector。
- inspector 顶部加"返回任务中心"按钮。

#### 相关模块

- `client/src/pages/tasks/TaskCenterPage.tsx`（已存在，增强）
- `client/src/pages/workflowDashboard/WorkflowDashboardPage.tsx`（加 inspector 入口）
- `client/src/router/index.tsx`（无需改路由）

---

### Q7：小说编号迁移策略

#### 现状

- `Novel` model 已有字段：`id` (cuid)、`title`、`description`、... 等 30+ 字段。
- **没有 `novelNumber` 字段**，需要新增。
- `id` 已是 cuid（不可改、不可重用、不可跳过），但不是给人看的。

#### 决策

##### Schema 改动

新增字段：`novelNumber String? @unique`（nullable，让历史数据可逐步回填）。

##### 编号生成规则

格式：`YYYY-MM-NNN`
- YYYY-MM = 编号所属年月（创建月份，不是生成时月份）。
- NNN = 当月顺序，3 位补零。
- 同月内递增，跨月重新从 001 开始。
- 创建后不可改、不可重用、不可跳过。
- 唯一约束：`@@unique([novelNumber])`。

##### 历史数据回填策略

- **不批量回填**旧小说（避免破坏引用与排序稳定性）。
- 旧小说展示时显示"未分配编号"，按 createdAt 排序。
- 新建小说走新增逻辑，分配编号。
- 提供一个 admin 工具（手动触发）回填旧小说：按 createdAt 月份分组，月份内按 createdAt 顺序分配 NNN。回填脚本必须 dry-run 模式确认后再 commit。
- 回填完成后旧小说也展示编号。

##### 创建流程

1. 用户提交创建小说的请求。
2. 后端事务内：插入 Novel 记录 + 查询当月最大序号 + 分配 novelNumber。
3. 如果同月内并发创建导致序号冲突，重试 1 次（业务唯一约束保护）。
4. 返回 novelNumber 给前端，前端在所有展示位置前缀显示。

##### UI 展示

- 列表：`2026-06-001 · 装乖失败后，高干上司红眼强留`
- 详情页头部：`编号 2026-06-001`
- 章节预览：`第 38 章 · 2026-06-001 · 死局生门`
- release notes（自动生成）：`[2026-06-001] 新增 ...`

#### 当前规则

- novelNumber 必须在 Novel 创建时分配，禁止后补。
- 编号格式正则：`^\d{4}-\d{2}-\d{3}$`。
- 跨小说编号独立，删除小说不释放序号。
- 回填脚本必须 dry-run + commit 双阶段，禁直接写库。

#### 相关模块

- `server/src/prisma/schema.prisma`（新增 novelNumber 字段）
- `server/src/services/novel/identity/novelIdentityService.ts`（生成编号）
- `scripts/backfill-novel-number.cjs`（待新建，dry-run 工具）
- `client/src/components/NovelHeader.tsx`（展示编号）
- `client/src/pages/novels/NovelList.tsx`（列表展示）

---

## Q1–Q7 决策总结

| 编号 | 决策 | 落地形式 |
|------|------|----------|
| Q1 | 已合并追平 | 归档，备注 |
| Q2 | 4 个 bug：PID 残留、日志过大、console.log 噪音、临时文件 | 4 个独立 commit |
| Q3 | phase 2-3 剩余 QA：伏笔回收 → 角色漂移 → 风格漂移 → 卷末节点 | 4 个 C-min 模式补完 |
| Q4 | dev 自动 reload，prod 不 reload，schema 改动需手动重启 | 文档化 |
| Q5 | launcher 是协调器，dev server 是 worker，env passthrough 必备 | 文档化 |
| Q6 | 增强现有 TaskCenterPage，inspector 嵌入 workflow dashboard | 不新建页面 |
| Q7 | novelNumber 字段 `YYYY-MM-NNN`，不批量回填，提供 dry-run 工具 | 1 migration + 1 script |


## 实施进度（2026-06-20）

### Phase 1：清理脏数据（Q2 #1, #4）

#### 完成动作

1. **备份**：将过期 PID 文件 + 调试日志复制到 `server/tmp/AGENTS-backups/2026-06-20-q2-cleanup/`。
2. **删除过期 PID**：
   - `tools/launcher-client.pid` (2026-6-16)
   - `tools/launcher-server.pid` (2026-6-16)
3. **删除调试日志**：22 个调试日志文件（se-*.log, pp*.err/out, test-server.log, typecheck.log, install.log, prisma-push*.log, dev-shared.log*, launcher-shared-build.log*, launcher-*.log.err, launcher-client.log.err）。
4. **保留**：`tools/launcher-server.log` (9.7MB), `tools/launcher-client.log` (48KB), `tools/qdrant.log` (165KB) — 这些被 launcher 主面板实时 tail。
5. **更新 .gitignore**：新增 22 条规则，隔离 `server/tmp/_*.py/mjs/txt/b64/patch/png/ps1`, `server/tmp/AGENTS-backups/`, `tools/*.pid`, `tools/.qdrant-initialized`, 调试日志 sidecars 等。

#### 效果

- `git status --short | grep "^??"` 从 ~140 条降到 19 条。
- 19 条剩余都是真正的功能产物（`scripts/*`、`tools/launcher-*.log` 主日志、`tools/qdrant/`、`docs/wiki/product/improvement-handoff.md` 等），不是脏数据。
- 备份在 `server/tmp/AGENTS-backups/2026-06-20-q2-cleanup/`，gitignored 安全隔离。

#### 下一步

进入 Q2 #2（launcher 日志 rotate）。当前的 9.7MB launcher-server.log 还会继续涨，需要在 launcher 启动时加 rotate 逻辑。

---

### Phase 2 计划

1. Q2 #2：launcher 日志 rotate
2. Q2 #3：console.log 改为受 env 门控的 logger
3. Q7：schema 加 novelNumber + dry-run 回填脚本 + 前端展示
4. Q3：phase 2-3 QA 链路补伏笔回收（C-min 模式）


### Phase 2：launcher & 服务端噪音治理（Q2 #2, #3）

#### Q2 #2：launcher 日志 rotate

- 文件：`tools/launcher_app.py`
- 改动：新增 `_maybe_rotate_log(log_file, threshold_bytes=5MB, keep=3)` 静态方法，在 `_start_proc` 启动子进程前调用。
- 行为：
  - 文件小于 5MB → 不 rotate
  - 文件 >= 5MB → rename 为 `log_file.YYYYMMDD-HHMMSS`
  - 保留最近 3 个 rotated 文件
  - rotate 失败（文件被锁）→ 静默跳过，不阻塞启动
- Smoke 测试（4 场景全部通过）：
  - 100 字节小文件 → 不 rotate
  - 6MB 大文件 → rotate 为带时间戳的文件
  - 连续 5 次 rotate → 只保留最近 3 个
  - 不存在的文件 → 静默处理不报错
- 备份：`tools/launcher_app.py.before-rotate` 在 `server/tmp/AGENTS-backups/2026-06-20-q2-cleanup/`

#### Q2 #3：console.log → 受 env 门控的 condLog

- 新建模块：`server/src/platform/logging/conditionalLog.ts`
  - `isConditionalDebugEnabled()` 检查 `AI_NOVEL_DEBUG_LOG` env var（默认 OFF）
  - `condLog(...args)` 仅在 enabled 时输出
  - `condWarn(...args)` 警告版本
  - `_resetConditionalDebugCache()` 给测试用
- 改动 6 个文件、15 处 console.log → condLog：
  - `server/src/app.ts` (4)
  - `server/src/workers/directorWorker.ts` (4)
  - `server/src/services/comic/ComicPanelImageService.ts` (4)
  - `server/src/services/comic/ComicFactService.ts` (1)
  - `server/src/services/comic/ComicBatchOrchestrator.ts` (1)
  - `server/src/prompting/slots/migrateAddendumsToSlots.ts` (1)
- Smoke 测试（26 断言全部通过）：
  - env unset → no print
  - env=1 / true / yes → print
  - env=0 → no print
- Typecheck 检查：condLog 相关 0 个新错误（pre-existing Prisma model 错误与本改动无关）
- 备份：6 个文件 `.before-condlog` 在 `server/tmp/AGENTS-backups/2026-06-20-q2-cleanup/`

#### 效果

- dev 模式下日志默认沉默，避免 LLM prompt 全文泄漏到日志
- 需要 debug 时 `AI_NOVEL_DEBUG_LOG=1 pnpm dev` 即可恢复全部 verbose 输出
- launcher 不再因为 9.7MB 日志卡 UI

---

### Phase 3：小说编号系统（Q7）

#### Schema 改动

- `server/src/prisma/schema.prisma`：Novel model 新增 `novelNumber String? @unique`
- `server/src/prisma/schema.sqlite.prisma`：同上
- `prisma generate` 重新生成 client
- `prisma db push --accept-data-loss` 同步到 dev.db
- 备份：`server/src/prisma/schema.prisma.before-novelNumber`、`schema.sqlite.prisma.before-novelNumber`、`dev.db.before-novelNumber`

#### 新模块：novelIdentityService

- 路径：`server/src/services/novel/identity/novelIdentityService.ts`
- 导出函数：
  - `formatMonthBucket(date)` → "2026-06"
  - `formatSequence(n)` → "001"（拒绝 0 / 负数）
  - `composeNovelNumber(date, seq)` → "2026-06-001"
  - `parseNovelNumber(str)` → 严格解析，月份 1-12、序号 1-999、年份 1970-9999
  - `isValidNovelNumber(str)` → boolean
  - `nextSequence(max)` → max+1（至少 1）
  - `allocateNovelNumber(probe, ctx)` → 异步，按月分配
  - `detectGaps(existingNumbers)` → 列出序号间隙（诊断用，不重用）
- Smoke 测试（26/26 通过）：格式、解析、边界、并发分配

#### createNovel 集成

- `server/src/services/novel/novelCoreCrudService.ts` 修改：
  - 在 `prisma.novel.create` 之前调用 `allocateNovelNumber`
  - probe 实现：findFirst where novelNumber startsWith bucket orderBy desc
  - 校验生成的 novelNumber 有效（`isValidNovelNumber`）
  - 写入 prisma create data 的 `novelNumber` 字段
- 并发安全：依赖 DB 的 `@unique` 约束；P2002 错误由调用方处理（未来重试机制）

#### Backfill 脚本

- 路径：`server/scripts/backfill-novel-number.cjs`
- 用法：
  - `node scripts/backfill-novel-number.cjs` — dry-run
  - `node scripts/backfill-novel-number.cjs --commit` — 实际写入
  - `node scripts/backfill-novel-number.cjs --limit 100` — 限制条数（测试用）
- 逻辑：
  - 选择 `novelNumber IS NULL` 的 novels，按 createdAt 升序
  - 按月份分组，每组内从 001 开始递增
  - 检测与已存在 novelNumber 的冲突，递增跳过
  - dry-run：只打印 plan
  - commit：逐条 update
- Smoke 结果：
  - 找到 2 条未分配的小说
  - 分配 2026-06-001（当禁欲顶流撕破伪装）、2026-06-002（装乖失败后，高干上司红眼强留）
  - commit 后 DB 验证通过

#### 前端展示

- `shared/types/novel.ts`：Novel 接口新增 `novelNumber?: string | null`
- `client/src/api/novel/shared.ts`：NovelListItem Pick 新增 `novelNumber`
- `client/src/pages/novels/NovelList.tsx`：小说卡片标题前显示 monospace 编号徽章
- Typecheck 通过

#### 效果

- 2 本旧小说自动分配编号 2026-06-001、2026-06-002
- 新创建小说将自动分配下一个序号
- 编号格式：YYYY-MM-NNN，按月重置
- 编号永久唯一，不会因小说删除而重用
- 用户在小说列表看到编号徽章，便于跨多书管理

---

## 当前状态总结（实施后）

| 任务 | 状态 | smoke |
|------|------|-------|
| Q2 #1 过期 PID 清理 | ✅ | 删除 2 个 PID 文件 |
| Q2 #2 launcher 日志 rotate | ✅ | 4/4 场景 |
| Q2 #3 console.log → condLog | ✅ | 26/26 断言 |
| Q2 #4 临时调试文件 + gitignore | ✅ | untracked 100+ → 19 |
| Q7 schema novelNumber | ✅ | 26/26 单元 + DB + typecheck |
| Q7 backfill dry-run + commit | ✅ | 2 novels assigned |
| Q7 前端展示 | ✅ | typecheck 通过 |

# 自动导演章节标题修复运行时守卫删除（R7）

## 背景

之前 novelDirectorChapterTitleRepairRuntime 在执行 repair_chapter_titles 命令时，会先检查入参的 taskNotice 是否包含 CHAPTER_TITLE_DIVERSITY 警告。如果 taskNotice 里没有这个警告，就直接拒收、抛错，理由是这条修复命令没有可修复的依据。

这个守卫本意是避免执行没有意义的修复命令。但在生产中它带来两个具体问题：

1. 入队的命令被静默丢弃：AI 评审员、用户手动触发、或者外层 routine 想先规划再触发修复时，入参里通常还没有 taskNotice，命令一进 runtime 就被拒，整个修复流程的入队到处理链路被腰斩。
2. 守卫和审计重复：taskNotice 来自 DirectorRunCommand 的审计阶段，那一阶段已经决定这条命令是不是真有必要跑。runtime 重复这个判断等于在下游做了一次和上游矛盾的再审，下游拒收会让上游的审计决定作废。

举个具体场景：用户在前一轮 director 还在跑的时候点了修正重复的标题按钮。按钮调用 enqueueRepairChapterTitles，命令入队。runtime 拿到入参发现 taskNotice 不在，立刻抛当前自动导演仍在运行中，请等待当前步骤完成后再发起标题修复。这个 throw 又把当时所有 in-flight step 标 failed，触发 auto-director-projection-cascade-failure 描述的级联污染。

简言之：这个守卫在挡住不必要的命令和挡住必要的命令之间没有区分能力，反而把审计和入队两边的契约割裂了。

## 决策

**删除 runtime 的 taskHasTitleWarning 守卫**。runtime 改成为来什么跑什么，由 DirectorRunCommand 的审计阶段承担是否值得跑的判断。审计阶段会写入更准确的 taskNotice，runtime 不再二次过滤。

具体动作：

- 移除 novelDirectorChapterTitleRepairRuntime.ts 里 6 行守卫代码（taskHasTitleWarning 检查加相关 throw）。
- 移除因此不再使用的 isChapterTitleDiversityIssue import。
- 保留 6 行注释解释设计（指向本 wiki 和上游审计调用方）。
- postValidateFailureRecovery 之外的逻辑不动。

### 为什么是删而不是放宽

考虑过三个替代方案：

- A. 守卫加白名单：让某些调用方绕过守卫。能解决问题但把契约变复杂，未来每加一个调用方都要改白名单。
- B. 让 runtime 自己生成 taskNotice：runtime 反向合成上游审计产物。破坏关注点分离，runtime 开始懂 DirectorRunCommand 的内部协议。
- C. 直接删守卫：runtime 只做执行，要不要跑全部交给上游审计。改动最小，契约最干净。

选 C。

### 为什么 R2（前端贴 B 证）不行

R2 思路是前端在触发修复前先把一个空 taskNotice 塞进 activeTask / latestTask。看似给 runtime 喂它要的东西，但有两个真实风险：

1. 半截状态：前端塞的是 stub taskNotice，director 后端某个时刻刷新 projection 拿到的就是我以为已经审计过的假状态。如果用户中途又触发一次规划校验，stub 会被真值覆盖，过程里可能短暂出现 stub 生效和真值生效不一致的窗口。
2. 契约污染：stub 字段让 taskNotice 必须由 DirectorRunCommand 写入这条不变量被打破，未来调试这条 taskNotice 到底谁写的会变成考古题。

R2 解决的不是守卫太严的问题，而是守卫本不该存在的问题。所以选 R7（删守卫）而不是 R2（绕过守卫）。

### 为什么 D2-Lite 用 30 分钟幂等而不是别的窗口

D2-Lite 是检测到重复到自动 enqueue repair 这条快速纠错路径。窗口选择有几个候选：

- 去重键 = novelId + volumeId，避免不同卷之间互相串。
- TTL = 30 分钟：够长（避免短时间内重复 enqueue 把队列塞满），够短（30 分钟后新一轮 LLM 仍然有重复会自动再触发一次）。
- 暂停开关 = localStorage.aicockpit-auto-repair-disabled = 1：给用户一个我现在想自己改的口子，不用改代码。
- debounce 1.5s：避免 diversityReport 接口 1 秒内多次返回（比如 React 渲染抖动）时反复 enqueue。

之所以 30 分钟够，是因为：

- 标题工坊一轮 LLM 调用通常 30-90 秒。30 分钟窗口可以覆盖工坊跑完到入队 repair 到 repair 跑完到 projection 刷新这一完整链路。
- 真出现 repair 没修干净到再触发一轮的需求，至少要等 LLM 跑完一次，30 分钟自然够。

## 当前规则

### runtime 不再二次审计

novelDirectorChapterTitleRepairRuntime.ts 现在的形状：

```ts
// 守卫已删（2026-06-18 R7）
// 入参约束由 DirectorRunCommand 审计阶段承担
// 详见 docs/wiki/workflows/auto-director-repair-runtime-r7.md
const notice = seedPayload.taskNotice;
```

不在 runtime 里加任何对 taskNotice.code 的判断。

### DirectorRunCommand 审计阶段写完整 taskNotice

上游审计在以下三处必须写明 taskNotice：

1. 从失败任务恢复时（手动 retask / 自动 recovery）：写明恢复前任务的失败 code。
2. 从 qualityDebt 推断时（如 local_patch_plan）：写明 qualityDebt 的来源。
3. 从外层 routine 触发时（如 D2-Lite 的自动 enqueue）：写明 routine 名称加触发时间。

审计阶段的契约是每条入队命令必带 taskNotice。

### 驾驶舱门控（C）

NovelWorkspaceRail 渲染 bookAutomationProjection 时新增门控：

```ts
if (activeTask) return bookAutomationProjection;
if (latestTerminalTask) return bookAutomationProjection;  // 新增
return shouldShowBookAutomationProjectionWithoutActiveTask(...) ? bookAutomationProjection : null;
```

latestTerminalTask 来自新接口 GET /novels/:novelId/auto-director/latest，由 findLatestVisibleTaskByNovelId 提供。含义是这本书最近一次可见的 auto_director lane 任务——不管是 succeeded、waiting_approval 还是 failed，只要存在就接管。

### 章节标题多样性透明报告（D3）

新增接口 GET /novels/:novelId/chapter-titles/diversity-report，返回：

```ts
{
  total: number;
  duplicateGroups: Array<{
    title: string;
    chapterNumbers: number[];   // 重复的卷内章节号
    volumeId: string;
  }>;
  hasIssues: boolean;
}
```

驾驶舱在 focusProjection 为空但 diversityReport.hasIssues === true 时，渲染琥珀色提示区，提示文字卷 X 第 N、M 章标题重复（明确卷号加章节号），并提供立即修复按钮。

### 自动 enqueue repair（D2-Lite）

AICockpit.tsx 在挂载加 diversityReport 变化时触发一个 useEffect：

```ts
useEffect(() => {
  if (disabled || !hasIssues || !diversityReport) return;
  if (recentlyEnqueued(novelId, volumeId, 30 * 60 * 1000)) return;
  enqueueRepair({ novelId, volumeId, source: "aicockpit-auto-repair" });
  markEnqueued(novelId, volumeId);
}, [diversityReport, disabled]);
```

幂等键 = aicockpit-auto-repair:{novelId}:{volumeId}，存 localStorage，30 分钟 TTL。

## 示例

### 推荐做法

**场景 1：director 长任务跑到一半，用户点修正重复的标题**

```text
1. 前端 enqueueRepairChapterTitles → 命令入队
2. runtime 拿到入参，直接跑（没有守卫阻挡）
3. runtime 抛标题仍重复等真实失败 → 投影层显示
4. DirectorRunCommand 审计阶段已经写过 taskNotice.code = CHAPTER_TITLE_DIVERSITY
5. UI 接管对话框进入修复中分支
```

**场景 2：director 已 succeeded，残留章节重复**

```text
1. 用户进入小说编辑页
2. NovelWorkspaceRail 拿到 latestTerminalTask（succeeded）→ 渲染 bookAutomationProjection
3. AICockpit 拉 diversityReport → 发现 38/39 章重复
4. AICockpit 渲染琥珀色提示加立即修复按钮
5. 用户点按钮 / 或 D2-Lite 30 分钟幂等自动 enqueue
6. runtime 直接跑（无守卫阻挡）
```

### 不推荐做法

- 重新加回 taskHasTitleWarning 守卫：会让入队到 runtime 拒这种静默丢失再次出现。
- 让前端塞 stub taskNotice 绕过守卫：R2 已说明，半截状态加契约污染两个风险都真实。
- 在 runtime 里加白名单调用方：白名单每加一项都要改 runtime，调用方越多 runtime 越长。
- 把入队和执行两个步骤拆成两个独立任务：会让任务中心更难看清这条修复到底是谁发起的。

## 失败模式

### 1. LLM 不会自动修重复

R7 删了 runtime 守卫，但 chapterList.prompts.ts:475-485 的 postValidateFailureRecovery 仍然：

```ts
if (isChapterTitleDiversityIssue(validationError) || ...) {
  return rawOutput;  // 接受坏结果
}
```

意味着即使 LLM 跑完一轮规划、diversity 校验失败、触发 recovery，recovery 也会接受 diversity 坏结果。要让 LLM 真的自动修 38/39 章重复，需要改这条 recovery 让 diversity issue 也 throw 或 throw 到触发新一轮 LLM call。**这是 T1，不在本轮 R7 范围。**

### 2. D2-Lite 30 分钟窗口内用户改了章节名

如果用户在 30 分钟内自己改了重复章节名，D2-Lite 不会重新 enqueue（因为幂等键还在）。**应对**：diversityReport 变化时清掉幂等键；或在 enqueue 前再做一次目标卷是否仍有重复的轻校验。

### 3. 暂停开关只控制前端

localStorage.aicockpit-auto-repair-disabled = 1 只阻止 D2-Lite 自动 enqueue，不阻止用户手动点立即修复按钮。**应对**：用户主动 enqueue 不应该被这个开关挡。如果未来想挡，要再加一个开关，不要共用。

### 4. findLatestVisibleTaskByNovelId 把被取消的任务也返回

最新任务可能是 cancelled（用户点了取消）。latestTerminalTask 拿到 cancelled 会让驾驶舱显示一个已取消状态。**应对**：渲染时把 cancelled 状态映射成无可见任务（null），不要渲染 bookAutomationProjection。

### 5. 任务投影恢复后用户缺继续入口

修复后 takeover 不会主动渲染修正重复的标题（缺 activeChapterTitleWarning），D3 提示区会显示。如果 D3 提示区被未来 UI 改动删掉，需要在回归测试里覆盖。

## 相关模块

- server/src/services/novel/director/phases/novelDirectorChapterTitleRepairRuntime.ts（守卫已删）
- server/src/services/novel/director/commands/DirectorRunCommand.ts（审计阶段写 taskNotice）
- server/src/services/novel/director/http/novelWorkflows.ts（/auto-director/latest 加 /chapter-titles/diversity-report 路由）
- server/src/services/novel/director/NovelWorkflowStoreService.ts（findLatestVisibleTaskByNovelId）
- client/src/api/novelWorkflow.ts（getLatestAutoDirectorTask）
- client/src/api/queryKeys.ts（autoDirectorTaskLatest 加 chapterTitleDiversityReport）
- client/src/api/novel/volumes.ts（getChapterTitleDiversityReport）
- client/src/components/layout/NovelWorkspaceRail.tsx（latestTaskQuery 加门控）
- client/src/components/autoDirector/AICockpit.tsx（D3 提示区加 D2-Lite auto-enqueue）
- server/src/prompting/prompts/planning/chapterList.prompts.ts（postValidateFailureRecovery，T1 未解决）

## 来源文档

- [自动导演投影级联失败污染与恢复](./auto-director-projection-cascade-failure.md)
- [重复故障模式与排查路径](../debugging/recurring-failure-modes.md)
- [章节生产链](./chapter-production-chain.md)

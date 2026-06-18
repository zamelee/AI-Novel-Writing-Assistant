# 自动导演投影级联失败污染与恢复

## 背景

`DirectorEventProjectionService.latestStep()` 按 `max(finishedAt, startedAt)` 选最新 step run。这一选择策略在 `DirectorRunCommand.continue` 成功之后不会产生新的 `DirectorStepRun` 记录（`continue` 走 policy 路径，不入 step 表），所以"成功恢复"的 run 会停留在"上一次实际跑过的 step"上。

当用户在前一轮自动导演还在跑 in-flight step 时点击"修正重复的标题"，`repair_chapter_titles` 命令会被 `novelDirectorChapterTitleRepairRuntime` 的 gate 阻挡（`row.status === "running"`），gate 的 throw 会把当时所有 in-flight step 级联标 `failed`，这些 step 共享同一个 `finishedAt`。后续 `continue` 成功恢复整个 run 后，DB 里没有新的 step run，于是：

- `latestStep()` 永远卡在那个共享 `finishedAt` 的失败 step 上
- `runtimeProjection.status` 被推成 `failed`
- `dashboardView.mode` 在 `buildMode()` line 128-136 命中"projection failed + 非 live + task 非 queued/running/waiting_approval"分支，返回 `failed`
- `bookAutomationProjection.status` 也变 `failed`
- 前端接管对话框标题走 `mode === "failed"` 分支，显示"自动导演已中断"
- `buildVisibleRiskBadges` 渲染"执行失败"红标
- `displayAutoDirectorTask.status` 被覆盖成 `failed`，导致抽屉 `canRetryWithOverrideModel = true` 但 takeover 渲染逻辑锁在 failed 分支

用户的真实状态（task 已 `workflow_completed`、1-10 章已生成）被一条级联失败记录遮蔽。

这条故障在长链路任务里反复出现：任意 gate throw + 任意 in-flight step 都会污染投影到任务真正结束之后。

## 决策

不修改级联失败的事实记录（DB 里 21 个 failed step 仍是审计真相），而是让 `latestStep()` 在选择时**过滤掉级联失败**，并把级联失败数作为透明指标暴露给投影消费者。

**为什么是过滤 latestStep 而不是过滤 UI**：

- UI 层（`buildDisplayAutoDirectorTask`、`mapDashboardModeToTakeoverMode`、`buildVisibleRiskBadges`）都基于投影衍生。在 UI 层加判断需要改 6+ 处，逻辑分散。
- 投影是 single source of truth。在投影层修一次，下游所有 UI 自动正确。
- 真实失败（step 是真失败，不是级联产生）仍能被 `latestStep()` 选中——因为我们只过滤特定的级联错误前缀，不过滤所有 failed step。

**为什么不直接 `latestStep()` 跳过所有 failed step**：

- 会掩盖真实失败：如果某 step 真失败且比当前 success step 更新，UI 会显示"步骤完成"，真实失败被吃掉。
- 没有可见性：用户失去"曾经失败过"的线索。

## 当前规则

### `DirectorEventProjectionService.latestStep` 选择策略

```ts
const CASCADE_FAILURE_ERROR_PREFIX = "当前自动导演仍在运行中";

function latestStep(steps: DirectorStepRun[]): DirectorStepRun | null {
  return steps.reduce<DirectorStepRun | null>((latest, step) => {
    // 跳过级联失败 step：error 含已知 gate-throw 前缀的 failed step
    if (step.status === "failed" && step.error?.includes(CASCADE_FAILURE_ERROR_PREFIX)) {
      return latest;
    }
    if (!latest) return step;
    const stepTime = Math.max(timestampOf(step.finishedAt), timestampOf(step.startedAt));
    const latestTime = Math.max(timestampOf(latest.finishedAt), timestampOf(latest.startedAt));
    return stepTime >= latestTime ? step : latest;
  }, null);
}
```

### 新增投影字段

在 `DirectorRuntimeProjection` 上新增：

```ts
cascadeFailureCount: number;  // 当前 run 中被级联标 failed 的 step 数
```

`buildSnapshotProjection` 计算：

```ts
const cascadeFailureCount = snapshot.steps.filter(
  s => s.status === "failed" && s.error?.includes(CASCADE_FAILURE_ERROR_PREFIX)
).length;
```

### 前端可见性：`buildVisibleRiskBadges` 新增徽标

```ts
if (cascadeFailureCount > 0) {
  push({ label: `曾级联失败 ${cascadeFailureCount} 步`, level: "info", source: "runtime" });
}
```

- `level: "info"` 不抢眼但保留线索
- 不依赖 status === "failed"，所以无论任务最终状态（completed / waiting_approval / failed）都能显示

## 示例

### 推荐做法

**场景 1：用户中途点修复按钮，gate 阻挡，级联失败**

```text
DB 状态：
  DirectorRunCommand: continue succeeded (02:01:59)
  DirectorStepRun: 11 succeeded, 21 failed (共享 finishedAt 01:59:07.598)

改前：
  latestStep → 21 个 failed 中的任意一个
  runtimeProjection.status = "failed"
  dashboardView.mode = "failed"
  takeover 标题 = "自动导演已中断"

改后：
  latestStep → 11 succeeded 中 finishedAt 最新的那一个（剧情正常流）
  runtimeProjection.status = "completed"
  dashboardView.mode = "completed"
  takeover 标题 = "正在自动导演"
  右上角徽标 = "曾级联失败 21 步"（信息级，不抢眼）
```

**场景 2：真实失败（非级联）**

```text
DB 状态：
  DirectorStepRun: 1 succeeded, 1 failed (independent)
  failed.error = "scene card 1_3 与合同 endingState 冲突"

改后：
  latestStep → failed step（因为 error 不含级联前缀，不被过滤）
  runtimeProjection.status = "failed"
  takeover 标题 = "自动导演已中断"
  正常显示失败内容
```

### 不推荐做法

- ❌ `latestStep()` 直接过滤 `status === "failed"`：会同时吃掉真实失败
- ❌ 在前端 `buildDisplayAutoDirectorTask` 里加 "如果 projection 说 failed 但 task 已 succeeded 则覆盖回去"：把派生逻辑写两遍，下一个 bug 隐藏点
- ❌ 改 `DirectorStepRun` 表里的 21 条记录把 status 改回 running 或 abandoned：污染审计线索、破坏快照一致性
- ❌ 在任务中心加"忽略投影的恢复按钮"：让用户绕过投影直接 retask，会和 projection 的其他消费者打架

## 失败模式

### 1. 跨过级联过滤的真实失败被错误归类为级联

如果未来有其他 gate 也用相同前缀（"当前自动导演仍在运行中"）的 throw，但实际指向真实失败而非级联——这条规则会错误放过。**应对**：级联前缀保持窄匹配；新 gate throw 时使用不同前缀，并在 wiki 记录所有"已知级联前缀"。

### 2. 21 个 failed step 永远不会被投影层展示

修复后 UI 不再显示"执行失败"红标（因为 projection.status = completed），但 DB 里的 failed step 仍在。**应对**：`buildVisibleRiskBadges` 新增的 "曾级联失败 N 步" 徽标承担可见性。如果徽标被未来 UI 改动删掉，需要在回归测试里覆盖。

### 3. `continue` 成功后没有新 step run，投影的真实"当前步骤"是模糊的

`continue` 走 policy 不入 step 表是历史决定。`latestStep()` 过滤级联后只能选"上一个真正成功跑过的 step"，但 run 的逻辑当前位置可能是 chapter 11+ 的执行入口。**应对**：未来如果要彻底解决"continue 留下 step 痕迹"，需要让 `DirectorRunCommand.continue` 在成功时插入一条 `DirectorStepRun` 记录（status=succeeded, nodeKey="chapter_batch.continue"），wiki 单独记录。

### 4. 投影恢复后用户缺继续入口

修复后 takeover mode 从 `failed` 变 `running`/`completed`，takeover 不会渲染"修正重复的标题"（缺 `activeChapterTitleWarning`，因为 `task.meta.taskNotice.code !== "CHAPTER_TITLE_DIVERSITY"`）。用户需要走任务中心 retask 或改 DB 解决最急的标题重复。

### 5. 回归测试必须覆盖

- 接管对话框标题：3 种 status（failed / waiting_approval / completed）× 3 种 checkpoint（chapter_batch_ready / workflow_completed / replan_required）
- 抽屉 capability：`canRetryWithOverrideModel` 在 5 种 task.status 下的值
- 跟进页 projection 卡片：红标/绿标/信息标
- 任务中心卡片：recovery candidate 过滤（确保不会被错误列出）
- DirectorFactInspection：仍能查到 21 个 failed step（审计线索不丢失）

## 相关模块

- `server/src/services/novel/director/runtime/DirectorEventProjectionService.ts`（`latestStep` / `buildSnapshotProjection` / `buildVisibleRiskBadges`）
- `server/src/services/novel/director/projections/DirectorDashboardViewBuilder.ts`（`buildMode`）
- `server/src/services/novel/director/projections/DirectorBookAutomationProjectionService.ts`（`dashboardModeToBookStatus` / `buildRecoveryDecision`）
- `server/src/services/novel/director/projections/DirectorDisplayStateBuilder.ts`（继承 `buildMode`）
- `server/src/services/novel/director/phases/novelDirectorChapterTitleRepairRuntime.ts`（级联 throw 源头）
- `client/src/pages/novels/novelEditAutomationStatus.ts`（`buildDisplayAutoDirectorTask` / `resolveTakeoverModeFromAutomation`）
- `client/src/pages/novels/NovelEdit.tsx`（`mapDashboardModeToTakeoverMode` / takeover buttons / `capabilities.canRetryWithOverrideModel`）
- `client/src/pages/novels/components/NovelTaskDrawer.tsx`（`canShowRetryWithOverrideModel`）
- `shared/types/directorRuntime.ts`（`DirectorRuntimeProjection` 类型新增 `cascadeFailureCount` 字段）

## 来源文档

- [重复故障模式与排查路径](../debugging/recurring-failure-modes.md)
- [自动导演执行面隔离与 API 保活计划](../../plans/auto-director-execution-plane-isolation-plan.md)
- [导演模式模块化与状态治理改造清单](../../plans/director-mode-module-state-refactor-checklist.md)

## 2026-06-18 实施记录：R7 修复运行时守卫删除

在 [auto-director-repair-runtime-r7](./auto-director-repair-runtime-r7.md) 的实施过程中，发现本 wiki 描述的级联污染源头有两层：

1. **latestStep 选择策略错误**（本 wiki 描述）：max(finishedAt, startedAt) 选最新 step run，级联失败的 step 抢走最新时间戳。已通过 CASCADE_FAILURE_ERROR_PREFIX 过滤修复。
2. **runtime 守卫 throw 自身也会产生级联失败**：见 R7 wiki 详述。taskHasTitleWarning 守卫抛出的 throw 也是已知级联前缀之一，本 wiki 的过滤规则同时覆盖这条 throw。

**R7 之后守卫不再 throw**，意味着未来如果再出现级联失败，前缀集合应当重新审计。本 wiki 的过滤规则不需改（它本来就是按错误前缀过滤，不是按 throw 来源过滤），但要在回归测试里覆盖：

- 接管对话框标题：3 种 status（failed / waiting_approval / completed）x 3 种 checkpoint（chapter_batch_ready / workflow_completed / replan_required）
- 抽屉 capability：canRetryWithOverrideModel 在 5 种 task.status 下的值
- 跟进页 projection 卡片：红标 / 绿标 / 信息标
- 任务中心卡片：recovery candidate 过滤（确保不会被错误列出）
- DirectorFactInspection：仍能查到级联 step 记录（审计线索不丢失）

C 门控（latestTerminalTask 派生）让 R7 修复后的任务在 UI 上完整可见，无需再走 retask 路径。

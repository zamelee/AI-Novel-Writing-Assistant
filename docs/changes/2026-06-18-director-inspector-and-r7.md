# 2026-06-18 director runtime inspector + repair runtime R7

This change set covers three rounds of work over a single 24-hour window.
Each round addresses a distinct user-visible problem. Reading order
matters: the inspector is the surface, R7 is the gate fix underneath,
and the narrowing fix is incidental cleanup that surfaced during the
inspector build.

## 1. Background: what was broken

Three problems were observed in production:

1. **Stale failure cards with no clear next step.** When an
   auto-director task failed because of a high-memory reservation
   collision (`当前小说已有高内存卷规划生成正在处理同一范围...`),
   the user saw a red card with the same text in three different
   fields. They could not tell whether the lock was still held, by
   whom, or whether a retry would just bounce again. The task
   eventually finished, but the UI kept showing the failure state
   because of cascade-pollution in `latestStep()`.
2. **Silent loss of chapter title repair commands.** The repair
   runtime rejected commands whose `seedPayload.taskNotice` did not
   already carry a `CHAPTER_TITLE_DIVERSITY` code. In practice this
   meant that the first attempt to repair duplicate chapter titles
   was dropped on the floor: the gate fired, the command was
   rejected, the user saw nothing, and the next attempt tried the
   same path with the same result.
3. **Pre-existing TypeScript narrowing noise in the reservation
   runtime.** `acquireScopedHighMemoryReservation` had four
   `Variable 'gate' is used before being assigned` and `Property
   'handle' does not exist on the false branch` errors that blocked
   clean `tsc` runs and would have hidden future real errors.

## 2. Three-layer solution

```
+---------------------------------------------------------------+
|  Layer 1: Workflow dashboard inspector panel                 |
|  - /workflow shows the familiar task buckets                 |
|  - Each novel_workflow card now has "展开 runtime 详情"      |
|  - Panel renders 4 sub-areas: in-flight / waiting / locks /  |
|    recent executions                                         |
|  - User can release a deadlock whose owner is finished       |
|  - Polling interval: 5s default, 10s preset, 2-60s custom    |
+---------------------------------------------------------------+
                          |  backed by
                          v
+---------------------------------------------------------------+
|  Layer 2: DirectorInspectorService + 3 new routes            |
|  - GET /novels/:novelId/director/inspector                   |
|  - GET /novels/:novelId/director/locks                       |
|  - POST /director/locks/release   (key in body, not URL)     |
|  - Aggregates DirectorRuntimeCommand + Instance + Execution  |
|    + AppSetting reservation keys                             |
+---------------------------------------------------------------+
                          |  executes through
                          v
+---------------------------------------------------------------+
|  Layer 3: Repair runtime gate (R7) + projection cleanup      |
|  - novelDirectorChapterTitleRepairRuntime: removed the       |
|    taskHasTitleWarning gate; runtime no longer second-guesses |
|    the audit phase                                           |
|  - DirectorEventProjectionService.latestStep: filters known  |
|    cascade-failure error prefixes; cascadeFailureCount badge |
+---------------------------------------------------------------+
```

## 3. Files changed

### Added (4 files)

| Path | Lines | Purpose |
|---|---|---|
| `server/src/services/novel/director/runtime/DirectorInspectorService.ts` | ~330 | Snapshot aggregator; one novelId in, full snapshot out |
| `client/src/api/workflow/inspector.ts` | ~125 | API client + TypeScript types for inspector responses |
| `client/src/pages/workflowDashboard/components/DirectorInspectorPanel.tsx` | ~350 | Panel component with poll input, release dialog, 4 sub-cards |
| `docs/wiki/workflows/auto-director-runtime-inspector.md` | ~155 | Design doc for the inspector (background, decision, examples, failure modes) |

### Modified (13 files)

| Path | Reason |
|---|---|
| `server/src/services/novel/director/http/novelWorkflows.ts` | Add 3 new routes + `DirectorInspectorService` import |
| `server/src/services/novel/highMemoryReservation.ts` | Fix 4 pre-existing TS narrowing errors (runtime behavior unchanged) |
| `server/src/services/novel/director/phases/novelDirectorChapterTitleRepairRuntime.ts` | R7: remove `taskHasTitleWarning` guard |
| `client/src/api/queryKeys.ts` | Add `directorInspector` + `directorInspectorLocks` query keys |
| `client/src/pages/workflowDashboard/components/WorkflowCard.tsx` | Accept `inspectorOpen` + `onToggleInspector` props |
| `client/src/pages/workflowDashboard/WorkflowDashboardPage.tsx` | Maintain `inspectorFor` state; mount panel; extract novelId from sourceRoute |
| `docs/wiki/workflows/auto-director-repair-runtime-r7.md` | New wiki page for the R7 gate removal |
| `docs/wiki/workflows/auto-director-projection-cascade-failure.md` | Append 2026-06-18 implementation record |
| `docs/releases/release-notes.md` | Add 2026-06-18 entry (merged R7 + inspector) |
| `README.md` | Update `## 最新更新` to 2026-06-18 |
| `client/src/api/novel/volumes.ts` | Earlier round: `getChapterTitleDiversityReport` |
| `client/src/api/novelWorkflow.ts` | Earlier round: `getLatestAutoDirectorTask` |
| `client/src/lib/directorTaskNotice.ts` | Earlier round: small task-notice constant tweak |

### Untouched but related (C-min round, in working tree, NOT in this commit)

The working tree also contains an earlier round of changes
(`server/src/prompting/prompts/novel/...`, several
`server/src/services/novel/director/...` files, launcher Python
sources, and `AI-Novel-Launcher.exe`). These belong to a separate
pre-T2 work item and are deliberately excluded from this commit so
that the inspector + R7 change can be reviewed in isolation.

## 4. Why these decisions

### 4.1 Why a per-novel panel and not a global tab

`/workflow` is the only place that already lists novel-scoped tasks
with a `sourceRoute`. Adding a separate global inspector route would
force the user to first pick a novel, then drill in. Expanding
inline keeps the existing mental model: see the failed card, click
"展开 runtime 详情", see why it failed and what to do.

### 4.2 Why user-configurable polling

Inspector data is small and mostly idle, so the cost of polling is
low. A fixed 5s interval would force power users to wait through the
default window; a fixed 1s interval would burn battery and CPU on
the dev server. Letting the user pick from a default, a slow preset,
or any custom interval between 2000ms and 60000ms covers both
casual and debugging scenarios without code changes.

### 4.3 Why a manual release-lock button

The `highMemoryReservation` mechanism has a 10-minute TTL with a
2-minute renewal. In normal flow, locks release on their own when
the owning task finishes. But if a task is killed mid-run or a
worker is restarted without releasing, a lock can outlive its
owner. Without a manual release, the only path to recover is
waiting for TTL expiry (up to 10 minutes of pain) or a DB-level
intervention. The button accepts only locks whose owner task is
already in a finished state; in-flight owners are protected.

### 4.4 Why the release route uses request body

Lock keys are
`runtime.highMemoryReservation.novel-high-memory.<base64url-scope>`
which contain dots and other characters that path-to-regexp cannot
capture with `(*)` wildcards. The original draft used
`router.post("/director/locks/:key(*)/release")` and crashed the
dev server on reload (`Missing parameter name at index 22`). The
release route now uses `/director/locks/release` with the full key
in the request body, where the Zod validator enforces presence
and length.

### 4.5 Why R7 deletes the gate instead of widening it

Three alternatives were considered:

- **Widen the gate** with a caller whitelist: future callers need
  to be added to the list, growing the file each time.
- **Synthesize a stub `taskNotice` in the runtime**: breaks the
  invariant that only `DirectorRunCommand` writes `taskNotice`, and
  introduces half-state windows where the projection sees a stub.
- **Delete the gate**: runtime does execution, audit phase decides
  whether to run. Smallest, cleanest contract.

R7 picks the third.

## 5. Verification

| Check | Result |
|---|---|
| `tsc --noEmit` (client) | 0 errors |
| `tsc --noEmit` (server) | 0 errors (was 4 pre-existing narrowing errors; now 0) |
| `GET /director/inspector` | 200, full snapshot structure |
| `GET /director/locks` | 200, locks + releasableCount |
| `POST /director/locks/release` | 200/409, key in body |
| ts-node-dev reload | Reloaded cleanly after route edit |
| 4 new files encoding | All CRLF 100%, no BOM |
| Backup coverage | All 3 modified source files backed up to `server/tmp/code-backups/20260618_*.bak` |

## 6. Known follow-ups (not in this commit)

- **T1**: `chapterList.prompts.ts:475-485` `postValidateFailureRecovery`
  still accepts diversity-broken results. R7 removed the runtime
  gate but did not make the LLM actually retry on diversity
  failures. This remains the root cause of repeated duplicate-title
  generations.
- **T2.1**: A priority-raise button (插队) in the inspector's
  waiting-commands card. Not in scope of this round.
- **actorTaskId audit**: The release route does not check that the
  caller owns the lock. Currently harmless because only finished
  owners are releasable; tighten before adding roles.
- **Upstream sync**: `ExplosiveCoderflome/AI-Novel-Writing-Assistant`
  has at least three director fixes that overlap with our
  scenarios (notably `f564657f` allow full-book JIT auto execution
  and `aeb64aba` prevent reset from clearing written chapters).
  Consider pulling those into a future commit.

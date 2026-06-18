# Director runtime inspector panel

## Background

The workflow dashboard at `/workflow` already shows task cards (status, stage, blocking reason), but it does not surface the lower-level director runtime state: in-flight commands, queued commands, high-memory reservation locks, recent executions. When a task is "failed" or "suspended", users cannot tell whether something is still running, whether a lock is holding them back, or whether a previous lock has become stale and can be released.

A failed auto-director task with `lastError = "当前小说已有高内存卷规划生成正在处理同一范围..."` is the canonical example. The user sees a red failure card, retries, and the same error comes back, but they cannot see: who is holding the lock, when it will expire, whether retrying just now makes sense, or whether the lock has been orphaned by a crashed process.

## Decision

Add a per-novel runtime inspector panel that the workflow dashboard expands on demand. The panel reads from a single new backend service that aggregates four tables (`DirectorRuntimeCommand`, `DirectorRuntimeInstance`, `DirectorRuntimeExecution`, `AppSetting` reservation keys) into one snapshot per novel. The panel renders four sub-areas (in-flight, waiting, locks, recent executions) and supports a manual "release lock" action for deadlocks whose owner task is already finished.

### Why a per-novel panel and not a global tab

`/workflow` is the only place that already lists novel-scoped tasks with a `sourceRoute`. Adding a separate global inspector route would force the user to first pick a novel, then drill in. Expanding inline keeps the existing mental model: see the failed card, click "展开 runtime 详情", see why it failed and what to do.

### Why user-configurable polling (default 5s, preset 10s, custom input)

Inspector data is small and mostly idle, so the cost of polling is low. A fixed 5s interval would force power users to wait through the default window; a fixed 1s interval would burn battery and CPU on the dev server. Letting the user pick from a default, a slow preset, or any custom interval between 2000ms and 60000ms covers both casual and debugging scenarios without code changes.

### Why a manual release-lock button

The `highMemoryReservation` mechanism has a 10-minute TTL with a 2-minute renewal. In normal flow, locks release on their own when the owning task finishes. But if a task is killed mid-run or a worker is restarted without releasing, a lock can outlive its owner. Without a manual release, the only path to recover is waiting for TTL expiry (up to 10 minutes of pain) or a DB-level intervention. The button accepts only locks whose owner task is already in a finished state (`failed`, `succeeded`, `cancelled`); in-flight owners are protected.

### Why the release route uses request body, not URL path

Lock keys are `runtime.highMemoryReservation.novel-high-memory.<base64url-scope>` which contain dots and other characters that path-to-regexp cannot capture with `(*)` wildcards. The original draft used `router.post("/director/locks/:key(*)/release")` and crashed the dev server on reload. The release route now uses `/director/locks/release` with the full key in the request body, where the Zod validator enforces presence and length.

## Current rules

### Backend service

`DirectorInspectorService.getSnapshot(novelId)` returns a `DirectorInspectorSnapshot`:

```ts
{
  novelId, generatedAt,
  inFlightCommands: InspectorCommandRow[],
  waitingCommands: InspectorCommandRow[],
  recentCommands: InspectorCommandRow[],   // last 20 terminal
  inFlightInstances: InspectorInstanceRow[],
  recentExecutions: InspectorExecutionRow[], // last 20
  activeLocks: InspectorLockRow[],          // scoped to novelId
  counts: { inFlight, waiting, recent, instances, executions, locks, releasableLocks },
}
```

Lock rows include `ownerTaskStatus`, `ownerTaskId`, `canSafelyRelease` (true iff owner is finished and not expired), `remainingMs`, and `isExpired`.

`DirectorInspectorService.releaseLock({ key, novelId, actorTaskId })` rejects with a `reason` if the lock is missing, expired, owned by an in-flight task, owned by a task that no longer exists, or belongs to a different novel. Returns `{ released: true }` only when the row was actually deleted.

### Routes

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET  | `/novels/:novelId/director/inspector` | - | Full snapshot |
| GET  | `/novels/:novelId/director/locks` | - | Just `activeLocks` + `releasableCount` |
| POST | `/director/locks/release` | `{ key, novelId, actorTaskId? }` | Release a deadlock |

All routes require the existing auth middleware and use the standard `ApiResponse` envelope.

### Frontend component

`client/src/pages/workflowDashboard/components/DirectorInspectorPanel.tsx` is mounted by `WorkflowDashboardPage` when a task card has its inspector expanded. It owns its own `pollMs` state, persisted to `localStorage` under `aicockpit-inspector-poll-ms` (clamped to `[2000, 60000]`). It renders four `Card`s in a 2x2 grid, plus a `ConfirmReleaseDialog` overlay.

### WorkflowCard change

`WorkflowCard` now accepts `inspectorOpen` and `onToggleInspector` props. When `task.kind === "novel_workflow"` and an `onToggleInspector` is provided, it renders a "展开 runtime 详情" / "收起 runtime 详情" button below the action row.

### WorkflowDashboardPage change

`WorkflowDashboardPage` derives `novelId` from `task.sourceRoute` via `extractNovelIdFromSourceRoute(route)` and maintains `inspectorFor: { novelId, title } | null`. Selecting a task card toggles the inspector; the panel mounts above the existing "需要处理 / 进行中 / 最近 24h 完成" sections.

## Examples

### Recommended usage

**Scenario 1: failed task with a stale lock**

```text
1. User opens /workflow
2. Sees a [failed] card with the lock error
3. Clicks "展开 runtime 详情"
4. Panel mounts: 0 in-flight, 0 waiting, 1 lock
5. Lock card shows ownerTaskStatus=failed, remainingMs=423000, canSafelyRelease=true
6. User clicks "现在释放"
7. ConfirmReleaseDialog explains what will happen
8. User clicks "确认释放"
9. POST /director/locks/release succeeds
10. Panel refetches; lock is gone
11. User retries the task and it proceeds
```

**Scenario 2: long task running normally**

```text
1. User opens /workflow
2. Sees a [running] card
3. Clicks "展开 runtime 详情"
4. Panel mounts: 2 in-flight commands, 5 waiting, 0 locks, recent executions visible
5. User watches ETA via startedAt + durationMs + ageMs columns
6. Polls every 10s via the preset button to reduce noise
```

### Not recommended

- Auto-releasing locks without an explicit user action. The mechanism exists for a reason (two writers must not run at the same time). Auto-releasing any in-flight owner's lock is dangerous.
- Calling `releaseDirectorInspectorLock` from anywhere other than the inspector panel. There is no other UI surface that explains the precondition (finished owner). Out-of-band callers will cause silent data loss.
- Bypassing the inspector and using `retryTask` repeatedly. Each retry re-enters the queue. If the lock is still held, the retry will fail identically, and the noise drowns out other tasks in the task center.
- Increasing the default polling rate above 5s as a project-wide constant. The persistence layer (`localStorage`) per-user default should stay at 5s; power users can opt in to faster polling only for the duration of their debugging session.

## Failure modes

### 1. ts-node-dev crashes on route reload

The release route was originally written with `:key(*)` in the URL. path-to-regexp rejected the wildcard and the dev server refused to reload. The fix moved the key to the request body. If a future contributor wants URL-based release again, use Express 5 splat syntax `/director/locks/*splat/release` with `req.params.splat`, or base64url-encode the scope client-side and accept it as a normal `:scope` param.

### 2. `highMemoryReservation` pre-existing TS narrowing errors

`acquireScopedHighMemoryReservation` had four TS errors (`Variable 'gate' is used before being assigned`, `Property 'handle' does not exist on the false branch`). The fix changed `let gate: Awaited<...>` to `let gate!: Awaited<...>` and replaced `!gate!.acquired` with `!gate || !gate.acquired`. Pure type-level change; runtime behavior was already correct. If new pre-existing TS errors appear in this file, follow the same pattern: non-null assertion on the declaration, defensive check before consumption.

### 3. `DirectorRuntimeInstance` schema does not have `startedAt`

The inspector panel maps `instance.startedAt` from `createdAt` because the actual table only has `createdAt` and `lastHeartbeatAt`. If a future migration adds `startedAt`, swap the mapping back.

### 4. Lock release with mismatched `actorTaskId`

The current release guard does not check `actorTaskId` against `record.ownerId`. Any authenticated user can release any finished task's lock. This is intentional for now (only finished owners are releasable, and releasing is harmless), but if multi-tenant permissions grow tighter, the route should compare `actorTaskId` to `ownerTaskId` or enforce an admin role.

### 5. Polling storms when many novels are expanded at once

Each panel issues its own refetch. With 10 novels expanded and a 2000ms poll interval, the backend sees 5 req/s per novel. Mitigated by the 2000ms floor and by the fact that `/workflow` typically shows 1-3 novels at a time. If scaling becomes a problem, add a per-novel in-memory cache in `DirectorInspectorService` with a 1-second TTL.

### 6. Lost `localStorage` poll preference

The persisted interval lives in `localStorage.aicockpit-inspector-poll-ms`. Clearing site data resets to the 5s default. If we ever want a project-wide default, expose it as a server config and let the panel fall back to it when the localStorage key is missing.

## Related modules

- `server/src/services/novel/director/runtime/DirectorInspectorService.ts` (new, 330 lines)
- `server/src/services/novel/director/http/novelWorkflows.ts` (added 3 routes)
- `server/src/services/novel/highMemoryReservation.ts` (TS narrowing fix, behavior unchanged)
- `client/src/api/workflow/inspector.ts` (new)
- `client/src/api/queryKeys.ts` (added `directorInspector`, `directorInspectorLocks`)
- `client/src/pages/workflowDashboard/components/DirectorInspectorPanel.tsx` (new)
- `client/src/pages/workflowDashboard/components/WorkflowCard.tsx` (added `inspectorOpen` + `onToggleInspector` props)
- `client/src/pages/workflowDashboard/WorkflowDashboardPage.tsx` (added `inspectorFor` state + panel mount)

## Source documents

- [Auto director runtime](./auto-director-runtime.md)
- [Auto director projection cascade failure](./auto-director-projection-cascade-failure.md)
- [Auto director repair runtime R7](./auto-director-repair-runtime-r7.md)
- [Chapter production chain](./chapter-production-chain.md)

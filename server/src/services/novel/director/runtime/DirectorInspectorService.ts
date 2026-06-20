import { prisma } from "../../../../db/prisma";

// Director runtime inspector: aggregates commands / instances / executions / locks
// for a single novelId. Read-only, no LLM calls.

export interface InspectorCommandRow {
  id: string;
  commandType: string;
  status: string;
  priority: number;
  attempt: number;
  runAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  runtimeId: string | null;
  workflowTaskId: string | null;
  isInFlight: boolean;
  isWaiting: boolean;
  isTerminal: boolean;
  ageMs: number;
  durationMs: number | null;
}

export interface InspectorInstanceRow {
  id: string;
  workflowTaskId: string | null;
  status: string;
  currentStep: string | null;
  runMode: string | null;
  lastHeartbeatAt: string | null;
  lastErrorClass: string | null;
  lastErrorMessage: string | null;
  workerMessage: string | null;
  startedAt: string;
  heartbeatAgeMs: number;
  isStale: boolean;
}

export interface InspectorExecutionRow {
  id: string;
  commandId: string | null;
  stepType: string | null;
  status: string;
  resourceClass: string | null;
  startedAt: string;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  activeLockKey: string | null;
}

export type OwnerTaskStatus =
  | "unknown"
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface InspectorLockRow {
  key: string;
  encodedScope: string;
  ownerId: string | null;
  namespace: string | null;
  scope: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
  remainingMs: number;
  isExpired: boolean;
  metadata: Record<string, unknown> | null;
  ownerTaskStatus: OwnerTaskStatus | null;
  ownerTaskId: string | null;
  canSafelyRelease: boolean;
}

export interface DirectorForesightAuditSummary {
  novelId: string;
  taskId: string;
  overdueCount: number;
  pendingCount: number;
  total: number;
  lastAuditAt: string;
  topItems: Array<{
    id: string;
    ledgerKey: string;
    title: string;
    currentStatus: "overdue" | "pending_payoff";
    targetEndChapterOrder: number | null;
    statusReason: string | null;
  }>;
}

const FORESIGHT_AUDIT_TOP_LIMIT = 5;

function readForesightAuditFromSeed(seedPayloadJson: string | null): DirectorForesightAuditSummary | null {
  if (!seedPayloadJson) return null;
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(seedPayloadJson);
    if (parsed && typeof parsed === "object") {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (!raw) return null;
  const value = raw.foresightAudit;
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.lastAuditAt !== "string") return null;
  const items = Array.isArray(snapshot.items)
    ? snapshot.items
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => ({
          id: typeof entry.id === "string" ? entry.id : "",
          ledgerKey: typeof entry.ledgerKey === "string" ? entry.ledgerKey : "",
          title: typeof entry.title === "string" ? entry.title : "",
          currentStatus: entry.currentStatus === "overdue" || entry.currentStatus === "pending_payoff"
            ? entry.currentStatus
            : "pending_payoff",
          targetEndChapterOrder: typeof entry.targetEndChapterOrder === "number" ? entry.targetEndChapterOrder : null,
          statusReason: typeof entry.statusReason === "string" ? entry.statusReason : null,
        }))
    : [];
  const narrowedItems = items.map((entry) => ({
    ...entry,
    currentStatus: (entry.currentStatus === "overdue" ? "overdue" : "pending_payoff") as "overdue" | "pending_payoff",
  }));
  return {
    novelId: typeof snapshot.novelId === "string" ? snapshot.novelId : "",
    taskId: typeof snapshot.taskId === "string" ? snapshot.taskId : "",
    overdueCount: typeof snapshot.overdueCount === "number" ? snapshot.overdueCount : 0,
    pendingCount: typeof snapshot.pendingCount === "number" ? snapshot.pendingCount : 0,
    total: typeof snapshot.total === "number" ? snapshot.total : 0,
    lastAuditAt: snapshot.lastAuditAt,
    topItems: narrowedItems.slice(0, FORESIGHT_AUDIT_TOP_LIMIT),
  };
}

export interface DirectorInspectorSnapshot {
  novelId: string;
  generatedAt: string;
  inFlightCommands: InspectorCommandRow[];
  waitingCommands: InspectorCommandRow[];
  recentCommands: InspectorCommandRow[];
  inFlightInstances: InspectorInstanceRow[];
  recentExecutions: InspectorExecutionRow[];
  activeLocks: InspectorLockRow[];
  foresightAudit: DirectorForesightAuditSummary | null;
  counts: {
    inFlight: number;
    waiting: number;
    recent: number;
    instances: number;
    executions: number;
    locks: number;
    releasableLocks: number;
  };
}

const TERMINAL_COMMAND_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const INFLIGHT_COMMAND_STATUSES = new Set(["running"]);
const INFLIGHT_INSTANCE_STATUSES = new Set(["running"]);
const STALE_HEARTBEAT_MS = 60 * 1000;
const RECENT_COMMAND_LIMIT = 20;
const RECENT_EXECUTION_LIMIT = 20;

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

interface ParsedReservation {
  ownerId?: string | null;
  namespace?: string | null;
  scope?: string | null;
  scopeKey?: string | null;
  acquiredAt?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

function parseReservationValue(raw: string | null | undefined): ParsedReservation | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ownerId: typeof parsed.ownerId === "string" ? parsed.ownerId : null,
      namespace: typeof parsed.namespace === "string" ? parsed.namespace : null,
      scope: typeof parsed.scope === "string" ? parsed.scope : null,
      scopeKey: typeof parsed.scopeKey === "string" ? parsed.scopeKey : null,
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : null,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      metadata: parsed.metadata && typeof parsed.metadata === "object" ? (parsed.metadata as Record<string, unknown>) : null,
    };
  } catch {
    return null;
  }
}

export class DirectorInspectorService {
  async getSnapshot(novelId: string): Promise<DirectorInspectorSnapshot> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const tasks = await prisma.novelWorkflowTask.findMany({
      where: { novelId },
      select: { id: true, status: true, seedPayloadJson: true, updatedAt: true },
    });
    const taskIdList = tasks.map((row) => row.id);
    const taskStatusById = new Map<string, string>();
    for (const row of tasks) {
      taskStatusById.set(row.id, row.status);
    }

    const [commands, instances, executions, lockSettings] = await Promise.all([
      taskIdList.length > 0
        ? prisma.directorRuntimeCommand.findMany({
            where: { workflowTaskId: { in: taskIdList } },
            orderBy: { updatedAt: "desc" },
            take: 200,
          })
        : Promise.resolve([] as Awaited<ReturnType<typeof prisma.directorRuntimeCommand.findMany>>),
      taskIdList.length > 0
        ? prisma.directorRuntimeInstance.findMany({
            where: { workflowTaskId: { in: taskIdList } },
            orderBy: { lastHeartbeatAt: "desc" },
            take: 50,
          })
        : Promise.resolve([] as Awaited<ReturnType<typeof prisma.directorRuntimeInstance.findMany>>),
      taskIdList.length > 0
        ? prisma.directorRuntimeExecution.findMany({
            where: { workflowTaskId: { in: taskIdList } },
            orderBy: { startedAt: "desc" },
            take: 200,
          })
        : Promise.resolve([] as Awaited<ReturnType<typeof prisma.directorRuntimeExecution.findMany>>),
      prisma.appSetting.findMany({
        where: { key: { startsWith: "runtime.highMemoryReservation.novel-high-memory." } },
      }),
    ]);

    const commandRows: InspectorCommandRow[] = commands.map((row) => {
      const startedAtMs = row.startedAt ? new Date(row.startedAt).getTime() : null;
      const finishedAtMs = row.finishedAt ? new Date(row.finishedAt).getTime() : null;
      const createdAtMs = new Date(row.createdAt).getTime();
      const isTerminal = TERMINAL_COMMAND_STATUSES.has(row.status);
      const isInFlight = INFLIGHT_COMMAND_STATUSES.has(row.status);
      const isWaiting = row.status === "queued";
      return {
        id: row.id,
        commandType: row.commandType,
        status: row.status,
        priority: row.priority,
        attempt: row.attempt,
        runAfter: toIso(row.runAfter),
        leaseOwner: row.leaseOwner ?? null,
        leaseExpiresAt: toIso(row.leaseExpiresAt),
        startedAt: toIso(row.startedAt),
        finishedAt: toIso(row.finishedAt),
        errorMessage: row.errorMessage ?? null,
        createdAt: toIso(row.createdAt) ?? nowIso,
        runtimeId: row.runtimeId ?? null,
        workflowTaskId: row.workflowTaskId ?? null,
        isInFlight,
        isWaiting,
        isTerminal,
        ageMs: Math.max(0, now - createdAtMs),
        durationMs: startedAtMs !== null && finishedAtMs !== null ? Math.max(0, finishedAtMs - startedAtMs) : null,
      };
    });

    const instanceRows: InspectorInstanceRow[] = instances.map((row) => {
      const lastHeartbeatMs = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : null;
      const heartbeatAge = lastHeartbeatMs !== null ? Math.max(0, now - lastHeartbeatMs) : Number.POSITIVE_INFINITY;
      const isStale = !INFLIGHT_INSTANCE_STATUSES.has(row.status) || heartbeatAge > STALE_HEARTBEAT_MS;
      return {
        id: row.id,
        workflowTaskId: row.workflowTaskId ?? null,
        status: row.status,
        currentStep: row.currentStep ?? null,
        runMode: row.runMode ?? null,
        lastHeartbeatAt: toIso(row.lastHeartbeatAt),
        lastErrorClass: row.lastErrorClass ?? null,
        lastErrorMessage: row.lastErrorMessage ?? null,
        workerMessage: row.workerMessage ?? null,
        startedAt: toIso(row.createdAt) ?? nowIso,
        heartbeatAgeMs: Number.isFinite(heartbeatAge) ? heartbeatAge : -1,
        isStale,
      };
    });

    const executionRows: InspectorExecutionRow[] = executions.map((row) => {
      const startedMs = row.startedAt ? new Date(row.startedAt).getTime() : Date.now();
      const finishedMs = row.finishedAt ? new Date(row.finishedAt).getTime() : null;
      return {
        id: row.id,
        commandId: row.commandId ?? null,
        stepType: row.stepType ?? null,
        status: row.status,
        resourceClass: row.resourceClass ?? null,
        startedAt: toIso(row.startedAt) ?? nowIso,
        finishedAt: toIso(row.finishedAt),
        leaseExpiresAt: toIso(row.leaseExpiresAt),
        errorClass: row.errorClass ?? null,
        errorMessage: row.errorMessage ?? null,
        durationMs: finishedMs !== null ? Math.max(0, finishedMs - startedMs) : null,
        activeLockKey: row.activeLockKey ?? null,
      };
    });

    const lockRows: InspectorLockRow[] = [];
    for (const setting of lockSettings) {
      const record = parseReservationValue(setting.value);
      if (!record) continue;
      const metadata = record.metadata ?? null;
      const metaNovelId = typeof metadata?.novelId === "string" ? (metadata.novelId as string) : null;
      if (metaNovelId !== novelId) continue;
      const expiresAtMs = record.expiresAt ? new Date(record.expiresAt).getTime() : Number.NaN;
      const isExpired = Number.isFinite(expiresAtMs) ? expiresAtMs <= now : false;
      const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : 0;
      const ownerTaskId = record.ownerId ?? null;
      const ownerTaskStatus = ownerTaskId ? (taskStatusById.get(ownerTaskId) ?? null) : null;
      const canSafelyRelease = !isExpired && ownerTaskStatus !== null && (ownerTaskStatus === "failed" || ownerTaskStatus === "succeeded" || ownerTaskStatus === "cancelled");
      const segments = setting.key.split(".");
      const encodedScope = segments[segments.length - 1] ?? "";
      lockRows.push({
        key: setting.key,
        encodedScope,
        ownerId: record.ownerId ?? null,
        namespace: record.namespace ?? null,
        scope: record.scope ?? record.scopeKey ?? null,
        acquiredAt: toIso(record.acquiredAt ? new Date(record.acquiredAt) : null),
        expiresAt: record.expiresAt ?? null,
        remainingMs,
        isExpired,
        metadata,
        ownerTaskStatus: (ownerTaskStatus as OwnerTaskStatus) ?? null,
        ownerTaskId,
        canSafelyRelease,
      });
    }

    const foresightAudit = (() => {
      const candidates = tasks
        .map((row) => readForesightAuditFromSeed(row.seedPayloadJson))
        .filter((entry): entry is DirectorForesightAuditSummary => entry !== null);
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.lastAuditAt.localeCompare(a.lastAuditAt));
      return candidates[0];
    })();

    return {
      novelId,
      generatedAt: nowIso,
      foresightAudit,
      inFlightCommands: commandRows.filter((c) => c.isInFlight),
      waitingCommands: commandRows.filter((c) => c.isWaiting),
      recentCommands: commandRows.filter((c) => c.isTerminal).slice(0, RECENT_COMMAND_LIMIT),
      inFlightInstances: instanceRows.filter((i) => INFLIGHT_INSTANCE_STATUSES.has(i.status) && !i.isStale),
      recentExecutions: executionRows.slice(0, RECENT_EXECUTION_LIMIT),
      activeLocks: lockRows,
      counts: {
        inFlight: commandRows.filter((c) => c.isInFlight).length,
        waiting: commandRows.filter((c) => c.isWaiting).length,
        recent: commandRows.filter((c) => c.isTerminal).length,
        instances: instanceRows.length,
        executions: executionRows.length,
        locks: lockRows.length,
        releasableLocks: lockRows.filter((l) => l.canSafelyRelease).length,
      },
    };
  }

  async releaseLock(input: { key: string; novelId: string; actorTaskId?: string | null; }): Promise<{ released: boolean; reason?: string; }> {
    const setting = await prisma.appSetting.findUnique({ where: { key: input.key } });
    if (!setting) return { released: false, reason: "lock_not_found" };
    const record = parseReservationValue(setting.value);
    if (!record) return { released: false, reason: "lock_value_unparseable" };
    const metadata = record.metadata ?? null;
    const metaNovelId = typeof metadata?.novelId === "string" ? (metadata.novelId as string) : null;
    if (metaNovelId !== input.novelId) return { released: false, reason: "lock_novel_mismatch" };
    const expiresAtMs = record.expiresAt ? new Date(record.expiresAt).getTime() : 0;
    if (expiresAtMs <= Date.now()) return { released: false, reason: "lock_already_expired" };
    if (!record.ownerId) return { released: false, reason: "lock_no_owner" };
    const ownerTask = await prisma.novelWorkflowTask.findUnique({ where: { id: record.ownerId }, select: { status: true } });
    if (!ownerTask) return { released: false, reason: "owner_task_missing" };
    if (![ "failed", "succeeded", "cancelled" ].includes(ownerTask.status)) {
      return { released: false, reason: "owner_task_in_flight" };
    }
    const deleted = await prisma.appSetting.deleteMany({ where: { key: input.key, value: setting.value } });
    return deleted.count === 1 ? { released: true } : { released: false, reason: "lock_value_changed" };
  }
}


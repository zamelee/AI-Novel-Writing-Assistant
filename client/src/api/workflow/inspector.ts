import type { ApiResponse } from "@ai-novel/shared/types/api";
import { apiClient } from "../client";

export type OwnerTaskStatus = "unknown" | "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

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

export interface DirectorInspectorLocksResponse {
  locks: InspectorLockRow[];
  releasableCount: number;
}

export interface DirectorInspectorReleaseResponse {
  released: boolean;
  reason?: string;
}

export async function getDirectorInspectorSnapshot(novelId: string) {
  const { data } = await apiClient.get<ApiResponse<DirectorInspectorSnapshot>>(
    "/novel-workflows/novels/" + novelId + "/director/inspector",
  );
  return data;
}

export async function getDirectorInspectorLocks(novelId: string) {
  const { data } = await apiClient.get<ApiResponse<DirectorInspectorLocksResponse>>(
    "/novel-workflows/novels/" + novelId + "/director/locks",
  );
  return data;
}

export async function releaseDirectorInspectorLock(payload: { key: string; novelId: string; actorTaskId?: string; }) {
  const { data } = await apiClient.post<ApiResponse<DirectorInspectorReleaseResponse>>(
    "/novel-workflows/director/locks/release",
    { key: payload.key, novelId: payload.novelId, actorTaskId: payload.actorTaskId },
  );
  return data;
}

export async function triggerForesightAudit(payload: {
  directorTaskId: string;
  novelId?: string;
  volumeId?: string;
}) {
  const { data } = await apiClient.post<ApiResponse<{
    commandId: string;
    status: string;
    taskId: string;
    commandType: string;
    acceptedAt: string;
  }>>(
    "/novel-workflows/" + payload.directorTaskId + "/audit-foresight",
    { novelId: payload.novelId, volumeId: payload.volumeId },
  );
  return data;
}

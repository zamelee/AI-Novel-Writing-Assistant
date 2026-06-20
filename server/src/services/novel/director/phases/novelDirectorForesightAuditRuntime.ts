import type { NovelWorkflowService } from "../../workflow/NovelWorkflowService";
import { prisma } from "../../../../db/prisma";
import {
  mergeSeedPayload,
  parseSeedPayload,
} from "../../workflow/novelWorkflow.shared";

const FORESIGHT_AUDIT_STEP_TYPE = "audit_foresight_payoff";
const FORESIGHT_AUDIT_LIMIT = 50;

export interface NovelDirectorForesightAuditInput {
  novelId: string;
  volumeId?: string | null;
}

export interface NovelDirectorForesightAuditItem {
  id: string;
  ledgerKey: string;
  title: string;
  summary: string;
  currentStatus: "overdue" | "pending_payoff";
  scopeType: string;
  targetStartChapterOrder: number | null;
  targetEndChapterOrder: number | null;
  lastTouchedChapterOrder: number | null;
  setupChapterId: string | null;
  payoffChapterId: string | null;
  statusReason: string | null;
}

export interface NovelDirectorForesightAuditSnapshot {
  novelId: string;
  taskId: string;
  overdueCount: number;
  pendingCount: number;
  total: number;
  lastAuditAt: string;
  items: NovelDirectorForesightAuditItem[];
}

function buildForesightAuditItem(row: {
  id: string;
  ledgerKey: string;
  title: string;
  summary: string;
  currentStatus: string;
  scopeType: string;
  targetStartChapterOrder: number | null;
  targetEndChapterOrder: number | null;
  lastTouchedChapterOrder: number | null;
  setupChapterId: string | null;
  payoffChapterId: string | null;
  statusReason: string | null;
}): NovelDirectorForesightAuditItem {
  return {
    id: row.id,
    ledgerKey: row.ledgerKey,
    title: row.title,
    summary: row.summary,
    currentStatus: row.currentStatus === "overdue" ? "overdue" : "pending_payoff",
    scopeType: row.scopeType,
    targetStartChapterOrder: row.targetStartChapterOrder,
    targetEndChapterOrder: row.targetEndChapterOrder,
    lastTouchedChapterOrder: row.lastTouchedChapterOrder,
    setupChapterId: row.setupChapterId,
    payoffChapterId: row.payoffChapterId,
    statusReason: row.statusReason,
  };
}

function isForesightDebtStatus(value: string): value is "overdue" | "pending_payoff" {
  return value === "overdue" || value === "pending_payoff";
}

export class NovelDirectorForesightAuditRuntime {
  constructor(private readonly deps: {
    workflowService: NovelWorkflowService;
  }) {}

  async auditForesightPayoff(
    taskId: string,
    input?: { novelId?: string | null; volumeId?: string | null },
  ): Promise<NovelDirectorForesightAuditSnapshot> {
    const row = await this.deps.workflowService.getTaskById(taskId);
    if (!row) {
      throw new Error("当前自动导演任务不存在。");
    }
    const novelId = input?.novelId?.trim() || row.novelId || null;
    if (!novelId) {
      throw new Error("当前自动导演任务缺少 novelId，无法执行伏笔兑现审计。");
    }

    const rows = await prisma.payoffLedgerItem.findMany({
      where: {
        novelId,
        currentStatus: { in: ["overdue", "pending_payoff"] },
      },
      orderBy: [
        { currentStatus: "asc" },
        { updatedAt: "desc" },
      ],
      take: FORESIGHT_AUDIT_LIMIT,
      select: {
        id: true,
        ledgerKey: true,
        title: true,
        summary: true,
        currentStatus: true,
        scopeType: true,
        targetStartChapterOrder: true,
        targetEndChapterOrder: true,
        lastTouchedChapterOrder: true,
        setupChapterId: true,
        payoffChapterId: true,
        statusReason: true,
      },
    });

    const items = rows
      .filter((row) => isForesightDebtStatus(row.currentStatus))
      .map(buildForesightAuditItem);

    const overdueCount = items.filter((item) => item.currentStatus === "overdue").length;
    const pendingCount = items.filter((item) => item.currentStatus === "pending_payoff").length;

    const snapshot: NovelDirectorForesightAuditSnapshot = {
      novelId,
      taskId,
      overdueCount,
      pendingCount,
      total: items.length,
      lastAuditAt: new Date().toISOString(),
      items,
    };

    const seedRow = await prisma.novelWorkflowTask.findUnique({
      where: { id: taskId },
      select: { seedPayloadJson: true },
    }).catch(() => null);
    if (seedRow) {
      const current = parseSeedPayload<Record<string, unknown>>(seedRow.seedPayloadJson) ?? {};
      const existingResults = (current.directorCommandResults && typeof current.directorCommandResults === "object"
        ? current.directorCommandResults
        : {}) as Record<string, unknown>;
      const next = {
        foresightAudit: snapshot,
        directorCommandResults: {
          ...existingResults,
          [`foresightAudit:${snapshot.lastAuditAt}`]: {
            result: snapshot,
            completedAt: snapshot.lastAuditAt,
            stepType: FORESIGHT_AUDIT_STEP_TYPE,
          },
        },
      } as Record<string, unknown>;
      await prisma.novelWorkflowTask.update({
        where: { id: taskId },
        data: {
          seedPayloadJson: mergeSeedPayload(seedRow.seedPayloadJson, next),
          heartbeatAt: new Date(),
        },
      }).catch(() => null);
    }

    return snapshot;
  }
}

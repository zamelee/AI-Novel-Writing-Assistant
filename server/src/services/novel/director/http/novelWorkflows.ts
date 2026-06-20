import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { authMiddleware } from "../../../../middleware/auth";
import { validate } from "../../../../middleware/validate";
import { DirectorCommandService } from "../commands/DirectorCommandService";
import { NovelWorkflowService } from "../../workflow/NovelWorkflowService";
import { NovelWorkflowTaskAdapter } from "../../../task/adapters/NovelWorkflowTaskAdapter";
import { NovelVolumeService } from "../../volume/NovelVolumeService";
import { getChapterTitleDiversityIssue } from "../../volume/chapterTitleDiversity";
import { DirectorInspectorService } from "../runtime/DirectorInspectorService";

const router = Router();
const workflowService = new NovelWorkflowService();
const workflowAdapter = new NovelWorkflowTaskAdapter();
const directorCommandService = new DirectorCommandService(workflowService);

const stageSchema = z.enum([
  "project_setup",
  "auto_director",
  "story_macro",
  "character_setup",
  "volume_strategy",
  "structured_outline",
  "chapter_execution",
  "quality_repair",
]);

const checkpointSchema = z.enum([
  "candidate_selection_required",
  "book_contract_ready",
  "character_setup_required",
  "volume_strategy_ready",
  "chapter_batch_ready",
  "replan_required",
  "workflow_completed",
]);

const bootstrapSchema = z.object({
  workflowTaskId: z.string().trim().optional(),
  novelId: z.string().trim().optional(),
  lane: z.enum(["manual_create", "auto_director"]),
  title: z.string().trim().optional(),
  seedPayload: z.record(z.string(), z.unknown()).optional(),
});

const continueParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const continueBodySchema = z.object({
  continuationMode: z.enum(["resume", "auto_execute_range", "skip_quality_repair"]).optional(),
});

const repairChapterTitlesBodySchema = z.object({
  volumeId: z.string().trim().optional(),
});

const novelParamsSchema = z.object({
  novelId: z.string().trim().min(1),
});

const syncStageSchema = z.object({
  novelId: z.string().trim().min(1),
  stage: stageSchema,
  itemLabel: z.string().trim().min(1),
  itemKey: z.string().trim().optional(),
  checkpointType: checkpointSchema.nullish(),
  checkpointSummary: z.string().trim().optional(),
  chapterId: z.string().trim().optional(),
  volumeId: z.string().trim().optional(),
  progress: z.number().min(0).max(1).optional(),
  status: z.enum(["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"]).optional(),
});

router.use(authMiddleware);

router.post("/bootstrap", validate({ body: bootstrapSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof bootstrapSchema>;
    const row = await workflowService.bootstrapTask(body);
    const data = await workflowAdapter.detail(row.id);
    res.status(200).json({
      success: true,
      data,
      message: "Novel workflow ready.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/novels/:novelId/auto-director", validate({ params: novelParamsSchema }), async (req, res, next) => {
  try {
    const { novelId } = req.params as z.infer<typeof novelParamsSchema>;
    const row = await workflowService.findActiveTaskByNovelAndLane(novelId, "auto_director");
    const data = row ? await workflowAdapter.detail(row.id, { seedPayloadMode: "compact" }) : null;
    res.status(200).json({
      success: true,
      data,
      message: data ? "Active auto director task loaded." : "No active auto director task found.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/continue", validate({ params: continueParamsSchema, body: continueBodySchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof continueParamsSchema>;
    const body = req.body as z.infer<typeof continueBodySchema>;
    const data = body.continuationMode === "resume"
      ? await directorCommandService.enqueueApproveGateCommand(id, {
        continuationMode: body.continuationMode,
      })
      : await directorCommandService.enqueueContinueCommand(id, {
        continuationMode: body.continuationMode,
      });
    res.status(202).json({
      success: true,
      data,
      message: "Novel workflow continue accepted.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/repair-chapter-titles", validate({ params: continueParamsSchema, body: repairChapterTitlesBodySchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof continueParamsSchema>;
    const body = req.body as z.infer<typeof repairChapterTitlesBodySchema>;
    const data = await directorCommandService.enqueueChapterTitleRepairCommand(id, {
      volumeId: body.volumeId,
    });
    res.status(202).json({
      success: true,
      data,
      message: "Chapter title repair accepted.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

const auditForesightBodySchema = z.object({
  novelId: z.string().trim().min(1).optional(),
  volumeId: z.string().trim().min(1).optional(),
}).optional();

router.post("/:id/audit-foresight", validate({ params: continueParamsSchema, body: auditForesightBodySchema }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof continueParamsSchema>;
    const body = req.body as z.infer<typeof auditForesightBodySchema> | undefined;
    const data = await directorCommandService.enqueueForesightAuditCommand(id, {
      novelId: body?.novelId ?? null,
      volumeId: body?.volumeId ?? null,
    });
    res.status(202).json({
      success: true,
      data,
      message: "Foresight payoff audit accepted.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/sync-stage", validate({ body: syncStageSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof syncStageSchema>;
    const row = await workflowService.syncStageByNovelId(body.novelId, {
      stage: body.stage,
      itemLabel: body.itemLabel,
      itemKey: body.itemKey,
      checkpointType: body.checkpointType ?? null,
      checkpointSummary: body.checkpointSummary ?? null,
      chapterId: body.chapterId,
      volumeId: body.volumeId,
      progress: body.progress,
      status: body.status,
    });
    const data = await workflowAdapter.detail(row.id);
    res.status(200).json({
      success: true,
      data,
      message: "Novel workflow stage synced.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});


router.get("/novels/:novelId/auto-director/latest", validate({ params: novelParamsSchema }), async (req, res, next) => {
  try {
    const { novelId } = req.params as z.infer<typeof novelParamsSchema>;
    const row = await workflowService.findLatestVisibleTaskByNovelId(novelId, "auto_director");
    const data = row ? await workflowAdapter.detail(row.id, { seedPayloadMode: "compact" }) : null;
    res.status(200).json({
      success: true,
      data,
      message: data ? "Latest auto director task loaded." : "No auto director task found.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/novels/:novelId/chapter-titles/diversity-report", validate({ params: novelParamsSchema }), async (req, res, next) => {
  try {
    const { novelId } = req.params as z.infer<typeof novelParamsSchema>;
    const volumeService = new NovelVolumeService();
    const workspace = await volumeService.getVolumes(novelId);
    const issues = [];
    for (const volume of workspace.volumes ?? []) {
      const entries = (volume.chapters ?? [])
        .map((chapter) => ({ order: chapter.chapterOrder, title: chapter.title ?? "" }))
        .filter((entry) => entry.title && entry.title.trim().length > 0);
      const issue = getChapterTitleDiversityIssue(entries);
      if (!issue) continue;
      const chapterOrders = (issue.duplicate && issue.duplicate.orders) ? issue.duplicate.orders : entries.map((e) => e.order);
      const exampleTitles = issue.duplicate ? [issue.duplicate.title] : entries.slice(0, 3).map((e) => e.title);
      issues.push({
        type: issue.type,
        message: issue.message,
        volumeOrder: volume.sortOrder,
        volumeId: volume.id,
        chapterOrders,
        exampleTitles,
      });
    }
    const data = { hasIssue: issues.length > 0, issues };
    res.status(200).json({
      success: true,
      data,
      message: data.hasIssue ? "Chapter title diversity issues detected." : "No chapter title diversity issues.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

const inspectorService = new DirectorInspectorService();

router.get("/novels/:novelId/director/inspector", validate({ params: novelParamsSchema }), async (req, res, next) => {
  try {
    const { novelId } = req.params as z.infer<typeof novelParamsSchema>;
    const data = await inspectorService.getSnapshot(novelId);
    res.status(200).json({
      success: true,
      data,
      message: "Director runtime inspector snapshot loaded.",
    } satisfies ApiResponse<typeof data>);
  } catch (error) { next(error); }
});

router.get("/novels/:novelId/director/locks", validate({ params: novelParamsSchema }), async (req, res, next) => {
  try {
    const { novelId } = req.params as z.infer<typeof novelParamsSchema>;
    const snapshot = await inspectorService.getSnapshot(novelId);
    const data = { locks: snapshot.activeLocks, releasableCount: snapshot.counts.releasableLocks };
    res.status(200).json({ success: true, data, message: "Director runtime locks loaded." } satisfies ApiResponse<typeof data>);
  } catch (error) { next(error); }
});

// Lock key is base64url with dots; express path-to-regexp does not support :key(*) wildcards.
// Pass key in request body instead so the URL stays simple and the route stays unambiguous.
const releaseLockBodySchema = z.object({ key: z.string().trim().min(1), novelId: z.string().trim().min(1), actorTaskId: z.string().trim().optional() });
router.post("/director/locks/release", validate({ body: releaseLockBodySchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof releaseLockBodySchema>;
    const data = await inspectorService.releaseLock({ key: body.key, novelId: body.novelId, actorTaskId: body.actorTaskId ?? null });
    res.status(data.released ? 200 : 409).json({ success: data.released, data, message: data.released ? "Lock released." : "Lock release rejected: " + (data.reason ?? "unknown") } satisfies ApiResponse<typeof data>);
  } catch (error) { next(error); }
});
export default router;

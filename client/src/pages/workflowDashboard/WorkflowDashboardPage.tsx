import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { archiveTask, cancelTask, listTasks, retryTask } from "@/api/tasks";
import type { UnifiedTaskSummary } from "@ai-novel/shared/types/task";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import WorkflowCard, { type WorkflowCardAction } from "./components/WorkflowCard";
import DirectorInspectorPanel from "./components/DirectorInspectorPanel";
import { useWorkflowDashboardData } from "./hooks/useWorkflowDashboardData";

function SummaryStrip(props: {
  needsAttention: number;
  running: number;
  completedRecent: number;
  total: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>需要处理</CardDescription>
          <CardTitle className={props.needsAttention > 0 ? "text-2xl text-destructive" : "text-2xl"}>
            {props.needsAttention}
          </CardTitle>
          <div className="text-xs text-muted-foreground">失败或被取消的任务</div>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>进行中</CardDescription>
          <CardTitle className="text-2xl">{props.running}</CardTitle>
          <div className="text-xs text-muted-foreground">正在排队或运行的任务</div>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>最近 24h 完成</CardDescription>
          <CardTitle className="text-2xl">{props.completedRecent}</CardTitle>
          <div className="text-xs text-muted-foreground">自动完成的成功任务</div>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>任务总数</CardDescription>
          <CardTitle className="text-2xl">{props.total}</CardTitle>
          <div className="text-xs text-muted-foreground">当前可见的所有任务</div>
        </CardHeader>
      </Card>
    </div>
  );
}

function EmptyState({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
      <div>{label}</div>
      <div className="mt-1 text-xs">{hint}</div>
    </div>
  );
}

export default function WorkflowDashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { buckets, isPending, isError, refetch } = useWorkflowDashboardData();

  const cancelMutation = useMutation({
    mutationFn: (task: UnifiedTaskSummary) => cancelTask(task.kind, task.id),
    onSuccess: async () => {
      toast.success("任务取消请求已提交");
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "取消任务失败";
      toast.error(message);
    },
  });

  const retryMutation = useMutation({
    mutationFn: (task: UnifiedTaskSummary) =>
      retryTask(task.kind, task.id, { resume: task.kind === "novel_workflow" }),
    onSuccess: async () => {
      toast.success("任务已重新入队");
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "重试失败";
      toast.error(message);
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (task: UnifiedTaskSummary) => archiveTask(task.kind, task.id),
    onSuccess: async () => {
      toast.success("任务已归档");
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "归档失败";
      toast.error(message);
    },
  });


function extractNovelIdFromSourceRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  const m = new RegExp("^/novels/([^/]+)/").exec(route);
  return m && m[1] ? m[1] : null;
}
  const [inspectorFor, setInspectorFor] = useState<{ novelId: string; title: string } | null>(null);

  const buildActions = (task: UnifiedTaskSummary): WorkflowCardAction[] => {
    const actions: WorkflowCardAction[] = [];

    if (task.sourceRoute) {
      actions.push({
        label: "打开来源页面",
        variant: "default",
        onClick: () => navigate(task.sourceRoute),
      });
    }

    if (task.status === "failed" || task.status === "cancelled") {
      actions.push({
        label: retryMutation.isPending && retryMutation.variables?.id === task.id
          ? "重试中…"
          : "按任务原模型重试",
        variant: "outline",
        disabled: retryMutation.isPending,
        onClick: () => retryMutation.mutate(task),
      });
    }

    const cancellable = task.status === "queued"
      || task.status === "running"
      || task.status === "waiting_approval"
      || task.status === "failed"
      || task.status === "cancelled";
    if (cancellable) {
      actions.push({
        label: cancelMutation.isPending && cancelMutation.variables?.id === task.id
          ? "取消中…"
          : "取消",
        variant: "outline",
        disabled: cancelMutation.isPending,
        onClick: () => cancelMutation.mutate(task),
      });
    }

    if (task.status === "succeeded" || task.status === "cancelled" || task.status === "failed") {
      actions.push({
        label: archiveMutation.isPending && archiveMutation.variables?.id === task.id
          ? "归档中…"
          : "归档",
        variant: "outline",
        disabled: archiveMutation.isPending,
        onClick: () => archiveMutation.mutate(task),
      });
    }

    return actions;
  };

  const renderTaskList = (items: UnifiedTaskSummary[], emptyLabel: string, emptyHint: string) => {
    if (items.length === 0) {
      return <EmptyState label={emptyLabel} hint={emptyHint} />;
    }
    return (
      <div className="space-y-3">
        {items.map((task) => (
          <WorkflowCard
            key={`${task.kind}-${task.id}`}
            task={task}
            actions={buildActions(task)}
            highlight={task.status === "failed"}
            inspectorOpen={inspectorFor?.novelId === extractNovelIdFromSourceRoute(task.sourceRoute)}
            onToggleInspector={() => {
              const nid = extractNovelIdFromSourceRoute(task.sourceRoute);
              if (!nid) return;
              setInspectorFor((cur) => cur && cur.novelId === nid ? null : { novelId: nid, title: task.title });
            }}
          />
        ))}
      </div>
    );
  };

  const sectionTitle = useMemo(() => {
    const parts: string[] = [];
    if (buckets.totals.needsAttention > 0) {
      parts.push(`需要处理 ${buckets.totals.needsAttention}`);
    }
    if (buckets.totals.running > 0) {
      parts.push(`进行中 ${buckets.totals.running}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "全部清空";
  }, [buckets.totals]);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">工作流水牌</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            一屏看完需要处理的任务、正在跑的任务和最近完成的进度，按"是否需要你动手"分组。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={buckets.totals.needsAttention > 0 ? "destructive" : "outline"}>
            {sectionTitle}
          </Badge>
          <Button asChild variant="outline" size="sm">
            <Link to="/tasks">完整任务列表</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/auto-director/follow-ups">导演跟进</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            刷新
          </Button>
        </div>
      </div>

      <SummaryStrip
        needsAttention={buckets.totals.needsAttention}
        running={buckets.totals.running}
        completedRecent={buckets.totals.completedRecent}
        total={buckets.totals.total}
      />

      {inspectorFor ? (
        <DirectorInspectorPanel
          novelId={inspectorFor.novelId}
          novelTitle={inspectorFor.title}
          onClose={() => setInspectorFor(null)}
        />
      ) : null}

            {isError ? (
        <Card>
          <CardHeader>
            <CardTitle>无法读取任务</CardTitle>
            <CardDescription>请检查后端是否运行正常，或点击刷新重试。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void refetch()}>重新加载</Button>
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">需要处理</h2>
          <span className="text-xs text-muted-foreground">失败和取消的任务优先在这里</span>
        </div>
        {isPending
          ? <EmptyState label="加载中…" hint="正在读取任务列表" />
          : renderTaskList(
              buckets.needsAttention,
              "当前没有需要处理的任务",
              "可以继续下一本书或查看进行中的任务",
            )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">进行中</h2>
          <span className="text-xs text-muted-foreground">后台排队或运行中的任务</span>
        </div>
        {isPending
          ? <EmptyState label="加载中…" hint="正在读取任务列表" />
          : renderTaskList(
              buckets.running,
              "当前没有运行中的任务",
              "需要新的章节或自动推进时再启动",
            )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">最近 24h 完成</h2>
          <span className="text-xs text-muted-foreground">成功后默认保留在这里</span>
        </div>
        {isPending
          ? <EmptyState label="加载中…" hint="正在读取任务列表" />
          : renderTaskList(
              buckets.completedRecent,
              "最近 24h 内没有完成的任务",
              "可以归档已完成任务，把列表清理干净",
            )}
      </section>
    </div>
  );
}

// Hint to tree-shakers: keep the helper exported for future use without flagging dead code.
export const __workflowDashboardHelpers = { listTasks };

import type { UnifiedTaskSummary } from "@ai-novel/shared/types/task";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  failed: { label: "失败", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
  queued: { label: "排队中", variant: "secondary" },
  running: { label: "运行中", variant: "default" },
  waiting_approval: { label: "等待你处理", variant: "secondary" },
  succeeded: { label: "已完成", variant: "outline" },
  archived: { label: "已归档", variant: "outline" },
};

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) {
    return "未知时间";
  }
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) {
    return "未知时间";
  }
  const deltaMs = Date.now() - target;
  if (deltaMs < 0) {
    return "刚刚";
  }
  const minutes = Math.floor(deltaMs / (60 * 1000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return `${months} 个月前`;
}

export interface WorkflowCardAction {
  label: string;
  onClick: () => void;
  variant?: "default" | "outline" | "destructive" | "secondary";
  disabled?: boolean;
}

export interface WorkflowCardProps {
  task: UnifiedTaskSummary;
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  actions?: WorkflowCardAction[];
  highlight?: boolean;
}

export default function WorkflowCard({ task, actions = [], highlight = false, inspectorOpen, onToggleInspector }: WorkflowCardProps) {
  const statusInfo = STATUS_LABEL[task.status] ?? { label: task.status, variant: "outline" as const };
  const blockingReason = task.blockingReason?.trim() || task.failureSummary?.trim() || null;
  const stage = task.currentStage?.trim() || task.currentItemKey?.trim() || null;
  const lastUpdateLabel = formatRelativeTime(task.updatedAt);

  return (
    <div
      className={cn(
        "rounded-xl border p-4 transition-colors",
        highlight
          ? "border-destructive/40 bg-destructive/5 shadow-sm"
          : "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
            {stage ? (
              <span className="text-xs text-muted-foreground">{stage}</span>
            ) : null}
          </div>
          <div className="text-base font-medium leading-tight">{task.title}</div>
          {task.currentItemLabel ? (
            <div className="text-sm text-muted-foreground line-clamp-2">
              {task.currentItemLabel}
            </div>
          ) : null}
          {blockingReason ? (
            <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
              {blockingReason}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
          <span>更新 {lastUpdateLabel}</span>
          {task.kind === "novel_workflow" ? (
            <span className="text-[10px] uppercase tracking-wide">auto_director</span>
          ) : (
            <span className="text-[10px] uppercase tracking-wide">{task.kind}</span>
          )}
        </div>
      </div>
      {(actions.length > 0 || onToggleInspector) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action, index) => (
            <Button
              key={`${task.id}-${index}`}
              size="sm"
              variant={action.variant ?? "outline"}
              onClick={action.onClick}
              disabled={action.disabled}
            >
              {action.label}
            </Button>
          ))}
          {onToggleInspector ? (
            <Button
              size="sm"
              variant={inspectorOpen ? "default" : "outline"}
              onClick={onToggleInspector}
            >
              {inspectorOpen ? "隐藏 Runtime 详情" : "Runtime 详情"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

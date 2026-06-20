import { useQuery } from "@tanstack/react-query";
import { listTasks } from "@/api/tasks";
import { queryKeys } from "@/api/queryKeys";
import type { UnifiedTaskSummary } from "@ai-novel/shared/types/task";

export interface WorkflowDashboardBuckets {
  needsAttention: UnifiedTaskSummary[];
  running: UnifiedTaskSummary[];
  completedRecent: UnifiedTaskSummary[];
  others: UnifiedTaskSummary[];
  totals: {
    needsAttention: number;
    running: number;
    completedRecent: number;
    total: number;
  };
}

const ACTIVE_STATUSES = new Set<string>(["queued", "running", "waiting_approval"]);
const NEEDS_ATTENTION_STATUSES = new Set<string>(["failed", "cancelled"]);
const RUNNING_STATUSES = new Set<string>(["queued", "running", "waiting_approval"]);

function bucketTasks(items: UnifiedTaskSummary[]): WorkflowDashboardBuckets {
  const now = Date.now();
  const needsAttention: UnifiedTaskSummary[] = [];
  const running: UnifiedTaskSummary[] = [];
  const completedRecent: UnifiedTaskSummary[] = [];
  const others: UnifiedTaskSummary[] = [];

  for (const item of items) {
    if (NEEDS_ATTENTION_STATUSES.has(item.status)) {
      needsAttention.push(item);
      continue;
    }
    if (RUNNING_STATUSES.has(item.status)) {
      running.push(item);
      continue;
    }
    if (item.status === "succeeded") {
      const updatedAt = new Date(item.updatedAt).getTime();
      if (!Number.isNaN(updatedAt) && now - updatedAt <= 24 * 60 * 60 * 1000) {
        completedRecent.push(item);
        continue;
      }
    }
    others.push(item);
  }

  // Sắp xếp: needs-attention theo updatedAt desc, running theo heartbeat desc, completed theo updatedAt desc.
  needsAttention.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  running.sort((a, b) => {
    const aTime = a.heartbeatAt ? new Date(a.heartbeatAt).getTime() : new Date(a.updatedAt).getTime();
    const bTime = b.heartbeatAt ? new Date(b.heartbeatAt).getTime() : new Date(b.updatedAt).getTime();
    return bTime - aTime;
  });
  completedRecent.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return {
    needsAttention,
    running,
    completedRecent,
    others,
    totals: {
      needsAttention: needsAttention.length,
      running: running.length,
      completedRecent: completedRecent.length,
      total: items.length,
    },
  };
}

export function useWorkflowDashboardData() {
  const query = useQuery({
    queryKey: queryKeys.tasks.list("workflow-dashboard"),
    queryFn: () => listTasks({ limit: 80 }),
    refetchInterval: (current) => {
      const items = current.state.data?.data?.items ?? [];
      const hasActive = items.some((item) => ACTIVE_STATUSES.has(item.status));
      return hasActive ? 4000 : false;
    },
  });

  const buckets = bucketTasks(query.data?.data?.items ?? []);
  return {
    ...query,
    buckets,
  };
}

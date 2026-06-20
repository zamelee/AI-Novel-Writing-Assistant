import type { DirectorTaskNotice } from "@ai-novel/shared/types/novelDirector";
import {
  formatChapterTitleDiversitySummary,
  isChapterTitleDiversityStructuredIssue,
  type ChapterTitleDiversityIssue,
} from "../../volume/chapterTitleDiversity";

export function buildChapterTitleDiversityTaskNotice(input: {
  issue: string | ChapterTitleDiversityIssue;
  volumeId?: string | null;
}): DirectorTaskNotice {
  const summary = isChapterTitleDiversityStructuredIssue(input.issue)
    ? formatChapterTitleDiversitySummary(input.issue)
    : input.issue.trim();
  return {
    code: "CHAPTER_TITLE_DIVERSITY",
    summary,
    action: {
      type: "open_structured_outline",
      label: "快速修复章节标题",
      volumeId: input.volumeId?.trim() || null,
    },
  };
}

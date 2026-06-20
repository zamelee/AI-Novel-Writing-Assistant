export type ChapterTitleSurfaceFrame =
  | "of_phrase"
  | "colon_split"
  | "comma_split"
  | "question_hook"
  | "plain_statement";

export type ChapterTitleDiversityIssueType =
  | "duplicate"
  | "frame_cluster"
  | "of_phrase_overuse"
  | "basic_quality";

export interface ChapterTitleDiversityEntry {
  order: number;
  title: string;
}

export interface ChapterTitleDiversityIssue {
  type: ChapterTitleDiversityIssueType;
  message: string;
  duplicate?: {
    title: string;
    orders: number[];
  };
}

const ENABLE_CHAPTER_TITLE_DIVERSITY_VALIDATION = true;
const CHAPTER_TITLE_OF_PHRASE_PATTERN = /^[^，,：:？?的\s]{1,18}的[^，,：:？?的\s]{1,18}$/u;
const CHAPTER_TITLE_MAX_CORE_CHARS = 16;
const CHAPTER_TITLE_SOFT_SENTENCE_CHARS = 12;
const CHAPTER_TITLE_FIRST_PERSON_PATTERN =
  /(^|[，,：:？?！!、\s])我|我的|我们|替我|为我|给我|把我|追杀我|杀我|救我|我[亲也却已又将把用拿看暗]/u;

function normalizeChapterTitle(title: string): string {
  return title
    .replace(/^["'“”‘’《》〈〉「」『』【】]+|["'“”‘’《》〈〉「」『』【】]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,/g, "，")
    .replace(/:/g, "：")
    .replace(/\?/g, "？");
}

function countChapterTitleCoreChars(title: string): number {
  return Array.from(normalizeChapterTitle(title))
    .filter((char) => !/[，,：:？?！!、；;·\s"'“”‘’《》〈〉「」『』【】]/u.test(char))
    .length;
}

function getChapterTitleBasicQualityIssue(title: string): string | null {
  const normalized = normalizeChapterTitle(title);
  if (!normalized) {
    return "章节标题不能为空。";
  }

  if (CHAPTER_TITLE_FIRST_PERSON_PATTERN.test(normalized)) {
    return `章节标题不应使用第一人称或口号式主角自述：${normalized}。请改成客观章名，例如事件、地点、冲突、异动或结果。`;
  }

  const coreCharCount = countChapterTitleCoreChars(normalized);
  if (coreCharCount > CHAPTER_TITLE_MAX_CORE_CHARS) {
    return `章节标题过长：${normalized}。请压缩到 ${CHAPTER_TITLE_MAX_CORE_CHARS} 个核心字以内，避免写成剧情梗概。`;
  }

  if (
    coreCharCount > CHAPTER_TITLE_SOFT_SENTENCE_CHARS
    && /[，,]/u.test(normalized)
    && /但|却|可|于是|因此|同时|然后/u.test(normalized)
  ) {
    return `章节标题像剧情梗概：${normalized}。请改成更短的章节名，不要把完整因果句写进标题。`;
  }

  return null;
}

export function detectChapterTitleSurfaceFrame(title: string): ChapterTitleSurfaceFrame {
  const normalized = normalizeChapterTitle(title);
  if (!normalized) {
    return "plain_statement";
  }
  if (normalized.includes("：")) {
    return "colon_split";
  }
  if (normalized.includes("，")) {
    return "comma_split";
  }
  if (normalized.includes("？")) {
    return "question_hook";
  }
  if (CHAPTER_TITLE_OF_PHRASE_PATTERN.test(normalized)) {
    return "of_phrase";
  }
  return "plain_statement";
}

function maximumOfPhraseCount(titleCount: number): number {
  return Math.max(1, Math.ceil(Math.max(titleCount, 1) * 0.3));
}

function maximumSingleFrameCount(titleCount: number): number {
  return Math.max(2, Math.ceil(Math.max(titleCount, 1) * 0.5));
}

function formatFrameLabel(frame: ChapterTitleSurfaceFrame): string {
  if (frame === "of_phrase") {
    return "“X的Y / X中的Y”";
  }
  if (frame === "comma_split") {
    return "“A，B / 四字动作，四字结果”";
  }
  if (frame === "colon_split") {
    return "“A：B”";
  }
  if (frame === "question_hook") {
    return "“问题钩子型”";
  }
  return "“平铺直述型”";
}

export function getChapterTitleDiversityIssue(
  entries: ChapterTitleDiversityEntry[],
): ChapterTitleDiversityIssue | null {
  if (!ENABLE_CHAPTER_TITLE_DIVERSITY_VALIDATION) {
    return null;
  }

  // Build order index per normalized title (so duplicate detection can report all positions).
  const ordersByNormalizedTitle = new Map<string, number[]>();
  for (const entry of entries) {
    const normalized = normalizeChapterTitle(entry.title);
    if (!normalized) continue;
    const list = ordersByNormalizedTitle.get(normalized) ?? [];
    list.push(entry.order);
    ordersByNormalizedTitle.set(normalized, list);
  }

  // Basic quality check: per entry, first failing wins.
  for (const entry of entries) {
    if (!entry.title) continue;
    const basicQualityIssue = getChapterTitleBasicQualityIssue(entry.title);
    if (basicQualityIssue) {
      return { type: "basic_quality", message: basicQualityIssue };
    }
  }

  const validNormalizedTitles = Array.from(ordersByNormalizedTitle.keys());
  if (validNormalizedTitles.length <= 1) {
    return null;
  }

  const seenTitles = new Set<string>();
  const ofPhraseExamples: string[] = [];
  const frameCounts = new Map<ChapterTitleSurfaceFrame, number>();
  const frameExamples = new Map<ChapterTitleSurfaceFrame, string[]>();
  let previousFrame: ChapterTitleSurfaceFrame | null = null;
  let currentFrameClusterCount = 0;
  let maxFrameClusterCount = 0;
  let dominantClusterFrame: ChapterTitleSurfaceFrame | null = null;

  for (const entry of entries) {
    const title = normalizeChapterTitle(entry.title);
    if (!title) continue;
    if (seenTitles.has(title)) {
      return buildDuplicateIssue(ordersByNormalizedTitle, title, entry.title);
    }
    seenTitles.add(title);

    const frame = detectChapterTitleSurfaceFrame(title);
    frameCounts.set(frame, (frameCounts.get(frame) ?? 0) + 1);
    const examples = frameExamples.get(frame) ?? [];
    if (examples.length < 3) {
      examples.push(title);
      frameExamples.set(frame, examples);
    }

    if (frame === "of_phrase") {
      if (ofPhraseExamples.length < 3) {
        ofPhraseExamples.push(title);
      }
    }

    if (frame === previousFrame) {
      currentFrameClusterCount += 1;
    } else {
      currentFrameClusterCount = 1;
      previousFrame = frame;
    }
    if (currentFrameClusterCount > maxFrameClusterCount) {
      maxFrameClusterCount = currentFrameClusterCount;
      dominantClusterFrame = frame;
    }
  }

  const ofPhraseCount = frameCounts.get("of_phrase") ?? 0;
  const maxAllowedOfPhraseCount = maximumOfPhraseCount(validNormalizedTitles.length);
  if (ofPhraseCount > maxAllowedOfPhraseCount) {
    return {
      type: "of_phrase_overuse",
      message: [
        `章节标题结构过于集中：${ofPhraseCount}/${validNormalizedTitles.length} 个标题使用了“X的Y / X中的Y”式结构。`,
        ofPhraseExamples.length > 0 ? `重复骨架示例：${ofPhraseExamples.join("、")}。` : "",
        "请降低这类标题占比，改用动作推进型、冲突压迫型、异常发现型、结果兑现型等不同章名。",
      ].filter(Boolean).join(""),
    };
  }

  let dominantFrame: ChapterTitleSurfaceFrame = "plain_statement";
  let dominantFrameCount = 0;
  for (const [frame, count] of frameCounts.entries()) {
    if (count > dominantFrameCount) {
      dominantFrame = frame;
      dominantFrameCount = count;
    }
  }

  const maxAllowedSingleFrameCount = maximumSingleFrameCount(validNormalizedTitles.length);
  if (dominantFrame !== "plain_statement" && dominantFrameCount > maxAllowedSingleFrameCount) {
    const examples = frameExamples.get(dominantFrame) ?? [];
    return {
      type: "frame_cluster",
      message: [
        `章节标题结构过于集中：${dominantFrameCount}/${validNormalizedTitles.length} 个标题都落在 ${formatFrameLabel(dominantFrame)} 骨架上。`,
        examples.length > 0 ? `重复骨架示例：${examples.join("、")}。` : "",
        "请把标题改得更分散，混用动作推进型、冲突压迫型、异常发现型、结果兑现型、决断转向型等不同句法。",
      ].filter(Boolean).join(""),
    };
  }

  if (maxFrameClusterCount > 3 && dominantClusterFrame && dominantClusterFrame !== "plain_statement") {
    return {
      type: "frame_cluster",
      message: `相邻章节标题结构过于重复：连续 ${maxFrameClusterCount} 个标题都在使用 ${formatFrameLabel(dominantClusterFrame)} 骨架。请把相邻章名改成不同句法。`,
    };
  }

  return null;
}


export function isChapterTitleDiversityIssue(message: string | null | undefined): boolean {
  if (!ENABLE_CHAPTER_TITLE_DIVERSITY_VALIDATION) {
    return false;
  }
  const normalized = message?.trim();
  if (!normalized) {
    return false;
  }
  return normalized.includes("章节标题结构过于集中")
    || normalized.includes("相邻章节标题结构过于重复")
    || normalized.includes("章节标题出现重复")
    || normalized.includes("章节标题不应使用第一人称")
    || normalized.includes("章节标题过长")
    || normalized.includes("章节标题像剧情梗概");
}

export function isBlockingChapterTitleQualityIssue(message: string | null | undefined): boolean {
  const normalized = message?.trim();
  if (!normalized) {
    return false;
  }
  return normalized.includes("章节标题不应使用第一人称")
    || normalized.includes("章节标题过长")
    || normalized.includes("章节标题像剧情梗概");
}

export function assertChapterTitleDiversity(entries: ChapterTitleDiversityEntry[]): void {
  const issue = getChapterTitleDiversityIssue(entries);
  if (issue) {
    throw new Error(issue.message);
  }
}

function buildDuplicateIssue(
  ordersByNormalizedTitle: Map<string, number[]>,
  normalizedTitle: string,
  originalTitle: string,
): ChapterTitleDiversityIssue {
  const orders = (ordersByNormalizedTitle.get(normalizedTitle) ?? [])
    .slice()
    .sort((a, b) => a - b);
  const orderList = orders.map((o) => `${o} 章`).join("、");
  return {
    type: "duplicate",
    message: `章节标题出现重复："${normalizedTitle}"，出现在第 ${orderList}。请确保每章标题唯一。`,
    duplicate: {
      title: originalTitle.trim(),
      orders,
    },
  };
}

export function formatChapterTitleDiversitySummary(issue: ChapterTitleDiversityIssue): string {
  return issue.message;
}

export function isChapterTitleDiversityStructuredIssue(
  value: unknown,
): value is ChapterTitleDiversityIssue {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; message?: unknown };
  return typeof candidate.type === "string" && typeof candidate.message === "string";
}

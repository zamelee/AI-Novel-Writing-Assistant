/**
 * Novel numbering service.
 *
 * Allocates short human-readable identifiers in the format YYYY-MM-NNN, where
 * YYYY-MM is the calendar month of the novel creation and NNN is a zero-padded
 * 3-digit counter that resets every month. Numbers are append-only — once a
 * number is assigned to a novel it is never reused, even if the novel is
 * deleted.
 *
 * Allocation flow:
 *   1. Compute the target month bucket from the desired timestamp.
 *   2. Query the largest existing NNN in that bucket.
 *   3. Return next number (max + 1, padded).
 *   4. The caller is responsible for inserting and retrying on unique
 *      constraint violation (P2002). This service is pure.
 */

const PAD_WIDTH = 3;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export interface NovelNumberContext {
  now?: Date;
}

export interface ParsedNovelNumber {
  year: number;
  month: number;
  sequence: number;
}

export function formatMonthBucket(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function formatSequence(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`sequence must be a positive integer, got ${sequence}`);
  }
  return String(sequence).padStart(PAD_WIDTH, "0");
}

export function composeNovelNumber(date: Date, sequence: number): string {
  return `${formatMonthBucket(date)}-${formatSequence(sequence)}`;
}

const NUMBER_PATTERN = /^(\d{4})-(\d{2})-(\d{3})$/;

export function parseNovelNumber(value: string): ParsedNovelNumber | null {
  const m = NUMBER_PATTERN.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const sequence = Number(m[3]);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    return null;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) {
    return null;
  }
  return { year, month, sequence };
}

export function isValidNovelNumber(value: string): boolean {
  return parseNovelNumber(value) !== null;
}

/**
 * Choose the next sequence number for the given month bucket.
 *   existingMax = 0 means no existing numbers in this bucket.
 */
export function nextSequence(existingMax: number): number {
  return Math.max(1, existingMax + 1);
}

export interface AllocationResult {
  novelNumber: string;
  bucket: string;
  sequence: number;
}

export interface NovelNumberExistingProbe {
  /** Returns the largest existing novelNumber matching the bucket, or null. */
  findMaxForBucket(bucket: string): Promise<string | null>;
}

/**
 * Probe-driven allocator: queries for the current max in the bucket and
 * composes the next number. Does NOT write. Caller is expected to insert
 * and retry on unique constraint violation.
 */
export async function allocateNovelNumber(
  probe: NovelNumberExistingProbe,
  ctx: NovelNumberContext = {},
): Promise<AllocationResult> {
  const now = ctx.now ?? new Date();
  const bucket = formatMonthBucket(now);
  const max = await probe.findMaxForBucket(bucket);
  let next = 1;
  if (max) {
    const parsed = parseNovelNumber(max);
    if (parsed) {
      next = parsed.sequence + 1;
    }
  }
  return {
    novelNumber: composeNovelNumber(now, next),
    bucket,
    sequence: next,
  };
}

/**
 * Backfill helper: given a list of existing novelNumbers for a single month
 * bucket (sorted ascending by sequence), find any gaps that could be reused.
 * Returns the next available sequence assuming gaps are fillable.
 *
 * Backfill policy: numbers are append-only. We never reuse gaps. This helper
 * exists to surface gaps in diagnostics, not to recommend filling them.
 */
export function detectGaps(existingNumbers: string[]): number[] {
  const sequences = existingNumbers
    .map((n) => parseNovelNumber(n))
    .filter((p): p is ParsedNovelNumber => p !== null)
    .map((p) => p.sequence)
    .sort((a, b) => a - b);
  if (sequences.length === 0) return [];
  const gaps: number[] = [];
  for (let i = 1; i < sequences.length; i += 1) {
    const expected = sequences[i - 1] + 1;
    if (sequences[i] !== expected) {
      for (let g = expected; g < sequences[i]; g += 1) {
        gaps.push(g);
      }
    }
  }
  return gaps;
}

export const __testing = {
  formatMonthBucket,
  formatSequence,
  composeNovelNumber,
  parseNovelNumber,
  nextSequence,
  detectGaps,
};

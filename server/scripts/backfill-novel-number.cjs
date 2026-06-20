#!/usr/bin/env node
/**
 * Backfill novelNumber for existing novels.
 *
 * Default mode is DRY-RUN: prints the proposed assignments without writing.
 * Use --commit to actually write to the database.
 *
 * Strategy:
 *   - Select novels with null novelNumber, ordered by createdAt ASC.
 *   - Group by month of createdAt.
 *   - Within each month, assign sequences 001, 002, ... in chronological order.
 *   - Numbers are append-only. If a novel already has novelNumber, skip it.
 *
 * Usage:
 *   node scripts/backfill-novel-number.cjs            # dry-run
 *   node scripts/backfill-novel-number.cjs --commit   # actually write
 */

const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
const { PrismaPg } = require("@prisma/adapter-pg");

function resolveDb() {
  const url = process.env.DATABASE_URL || "file:./src/prisma/dev.db";
  if (url.startsWith("file:")) {
    const filePath = url.slice("file:".length) || "./dev.db";
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    return new PrismaBetterSqlite3({ url: `file:${absolute}`, timeout: 15000 });
  }
  return new PrismaPg({ connectionString: url });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    commit: args.includes("--commit"),
    limit: (() => {
      const idx = args.indexOf("--limit");
      if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
      return Infinity;
    })(),
  };
}

function monthBucket(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatSequence(n) {
  return String(n).padStart(3, "0");
}

function composeNumber(d, seq) {
  return `${monthBucket(d)}-${formatSequence(seq)}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient({ adapter: resolveDb() });
  try {
    const novels = await prisma.novel.findMany({
      where: { novelNumber: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, novelNumber: true, createdAt: true },
    });

    if (novels.length === 0) {
      console.log("No novels need backfilling.");
      return;
    }

    // Detect collisions with EXISTING numbers in the same buckets
    const allWithNumbers = await prisma.novel.findMany({
      where: { novelNumber: { not: null } },
      select: { novelNumber: true },
    });
    const taken = new Set();
    for (const r of allWithNumbers) {
      if (r.novelNumber) taken.add(r.novelNumber);
    }

    // Group unnumbered novels by month bucket
    const byBucket = new Map();
    for (const n of novels) {
      if (!n.createdAt) continue;
      const bucket = monthBucket(n.createdAt);
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(n);
    }

    const assignments = [];
    let conflicts = 0;
    for (const [bucket, list] of byBucket.entries()) {
      let seq = 1;
      for (const n of list) {
        if (args.limit !== Infinity && assignments.length >= args.limit) break;
        let candidate = composeNumber(n.createdAt, seq);
        // Skip already-taken numbers (defensive against edge cases)
        while (taken.has(candidate)) {
          conflicts += 1;
          seq += 1;
          candidate = composeNumber(n.createdAt, seq);
        }
        assignments.push({
          id: n.id,
          title: n.title,
          createdAt: n.createdAt,
          bucket,
          oldNovelNumber: n.novelNumber,
          newNovelNumber: candidate,
        });
        taken.add(candidate);
        seq += 1;
      }
    }

    console.log(`--- Backfill Plan (${args.commit ? "COMMIT" : "DRY-RUN"}) ---`);
    console.log(`Total novels to assign: ${assignments.length}`);
    console.log(`Existing numbers in DB: ${taken.size - new Set(assignments.map((a) => a.newNovelNumber)).size}`);
    if (conflicts > 0) {
      console.log(`Note: ${conflicts} sequence collisions detected and skipped`);
    }
    console.log();
    for (const a of assignments) {
      const flag = a.oldNovelNumber ? "REPLACE" : "ASSIGN";
      console.log(`  [${flag}] ${a.id}  ${a.bucket}  ${a.newNovelNumber}  ${a.title.slice(0, 30)}`);
    }
    console.log();

    if (!args.commit) {
      console.log("Dry-run complete. Re-run with --commit to apply.");
      return;
    }

    let written = 0;
    for (const a of assignments) {
      await prisma.novel.update({
        where: { id: a.id },
        data: { novelNumber: a.newNovelNumber },
      });
      written += 1;
    }
    console.log(`Committed ${written} assignments.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

import { chromium, type Page } from "playwright";
import { writeFileSync } from "fs";

const DATA_DIR = "./.chrome-data";
const CONCURRENCY = 3;
const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://amazon:password@localhost:5433/amazon_crawler";

// ASINs from CLI args
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun run index.ts <ASIN1> [ASIN2] ...");
  process.exit(1);
}
const TARGET_ASINS = args;

// --- CSV parsing ---

interface ScrapedRow {
  rank: number;
  keyword: string;
  search_volume: string | null;
  search_volume_trend: string | null;
  traffic_share: string | null;
  ranking_position: string | null;
  difficulty: string | null;
  click_rate: string | null;
  conversion_rate: string | null;
  extra_data: Record<string, string | null>;
}

function parseCsvLine(line: string): ScrapedRow | null {
  // Custom CSV parser handling quoted fields with commas
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());

  // Skip if too few fields or no keyword
  if (fields.length < 2 || !fields[1]) return null;

  // Col 3: "340,592 -13.26%" -> volume + trend
  const svParts = (fields[2] || "").split(" ");
  const search_volume = svParts[0] || null;
  const search_volume_trend = svParts[1] || null;

  return {
    rank: parseInt(fields[0], 10) || 0,
    keyword: fields[1],
    search_volume,
    search_volume_trend,
    traffic_share: fields[3] || null,
    ranking_position: fields[7] || null,
    difficulty: fields[13] || null,
    click_rate: fields[15] || null,
    conversion_rate: fields[16] || null,
    extra_data: {
      click_share: fields[4] || null,
      organic_sponsored_split: fields[5] || null,
      traffic_sources_raw: fields[6] || null,
      prev_organic_rank: fields[8] || null,
      reviews_count: fields[9] || null,
      competitor_keywords: fields[10] || null,
      bid_range: fields[11] || null,
      difficulty_pct: fields[12] || null,
      recommendation: fields[14] || null,
      funnel_raw: fields[17] || null,
    },
  };
}

// --- PostgreSQL write using Bun.sql ---

async function saveToDb(
  asin: string,
  csvData: string,
): Promise<number> {
  const { SQL } = await import("bun");
  const db = new SQL(DB_URL);

  const lines = csvData
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  if (lines.length === 0) return 0;

  let count = 0;
  try {
    await db.begin(async (tx) => {
      for (const line of lines) {
        const row = parseCsvLine(line);
        if (!row) continue;

        const scrapedAt = new Date().toISOString();
        await tx`
          INSERT INTO keywords (asin, keyword, rank, search_volume,
            search_volume_trend, traffic_share, difficulty, ranking_position,
            click_rate, conversion_rate, extra_data, scraped_at)
          VALUES (
            ${asin}, ${row.keyword}, ${row.rank}, ${row.search_volume},
            ${row.search_volume_trend}, ${row.traffic_share}, ${row.difficulty},
            ${row.ranking_position}, ${row.click_rate}, ${row.conversion_rate},
            ${JSON.stringify(row.extra_data)}::jsonb,
            ${scrapedAt}::timestamptz
          )
          ON CONFLICT (asin, keyword)
          DO UPDATE SET
            rank = EXCLUDED.rank,
            search_volume = EXCLUDED.search_volume,
            search_volume_trend = EXCLUDED.search_volume_trend,
            traffic_share = EXCLUDED.traffic_share,
            difficulty = EXCLUDED.difficulty,
            ranking_position = EXCLUDED.ranking_position,
            click_rate = EXCLUDED.click_rate,
            conversion_rate = EXCLUDED.conversion_rate,
            extra_data = EXCLUDED.extra_data,
            scraped_at = EXCLUDED.scraped_at
        `;
        count++;
      }
    });
  } finally {
    db.close();
  }
  return count;
}

// --- Single ASIN scraping logic ---

async function extractTableData(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(
      'table tbody tr, .el-table__body-wrapper tr, .x-table-body tr',
    );
    if (rows.length === 0) return "";

    const lines: string[] = [];
    for (const row of rows) {
      const cells = row.querySelectorAll("td, .cell");
      if (cells.length === 0) continue;
      const texts = Array.from(cells)
        .map((c) => c.textContent?.trim() ?? "")
        .filter(Boolean);
      if (texts.length > 0) {
        lines.push(
          texts.map((t) => `"${t.replace(/"/g, '""')}"`).join(","),
        );
      }
    }
    return lines.join("\n");
  });
}

async function scrapeAsin(
  page: Page,
  asin: string,
): Promise<string | null> {
  try {
    await page.goto("https://www.xiyouzhaoci.com/asin");
    console.log(`[${asin}] Page loaded: ${await page.title()}`);
    await page.waitForTimeout(5000);

    const asinInput = page.locator('input[placeholder*="子ASIN"]');
    await asinInput.waitFor({ state: "visible", timeout: 10000 });
    await asinInput.click();
    await asinInput.fill("");
    await asinInput.type(asin, { delay: 100 });
    await asinInput.press("Enter");
    console.log(`[${asin}] Submitted query...`);
    await page.waitForTimeout(2000);

    const checkBlock = page.locator(".check_block").first();
    for (let i = 0; i < 20; i++) {
      if (
        await checkBlock
          .isVisible({ timeout: 500 })
          .catch(() => false)
      ) {
        break;
      }
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(500);
    }
    await checkBlock.waitFor({ state: "visible", timeout: 10000 });
    await checkBlock.click();
    console.log(`[${asin}] Selected all rows`);
    await page.waitForTimeout(2000);

    const tableData = await extractTableData(page);
    if (tableData.length > 0) {
      // Save CSV as backup
      const outPath = `./keywords-${asin}.csv`;
      writeFileSync(outPath, tableData, "utf-8");

      // Write to PostgreSQL (primary)
      try {
        const count = await saveToDb(asin, tableData);
        console.log(
          `[${asin}] DB: inserted/updated ${count} keywords`,
        );
      } catch (dbErr) {
        console.error(`[${asin}] DB write failed:`, dbErr);
      }

      const rowCount = tableData.split("\n").length;
      console.log(
        `[${asin}] CSV saved: ${outPath} (${rowCount} rows)`,
      );
      return tableData;
    }

    console.log(`[${asin}] Failed to extract table data`);
    return null;
  } catch (err) {
    console.error(`[${asin}] Error:`, err);
    return null;
  }
}

// --- Concurrency control (semaphore) ---

function semaphore(limit: number) {
  let running = 0;
  const queue: Array<() => void> = [];

  return async function acquire<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    if (running >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (queue.length > 0) {
        queue.shift()!();
      }
    }
  };
}

// --- Main ---

async function main() {
  if (TARGET_ASINS.length === 0) {
    console.error("No ASINs configured.");
    return;
  }

  console.log(`Scraping ${TARGET_ASINS.length} ASINs...`);

  const context = await chromium.launchPersistentContext(DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  });

  const acquire = semaphore(CONCURRENCY);
  const results: Array<{ asin: string; ok: boolean }> = [];

  const tasks = TARGET_ASINS.map(
    (asin, index) => () =>
      new Promise<void>(async (resolve) => {
        if (index > 0) {
          await new Promise((r) => setTimeout(r, 2000 * index));
        }

        const page = await context.newPage();
        console.log(`[${asin}] Tab opened`);
        const content = await scrapeAsin(page, asin);
        await page.close();

        results.push({
          asin,
          ok: content !== null,
        });
        console.log(`[${asin}] Tab closed`);
        resolve();
      }),
  );

  await Promise.allSettled(tasks.map((task) => acquire(task)));

  console.log("\n--- Summary ---");
  for (const r of results) {
    const status = r.ok ? "OK" : "FAILED";
    console.log(`  ${r.asin}: ${status}`);
  }

  await context.close();
}

main().catch(console.error);

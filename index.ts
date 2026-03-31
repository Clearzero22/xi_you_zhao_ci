import { chromium, type BrowserContext, type Page } from "playwright";
import { writeFileSync } from "fs";

const DATA_DIR = "./.chrome-data";
const CONCURRENCY = 3;

const TARGET_ASINS = [
  "B0DZFGTCLR",
  // Add more ASINs here
];

// --- Single ASIN scraping logic ---

async function extractTableData(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Find the data table — look for rows with keyword data
    const rows = document.querySelectorAll('table tbody tr, .el-table__body-wrapper tr, .x-table-body tr');
    if (rows.length === 0) return "";

    const lines: string[] = [];
    for (const row of rows) {
      const cells = row.querySelectorAll('td, .cell');
      if (cells.length === 0) continue;
      const texts = Array.from(cells)
        .map((c) => c.textContent?.trim() ?? "")
        .filter(Boolean);
      if (texts.length > 0) {
        lines.push(texts.join("\t"));
      }
    }
    return lines.join("\n");
  });
}

async function scrapeAsin(page: Page, asin: string): Promise<string | null> {
  try {
    // Navigate to ASIN page
    await page.goto("https://www.xiyouzhaoci.com/asin");
    console.log(`[${asin}] Page loaded: ${await page.title()}`);
    await page.waitForTimeout(5000);

    // Input ASIN and submit
    const asinInput = page.locator('input[placeholder*="子ASIN"]');
    await asinInput.waitFor({ state: "visible", timeout: 10000 });
    await asinInput.click();
    await asinInput.fill("");
    await asinInput.type(asin, { delay: 100 });
    await asinInput.press("Enter");
    console.log(`[${asin}] Submitted query...`);
    await page.waitForTimeout(2000);

    // Scroll down until .check_block is visible, then click select-all
    const checkBlock = page.locator('.check_block').first();
    for (let i = 0; i < 20; i++) {
      if (await checkBlock.isVisible({ timeout: 500 }).catch(() => false)) {
        break;
      }
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(500);
    }
    await checkBlock.waitFor({ state: "visible", timeout: 10000 });
    await checkBlock.click();
    console.log(`[${asin}] Selected all rows`);
    await page.waitForTimeout(2000);

    // Extract table data from DOM
    const tableData = await extractTableData(page);
    if (tableData.length > 0) {
      const outPath = `./keywords-${asin}.txt`;
      writeFileSync(outPath, tableData, "utf-8");
      console.log(`[${asin}] Saved: ${outPath} (${(tableData.length / 1024).toFixed(1)} KB, ${tableData.split('\n').length} rows)`);
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

  return async function acquire<T>(fn: () => Promise<T>): Promise<T> {
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
    console.error("No ASINs configured. Add entries to TARGET_ASINS array.");
    return;
  }

  const context: BrowserContext = await chromium.launchPersistentContext(DATA_DIR, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  });

  const acquire = semaphore(CONCURRENCY);
  const results: Array<{ asin: string; ok: boolean; size?: string }> = [];

  // Launch all tabs with staggered delays to avoid clipboard race
  const tasks = TARGET_ASINS.map(
    (asin, index) => () =>
      new Promise<void>(async (resolve) => {
        // Stagger: wait a bit before opening each tab
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
          size: content ? `${(content.length / 1024).toFixed(1)} KB` : undefined,
        });
        console.log(`[${asin}] Tab closed`);
        resolve();
      }),
  );

  await Promise.allSettled(tasks.map((task) => acquire(task)));

  // Summary
  console.log("\n--- Summary ---");
  for (const r of results) {
    const status = r.ok ? `OK (${r.size})` : "FAILED";
    console.log(`  ${r.asin}: ${status}`);
  }

  await context.close();
}

main().catch(console.error);

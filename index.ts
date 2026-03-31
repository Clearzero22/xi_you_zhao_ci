import { chromium, type BrowserContext, type Page } from "playwright";
import { writeFileSync } from "fs";

const DATA_DIR = "./.chrome-data";
const CONCURRENCY = 3;

const TARGET_ASINS = [
  "B0DZFGTCLR",
  // Add more ASINs here
];

// --- Single ASIN scraping logic ---

async function readClipboard(page: Page): Promise<string | null> {
  // Strategy 1: navigator.clipboard.readText()
  const text = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });
  if (text && text.length > 10) return text;

  // Strategy 2: execCommand("paste") fallback
  return page.evaluate(() => {
    return new Promise<string | null>((resolve) => {
      const handler = (e: ClipboardEvent) => {
        const data = e.clipboardData?.getData("text/plain") ?? null;
        document.removeEventListener("paste", handler);
        resolve(data);
      };
      document.addEventListener("paste", handler);
      document.execCommand("paste");
      setTimeout(() => {
        document.removeEventListener("paste", handler);
        resolve(null);
      }, 3000);
    });
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

    // Click batch copy
    await page.getByText('批量复制').first().click();
    console.log(`[${asin}] Clicked batch copy`);
    await page.waitForTimeout(2000);

    // Read clipboard
    const clipboardText = await readClipboard(page);
    if (clipboardText && clipboardText.length > 10) {
      const outPath = `./keywords-${asin}.txt`;
      writeFileSync(outPath, clipboardText, "utf-8");
      console.log(`[${asin}] Saved: ${outPath} (${(clipboardText.length / 1024).toFixed(1)} KB)`);
      return clipboardText;
    }

    console.log(`[${asin}] Failed to read clipboard`);
    return null;
  } catch (err) {
    console.error(`[${asin}] Error:`, err);
    return null;
  }
}

// --- Concurrency control (semaphore) ---

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const p = task().then(
      (value) => {
        results.push({ status: "fulfilled", value });
      },
      (reason) => {
        results.push({ status: "rejected", reason });
      },
    );

    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
      // Remove completed promises
      for (let i = executing.length - 1; i >= 0; i--) {
        // Re-check: if a promise settled, remove it
        // We use a trick: race already resolved, so at least one is done
        break;
      }
      // Clear settled promises from the array
      const settled = executing.filter((e) => {
        // Can't easily check, so we use a different approach
        return false;
      });
    }
  }

  await Promise.all(executing);
  return results;
}

// Better semaphore implementation
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

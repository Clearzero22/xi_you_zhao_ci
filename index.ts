import { chromium, type BrowserContext } from "playwright";
import { writeFileSync } from "fs";

const DATA_DIR = "./.chrome-data";
const TARGET_ASIN = "B0DZFGTCLR";

async function main() {
  const context: BrowserContext = await chromium.launchPersistentContext(DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] ?? (await context.newPage());

  // Step 1: Navigate and search
  await page.goto("https://www.xiyouzhaoci.com/asin");
  console.log("Page title:", await page.title());
  await page.waitForTimeout(5000);

  const asinInput = page.locator('input[placeholder*="子ASIN"]');
  await asinInput.waitFor({ state: "visible", timeout: 10000 });
  await asinInput.click();
  await asinInput.fill("");
  await asinInput.type(TARGET_ASIN, { delay: 100 });
  await asinInput.press("Enter");
  console.log("Submitted ASIN query...");
  await page.waitForTimeout(12000);

  // Step 1.5: Switch to "反查关键词" tab if needed
  const keywordTab = page.getByText("反查关键词").first();
  if (await keywordTab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await keywordTab.click();
    console.log("Switched to '反查关键词' tab");
    await page.waitForTimeout(8000);
  }

  // Step 2: Click select-all checkbox
  await page.locator('.check_block').first().click();
  console.log("Clicked select-all checkbox (.check_block)");
  await page.waitForTimeout(2000);

  // Step 3: Click "批量复制"
  await page.getByText('批量复制').first().click();
  console.log("Clicked '批量复制'");
  await page.waitForTimeout(2000);

  // Step 5: Read clipboard content
  // Use page.evaluate to read from clipboard
  const clipboardText = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });

  if (clipboardText && clipboardText.length > 10) {
    writeFileSync("./keywords-copied.txt", clipboardText, "utf-8");
    console.log(`\nClipboard content saved: ./keywords-copied.txt (${(clipboardText.length / 1024).toFixed(1)} KB)`);
    console.log("Preview (first 1000 chars):");
    console.log(clipboardText.substring(0, 1000));
  } else {
    console.log("Direct clipboard read failed. Trying paste fallback...");

    // Fallback: intercept clipboard via paste event
    const pasted = await page.evaluate(() => {
      return new Promise<string | null>((resolve) => {
        const handler = (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData("text/plain") ?? null;
          document.removeEventListener("paste", handler);
          resolve(text);
        };
        document.addEventListener("paste", handler);
        document.execCommand("paste");
        setTimeout(() => {
          document.removeEventListener("paste", handler);
          resolve(null);
        }, 3000);
      });
    });

    if (pasted && pasted.length > 10) {
      writeFileSync("./keywords-copied.txt", pasted, "utf-8");
      console.log(`\nClipboard content saved: ./keywords-copied.txt (${(pasted.length / 1024).toFixed(1)} KB)`);
      console.log("Preview (first 1000 chars):");
      console.log(pasted.substring(0, 1000));
    } else {
      console.log("Could not read clipboard programmatically.");
      console.log("The '批量复制' likely copied to OS clipboard — check by pasting manually.");
    }
  }

  await context.close();
}

main().catch(console.error);

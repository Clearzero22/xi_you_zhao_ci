import { chromium } from "playwright";

const DATA_DIR = "./.chrome-data";

async function main() {
  const context = await chromium.launchPersistentContext(DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.xiyouzhaoci.com/asin");

  console.log("Browser opened with existing session.");
  console.log("Press Ctrl+C to close.");

  // Keep open
  await new Promise(() => {});
}

main().catch(console.error);

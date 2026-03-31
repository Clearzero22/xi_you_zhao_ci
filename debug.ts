import { chromium, type BrowserContext } from "playwright";
import { writeFileSync } from "fs";

const DATA_DIR = "./.chrome-data";
const TARGET_ASIN = "B0DZFGTCLR";

async function main() {
  const context: BrowserContext = await chromium.launchPersistentContext(DATA_DIR, {
    headless: false,
    slowMo: 300,
    viewport: { width: 1280, height: 720 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] ?? (await context.newPage());

  // Enable console log from browser
  page.on("console", (msg) => console.log(`[browser] ${msg.type()}: ${msg.text()}`));

  // Capture all requests to see exact headers
  const capturedRequests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

  page.on("request", (req) => {
    if (req.url().includes("/v3/asins/research/list")) {
      capturedRequests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        body: req.postData() ?? "",
      });
      console.log(`\n[CAPTURED] ${req.method()} ${req.url()}`);
      console.log("Headers:", JSON.stringify(req.headers(), null, 2));
      console.log("Body:", req.postData()?.substring(0, 500));
    }
  });

  // Navigate
  await page.goto("https://www.xiyouzhaoci.com/asin");
  console.log("Page title:", await page.title());
  await page.screenshot({ path: "./debug-1-home.png" });
  console.log("[debug] Screenshot: debug-1-home.png");

  await page.waitForTimeout(5000);

  // Type ASIN
  const asinInput = page.locator('input[placeholder*="子ASIN"]');
  await asinInput.waitFor({ state: "visible", timeout: 10000 });
  await asinInput.click();
  await asinInput.fill("");
  await asinInput.type(TARGET_ASIN, { delay: 100 });
  await page.screenshot({ path: "./debug-2-typed.png" });
  console.log("[debug] Screenshot: debug-2-typed.png");

  // Submit
  await asinInput.press("Enter");
  console.log("Submitted, waiting for data to load...");

  // Wait for table to appear
  await page.waitForTimeout(12000);
  await page.screenshot({ path: "./debug-3-results.png" });
  console.log("[debug] Screenshot: debug-3-results.png");

  // Output captured API request info
  if (capturedRequests.length > 0) {
    writeFileSync("./captured-request.json", JSON.stringify(capturedRequests[0], null, 2), "utf-8");
    console.log("\nSaved captured request to ./captured-request.json");
  } else {
    console.log("\nNo /v3/asins/research/list request captured.");
    console.log("The keyword table may use a different API or lazy loading.");
  }

  // Keep browser open for manual inspection
  console.log("\nBrowser stays open. Press Ctrl+C to exit.");
  await new Promise(() => {}); // hang forever
}

main().catch(console.error);

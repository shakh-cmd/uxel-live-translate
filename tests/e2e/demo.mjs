import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const port = process.env.PORT || "4321";
const base = process.env.E2E_BASE || `http://127.0.0.1:${port}`;
const outDir = "/opt/cursor/artifacts";
const ownServer = !process.env.E2E_BASE;

const server = ownServer
  ? spawn("npx", ["tsx", "src/server/index.ts"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: port,
    HOST: "127.0.0.1",
    NODE_ENV: "development",
    TRANSLATION_PROVIDER: "mock",
    GUIDE_PIN: "2468",
    STORE_AUDIO: "false",
    MAX_GUESTS: "6",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
  : null;
server?.stdout.on("data", (chunk) => process.stdout.write(chunk));
server?.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForHealth(base);
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const guideContext = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    permissions: ["microphone"],
  });
  const guide = await guideContext.newPage();
  await guide.goto(`${base}/guide`, { waitUntil: "networkidle" });
  await guide.getByTestId("guide-pin").fill("2468");
  await guide.getByTestId("guide-create").click();
  await guide.getByTestId("guide-code").waitFor();
  await guide.waitForFunction(() => document.querySelector("[data-testid='guide-status']")?.textContent?.includes("Connected"));
  const code = (await guide.getByTestId("guide-code").innerText()).trim();
  await guide.getByTestId("guide-start").click();
  await guide.getByTestId("stop-name").fill("Basilica Cistern");
  await guide.getByTestId("stop-script").fill(
    "This is the Basilica Cistern in Istanbul. Emperor Justinian built it in the sixth century to store water for the palace. Mind the wet floor.",
  );
  await guide.getByTestId("stop-create").click();
  await guide.getByText("12/12 languages ready").waitFor({ timeout: 30_000 });

  const guests = [];
  for (const lang of ["de", "es", "ar", "ja"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      locale: lang === "ar" ? "ar" : lang === "ja" ? "ja" : lang,
    });
    const page = await context.newPage();
    await page.goto(`${base}/g/${code}`, { waitUntil: "networkidle" });
    await page.getByTestId(`lang-${lang}`).click();
    await page.getByTestId("guest-listen").click();
    guests.push({ lang, page, context });
  }

  await guests[0].page.getByTestId("guest-cache").getByText(/1 stop saved/).waitFor({ timeout: 20_000 });
  await guide.getByTestId("guide-demo").click();
  await guests[0].page.getByTestId("guest-caption").getByText(/Willkommen/).waitFor({ timeout: 20_000 });
  await guests[2].page.getByTestId("guest-caption").getByText(/Hagia Sophia/).waitFor({ timeout: 20_000 });
  await guide.getByTestId("guide-caption").getByText(/Hagia Sophia/).waitFor();
  await guide.getByTestId("guide-guests").getByText("de").waitFor();

  await guide.screenshot({ path: `${outDir}/guide-mobile.png`, fullPage: true });
  await guests[0].page.screenshot({ path: `${outDir}/guest-mobile-de.png`, fullPage: true });
  await guests[2].page.screenshot({ path: `${outDir}/guest-mobile-ar.png`, fullPage: true });
  await guests[3].page.screenshot({ path: `${outDir}/guest-mobile-ja.png`, fullPage: true });

  const german = await guests[0].page.getByTestId("guest-caption").innerText();
  const arabic = await guests[2].page.getByTestId("guest-caption").innerText();
  const japanese = await guests[3].page.getByTestId("guest-caption").innerText();
  if (!german.includes("Willkommen") || !german.includes("Hagia Sophia")) throw new Error(`German caption: ${german}`);
  if (!arabic.includes("Hagia Sophia")) throw new Error(`Arabic caption: ${arabic}`);
  if (!japanese.includes("Hagia Sophia")) throw new Error(`Japanese caption: ${japanese}`);
  console.log(JSON.stringify({ ok: true, code, german, arabic, japanese }));
  await browser.close();
} finally {
  server?.kill("SIGTERM");
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`server did not start: ${last}`);
}

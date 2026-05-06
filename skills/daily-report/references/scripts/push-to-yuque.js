// Push consolidated daily reports to Yuque single-doc.
// Reads ~/Knowledge-Library/05-Reports/daily/*.md, strips frontmatter,
// concatenates newest-first, then PUT to Yuque doc via Playwright same-origin.
//
// Env:
//   DAILY_DIR        default: $HOME/Knowledge-Library/05-Reports/daily
//   YUQUE_STATE      default: $HOME/.openclaw/workspace/astraeus/.playwright/yuque-state.json
//   YUQUE_DOC_ID     numeric doc id
//   YUQUE_BOOK_ID    numeric book id
//   YUQUE_DOC_URL    full https URL of target doc (used for sharing)
//   YUQUE_DRY_RUN    if "1", skip PUT and write body to /tmp/yuque-body.md
//
// Output (stdout, one per line):
//   YUQUE_OK
//   YUQUE_URL:<url>
//   YUQUE_BODY_LEN:<n>
//   YUQUE_FILES:<n>
//   YUQUE_UPDATED_AT:<iso>

const fs = require("fs");
const path = require("path");

const DAILY_DIR = process.env.DAILY_DIR || `${process.env.HOME}/Knowledge-Library/05-Reports/daily`;
const STATE = process.env.YUQUE_STATE || `${process.env.HOME}/.openclaw/workspace/astraeus/.playwright/yuque-state.json`;
const DOC_ID = parseInt(process.env.YUQUE_DOC_ID || "268487158", 10);
const BOOK_ID = parseInt(process.env.YUQUE_BOOK_ID || "986668", 10);
const DOC_URL = process.env.YUQUE_DOC_URL || "https://banniu.yuque.com/staff-dmhmqa/selgla/btrxleogyolxi413";
const DRY_RUN = process.env.YUQUE_DRY_RUN === "1";

const PLAYWRIGHT_PATHS = [
  "/home/ubuntu/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core",
  "/home/ubuntu/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core",
  "playwright-core",
];

function loadPlaywright() {
  for (const p of PLAYWRIGHT_PATHS) {
    try { return require(p); } catch (e) { /* try next */ }
  }
  throw new Error("playwright-core not found in any candidate path");
}

function stripFrontmatter(md) {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return md;
  return md.slice(end + 4).replace(/^\n+/, "");
}

async function main() {
  if (!fs.existsSync(DAILY_DIR)) {
    console.error("FATAL: DAILY_DIR not found:", DAILY_DIR);
    process.exit(1);
  }
  if (!fs.existsSync(STATE)) {
    console.error("FATAL: yuque session not found:", STATE);
    process.exit(1);
  }

  const files = fs.readdirSync(DAILY_DIR)
    .filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error("FATAL: no daily files in", DAILY_DIR);
    process.exit(1);
  }

  let body = "# 产研日报合集\n\n> 由 daily-report skill 自动汇总生成,最新在最上方\n\n";
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DAILY_DIR, f), "utf-8");
    body += stripFrontmatter(raw).trimEnd() + "\n\n---\n\n";
  }

  if (DRY_RUN) {
    fs.writeFileSync("/tmp/yuque-body.md", body);
    console.log("YUQUE_OK");
    console.log(`YUQUE_URL:${DOC_URL}`);
    console.log(`YUQUE_BODY_LEN:${body.length}`);
    console.log(`YUQUE_FILES:${files.length}`);
    console.log("YUQUE_UPDATED_AT:dry-run");
    console.log("DRY_RUN body written to /tmp/yuque-body.md");
    return;
  }

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let result;
  try {
    const ctx = await browser.newContext({ storageState: STATE });
    const page = await ctx.newPage();
    await page.goto("https://banniu.yuque.com/api/mine", { waitUntil: "domcontentloaded", timeout: 20000 });
    result = await page.evaluate(async ({ docId, payloadBody }) => {
      const csrf = (document.cookie.match(/yuque_ctoken=([^;]+)/) || [, ""])[1];
      const r = await fetch(`/api/docs/${docId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ body: payloadBody, format: "markdown", _force_asl: 1 }),
      });
      const txt = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch (e) { /* ignore */ }
      return {
        status: r.status,
        ok: r.ok && parsed && parsed.data && parsed.data.id ? true : false,
        content_updated_at: parsed && parsed.data ? parsed.data.content_updated_at : null,
        body_len: parsed && parsed.data && typeof parsed.data.body === "string" ? parsed.data.body.length : null,
        error_head: !r.ok ? txt.slice(0, 400) : null,
      };
    }, { docId: DOC_ID, payloadBody: body });
  } finally {
    await browser.close();
  }

  if (!result.ok) {
    console.error("FATAL: PUT failed:", JSON.stringify(result));
    process.exit(2);
  }
  console.log("YUQUE_OK");
  console.log(`YUQUE_URL:${DOC_URL}`);
  console.log(`YUQUE_BODY_LEN:${result.body_len}`);
  console.log(`YUQUE_FILES:${files.length}`);
  console.log(`YUQUE_UPDATED_AT:${result.content_updated_at}`);
}

main().catch(e => { console.error("FATAL:", e.stack || e.message || String(e)); process.exit(3); });

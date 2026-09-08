/**
 * Recon run: a visible browser you drive by hand, which records every step of the booking
 * flow so the selectors for auto-booking can be written from what the site actually does
 * rather than guessed.
 *
 *   npm run recon
 *
 * It books nothing. It cannot book anything — it only watches and saves. The one thing it
 * cannot protect you from is your own click on the final confirm button, so don't press it.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium, type BrowserContext, type Page } from "playwright";

const BASE_URL = "https://www.destinationgotland.se/";
const CONSENT_STATE = path.resolve("data", "consent-state.json");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = path.resolve("debug", "recon", stamp);

let step = 0;
let capturing = false;
let lastCapture = 0;

/**
 * Saves the page three ways: a screenshot to look at, the HTML to write selectors from,
 * and the text to search. Input values are stripped from the HTML — the flow runs through
 * a login form and a passenger form, and none of that belongs in a file on disk.
 */
async function capture(page: Page, label: string): Promise<void> {
  // Clicks arrive in bursts as the SPA re-renders; one capture per settled state is enough.
  if (capturing || Date.now() - lastCapture < 900) return;
  capturing = true;
  try {
    await page.waitForTimeout(1200);
    const n = String(++step).padStart(3, "0");
    const safe = label.replace(/[^a-z0-9åäö]+/gi, "-").slice(0, 40).replace(/^-|-$/g, "") || "step";
    const base = path.join(OUT_DIR, `${n}-${safe}`);

    const html = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      for (const el of Array.from(clone.querySelectorAll("input, textarea"))) {
        el.setAttribute("value", "");
        el.textContent = "";
      }
      return clone.outerHTML;
    });
    fs.writeFileSync(`${base}.html`, html);
    fs.writeFileSync(`${base}.txt`, await page.evaluate(() => document.body.innerText));
    await page.screenshot({ path: `${base}.png`, fullPage: true });

    console.log(`  [${n}] ${label} — ${page.url()}`);
    lastCapture = Date.now();
  } catch (error) {
    console.warn(`  (kunde inte spara steget: ${error instanceof Error ? error.message : error})`);
  } finally {
    capturing = false;
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const ctx: BrowserContext = await browser.newContext({
    locale: "sv-SE",
    viewport: { width: 1400, height: 1100 },
    storageState: fs.existsSync(CONSENT_STATE) ? CONSENT_STATE : undefined,
  });
  // Same shim as the scraper: tsx's keepNames wraps functions in a __name helper that does
  // not exist inside the page, and every evaluate() would throw without it.
  await ctx.addInitScript(() => {
    (globalThis as any).__name = (fn: unknown) => fn;
  });

  const page = await ctx.newPage();

  // A click is what moves this flow along, so that is what triggers a capture. The label
  // is the text of whatever was clicked, which makes the file names read like a transcript.
  await ctx.exposeBinding("reconCapture", async (source, label: string) => {
    await capture(source.page, String(label));
  });
  await ctx.addInitScript(() => {
    document.addEventListener(
      "click",
      (event) => {
        const el = (event.target as HTMLElement)?.closest("button, a, label, [role=button], input");
        const text = (el?.textContent || (el as HTMLInputElement)?.value || "klick").trim();
        (window as any).reconCapture?.(text.replace(/\s+/g, " ").slice(0, 40));
      },
      true
    );
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) void capture(page, "sida");
  });

  console.log(`
──────────────────────────────────────────────────────────────
  REKOGNOSERING — ingenting bokas, ingenting betalas.
  Allt sparas i: ${path.relative(process.cwd(), OUT_DIR)}

  Klicka er igenom flödet i webbläsarfönstret:
    sök → välj biljettklass → välj salong → logga in
    → passageraruppgifter → sittplats → betalning med reskassa

  STANNA vid den sista bekräfta-/betala-knappen. Tryck inte på den.

  Enter här = spara nuvarande läge (om ett steg inte fångades)
  Ctrl+C     = avsluta
──────────────────────────────────────────────────────────────
`);

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", () => void capture(page, "manuell"));

  const shutdown = async () => {
    rl.close();
    console.log(`\n${step} steg sparade i ${path.relative(process.cwd(), OUT_DIR)}`);
    await browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  // Closing the window is the other natural way to finish.
  browser.on("disconnected", () => void shutdown());
}

void main();

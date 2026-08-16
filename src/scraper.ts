import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import type { CheckResult, Watch } from "./types.js";

const BASE_URL = "https://www.destinationgotland.se";

// Best-effort heuristic, not verified against the live site (see README "Calibrating the
// scraper"). Add phrases here as you learn how the real page words a sold-out departure.
const SOLD_OUT_PHRASES = [
  "fullbokad",
  "fullbokat",
  "slutsåld",
  "slutsålt",
  "inga lediga platser",
  "ej tillgänglig",
  "fullt just nu",
];

const BOOKABLE_HINTS = ["boka", "välj resa", "lägg till", "kr"];

const DEBUG_DIR = path.resolve("debug");

async function dumpDebugArtifacts(
  watchId: string,
  screenshot: Buffer,
  text: string
): Promise<{ screenshotPath: string; textDumpPath: string }> {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(DEBUG_DIR, `${watchId}-${stamp}.png`);
  const textDumpPath = path.join(DEBUG_DIR, `${watchId}-${stamp}.txt`);
  fs.writeFileSync(screenshotPath, screenshot);
  fs.writeFileSync(textDumpPath, text);
  return { screenshotPath, textDumpPath };
}

/**
 * Loads the departure's search-results page and applies a text heuristic to guess
 * whether the departure is bookable. See README "Calibrating the scraper" — this has not
 * been verified against the live site and will likely need the phrase lists above tuned
 * after the first real run.
 */
export async function checkAvailability(watch: Watch): Promise<CheckResult> {
  const debugAlways = process.env.DEBUG_SCRAPER === "1";
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();

    if (watch.searchUrl) {
      await page.goto(watch.searchUrl, { waitUntil: "networkidle", timeout: 30_000 });
    } else {
      // Experimental fallback: no captured search URL was supplied for this watch, so we
      // just land on the homepage. This almost certainly will NOT find real availability —
      // it exists so the app doesn't crash, and to make the failure mode obvious in the
      // debug dump. Supplying `searchUrl` (see README) is the supported path.
      await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 30_000 });
    }

    const bodyText = (await page.textContent("body")) ?? "";
    const lowerText = bodyText.toLowerCase();

    const soldOut = SOLD_OUT_PHRASES.some((phrase) => lowerText.includes(phrase));
    const bookable = BOOKABLE_HINTS.some((hint) => lowerText.includes(hint));

    let status: CheckResult["status"];
    if (soldOut) {
      status = "full";
    } else if (bookable) {
      status = "available";
    } else {
      status = "unknown";
    }

    let screenshotPath: string | undefined;
    let textDumpPath: string | undefined;
    if (status === "unknown" || debugAlways) {
      const screenshot = await page.screenshot({ fullPage: true });
      const dumped = await dumpDebugArtifacts(watch.id, screenshot, bodyText);
      screenshotPath = dumped.screenshotPath;
      textDumpPath = dumped.textDumpPath;
    }

    return {
      status,
      detail:
        status === "unknown"
          ? "Could not determine availability from page text — see debug/ artifacts."
          : `Detected "${status}" from page text heuristic.`,
      screenshotPath,
      textDumpPath,
    };
  } catch (error) {
    return {
      status: "unknown",
      detail: `Scrape failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await browser?.close();
  }
}

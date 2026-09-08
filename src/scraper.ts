import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  SALONG_TIERS,
  VEHICLE_LABELS,
  type CheckResult,
  type DepartureOffer,
  type FareOffer,
  type SalongOffer,
  type TripLeg,
  type Watch,
  type WatchStatus,
} from "./types.js";

const BASE_URL = "https://www.destinationgotland.se/";
const DEBUG_DIR = path.resolve("debug");
const STATE_FILE = path.resolve("data", "consent-state.json");

/** Booking widget control ids, verified against the live site. */
const BTN_ROUTE = "#booking-widget-transport-button-11";
const BTN_DATE = "#booking-widget-transport-button-9";
const BTN_DATE_RETURN = "#booking-widget-transport-button-10";
const BTN_PASSENGERS = "#booking-widget-transport-button-1";
const BTN_VEHICLE = "#booking-widget-transport-button-13";
const OVERLAY = ".BookingWidgetOverlayContent";

/**
 * One browser is shared across checks; contexts are per-check so each run starts from the
 * widget's default state and every field is set explicitly.
 */
let browser: Browser | undefined;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch();
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

/**
 * The cookie banner (Cookie Information) covers the widget until it is dismissed. We keep
 * only its cookies — not localStorage — so a stored search never leaks between checks.
 */
async function dismissConsent(page: Page, ctx: BrowserContext): Promise<void> {
  const decline = page.locator("#declineButton");
  try {
    await decline.waitFor({ state: "visible", timeout: 8000 });
  } catch {
    return; // already consented via the stored cookie
  }
  await decline.click();
  await page.waitForTimeout(1500);
  const state = await ctx.storageState();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ cookies: state.cookies, origins: [] }, null, 2));
}

function loadConsentState(): string | undefined {
  return fs.existsSync(STATE_FILE) ? STATE_FILE : undefined;
}

/** Midnight in Europe/Stockholm for a YYYY-MM-DD date, which is what the picker uses. */
function dayTimestamp(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Find the UTC instant whose Stockholm wall-clock time is that day at 00:00.
  for (const offsetHours of [1, 2]) {
    const guess = Date.UTC(y, m - 1, d, -offsetHours, 0, 0, 0);
    const wall = new Date(guess).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
    const hour = new Date(guess).toLocaleString("sv-SE", {
      timeZone: "Europe/Stockholm",
      hour: "2-digit",
      hour12: false,
    });
    if (wall === isoDate && Number(hour) === 0) return guess;
  }
  throw new Error(`Could not resolve Stockholm midnight for ${isoDate}`);
}

/**
 * The widget opens on "Tur och retur", so a one-way search is the one that has to click.
 * A return watch leaves it alone and fills the second date instead.
 */
async function setTripType(page: Page, roundTrip: boolean): Promise<void> {
  const checkbox = page.locator("input[type=checkbox]").first();
  if ((await checkbox.isChecked()) !== roundTrip) {
    await page.getByText("Tur och retur", { exact: true }).first().click();
    await page.waitForTimeout(1000);
  }
}

async function setRoute(page: Page, route: string): Promise<void> {
  const [origin, destination] = route.split("-");
  await page.locator(BTN_ROUTE).click();
  const overlay = page.locator(OVERLAY);
  await overlay.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);
  await overlay.locator("label", { hasText: `${origin}${destination}` }).first().click();
  await page.waitForTimeout(1200);
}

async function setDate(page: Page, isoDate: string, button = BTN_DATE): Promise<void> {
  const target = dayTimestamp(isoDate);
  const overlay = page.locator(OVERLAY);
  // Picking the outbound date of a return trip can leave the picker open on the return
  // month, ready for the second date. Only click the button when it isn't already open.
  if (!(await overlay.isVisible().catch(() => false))) {
    await page.locator(button).click();
  }
  await overlay.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(800);

  for (let month = 0; month < 14; month++) {
    const day = overlay.locator(`button[data-timestamp="${target}"]`);
    if ((await day.count()) > 0) {
      if (await day.first().isDisabled()) {
        throw new Error(`Date ${isoDate} is not selectable on the site (no sailings or in the past).`);
      }
      await day.first().click();
      await page.waitForTimeout(1200);
      return;
    }
    const next = overlay.getByLabel("Next month");
    if (await next.isDisabled()) break;
    await next.click();
    await page.waitForTimeout(800);
  }
  throw new Error(`Date ${isoDate} was not offered by the date picker.`);
}

/** Rows are in a fixed order; adults ("Vuxen 26+ år") is the first. */
async function setPassengers(page: Page, adults: number): Promise<void> {
  await page.locator(BTN_PASSENGERS).click();
  const overlay = page.locator(OVERLAY);
  await overlay.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);

  for (let i = 0; i < 12; i++) {
    const current = await overlay.evaluate((el) => {
      const text = (el as HTMLElement).innerText || "";
      const m = text.match(/Vuxen 26\+ år\s*\n?\s*(\d+)/);
      return m ? Number(m[1]) : NaN;
    });
    if (!Number.isFinite(current)) throw new Error("Could not read the adult passenger count.");
    if (current === adults) break;
    await overlay.getByLabel(current < adults ? "Öka antal" : "Minska antal").nth(0).click();
    await page.waitForTimeout(400);
  }

  await page.getByRole("button", { name: /^klar$/i }).click();
  await page.waitForTimeout(1000);
}

async function setVehicle(page: Page, vehicle: keyof typeof VEHICLE_LABELS): Promise<void> {
  if (vehicle === "none") return; // widget defaults to no vehicle
  await page.locator(BTN_VEHICLE).click();
  const overlay = page.locator(OVERLAY);
  await overlay.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.locator("#car-vehicle-group_summary").click();
  await page.waitForTimeout(800);
  await overlay.getByText(VEHICLE_LABELS[vehicle], { exact: false }).first().click();
  await page.waitForTimeout(600);
  try {
    await page.getByRole("button", { name: /^klar$/i }).click({ timeout: 6000 });
  } catch {
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(1000);
}

/**
 * Tags every fare button with its departure time and its leg, so we can address a specific
 * one later, and reports what is on the results page.
 *
 * A return search stacks both legs on the same page under one heading each, with no id or
 * data attribute to tell them apart — only the text "Välj returresa" sits between them.
 * Everything after that marker belongs to the return. Without this a watch on 07:15 out
 * would happily match a 07:15 sailing coming back.
 */
async function tagFareButtons(page: Page): Promise<{ departure: string; arrival: string | null; fare: string; price: string | null; soldOut: boolean; key: string; leg: TripLeg }[]> {
  return page.evaluate(() => {
    const marker = Array.from(document.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && /^Välj returresa$/i.test((el.textContent || "").trim())
    );
    const isFare = (t: string) => /^(Mini|Flexi \+|Flexi)\b/.test(t);
    const out: any[] = [];
    let n = 0;
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      const text = ((btn as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!isFare(text)) continue;

      // Walk up to the departure row: the closest ancestor starting with a time.
      let row: HTMLElement | null = btn;
      let times: string[] = [];
      for (let i = 0; i < 8 && row; i++, row = row.parentElement) {
        const rowText = (row.innerText || "").trim();
        const m = rowText.match(/^(\d{2}:\d{2})\s*\n\s*(\d{2}:\d{2})?/);
        if (m) {
          times = [m[1], m[2] ?? ""];
          break;
        }
      }
      const key = `fw-${n++}`;
      btn.setAttribute("data-fw-fare", key);
      const afterMarker =
        !!marker && !!(marker.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING);
      const priceMatch = text.match(/(\d[\d\s]*:-)/);
      out.push({
        departure: times[0] ?? "",
        arrival: times[1] || null,
        fare: text.replace(/\s*\d[\d\s]*:-\s*$/, "").replace(/\s*Slutsålt\s*$/i, "").trim(),
        price: priceMatch ? priceMatch[1].trim() : null,
        soldOut: /slutsålt/i.test(text) || (btn as HTMLButtonElement).disabled || btn.className.includes("Mui-disabled"),
        key,
        leg: afterMarker ? "return" : "out",
      });
    }
    return out;
  });
}

/** Reads the lounge rows that appear under a departure once a fare is expanded. */
async function readSalongs(page: Page, fareKey: string): Promise<SalongOffer[]> {
  const rows = await page.evaluate((key) => {
    const btn = document.querySelector(`[data-fw-fare="${key}"]`);
    if (!btn) return [];
    let row: HTMLElement | null = btn as HTMLElement;
    for (let i = 0; i < 8 && row; i++, row = row.parentElement) {
      if (row.querySelector("input[type=radio]")) break;
    }
    if (!row) return [];
    const seen = new Set<string>();
    const out: { name: string; raw: string; disabled: boolean }[] = [];
    for (const radio of Array.from(row.querySelectorAll("input[type=radio]"))) {
      let cell: HTMLElement | null = radio as HTMLElement;
      for (let i = 0; i < 6 && cell; i++, cell = cell.parentElement) {
        const t = (cell.innerText || "").replace(/\s+/g, " ").trim();
        if (t && /[A-Za-zÅÄÖåäö]/.test(t) && t.length < 60) {
          if (seen.has(t)) break;
          seen.add(t);
          out.push({
            name: t,
            raw: t,
            disabled:
              (radio as HTMLInputElement).disabled ||
              (cell.className || "").includes("Mui-disabled") ||
              /slutsålt/i.test(t),
          });
          break;
        }
      }
    }
    return out;
  }, fareKey);

  return rows.map((r) => {
    const priceMatch = r.raw.match(/(\d[\d\s]*:-)/);
    const name = r.raw
      .replace(/\s*\d[\d\s]*:-\s*$/, "")
      .replace(/\s*Slutsålt\s*$/i, "")
      .trim();
    const soldOut = /slutsålt/i.test(r.raw) || (!priceMatch && r.disabled);
    return {
      name,
      price: priceMatch ? priceMatch[1].trim() : null,
      soldOut,
      tier: SALONG_TIERS[name] ?? "other",
    } satisfies SalongOffer;
  });
}

async function dumpDebug(watchId: string, page: Page, note: string): Promise<{ screenshotPath: string; textDumpPath: string }> {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(DEBUG_DIR, `${watchId}-${stamp}.png`);
  const textDumpPath = path.join(DEBUG_DIR, `${watchId}-${stamp}.txt`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const text = await page.evaluate(() => (document.body as HTMLElement).innerText);
  fs.writeFileSync(textDumpPath, `# ${note}\n\n${text}`);
  return { screenshotPath, textDumpPath };
}

/** A leg is bookable when any fare still has any lounge that isn't sold out. */
export function isBookable(offer: DepartureOffer): boolean {
  return offer.fares.some((f) => !f.soldOut && f.salongs.some((s) => !s.soldOut));
}

/**
 * Reads one leg: finds the watched departure among that leg's buttons, expands each fare
 * that isn't sold out and reads the lounges under it. Returns a sentence instead of an
 * offer when the departure isn't on the page — the times that were found are the useful
 * part of that answer, since it usually means a mistyped departure.
 */
async function readLeg(
  page: Page,
  departureTime: string,
  leg: TripLeg
): Promise<{ offer: DepartureOffer } | { missing: string }> {
  const buttons = (await tagFareButtons(page)).filter((b) => b.leg === leg);
  const matching = buttons.filter((b) => b.departure === departureTime);
  const what = leg === "out" ? "Avgång" : "Returavgång";

  if (matching.length === 0) {
    const found = [...new Set(buttons.map((b) => b.departure).filter(Boolean))];
    return {
      missing: found.length
        ? `${what} ${departureTime} fanns inte i sökresultatet. Hittade: ${found.join(", ")}.`
        : `Inga ${leg === "out" ? "avgångar" : "returavgångar"} hittades på sökresultatsidan.`,
    };
  }

  const fares: FareOffer[] = [];
  for (const b of matching) {
    if (b.soldOut) {
      fares.push({ fare: b.fare, price: b.price, soldOut: true, salongs: [] });
      continue;
    }
    await page.locator(`[data-fw-fare="${b.key}"]`).click();
    await page.waitForTimeout(3000);
    fares.push({ fare: b.fare, price: b.price, soldOut: false, salongs: await readSalongs(page, b.key) });
  }

  return { offer: { departure: departureTime, arrival: matching[0]?.arrival ?? null, fares, leg } };
}

/** One leg's worth of prose, whichever way it turned out. */
function describeLeg(offer: DepartureOffer): string {
  const what = offer.leg === "out" ? "Avgång" : "Returavgång";
  if (isBookable(offer)) return `${what} ${offer.departure}:\n${summarizeOffer(offer)}`;
  if (offer.fares.every((f) => f.soldOut)) {
    return `${what} ${offer.departure} är slutsåld — ingen biljettklass går att välja.`;
  }
  return `${what} ${offer.departure}: biljettklasser finns kvar, men alla salonger är slutsålda.\n${summarizeOffer(offer)}`;
}

/** Both legs of a return trip, or just the one for a one-way watch. */
export function describeTrip(offer: DepartureOffer, returnOffer?: DepartureOffer): string {
  if (!returnOffer) return describeLeg(offer);
  return `${describeLeg(offer)}\n\n${describeLeg(returnOffer)}`;
}

/**
 * Drives the real booking flow: dismiss consent, fill the search widget, search, then
 * expand each fare on the watched departure and read its lounge availability.
 */
export async function checkAvailability(watch: Watch): Promise<CheckResult> {
  const debugAlways = process.env.DEBUG_SCRAPER === "1";
  const b = await getBrowser();
  const ctx = await b.newContext({
    locale: "sv-SE",
    viewport: { width: 1400, height: 1200 },
    storageState: loadConsentState(),
  });
  // tsx compiles with esbuild's keepNames, which wraps functions in a `__name` helper.
  // That helper does not exist inside the page, so provide a no-op shim before any script
  // runs — otherwise every page.evaluate() below throws ReferenceError: __name.
  await ctx.addInitScript(() => {
    (globalThis as any).__name = (fn: unknown) => fn;
  });

  const page = await ctx.newPage();

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await dismissConsent(page, ctx);

    const roundTrip = !!(watch.returnDate && watch.returnTime);
    await setTripType(page, roundTrip);
    await setRoute(page, watch.route);
    await setDate(page, watch.date);
    if (roundTrip) await setDate(page, watch.returnDate!, BTN_DATE_RETURN);
    await setPassengers(page, watch.adults);
    await setVehicle(page, watch.vehicle);

    await page.getByRole("button", { name: /^sök resor$/i }).click();
    await page.waitForTimeout(7000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 25_000 });
    } catch {
      /* the page keeps polling; the wait above is enough */
    }
    await page.waitForTimeout(2000);

    const outbound = await readLeg(page, watch.departureTime, "out");
    if ("missing" in outbound) {
      const dumped = await dumpDebug(watch.id, page, `departure ${watch.departureTime} not found`);
      return { status: "unknown", detail: outbound.missing, ...dumped };
    }

    // The return list may only render once an outbound fare has been expanded, so it is
    // read after the outbound and the buttons are tagged again rather than reused.
    let returnLeg: DepartureOffer | undefined;
    if (roundTrip) {
      const back = await readLeg(page, watch.returnTime!, "return");
      if ("missing" in back) {
        const dumped = await dumpDebug(watch.id, page, `return ${watch.returnTime} not found`);
        return { status: "unknown", detail: back.missing, ...dumped };
      }
      returnLeg = back.offer;
    }

    const offer = outbound.offer;
    const outBookable = isBookable(offer);
    const backBookable = returnLeg ? isBookable(returnLeg) : true;
    // A return watch is only a hit when the whole trip can be booked; one leg on its own
    // is worth reporting but is not what the watch is waiting for.
    const status: WatchStatus = outBookable && backBookable
      ? "available"
      : roundTrip && (outBookable || backBookable)
        ? "partial"
        : "full";
    const bookable = status === "available";

    let extra: { screenshotPath?: string; textDumpPath?: string } = {};
    if (debugAlways) extra = await dumpDebug(watch.id, page, `status=${status}`);

    return {
      status,
      detail: describeTrip(offer, returnLeg),
      offer,
      returnOffer: returnLeg,
      ...extra,
    };
  } catch (error) {
    let extra: { screenshotPath?: string; textDumpPath?: string } = {};
    try {
      extra = await dumpDebug(watch.id, page, "scrape failed");
    } catch {
      /* page may be gone */
    }
    return {
      status: "unknown",
      detail: `Kontrollen misslyckades: ${error instanceof Error ? error.message : String(error)}`,
      ...extra,
    };
  } finally {
    await ctx.close();
  }
}

/** Human-readable summary of what is bookable, used in the Discord message and the UI. */
export function summarizeOffer(offer: DepartureOffer): string {
  const lines: string[] = [];
  for (const fare of offer.fares) {
    if (fare.soldOut) {
      lines.push(`• ${fare.fare}: slutsåld`);
      continue;
    }
    const free = fare.salongs.filter((s) => !s.soldOut);
    if (free.length === 0) {
      lines.push(`• ${fare.fare} ${fare.price ?? ""}: inga lediga salonger`.trim());
      continue;
    }
    const rendered = free
      .map((s) => `${tierMark(s.tier)}${s.name}${s.price ? ` ${s.price}` : ""}`)
      .join(", ");
    lines.push(`• ${fare.fare}${fare.price ? ` ${fare.price}` : ""}: ${rendered}`);
  }
  return lines.join("\n");
}

function tierMark(tier: SalongOffer["tier"]): string {
  if (tier === "preferred") return "⭐ ";
  if (tier === "acceptable") return "👍 ";
  if (tier === "last-resort") return "⚠️ ";
  return "";
}

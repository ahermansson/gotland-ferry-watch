/**
 * Drives the real booking flow from search results through to the checkout page. It logs
 * in, picks the fare and lounge the watch's preferences allow, fills the passenger step
 * from saved travellers, skips every paid add-on the watch didn't ask for, and on the
 * "Kassa" page selects Reskort and accepts the terms.
 *
 * `prepareBooking` stops there and hands back the still-open page -- it never clicks
 * Betala itself. `pressBetala` is the one function in this entire project that does, and
 * it is only ever called from src/purchase.ts, on exactly the session that was prepared
 * here: after an approved Discord click, or immediately when AUTO_BOOKING_UNATTENDED is
 * on. `npm run book` (below) calls prepareBooking and then closes it unpressed, for
 * testing the flow with no approval bot and no purchase involved at all.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getWatch } from "./db.js";
import {
  BASE_URL,
  BTN_DATE_RETURN,
  dismissConsent,
  loadConsentState,
  readLeg,
  selectSalong,
  setDate,
  setPassengers,
  setRoute,
  setTripType,
  setVehicle,
  tagFareButtons,
} from "./scraper.js";
import type { BookingPrefs, DepartureOffer, TripLeg, Watch } from "./types.js";

const DEBUG_DIR = path.resolve("debug", "booking");

export interface BookingChoice {
  fare: string;
  salong: string;
}

/** A number a price token like "786:-" or "0:-" reads as, or null when there wasn't one. */
function priceValue(token: string | null): number | null {
  if (!token) return null;
  const digits = token.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

/**
 * The highest-ranked bookable fare class that has any allowed lounge still free, and the
 * cheapest of those lounges. A lounge with no price shown is free with the fare, which
 * beats every priced one, so it sorts as 0.
 */
export function chooseBooking(offer: DepartureOffer, prefs: BookingPrefs): BookingChoice | null {
  for (const fareName of prefs.fareOrder) {
    const fare = offer.fares.find((f) => f.fare === fareName && !f.soldOut);
    if (!fare) continue;
    const allowed = fare.salongs.filter((s) => !s.soldOut && prefs.salongs.includes(s.name));
    if (allowed.length === 0) continue;
    const cheapest = allowed.reduce((a, b) => (priceValue(b.price) ?? 0) < (priceValue(a.price) ?? 0) ? b : a);
    return { fare: fare.fare, salong: cheapest.name };
  }
  return null;
}

export interface DryRunResult {
  ok: boolean;
  detail: string;
  screenshotPath?: string;
  textDumpPath?: string;
}

export interface PreparedBooking {
  ok: true;
  watch: Watch;
  page: Page;
  total: number | null;
  detail: string;
  screenshotPath: string;
  textDumpPath: string;
  /** Closes the browser without ever touching Betala -- rejection and expiry both use this. */
  cancel: () => Promise<void>;
}

export interface FailedBooking {
  ok: false;
  detail: string;
  screenshotPath?: string;
  textDumpPath?: string;
}

async function login(page: Page): Promise<void> {
  if (await page.locator("#user-button").isVisible().catch(() => false)) return;

  const username = process.env.DG_USERNAME;
  const password = process.env.DG_PASSWORD;
  if (!username || !password) {
    throw new Error("DG_USERNAME / DG_PASSWORD saknas -- kan inte logga in.");
  }

  await page.locator("#login-button").click();
  const usernameField = page.locator("#form-input-text-username");
  await usernameField.waitFor({ state: "visible", timeout: 15_000 });
  await usernameField.fill(username);
  await page.locator("#form-input-text-password").fill(password);
  await page
    .locator("form")
    .filter({ has: page.locator("#form-input-text-username") })
    .getByRole("button", { name: "Logga in", exact: true })
    .click();
  await page.locator("#user-button").waitFor({ state: "visible", timeout: 20_000 });
}

/**
 * Expands the leg's fares (readLeg does this while reading), chooses per prefs, then
 * re-tags the buttons to find the live key for the chosen fare -- readLeg's own return
 * value has no key on it, only the names and prices it read from the same click.
 */
async function pickLeg(
  page: Page,
  departureTime: string,
  leg: TripLeg,
  prefs: BookingPrefs
): Promise<{ choice: BookingChoice } | { fail: string }> {
  const read = await readLeg(page, departureTime, leg);
  if ("missing" in read) return { fail: read.missing };

  const choice = chooseBooking(read.offer, prefs);
  if (!choice) {
    return { fail: `Inget av de tillåtna biljettslagen/salongerna gick att boka för ${leg === "out" ? "utresan" : "returen"}.` };
  }

  const buttons = (await tagFareButtons(page)).filter(
    (b) => b.leg === leg && b.departure === departureTime && b.fare === choice.fare
  );
  if (buttons.length === 0) return { fail: `Hittade inte biljettknappen för ${choice.fare} igen.` };

  const picked = await selectSalong(page, buttons[0].key, choice.salong);
  if (!picked) return { fail: `Kunde inte klicka i salongen "${choice.salong}".` };

  return { choice };
}

/** "Boka nu" under Platsreservation, only when the watch asked for it -- never Båtbuss. */
async function handleSeatReservation(page: Page, wanted: boolean): Promise<void> {
  if (!wanted) return; // leaving every "Boka nu" unclicked is how this step is skipped
  const clicked = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h2")).find(
      (h) => (h.textContent || "").trim() === "Platsreservation"
    );
    if (!heading) return false;
    let card: HTMLElement | null = heading as HTMLElement;
    for (let i = 0; i < 8 && card; i++, card = card.parentElement) {
      const button = Array.from(card.querySelectorAll("button")).find(
        (b) => (b.textContent || "").trim() === "Boka nu"
      );
      if (button) {
        (button as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (clicked) await page.waitForTimeout(1000);
  else console.warn('  Hittade ingen "Boka nu"-knapp under Platsreservation.');
}

async function goPastTillval(page: Page, roundTrip: boolean, seatReservation: boolean): Promise<void> {
  await handleSeatReservation(page, seatReservation);
  if (roundTrip) {
    const returnTab = page.getByRole("tab", { name: "Returresa" });
    if (await returnTab.isVisible().catch(() => false)) {
      await returnTab.click();
      await page.waitForTimeout(800);
      await handleSeatReservation(page, seatReservation);
    }
  }
}

/** Fills "Mina sparade resenärer" for as many passenger slots as there are configured names. */
async function pickSavedPassengers(page: Page): Promise<void> {
  const names = (process.env.DG_PASSENGERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return; // nothing configured -- leave the passenger form for a human

  const selects = page.locator('[id^="form-select-coPassengers"]');
  const count = Math.min(await selects.count(), names.length);
  for (let i = 0; i < count; i++) {
    await selects.nth(i).click();
    await page.getByRole("option", { name: names[i], exact: true }).click();
    await page.waitForTimeout(400);
  }
}

/** Picks "Reskort" among whatever payment methods actually rendered, if it's offered. */
async function selectReskort(page: Page): Promise<{ picked: boolean; offered: string[] }> {
  const options = page.locator(".PaymentOptionSelector label");
  const offered: string[] = [];
  const count = await options.count();
  for (let i = 0; i < count; i++) offered.push((await options.nth(i).innerText()).trim());

  const reskort = options.filter({ hasText: "Reskort" });
  if ((await reskort.count()) === 0) return { picked: false, offered };

  const checked = (await reskort.first().getAttribute("class"))?.includes("Mui-checked");
  if (!checked) await reskort.first().click();
  return { picked: true, offered };
}

async function acceptTerms(page: Page): Promise<void> {
  const checkbox = page.locator("#checkbox-ApproveTermsAndConditions");
  if (!(await checkbox.isChecked())) {
    await page.locator('label[for="checkbox-ApproveTermsAndConditions"]').click();
  }
}

function dump(watchId: string, page: Page): Promise<{ screenshotPath: string; textDumpPath: string }> {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(DEBUG_DIR, `${watchId}-${stamp}-dryrun.png`);
  const textDumpPath = path.join(DEBUG_DIR, `${watchId}-${stamp}-dryrun.txt`);
  return page
    .screenshot({ path: screenshotPath, fullPage: true })
    .then(() => page.evaluate(() => (document.body as HTMLElement).innerText))
    .then((text) => {
      fs.writeFileSync(textDumpPath, text);
      return { screenshotPath, textDumpPath };
    });
}

/**
 * Runs the whole flow up to the checkout page. On success the browser is left open and
 * handed back in the result, with `cancel` as the only way this function's caller can
 * close it -- there is no path from here to Betala.
 */
export async function prepareBooking(watch: Watch): Promise<PreparedBooking | FailedBooking> {
  const headless = process.env.BOOKING_HEADLESS === "1";
  const browser: Browser = await chromium.launch({ headless, slowMo: headless ? 0 : 50 });
  const ctx: BrowserContext = await browser.newContext({
    locale: "sv-SE",
    viewport: { width: 1400, height: 1200 },
    storageState: loadConsentState(),
  });
  await ctx.addInitScript(() => {
    (globalThis as any).__name = (fn: unknown) => fn;
  });
  const page = await ctx.newPage();
  const cancel = async () => {
    await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  };

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await dismissConsent(page, ctx);
    await login(page);

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

    const out = await pickLeg(page, watch.departureTime, "out", watch.booking);
    if ("fail" in out) {
      const dumped = await dump(watch.id, page);
      await cancel();
      return { ok: false, detail: out.fail, ...dumped };
    }

    if (roundTrip) {
      const back = await pickLeg(page, watch.returnTime!, "return", watch.booking);
      if ("fail" in back) {
        const dumped = await dump(watch.id, page);
        await cancel();
        return { ok: false, detail: back.fail, ...dumped };
      }
    }

    await page.getByRole("button", { name: "Fortsätt" }).click();
    await page.waitForTimeout(2000);

    await pickSavedPassengers(page);
    await page.getByRole("button", { name: "Fortsätt" }).click();
    await page.waitForTimeout(2000);

    await goPastTillval(page, roundTrip, watch.booking.seatReservation);
    await page.getByRole("button", { name: "Fortsätt" }).click();
    await page.waitForTimeout(3000);

    const { picked, offered } = await selectReskort(page);
    await acceptTerms(page);

    const bodyText = await page.evaluate(() => (document.body as HTMLElement).innerText);
    const totalMatch = bodyText.match(/Att betala:?\s*\n?\s*([\d\s]+kr)/);
    const total = priceValue(totalMatch?.[1] ?? null);

    const betala = page.getByRole("button", { name: "Betala" });
    const betalaReady = await betala.isVisible().catch(() => false);

    const { screenshotPath, textDumpPath } = await dump(watch.id, page);

    if (!picked) {
      await cancel();
      return {
        ok: false,
        detail: `Reskort erbjöds inte som betalsätt (bara: ${offered.join(", ") || "inget alternativ hittades"}).`,
        screenshotPath,
        textDumpPath,
      };
    }
    if (watch.booking.maxPrice != null && total != null && total > watch.booking.maxPrice) {
      await cancel();
      return {
        ok: false,
        detail: `Totalpriset ${total} kr överstiger taket på ${watch.booking.maxPrice} kr.`,
        screenshotPath,
        textDumpPath,
      };
    }
    if (!betalaReady) {
      await cancel();
      return { ok: false, detail: "Kom fram till kassan men Betala-knappen syns inte.", screenshotPath, textDumpPath };
    }

    return {
      ok: true,
      watch,
      page,
      total,
      detail: `Redo att betala${total != null ? ` ${total} kr` : ""} med Reskort.`,
      screenshotPath,
      textDumpPath,
      cancel,
    };
  } catch (error) {
    const dumped = await dump(watch.id, page).catch(() => undefined);
    await cancel();
    return {
      ok: false,
      detail: `Flödet misslyckades: ${error instanceof Error ? error.message : String(error)}`,
      ...dumped,
    };
  }
}

/**
 * The only call to click() on the Betala button in this codebase. Only src/purchase.ts
 * calls it, from exactly two places: after an approved Discord user clicked "Godkänn köp"
 * on this prepared session inside the approval window, or -- with AUTO_BOOKING_UNATTENDED
 * on -- straight after prepareBooking returned ok. Never from the scraper, never from a
 * route, and never from `npm run book`, whatever the settings say.
 */
export async function pressBetala(prepared: PreparedBooking): Promise<DryRunResult> {
  const { page, watch } = prepared;
  try {
    await page.getByRole("button", { name: "Betala" }).click();
    await page.waitForTimeout(5000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 20_000 });
    } catch {
      /* payment redirects keep polling; the wait above is enough */
    }
    const { screenshotPath, textDumpPath } = await dump(watch.id, page);
    return { ok: true, detail: "Betala klickad -- se skärmdumpen för resultatet.", screenshotPath, textDumpPath };
  } finally {
    await prepared.cancel();
  }
}

/** Drives the flow to checkout and closes it unpressed -- for testing with `npm run book`. */
export async function runBookingDryRun(watch: Watch): Promise<DryRunResult> {
  const prepared = await prepareBooking(watch);
  if (!prepared.ok) return prepared;
  await prepared.cancel();
  return {
    ok: true,
    detail: `${prepared.detail} Betala har INTE klickats.`,
    screenshotPath: prepared.screenshotPath,
    textDumpPath: prepared.textDumpPath,
  };
}

async function main(): Promise<void> {
  const watchId = process.argv[2];
  if (!watchId) {
    console.error("Användning: npm run book -- <watchId>");
    process.exit(1);
  }
  const watch = getWatch(watchId);
  if (!watch) {
    console.error(`Ingen bevakning med id ${watchId}.`);
    process.exit(1);
  }
  if (!watch.booking.autoBook) {
    console.error(`${watch.label}: auto-bokning är avstängd för den här bevakningen.`);
    process.exit(1);
  }

  console.log(`Kör köpflödet för "${watch.label}" fram till kassan -- Betala klickas inte.`);
  const result = await runBookingDryRun(watch);
  console.log(result.ok ? "OK: " : "AVBRUTET: ", result.detail);
  if (result.screenshotPath) console.log(`Skärmdump: ${result.screenshotPath}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("booking.ts")) {
  void main();
}

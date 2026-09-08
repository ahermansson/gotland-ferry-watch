import cors from "cors";
import express from "express";
import path from "node:path";
import {
  createWatch,
  deleteWatch,
  getSettings,
  listWatches,
  saveBookingPrefs,
  saveSettings,
  setActive,
} from "./db.js";
import { getSchedulerState, rescheduleNow, runSingleCheck, startCycleNow } from "./scheduler.js";
import {
  BOOKABLE_SALONGS,
  DEFAULT_BOOKING_PREFS,
  FARE_CLASSES,
  ROUTES,
  SETTINGS_LIMITS,
  VEHICLE_LABELS,
  type NewWatchInput,
  type BookingPrefs,
  type FareClass,
  type NumericSetting,
  type Route,
  type Settings,
  type VehicleType,
} from "./types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
/** Stricter than TIME_RE: a settings window has to be a real clock time. */
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Reads the booking settings off a request. Everything is checked against the known fare
 * classes and lounges rather than trusted: these values end up driving a purchase, and a
 * typo that silently widened what may be bought is exactly the wrong kind of bug.
 *
 * A price cap is required once auto-booking is on. It can be set as high as you like, but
 * it cannot be absent — it is the one limit that holds when everything else misreads.
 */
function parseBookingPrefs(input: unknown, errors: string[]): BookingPrefs {
  const body = (input ?? {}) as Partial<Record<keyof BookingPrefs, unknown>>;
  const prefs: BookingPrefs = { ...DEFAULT_BOOKING_PREFS };

  if (body.autoBook !== undefined) prefs.autoBook = body.autoBook === true;

  if (body.fareOrder !== undefined) {
    const order = Array.isArray(body.fareOrder) ? body.fareOrder.map(String) : [];
    if (order.some((f) => !FARE_CLASSES.includes(f as FareClass))) errors.push("okänd biljettklass");
    if (new Set(order).size !== order.length) errors.push("biljettklass angiven flera gånger");
    prefs.fareOrder = order as FareClass[];
  }

  if (body.salongs !== undefined) {
    const salongs = Array.isArray(body.salongs) ? body.salongs.map(String) : [];
    if (salongs.some((s) => !BOOKABLE_SALONGS.includes(s as (typeof BOOKABLE_SALONGS)[number]))) {
      errors.push("okänd salong");
    }
    prefs.salongs = salongs;
  }

  if (body.maxPrice !== undefined && body.maxPrice !== null && body.maxPrice !== "") {
    const price = Number(body.maxPrice);
    if (!Number.isInteger(price) || price <= 0) errors.push("takpris måste vara ett positivt heltal");
    prefs.maxPrice = price;
  } else {
    prefs.maxPrice = null;
  }

  if (body.seatReservation !== undefined) prefs.seatReservation = body.seatReservation === true;

  if (prefs.autoBook) {
    if (prefs.fareOrder.length === 0) errors.push("autobokning kräver minst en biljettklass");
    if (prefs.salongs.length === 0) errors.push("autobokning kräver minst en salong");
    if (prefs.maxPrice === null) errors.push("autobokning kräver ett takpris");
  }

  return prefs;
}

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.resolve("public")));

  app.get("/api/options", (_req, res) => {
    res.json({
      routes: ROUTES,
      vehicles: VEHICLE_LABELS,
      fareClasses: FARE_CLASSES,
      salongs: BOOKABLE_SALONGS,
      bookingDefaults: DEFAULT_BOOKING_PREFS,
    });
  });

  app.get("/api/settings", (_req, res) => {
    res.json({ ...getSettings(), ...getSchedulerState(), limits: SETTINGS_LIMITS });
  });

  app.put("/api/settings", (req, res) => {
    const body = req.body as Partial<Record<keyof Settings, unknown>>;
    const current = getSettings();
    const errors: string[] = [];

    const parse = (key: NumericSetting): number => {
      if (body[key] === undefined) return current[key];
      const value = Number(body[key]);
      const { min, max } = SETTINGS_LIMITS[key];
      if (!Number.isInteger(value) || value < min || value > max) {
        errors.push(`${key} måste vara ett heltal ${min}–${max}`);
      }
      return value;
    };

    const parseTime = (key: "activeFrom" | "activeTo"): string => {
      if (body[key] === undefined) return current[key];
      const value = String(body[key]);
      if (!CLOCK_RE.test(value)) errors.push(`${key} måste vara HH:MM`);
      return value;
    };

    const settings = {
      intervalMinutes: parse("intervalMinutes"),
      jitterMinutes: parse("jitterMinutes"),
      activeFrom: parseTime("activeFrom"),
      activeTo: parseTime("activeTo"),
    };
    if (errors.length) {
      res.status(400).json({ error: errors.join(", ") });
      return;
    }

    const saved = saveSettings(settings);
    // Re-arm now, so a shortened interval doesn't wait out the pending one.
    rescheduleNow();
    res.json({ ...saved, ...getSchedulerState(), limits: SETTINGS_LIMITS });
  });

  app.get("/api/watches", (_req, res) => {
    res.json(listWatches());
  });

  app.post("/api/watches", (req, res) => {
    const body = req.body as Partial<NewWatchInput>;
    const errors: string[] = [];

    if (!body.label?.trim()) errors.push("label krävs");
    if (!body.route || !ROUTES.includes(body.route as Route)) errors.push("okänd route");
    if (!body.date || !DATE_RE.test(body.date)) errors.push("date måste vara YYYY-MM-DD");
    if (!body.departureTime || !TIME_RE.test(body.departureTime))
      errors.push("departureTime måste vara HH:MM");

    // Both halves or neither: half a return leg would search for a trip nobody asked for.
    const returnDate = body.returnDate?.trim() || null;
    const returnTime = body.returnTime?.trim() || null;
    if (!!returnDate !== !!returnTime) {
      errors.push("returresa kräver både returnDate och returnTime");
    }
    if (returnDate && !DATE_RE.test(returnDate)) errors.push("returnDate måste vara YYYY-MM-DD");
    if (returnTime && !TIME_RE.test(returnTime)) errors.push("returnTime måste vara HH:MM");
    if (returnDate && body.date && returnDate < body.date) {
      errors.push("returnDate kan inte vara före date");
    }

    const adults = body.adults === undefined ? 2 : Number(body.adults);
    if (!Number.isInteger(adults) || adults < 1 || adults > 9) errors.push("adults måste vara 1–9");

    const vehicle = (body.vehicle ?? "car-under-225") as VehicleType;
    if (!(vehicle in VEHICLE_LABELS)) errors.push("okänt fordon");

    const booking = parseBookingPrefs(body.booking, errors);

    if (errors.length) {
      res.status(400).json({ error: errors.join(", ") });
      return;
    }

    const watch = createWatch({
      label: body.label!.trim(),
      route: body.route as Route,
      date: body.date!,
      departureTime: body.departureTime!,
      returnDate,
      returnTime,
      adults,
      vehicle,
      booking,
    });
    // Adding a watch is the one action that earns a check straight away, rather than just
    // waking the idle scheduler and waiting out an interval to find out.
    startCycleNow();
    res.status(201).json(watch);
  });

  app.patch("/api/watches/:id", (req, res) => {
    const body = req.body as { active?: boolean; booking?: unknown };

    if (body.booking !== undefined) {
      const errors: string[] = [];
      const prefs = parseBookingPrefs(body.booking, errors);
      if (errors.length) {
        res.status(400).json({ error: errors.join(", ") });
        return;
      }
      saveBookingPrefs(req.params.id, prefs);
    }

    if (typeof body.active === "boolean") {
      setActive(req.params.id, body.active);
      // Switching one on starts the timer; switching the last one off stops it, so the
      // page stops counting down to a cycle that would have nothing to check.
      rescheduleNow();
    }
    res.status(204).end();
  });

  app.delete("/api/watches/:id", (req, res) => {
    deleteWatch(req.params.id);
    // Deleting the last active watch idles the scheduler, same as switching it off.
    rescheduleNow();
    res.status(204).end();
  });

  app.post("/api/watches/:id/check", async (req, res) => {
    let result;
    try {
      result = await runSingleCheck(req.params.id);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "watch not found" });
      return;
    }
    res.json(result);
  });

  return app;
}

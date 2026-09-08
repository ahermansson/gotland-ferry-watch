import cors from "cors";
import express from "express";
import path from "node:path";
import { createWatch, deleteWatch, getSettings, listWatches, saveSettings, setActive } from "./db.js";
import { getSchedulerState, rescheduleNow, runSingleCheck, startCycleNow } from "./scheduler.js";
import {
  ROUTES,
  SETTINGS_LIMITS,
  VEHICLE_LABELS,
  type NewWatchInput,
  type NumericSetting,
  type Route,
  type Settings,
  type VehicleType,
} from "./types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
/** Stricter than TIME_RE: a settings window has to be a real clock time. */
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.resolve("public")));

  app.get("/api/options", (_req, res) => {
    res.json({ routes: ROUTES, vehicles: VEHICLE_LABELS });
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

    const adults = body.adults === undefined ? 2 : Number(body.adults);
    if (!Number.isInteger(adults) || adults < 1 || adults > 9) errors.push("adults måste vara 1–9");

    const vehicle = (body.vehicle ?? "car-under-225") as VehicleType;
    if (!(vehicle in VEHICLE_LABELS)) errors.push("okänt fordon");

    if (errors.length) {
      res.status(400).json({ error: errors.join(", ") });
      return;
    }

    const watch = createWatch({
      label: body.label!.trim(),
      route: body.route as Route,
      date: body.date!,
      departureTime: body.departureTime!,
      adults,
      vehicle,
    });
    // Adding a watch is the one action that earns a check straight away, rather than just
    // waking the idle scheduler and waiting out an interval to find out.
    startCycleNow();
    res.status(201).json(watch);
  });

  app.patch("/api/watches/:id", (req, res) => {
    const { active } = req.body as { active?: boolean };
    if (typeof active === "boolean") {
      setActive(req.params.id, active);
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

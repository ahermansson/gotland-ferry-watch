import cors from "cors";
import express from "express";
import path from "node:path";
import { createWatch, deleteWatch, listWatches, setActive } from "./db.js";
import { runSingleCheck } from "./scheduler.js";
import { ROUTES, VEHICLE_LABELS, type NewWatchInput, type Route, type VehicleType } from "./types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.resolve("public")));

  app.get("/api/options", (_req, res) => {
    res.json({ routes: ROUTES, vehicles: VEHICLE_LABELS });
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
    res.status(201).json(watch);
  });

  app.patch("/api/watches/:id", (req, res) => {
    const { active } = req.body as { active?: boolean };
    if (typeof active === "boolean") {
      setActive(req.params.id, active);
    }
    res.status(204).end();
  });

  app.delete("/api/watches/:id", (req, res) => {
    deleteWatch(req.params.id);
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

import cors from "cors";
import express from "express";
import path from "node:path";
import { createWatch, deleteWatch, listWatches, setActive } from "./db.js";
import { runSingleCheck } from "./scheduler.js";
import type { NewWatchInput } from "./types.js";

export function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.resolve("public")));

  app.get("/api/watches", (_req, res) => {
    res.json(listWatches());
  });

  app.post("/api/watches", (req, res) => {
    const body = req.body as Partial<NewWatchInput>;
    if (!body.label || !body.origin || !body.destination || !body.date) {
      res.status(400).json({ error: "label, origin, destination and date are required" });
      return;
    }
    const watch = createWatch({
      label: body.label,
      origin: body.origin,
      destination: body.destination,
      date: body.date,
      time: body.time ?? null,
      searchUrl: body.searchUrl ?? null,
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

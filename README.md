# Gotland Ferry Watch

A small local tool that watches specific Destination Gotland ferry departures and pings a
Discord channel when a departure that was sold out has a spot open up.

It runs entirely on your own machine: a tiny local web page to add/remove watched
departures, a background job that checks them on a schedule, and a Discord webhook for
the notification.

## How it works

1. You add a "watch" (a departure you care about) via the local web UI.
2. Every `CHECK_INTERVAL_MINUTES` (default 10), the app loads that departure's page on
   destinationgotland.se in a headless browser and looks for text that indicates the
   departure is sold out vs. bookable.
3. If a watch flips from "full"/"unknown" to "available", you get a Discord message.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env`:
- `DISCORD_WEBHOOK_URL` — create one in Discord: **Server Settings → Integrations →
  Webhooks → New Webhook → Copy Webhook URL**.
- `CHECK_INTERVAL_MINUTES` — how often to check (keep this reasonable, e.g. 5–15 minutes,
  to avoid hammering destinationgotland.se — see "A note on scraping" below).

Start it:

```bash
npm start
```

Open http://localhost:3000.

## Adding a watch — and why the "Sökresultat-URL" field matters

destinationgotland.se's booking search form wasn't something I could inspect while
building this (the sandbox this was built in couldn't reach the site), so the app does
**not** try to fill in the search form for you. Instead:

1. Go to destinationgotland.se yourself and manually search for the route/date/time you
   want to watch, the same way you normally would when booking.
2. Once you're on the results page showing that specific departure, copy the URL from
   your browser's address bar.
3. Paste that URL into the "Sökresultat-URL" field when adding the watch in this app.

The app then just reloads that exact URL on a schedule and re-reads the page — much more
reliable than guessing at form fields and selectors.

If you leave the URL blank, the app will fall back to loading the homepage, which will
not find real availability — it's there so the app doesn't crash, not as a working
substitute. Debug artifacts (see below) will make this obvious if it happens.

## Calibrating the scraper

The "is this departure bookable?" check in `src/scraper.ts` is a text heuristic: it scans
the page for Swedish phrases like "fullbokad" / "slutsåld" (sold out) vs. words like
"boka" or a price (bookable). This has **not** been verified against the real site's
wording, so the first run needs a quick calibration pass:

1. Add one watch for a departure you know is **sold out**, and one for a departure you
   know has **space**.
2. Run `npm run dev` (or use the "Kolla nu" / "Check now" button in the UI) and check
   `debug/` — a screenshot (`.png`) and the raw page text (`.txt`) are saved automatically
   whenever the status comes back `unknown`, or always if `DEBUG_SCRAPER=1` is set in
   `.env`.
3. Compare the two text dumps and adjust `SOLD_OUT_PHRASES` / `BOOKABLE_HINTS` at the top
   of `src/scraper.ts` to match the actual wording the site uses.

Re-run the check after each tweak until both known cases resolve correctly.

## Running it continuously

This is a plain Node process (`npm start`), meant to be left running. Options:

- **tmux/screen**: `tmux new -s ferry-watch`, run `npm start`, detach.
- **pm2**: `npx pm2 start "npm start" --name ferry-watch`
- **systemd** (Linux) / **launchd** (macOS): wrap `npm start` in a service unit if you
  want it to survive reboots.

## A note on scraping

This tool automates loading pages on destinationgotland.se on a recurring schedule. It's
built for personal, low-frequency use (checking a handful of specific departures every
few minutes) — not for bulk scraping. Please:

- Keep `CHECK_INTERVAL_MINUTES` reasonable.
- Check destinationgotland.se's terms of use if you plan to rely on this long-term or run
  it more aggressively.
- Expect the scraper to break if the site's page structure or wording changes — it's
  reading page text, not calling an official API.

## Project structure

```
src/
  index.ts       entry point — starts the web server + scheduler
  server.ts      Express app + REST API for the UI
  scheduler.ts   cron loop that checks active watches
  scraper.ts     Playwright-based availability check (see "Calibrating" above)
  notifier.ts    Discord webhook sender
  db.ts          SQLite storage for watches
  types.ts       shared types
public/          the local web UI (plain HTML/CSS/JS, no build step)
```

## Data

Watches are stored in `data/watches.sqlite` (created automatically, gitignored).

# Gotland Ferry Watch

A small local tool that watches a specific Destination Gotland departure and pings a
Discord channel when a seat opens up — including *which* lounges and fare classes are
available.

It runs entirely on your own machine: a tiny local web page to add/remove watched
departures, a background job that checks them on a schedule, and a Discord webhook for
the notification.

## How it works

1. You add a "watch" (route, date, departure time, passengers, vehicle) via the local web UI.
2. Every 10–15 minutes (base interval plus jitter), the app drives the real booking flow on
   destinationgotland.se in a headless browser: dismiss the cookie banner, fill in the
   search widget, search, then expand each fare class on your departure and read the
   lounge rows.
3. If the watch flips from "full"/"unknown" to "available", you get a Discord message
   listing every bookable fare class and lounge.

### Why it drives the form instead of reloading a URL

The site's search is session-based: submitting the widget lands on
`/resa-sok-resultat/` with **no query parameters**, so a pasted result URL cannot be
replayed. Availability also isn't visible until a fare class is expanded — the results
table only shows Mini/Flexi/Flexi + with a price or *Slutsålt*; the lounges appear
underneath once you click one.

Both the fare classes and the lounges mark sold-out state the same way: a disabled
control reading *Slutsålt*, versus a price when bookable. The scraper reads that
structural signal rather than guessing at page wording.

## Return trips

A watch can follow both legs of a return trip: tick **Tur och retur** when adding it and
give the return date and departure. The site stacks both legs on one results page with
nothing but the text *Välj returresa* between them, so the scraper splits them on that
marker and tags every fare button with the leg it belongs to — without it a watch on 07:15
out would match the 07:15 coming back.

A return watch is only **available** when both legs have a bookable lounge. One leg alone
is a **partial** hit: you are told, since you may want to take the single, but the watch
keeps running. The leg is remembered, so the same half-open trip isn't announced every
cycle while the other leg opening still is.

## Auto-booking settings

A watch says which fare classes and which lounges it is watching for, and those are what
count as a hit: a watch for Försalong is not answered by a free Barnsalong, and the check
reports "det finns lediga platser, men inte i biljettklass/salong du bevakar" rather than
staying silent about why. The fare classes are ranked, best first.

Auto-booking adds exactly two things on top: a price cap for the whole trip, and whether
to buy the paid seat reservation. When it fires, the highest ranked bookable fare wins and
the cheapest permitted lounge is taken.

**All of it is decided when the watch is added, and none of it can be changed afterwards.**
Fare classes and lounges are part of the add form itself; ticking **Autoboka** reveals the
price cap and the seat reservation. A watch that auto-books carries a 🤖 on its row, and
the detail behind the row's arrow spells out what it may buy. There is no switch on the row
and `PATCH /api/watches/:id` refuses a `booking` body — an auto-booking that can be turned off from a table is one that can be turned off by
a mis-tap, and an auto-booking that is silently off is the failure this whole flow exists to
prevent. Changed your mind: delete the watch and add it again.

When a watch with **Auto** on finds an available departure — and the global
`AUTO_BOOKING_ENABLED` switch is also on — the scheduler drives the real flow: login, fare
and lounge selection per the watch's preferences, passengers from saved travellers,
skipping every paid add-on that wasn't asked for, selecting Reskort and accepting the
terms. It stops on the checkout page and **asks instead of buying**: a Discord bot (not
the webhook — a real bot connection, `DISCORD_BOT_TOKEN`) posts the prepared checkout with
a screenshot and a "Godkänn köp" / "Avbryt" button pair. The browser session is held open,
parked, until one of the ids in `DISCORD_APPROVERS` clicks — within `BOOKING_APPROVAL_MINUTES`,
after which it's dropped unpressed and the watch keeps running.

**Betala is only ever clicked in one place** (`pressBetala` in `src/booking.ts`), only
reachable from the approval click in `src/purchase.ts`. `npm run book -- <watchId>` runs
the same flow manually for testing and always closes the session unpressed — there is no
flag that makes it press Betala. A price cap is required before a watch's Auto switch can
be turned on at all: it is the one limit that still holds when everything else misreads.

## What it reports, and where

Two kinds of message go to Discord, and they are not the same thing.

A **notification** is the point of the watch: a seat opened, or a booking is prepared and
waiting for a click. It leads with `DISCORD_MENTION` so it reaches your phone.

A **report** is the app saying what it just did — and above all what it declined to do.
Auto-booking that didn't run and why, a check that crashed, a cycle where every check
failed and the interval is backing off, the approval bot failing to connect. These used to
be `console.warn` lines in a terminal nobody is looking at, which meant a watch that found
a seat and did not book it looked exactly like a watch that never got the chance. Reports
never mention anyone, and go to `DISCORD_LOG_WEBHOOK_URL` when it is set — otherwise to
the same webhook as the notifications.

`report()` in `src/notifier.ts` is the only way one is sent, and it always writes the
console line too, so the terminal stays the complete record. Repeats are throttled per
condition (one message an hour per watch and reason, so a single broken watch can't bury
the channel) and the throttle clears the moment the checks recover.

## The watch table

A row answers one question — which trip, and when — plus a 🤖 when the watch may buy it and
a dot for how it stands. The arrow on the left opens everything else about it: passengers,
vehicle, what counts as a hit, what it may pay, what the last check actually said, and the
controls (pause, check now, delete). A paused watch says so on the row itself, since that
is the one piece of state you would otherwise have to open a row to discover.

## Lounge priority

Lounges are grouped into tiers, shown in notifications as:

| Tier | Lounges | Marker |
|---|---|---|
| Preferred | Försalong, Aktersalong | ⭐ |
| Acceptable | Mittsalong | 👍 |
| Last resort | Barnsalong, Djursalong | ⚠️ |
| Other | Kupé (Utsides/Insides/Djur/HCP/Allergi) and anything new | – |

A watch counts as "available" when a fare class **it is watching** has a bookable lounge
**it is watching**; the message tells you which, so you can judge whether it's worth taking.
The tiers above only order and mark them — they do not decide the hit, the watch's own
choices do. Adjust the mapping in `SALONG_TIERS` in `src/types.ts`.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env`:
- `DISCORD_WEBHOOK_URL` — create one in Discord: **Server Settings → Integrations →
  Webhooks → New Webhook → Copy Webhook URL**. Treat it like a password.
- `DISCORD_MENTION` — a mention to lead each notification with, `@everyone` by default.
  Worth keeping: Discord holds back a plain message's mobile push while you look active on
  another client, and drops it altogether for a muted channel, so a notification can land
  in the channel without ever reaching your phone. A mention gets through both. Set it to
  `<@your-user-id>` to ping only yourself, or leave it empty for no mention. Only the
  mention set here can ping — nothing in the message body does.
- `CHECK_INTERVAL_MINUTES` / `CHECK_JITTER_MINUTES` — base interval plus random jitter,
  default 10 + 0–5, i.e. an actual interval of 10–15 minutes. These are the starting
  values only: once you save the interval in the web UI, the stored value wins and
  editing `.env` no longer changes it. See "Check interval" and "A note on scraping".
- `CHECK_WINDOW_FROM` / `CHECK_WINDOW_TO` — the daily window checks run in, default
  06:00–00:00. Seeds the UI setting the same way.
- `DEBUG_SCRAPER=1` — save a screenshot + text dump to `debug/` on every check. Failures
  and "departure not found" always dump, regardless of this setting.

Start it:

```bash
npm start
```

Open http://localhost:4000 (or whatever `PORT` you set).

## Adding a watch

Pick the route, date, departure time, number of adults and vehicle. The **departure time
must match the site's timetable exactly** (e.g. `07:15`) — if it doesn't, the check
reports which departures it did find, so you can correct it.

V1 supports one-way trips, adults (Vuxen 26+ år) only, and no vehicle / car under 2,25 m /
car over 2,25 m. Other passenger categories and vehicle types exist on the site but aren't
exposed yet.

## Check interval

The **Kontrollintervall** card at the bottom of the web UI sets how often the watches are
checked: a base interval in minutes plus a random jitter added on top, so `5` + `3` means
a check every 5–8 minutes. It also shows when the next check is due.

A countdown at the top of the page shows how long until the next cycle starts — a cycle
checks every active watch in turn, so once more than one watch is active there is no
single "next check" to count down to. Outside the window it shows the clock time the next
cycle starts instead, since that wait is hours rather than minutes.

The same card sets the daily window the checks run in (default 06:00–00:00, Swedish time —
nobody releases ferry tickets at 03:00, and nobody books one then either). Outside the
window the scheduler sleeps until it opens rather than waking up to do nothing, so a night
costs no requests at all. An end time before the start time is a window across midnight;
setting both to the same time turns the window off and checks run around the clock.
**Kolla nu** ignores the window — a manual check is always allowed.

Saving applies immediately — the pending timer is re-armed, so shortening the interval
doesn't wait out the old one. The value is stored in `data/watches.sqlite` and survives a
restart; `CHECK_INTERVAL_MINUTES` / `CHECK_JITTER_MINUTES` in `.env` only seed it on a
fresh install.

## Running it continuously

Several watches are checked one after another in the same cycle, and the interval is the
gap *between* cycles rather than a fixed period — so the more watches you add, the less
often each one is checked. With ~35 seconds per check plus 5–20 seconds between them,
three watches take around two minutes per cycle.

This is a plain Node process (`npm start`), meant to be left running. Options:

- **tmux/screen**: `tmux new -s ferry-watch`, run `npm start`, detach.
- **pm2**: `npx pm2 start "npm start" --name ferry-watch`
- **systemd** (Linux) / **launchd** (macOS): wrap `npm start` in a service unit if you
  want it to survive reboots.

## A note on scraping

This tool automates the booking flow on destinationgotland.se on a recurring schedule.
It's built for personal, low-frequency use (a handful of specific departures every few
minutes) — not for bulk scraping. Please:

- Keep the check interval reasonable. One check takes ~30–40 seconds per watch.
- Checks are spaced by the base interval plus random jitter, so they don't land on the
  same clock tick every hour, and they run sequentially — never in parallel. Inside a
  cycle the watches are spaced 5–20 seconds apart too, so several watches don't go out as
  one burst.
- Only one check runs at a time, whatever asked for it: **Kolla nu** queues behind the
  check in progress rather than opening a second session alongside a running cycle. It
  waits out one check, not the whole cycle.
- If every check in a cycle fails, the interval doubles (capped at 8×, so ~80–120 min)
  until one succeeds. If the site is pushing back, knocking at the same rate helps nobody.
- Checks pause outside the daily window (06:00–00:00 by default), so the site sees
  nothing from this tool overnight.
- The single biggest load reduction is that watches stop on their own: once a
  notification is delivered, and once the departure time has passed.
- Check destinationgotland.se's terms of use if you plan to rely on this long-term.
- Expect it to break if the site's widget changes — it depends on element ids like
  `#booking-widget-transport-button-1` and the `Slutsålt` wording.

The scraper (used by the scheduled checks) never logs in, never proceeds past lounge
selection, and never books anything. `npm run book` is a separate, manually-run tool that
does log in and drive a real purchase up to the checkout page — it is never triggered by
the scheduler.

## Project structure

```
src/
  index.ts       entry point — starts the web server + scheduler
  server.ts      Express app + REST API for the UI
  scheduler.ts   self-scheduling check loop, with jitter and failure backoff
  scraper.ts     Playwright booking-flow automation and availability parsing
  booking.ts     drives a real purchase to checkout; pressBetala is the only Betala click
  purchase.ts    Discord approval bot -- the only caller of pressBetala
  recon.ts       records a hand-driven run of the site (npm run recon)
  notifier.ts    Discord webhook sender (plain notifications, no buttons)
  db.ts          SQLite storage for watches
  types.ts       shared types, route/vehicle/lounge tables
public/          the local web UI (plain HTML/CSS/JS, no build step)
```

## Data

Watches are stored in `data/watches.sqlite`, and the cookie-consent cookie in
`data/consent-state.json` (both created automatically, gitignored). The pre-V1
search-URL schema is dropped automatically on first start.

/**
 * Builds the .ics attached to a purchase's Discord confirmation (src/purchase.ts). Each
 * leg becomes its own event, starting not at the boat's departure time but at when you
 * actually need to leave for the terminal -- the lead time is what decides your morning,
 * not the sailing itself.
 */
import { createEvents, type DateArray, type EventAttributes } from "ics";
import type { Route, TripLeg, Watch } from "./types.js";

/** Minutes needed at the terminal before departure. Oskarshamn is a guess -- that route
 * isn't actually used, it's here only so buildTripInvite never has nothing to fall back on. */
const DEPARTURE_LEAD_MINUTES: Record<string, number> = {
  Nynäshamn: 80,
  Visby: 100,
  Oskarshamn: 80,
};
const DEFAULT_LEAD_MINUTES = 80;
/** Used only if the site somehow didn't report an arrival time for the leg. */
const FALLBACK_DURATION_MINUTES = 3 * 60;

/** The city a leg departs *from* -- the second half of the route on the way back. */
function departureTerminal(route: Route, leg: TripLeg): string {
  const [from, to] = route.split("-");
  return leg === "out" ? from : to;
}

/**
 * The real UTC instant for a "YYYY-MM-DD" + "HH:MM" wall-clock reading in Stockholm.
 * `ics`'s own "local" input type means "whatever timezone this Node process happens to be
 * running in" -- correct on a laptop set to Europe/Stockholm, silently wrong on a server
 * whose TZ is UTC (the ordinary default), since every ferry time in this app is Swedish
 * local time regardless of where the process runs. Same offset-guessing trick as
 * `dayTimestamp` in scraper.ts, generalised from midnight to an arbitrary time of day.
 */
function stockholmToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  for (const offsetHours of [1, 2]) {
    const guess = new Date(Date.UTC(y, m - 1, d, h - offsetHours, min));
    const wallDate = guess.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
    const wallTime = guess.toLocaleTimeString("sv-SE", {
      timeZone: "Europe/Stockholm",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (wallDate === date && wallTime === time) return guess;
  }
  throw new Error(`Could not resolve Stockholm time for ${date} ${time}.`);
}

/**
 * The UTC instant `minutes` away from a Stockholm wall-clock reading, as a DateArray for
 * `ics` with `*InputType: "utc"` -- output the exact instant ourselves rather than trust
 * the library's ambiguous "local" to guess it from the host machine's timezone.
 */
function shiftMinutes(date: string, time: string, minutes: number): DateArray {
  const shifted = new Date(stockholmToUtc(date, time).getTime() + minutes * 60_000);
  return [
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
  ];
}

function buildLeg(
  watch: Watch,
  leg: TripLeg,
  date: string,
  departureTime: string,
  arrival: string | null
): EventAttributes {
  const terminal = departureTerminal(watch.route, leg);
  const lead = DEPARTURE_LEAD_MINUTES[terminal] ?? DEFAULT_LEAD_MINUTES;
  const [from, to] = leg === "out" ? watch.route.split("-") : [...watch.route.split("-")].reverse();
  const who = `${watch.adults} ${watch.adults === 1 ? "vuxen" : "vuxna"}`;

  return {
    title: `Färja ${from} → ${to}`,
    description: `Båten går kl ${departureTime} från ${terminal}. ${who}.`,
    location: terminal,
    // "utc" here means "the DateArray below already is UTC" (it is, via shiftMinutes) --
    // not "this event happens in UTC". A calendar app still renders it in the viewer's
    // own timezone, same as any other UTC-stamped event.
    start: shiftMinutes(date, departureTime, -lead),
    startInputType: "utc",
    end: arrival ? shiftMinutes(date, arrival, 0) : shiftMinutes(date, departureTime, FALLBACK_DURATION_MINUTES),
    endInputType: "utc",
  };
}

/**
 * One event for the outbound leg, plus a second for the return leg on a round trip.
 * Throws if `ics` itself can't produce a file -- that only happens on a malformed
 * EventAttributes object, which would be a bug here, not something a caller can recover
 * from meaningfully.
 */
export function buildTripInvite(watch: Watch, arrival: string | null, returnArrival: string | null): Buffer {
  const events: EventAttributes[] = [buildLeg(watch, "out", watch.date, watch.departureTime, arrival)];
  if (watch.returnDate && watch.returnTime) {
    events.push(buildLeg(watch, "return", watch.returnDate, watch.returnTime, returnArrival));
  }

  const { error, value } = createEvents(events);
  if (error || !value) throw error ?? new Error("ics gav ingen fil.");
  return Buffer.from(value, "utf-8");
}

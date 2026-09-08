/**
 * "partial" only happens on a return watch: one leg is bookable and the other is not. It
 * is worth telling you about — you may want to take the single — but it is not the hit
 * the watch is looking for, so the watch stays on.
 */
export type WatchStatus = "unknown" | "available" | "partial" | "full";

/** The four routes the booking widget offers. */
export type Route =
  | "Visby-Nynäshamn"
  | "Visby-Oskarshamn"
  | "Nynäshamn-Visby"
  | "Oskarshamn-Visby";

export const ROUTES: Route[] = [
  "Visby-Nynäshamn",
  "Visby-Oskarshamn",
  "Nynäshamn-Visby",
  "Oskarshamn-Visby",
];

/** Vehicle options we support in V1. `none` books as a foot passenger. */
export type VehicleType = "none" | "car-under-225" | "car-over-225";

export const VEHICLE_LABELS: Record<VehicleType, string> = {
  none: "Inget fordon",
  "car-under-225": "Personbil, under 2,25 m hög",
  "car-over-225": "Personbil, över 2,25 m hög",
};

/**
 * Preference tiers for the on-board lounges, per the V1 requirement:
 * Försalong/Aktersalong first, Mittsalong acceptable, Barnsalong/Djursalong only in a
 * pinch. Cabins ("Kupé …") and anything else the site adds fall into `other` — still
 * reported, but never treated as a preferred hit.
 */
export type SalongTier = "preferred" | "acceptable" | "last-resort" | "other";

export const SALONG_TIERS: Record<string, SalongTier> = {
  Försalong: "preferred",
  Aktersalong: "preferred",
  Mittsalong: "acceptable",
  Barnsalong: "last-resort",
  Djursalong: "last-resort",
};

export const TIER_ORDER: SalongTier[] = ["preferred", "acceptable", "last-resort", "other"];

/**
 * The lounges an auto-booking may be pointed at. Cabins are deliberately absent: they cost
 * several times a lounge seat, and nothing should buy one because a lounge sold out.
 */
export const BOOKABLE_SALONGS = [
  "Försalong",
  "Aktersalong",
  "Mittsalong",
  "Ekonomiplats",
  "Barnsalong",
  "Djursalong",
] as const;

/** The three fare classes, in the order the site lists them. */
export const FARE_CLASSES = ["Mini", "Flexi", "Flexi +"] as const;
export type FareClass = (typeof FARE_CLASSES)[number];

/**
 * What an auto-booking is allowed to buy for one watch. The fare classes are a ranked
 * list — the highest ranked one that can be booked wins, so refundability can outrank
 * price — while the lounges are a plain allowlist and the cheapest permitted one is taken.
 */
export interface BookingPrefs {
  /** Off until switched on, per watch, on top of the global switch. */
  autoBook: boolean;
  /** Ranked, best first. A class left out is never bought. */
  fareOrder: FareClass[];
  /** Unordered: whichever of these is cheapest gets booked. */
  salongs: string[];
  /** Total for the whole trip in kronor, both legs. Over it, the booking is abandoned. */
  maxPrice: number | null;
  /** Platsreservation, the paid seat add-on under Tillval. */
  seatReservation: boolean;
}

export const DEFAULT_BOOKING_PREFS: BookingPrefs = {
  autoBook: false,
  fareOrder: ["Mini", "Flexi", "Flexi +"],
  salongs: ["Försalong", "Aktersalong"],
  maxPrice: null,
  seatReservation: false,
};

export interface SalongOffer {
  name: string;
  price: string | null;
  soldOut: boolean;
  tier: SalongTier;
}

export interface FareOffer {
  /** "Mini", "Flexi" or "Flexi +" */
  fare: string;
  price: string | null;
  soldOut: boolean;
  salongs: SalongOffer[];
}

/** Which half of a return trip something belongs to. */
export type TripLeg = "out" | "return";

export interface DepartureOffer {
  /** Departure time as shown on the site, e.g. "07:15". */
  departure: string;
  arrival: string | null;
  fares: FareOffer[];
  /** Which half of the trip this is. One-way watches only ever produce "out". */
  leg: TripLeg;
}

export interface Watch {
  id: string;
  label: string;
  route: Route;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Departure time to watch, HH:MM as shown on the site. */
  departureTime: string;
  /** Return leg, both set or both null. Null means a one-way watch. */
  returnDate: string | null;
  returnTime: string | null;
  adults: number;
  vehicle: VehicleType;
  active: boolean;
  lastStatus: WatchStatus;
  lastCheckedAt: string | null;
  lastDetail: string | null;
  notifiedAt: string | null;
  /**
   * Which leg was free the last time a partial hit was reported, so the same half-open
   * trip isn't announced every five minutes — but the other leg opening still is.
   */
  partialNotifiedLeg: TripLeg | null;
  booking: BookingPrefs;
  createdAt: string;
}

export interface NewWatchInput {
  label: string;
  route: Route;
  date: string;
  departureTime: string;
  returnDate?: string | null;
  returnTime?: string | null;
  adults?: number;
  vehicle?: VehicleType;
  booking?: Partial<BookingPrefs>;
}

/** How often, and when, the scheduler runs a check cycle. Editable from the web UI. */
export interface Settings {
  /** Base minutes between cycles. */
  intervalMinutes: number;
  /** Random minutes added on top, so checks don't land on the same clock tick every hour. */
  jitterMinutes: number;
  /**
   * Daily window the checks run in, HH:MM in Europe/Stockholm — the timezone the
   * timetable is stated in. `activeTo` may be earlier than `activeFrom`, which reads as a
   * window across midnight; equal values mean no window at all, i.e. around the clock.
   */
  activeFrom: string;
  activeTo: string;
}

export const SETTINGS_LIMITS = {
  intervalMinutes: { min: 1, max: 240 },
  jitterMinutes: { min: 0, max: 60 },
} as const;

export type NumericSetting = keyof typeof SETTINGS_LIMITS;
export const TIME_SETTINGS = ["activeFrom", "activeTo"] as const;
export type TimeSetting = (typeof TIME_SETTINGS)[number];

export interface CheckResult {
  status: WatchStatus;
  detail: string;
  /** The matched departure, when the scrape got far enough to find it. */
  offer?: DepartureOffer;
  /** The return leg, on a return watch that got that far. */
  returnOffer?: DepartureOffer;
  screenshotPath?: string;
  textDumpPath?: string;
}

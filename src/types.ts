export type WatchStatus = "unknown" | "available" | "full";

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

export interface DepartureOffer {
  /** Departure time as shown on the site, e.g. "07:15". */
  departure: string;
  arrival: string | null;
  fares: FareOffer[];
}

export interface Watch {
  id: string;
  label: string;
  route: Route;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** Departure time to watch, HH:MM as shown on the site. */
  departureTime: string;
  adults: number;
  vehicle: VehicleType;
  active: boolean;
  lastStatus: WatchStatus;
  lastCheckedAt: string | null;
  lastDetail: string | null;
  notifiedAt: string | null;
  createdAt: string;
}

export interface NewWatchInput {
  label: string;
  route: Route;
  date: string;
  departureTime: string;
  adults?: number;
  vehicle?: VehicleType;
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
  screenshotPath?: string;
  textDumpPath?: string;
}

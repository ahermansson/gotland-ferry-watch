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

export interface CheckResult {
  status: WatchStatus;
  detail: string;
  /** The matched departure, when the scrape got far enough to find it. */
  offer?: DepartureOffer;
  screenshotPath?: string;
  textDumpPath?: string;
}

export type WatchStatus = "unknown" | "available" | "full";

export interface Watch {
  id: string;
  label: string;
  origin: string;
  destination: string;
  date: string;
  time: string | null;
  searchUrl: string | null;
  active: boolean;
  lastStatus: WatchStatus;
  lastCheckedAt: string | null;
  lastDetail: string | null;
  notifiedAt: string | null;
  createdAt: string;
}

export interface NewWatchInput {
  label: string;
  origin: string;
  destination: string;
  date: string;
  time?: string | null;
  searchUrl?: string | null;
}

export interface CheckResult {
  status: WatchStatus;
  detail: string;
  screenshotPath?: string;
  textDumpPath?: string;
}

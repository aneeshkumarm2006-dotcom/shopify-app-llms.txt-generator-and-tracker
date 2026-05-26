// Aggregation helpers for the tracking dashboard. PRD §7.4 / TODO Phase 5.
//
// Pure, framework-free utilities that take an array of `TrackingEvent`-shaped
// rows and roll them up by day / week / source / UTM. Pure so the dashboard
// loader can pull rows once and slice them multiple ways without re-querying,
// and so the logic is unit-testable without a database.
//
// Time is treated in **UTC** throughout. We don't have a per-shop timezone
// configured, and mixing the merchant's local zone with stored UTC timestamps
// would silently shift bucket boundaries. UTC also matches what Postgres
// stores, so charts line up with raw `tracking_events.occurred_at`.

export type Classification = "ai" | "other";

/** Minimal row shape the helpers need. A real `TrackingEvent` is a superset. */
export interface AggregateRow {
  classification: Classification;
  source: string | null;
  matchedBy: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrerDomain: string | null;
  landingPath: string | null;
  occurredAt: Date;
}

export interface DateRange {
  start: Date; // inclusive
  end: Date; // exclusive
}

export interface BucketPoint {
  /** ISO date (YYYY-MM-DD for day, Monday-anchored YYYY-MM-DD for week). */
  bucket: string;
  /** UTC midnight at the bucket start — handy for chart x-axis labels. */
  date: Date;
  count: number;
}

export interface SourceCount {
  source: string;
  count: number;
}

export interface KpiSummary {
  total: number;
  priorTotal: number;
  /** null when prior was zero — avoids `Infinity%` in the UI. */
  changePercent: number | null;
  changeAbsolute: number;
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

/**
 * Last N days ending at "now", with bucket boundaries snapped to UTC midnight.
 * `start` is the midnight `days` days ago; `end` is the next UTC midnight after
 * `now` so the current (partial) day is included exclusive of the next.
 */
export function rangeLastNDays(days: number, now: Date = new Date()): DateRange {
  if (days < 1) throw new Error("days must be >= 1");
  const end = startOfUtcDay(now);
  end.setUTCDate(end.getUTCDate() + 1); // exclusive upper bound = tomorrow 00:00
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end };
}

/**
 * The equal-length window immediately preceding `range`. Used for the KPI
 * "% change vs prior period" comparison.
 */
export function priorPeriod(range: DateRange): DateRange {
  const span = range.end.getTime() - range.start.getTime();
  return {
    start: new Date(range.start.getTime() - span),
    end: new Date(range.start.getTime()),
  };
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/**
 * Bucket events into one row per UTC day across `range`. Days with zero
 * events are filled with `count: 0` so chart x-axes stay continuous.
 */
export function bucketByDay(
  events: AggregateRow[],
  range: DateRange,
): BucketPoint[] {
  const buckets = new Map<string, number>();

  // Pre-seed every day in range with 0 so the line chart has no gaps.
  for (const day of iterateDays(range)) {
    buckets.set(isoDate(day), 0);
  }

  for (const event of events) {
    if (event.occurredAt < range.start || event.occurredAt >= range.end) continue;
    const key = isoDate(startOfUtcDay(event.occurredAt));
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }

  return Array.from(buckets.entries()).map(([bucket, count]) => ({
    bucket,
    date: new Date(`${bucket}T00:00:00.000Z`),
    count,
  }));
}

/**
 * Bucket events into ISO weeks (Monday-anchored). Each bucket key is the
 * YYYY-MM-DD of the Monday that starts the week. Weeks fully within the
 * range are zero-filled.
 */
export function bucketByWeek(
  events: AggregateRow[],
  range: DateRange,
): BucketPoint[] {
  const buckets = new Map<string, number>();

  let cursor = startOfUtcWeek(range.start);
  while (cursor < range.end) {
    buckets.set(isoDate(cursor), 0);
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + 7);
    cursor = next;
  }

  for (const event of events) {
    if (event.occurredAt < range.start || event.occurredAt >= range.end) continue;
    const key = isoDate(startOfUtcWeek(event.occurredAt));
    if (buckets.has(key)) {
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }

  return Array.from(buckets.entries()).map(([bucket, count]) => ({
    bucket,
    date: new Date(`${bucket}T00:00:00.000Z`),
    count,
  }));
}

// ---------------------------------------------------------------------------
// Source / UTM rollups
// ---------------------------------------------------------------------------

/** Count AI-classified events by canonical source (chatgpt, perplexity, …). */
export function aggregateAiBySource(events: AggregateRow[]): SourceCount[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.classification !== "ai") continue;
    const key = event.source ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

export interface UtmRow {
  source: string;
  medium: string;
  campaign: string;
  count: number;
}

/**
 * Group every event (not just AI) by the (utm_source, utm_medium,
 * utm_campaign) triple. Rows missing all three are bucketed under
 * "(no utm)" so the table is exhaustive. PRD §7.4: merchants want the
 * full picture, not just the AI cut.
 */
export function aggregateByUtm(events: AggregateRow[]): UtmRow[] {
  const counts = new Map<string, UtmRow>();
  for (const event of events) {
    const source = event.utmSource ?? "";
    const medium = event.utmMedium ?? "";
    const campaign = event.utmCampaign ?? "";
    const key = `${source}|${medium}|${campaign}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        source: source || "(none)",
        medium: medium || "(none)",
        campaign: campaign || "(none)",
        count: 1,
      });
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// KPI summary
// ---------------------------------------------------------------------------

/**
 * Headline KPI for the dashboard: total AI-referred visits in `range`,
 * compared to the immediately preceding equal-length window.
 *
 * Pass *both* event sets (current and prior). The caller already has them
 * loaded; we don't filter by date here so the helper stays trivially testable.
 */
export function summarizeAiKpi(
  currentEvents: AggregateRow[],
  priorEvents: AggregateRow[],
): KpiSummary {
  const total = currentEvents.filter((e) => e.classification === "ai").length;
  const priorTotal = priorEvents.filter((e) => e.classification === "ai").length;
  const changeAbsolute = total - priorTotal;
  // priorTotal===0 with total>0 is "infinite growth" — surface as null and
  // let the UI render "—" rather than "Infinity%".
  const changePercent =
    priorTotal === 0 ? null : (changeAbsolute / priorTotal) * 100;
  return { total, priorTotal, changeAbsolute, changePercent };
}

// ---------------------------------------------------------------------------
// Internal date utilities (UTC only — see file header)
// ---------------------------------------------------------------------------

export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

/** ISO-week anchor: Monday at 00:00 UTC. */
export function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  // getUTCDay: 0=Sun..6=Sat. Convert so Monday=0..Sunday=6.
  const isoDow = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - isoDow);
  return day;
}

export function isoDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function* iterateDays(range: DateRange): Generator<Date> {
  let cursor = startOfUtcDay(range.start);
  while (cursor < range.end) {
    yield cursor;
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next;
  }
}

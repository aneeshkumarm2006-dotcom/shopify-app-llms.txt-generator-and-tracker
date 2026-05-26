// Unit tests for the tracking aggregation helpers. Run via:
//
//   npm run test:aggregate
//
// Uses Node 20's built-in test runner (`node:test` + `node:assert`) plus tsx
// for TypeScript loading — no extra dev dependency required. Pure-function
// tests only; nothing here touches Prisma or the network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateAiBySource,
  aggregateByUtm,
  bucketByDay,
  bucketByWeek,
  isoDate,
  priorPeriod,
  rangeLastNDays,
  startOfUtcDay,
  startOfUtcWeek,
  summarizeAiKpi,
  type AggregateRow,
} from "./aggregate";

function event(overrides: Partial<AggregateRow>): AggregateRow {
  return {
    classification: "other",
    source: null,
    matchedBy: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    referrerDomain: null,
    landingPath: null,
    occurredAt: new Date("2026-05-15T12:00:00.000Z"),
    ...overrides,
  };
}

test("startOfUtcDay strips time-of-day in UTC", () => {
  const d = new Date("2026-05-15T13:45:21.123Z");
  assert.equal(startOfUtcDay(d).toISOString(), "2026-05-15T00:00:00.000Z");
});

test("startOfUtcWeek anchors to Monday 00:00 UTC", () => {
  // 2026-05-15 is a Friday.
  const friday = new Date("2026-05-15T12:00:00.000Z");
  assert.equal(startOfUtcWeek(friday).toISOString(), "2026-05-11T00:00:00.000Z");

  // Sunday rolls back to the Monday six days earlier (not forward).
  const sunday = new Date("2026-05-17T00:00:00.000Z");
  assert.equal(startOfUtcWeek(sunday).toISOString(), "2026-05-11T00:00:00.000Z");
});

test("isoDate emits YYYY-MM-DD", () => {
  assert.equal(isoDate(new Date("2026-05-15T00:00:00.000Z")), "2026-05-15");
});

test("rangeLastNDays spans the last N full days plus today", () => {
  const now = new Date("2026-05-15T08:30:00.000Z");
  const range = rangeLastNDays(7, now);
  // End is tomorrow midnight UTC.
  assert.equal(range.end.toISOString(), "2026-05-16T00:00:00.000Z");
  // Start is 7 days before end.
  assert.equal(range.start.toISOString(), "2026-05-09T00:00:00.000Z");
});

test("priorPeriod returns an equal-length window immediately before", () => {
  const range = {
    start: new Date("2026-05-09T00:00:00.000Z"),
    end: new Date("2026-05-16T00:00:00.000Z"),
  };
  const prior = priorPeriod(range);
  assert.equal(prior.start.toISOString(), "2026-05-02T00:00:00.000Z");
  assert.equal(prior.end.toISOString(), "2026-05-09T00:00:00.000Z");
  assert.equal(
    prior.end.getTime() - prior.start.getTime(),
    range.end.getTime() - range.start.getTime(),
  );
});

test("bucketByDay zero-fills empty days and counts hits per day", () => {
  const range = {
    start: new Date("2026-05-10T00:00:00.000Z"),
    end: new Date("2026-05-13T00:00:00.000Z"),
  };
  const events = [
    event({ occurredAt: new Date("2026-05-10T01:00:00.000Z") }),
    event({ occurredAt: new Date("2026-05-10T23:59:59.000Z") }),
    event({ occurredAt: new Date("2026-05-12T08:00:00.000Z") }),
  ];
  const buckets = bucketByDay(events, range);
  assert.deepEqual(
    buckets.map((b) => [b.bucket, b.count]),
    [
      ["2026-05-10", 2],
      ["2026-05-11", 0],
      ["2026-05-12", 1],
    ],
  );
});

test("bucketByDay excludes events outside the range", () => {
  const range = {
    start: new Date("2026-05-10T00:00:00.000Z"),
    end: new Date("2026-05-11T00:00:00.000Z"),
  };
  const events = [
    event({ occurredAt: new Date("2026-05-09T23:59:59.000Z") }), // before
    event({ occurredAt: new Date("2026-05-11T00:00:00.000Z") }), // exclusive end
    event({ occurredAt: new Date("2026-05-10T05:00:00.000Z") }), // in
  ];
  const buckets = bucketByDay(events, range);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].count, 1);
});

test("bucketByWeek groups by Monday anchor", () => {
  // Two weeks: Mon 2026-05-04 and Mon 2026-05-11.
  const range = {
    start: new Date("2026-05-04T00:00:00.000Z"),
    end: new Date("2026-05-18T00:00:00.000Z"),
  };
  const events = [
    event({ occurredAt: new Date("2026-05-05T00:00:00.000Z") }), // week 1
    event({ occurredAt: new Date("2026-05-10T23:00:00.000Z") }), // week 1 (Sun)
    event({ occurredAt: new Date("2026-05-12T00:00:00.000Z") }), // week 2
  ];
  const buckets = bucketByWeek(events, range);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].bucket, "2026-05-04");
  assert.equal(buckets[0].count, 2);
  assert.equal(buckets[1].bucket, "2026-05-11");
  assert.equal(buckets[1].count, 1);
});

test("aggregateAiBySource counts only AI events and sorts desc", () => {
  const events = [
    event({ classification: "ai", source: "chatgpt" }),
    event({ classification: "ai", source: "chatgpt" }),
    event({ classification: "ai", source: "perplexity" }),
    event({ classification: "other", source: "newsletter" }),
    event({ classification: "ai", source: null }), // falls into "unknown"
  ];
  const breakdown = aggregateAiBySource(events);
  assert.deepEqual(breakdown, [
    { source: "chatgpt", count: 2 },
    { source: "perplexity", count: 1 },
    { source: "unknown", count: 1 },
  ]);
});

test("aggregateByUtm includes non-AI sources and bucket empty triples", () => {
  const events = [
    event({ utmSource: "newsletter", utmMedium: "email", utmCampaign: "spring" }),
    event({ utmSource: "newsletter", utmMedium: "email", utmCampaign: "spring" }),
    event({ utmSource: "chatgpt", classification: "ai" }),
    event({}), // all null → "(none)" triple
  ];
  const rows = aggregateByUtm(events);
  assert.equal(rows[0].source, "newsletter");
  assert.equal(rows[0].count, 2);
  const noUtmRow = rows.find((r) => r.source === "(none)");
  assert.ok(noUtmRow, "expected a (none) row");
  assert.equal(noUtmRow!.count, 1);
});

test("summarizeAiKpi computes change vs prior period", () => {
  const current = [
    event({ classification: "ai" }),
    event({ classification: "ai" }),
    event({ classification: "ai" }),
    event({ classification: "other" }),
  ];
  const prior = [
    event({ classification: "ai" }),
    event({ classification: "other" }),
  ];
  const kpi = summarizeAiKpi(current, prior);
  assert.equal(kpi.total, 3);
  assert.equal(kpi.priorTotal, 1);
  assert.equal(kpi.changeAbsolute, 2);
  assert.equal(kpi.changePercent, 200);
});

test("summarizeAiKpi returns null changePercent when prior is zero", () => {
  const kpi = summarizeAiKpi(
    [event({ classification: "ai" })],
    [event({ classification: "other" })],
  );
  assert.equal(kpi.priorTotal, 0);
  assert.equal(kpi.changeAbsolute, 1);
  assert.equal(kpi.changePercent, null);
});

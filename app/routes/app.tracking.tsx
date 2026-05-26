// AI referral tracking dashboard. PRD §7.4 / TODO Phase 5.
//
// Single Polaris page that visualises everything the AI Referral Pixel has
// landed in `tracking_events` for the authenticated shop:
//
//   - headline KPI (AI-referred visits in range, vs prior equal period)
//   - source breakdown (canonical AI tools, sorted)
//   - daily trend line
//   - recent visits (paginated)
//   - full UTM rollup (all sources, not just AI)
//
// All aggregation is performed by pure helpers in app/lib/tracking/aggregate.ts
// so this route only owns presentation + query orchestration. State that
// affects the visualisations (date range, table page) is persisted in URL
// search params so refresh / back-button / share-link all work.

import { useCallback, useMemo } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import {
  Badge,
  BlockStack,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Layout,
  Page,
  Pagination,
  Select,
  Text,
  useIndexResourceState,
} from "@shopify/polaris";

import { PageErrorBoundary } from "../components/PageErrorBoundary";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  aggregateAiBySource,
  aggregateByUtm,
  bucketByDay,
  priorPeriod,
  rangeLastNDays,
  summarizeAiKpi,
  type AggregateRow,
  type BucketPoint,
  type DateRange,
  type KpiSummary,
  type SourceCount,
  type UtmRow,
} from "../lib/tracking/aggregate";

// Range presets we expose in the UI. Keep small and opinionated — anyone
// who wants finer slicing should export rather than scroll a dropdown.
const RANGE_PRESETS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "Last 365 days", value: "365" },
] as const;

const DEFAULT_RANGE_DAYS = 30;
const PAGE_SIZE = 25;

// Pretty labels for canonical AI source keys. Falls through to the raw key
// when we encounter a source the dashboard hasn't been taught about yet
// (e.g. a new entry added to ai-sources.ts before this map is updated).
const SOURCE_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  openai: "OpenAI",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
  anthropic: "Anthropic",
  copilot: "Copilot",
  "you.com": "You.com",
  phind: "Phind",
  unknown: "Unknown AI",
};

function labelForSource(key: string): string {
  return SOURCE_LABELS[key] ?? key;
}

function parseRangeDays(raw: string | null): number {
  const n = raw ? Number(raw) : NaN;
  return RANGE_PRESETS.some((p) => p.value === String(n))
    ? n
    : DEFAULT_RANGE_DAYS;
}

function parsePage(raw: string | null): number {
  const n = raw ? Math.floor(Number(raw)) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const days = parseRangeDays(url.searchParams.get("range"));
  const page = parsePage(url.searchParams.get("page"));

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  const range = rangeLastNDays(days);
  const prior = priorPeriod(range);

  if (!shop) {
    return emptyResponse(session.shop, days, range, prior, page);
  }

  // Pull both windows in parallel — small payloads, dashboards aren't worth
  // a clever cursor strategy at this size. Hard ceiling on `take` so a shop
  // with a runaway pixel doesn't blow up the loader.
  const [currentRows, priorRows, recentRows, totalRecent] = await Promise.all([
    prisma.trackingEvent.findMany({
      where: {
        shopId: shop.id,
        occurredAt: { gte: range.start, lt: range.end },
      },
      orderBy: { occurredAt: "desc" },
      take: 20_000,
      select: aggregateSelection,
    }),
    prisma.trackingEvent.findMany({
      where: {
        shopId: shop.id,
        occurredAt: { gte: prior.start, lt: prior.end },
      },
      take: 20_000,
      select: aggregateSelection,
    }),
    prisma.trackingEvent.findMany({
      where: {
        shopId: shop.id,
        occurredAt: { gte: range.start, lt: range.end },
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: recentSelection,
    }),
    prisma.trackingEvent.count({
      where: {
        shopId: shop.id,
        occurredAt: { gte: range.start, lt: range.end },
      },
    }),
  ]);

  const currentAgg = currentRows.map(rowToAggregate);
  const priorAgg = priorRows.map(rowToAggregate);

  return {
    shopDomain: session.shop,
    rangeDays: days,
    range: rangeToWire(range),
    prior: rangeToWire(prior),
    page,
    pageSize: PAGE_SIZE,
    totalRecent,
    kpi: summarizeAiKpi(currentAgg, priorAgg),
    trend: bucketByDay(
      currentAgg.filter((r) => r.classification === "ai"),
      range,
    ),
    sourceBreakdown: aggregateAiBySource(currentAgg),
    utmBreakdown: aggregateByUtm(currentAgg),
    recent: recentRows.map((r) => ({
      id: r.id,
      classification: r.classification,
      source: r.source,
      utmCampaign: r.utmCampaign,
      landingPath: r.landingPath,
      referrerDomain: r.referrerDomain,
      occurredAt: r.occurredAt.toISOString(),
    })),
    totalEventsInRange: currentAgg.length,
  };
};

const aggregateSelection = {
  classification: true,
  source: true,
  matchedBy: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  utmTerm: true,
  utmContent: true,
  referrerDomain: true,
  landingPath: true,
  occurredAt: true,
} as const;

const recentSelection = {
  id: true,
  classification: true,
  source: true,
  utmCampaign: true,
  landingPath: true,
  referrerDomain: true,
  occurredAt: true,
} as const;

function rowToAggregate(
  row: {
    classification: "ai" | "other";
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
  },
): AggregateRow {
  return row;
}

function rangeToWire(range: DateRange) {
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  };
}

function emptyResponse(
  shopDomain: string,
  days: number,
  range: DateRange,
  prior: DateRange,
  page: number,
) {
  return {
    shopDomain,
    rangeDays: days,
    range: rangeToWire(range),
    prior: rangeToWire(prior),
    page,
    pageSize: PAGE_SIZE,
    totalRecent: 0,
    kpi: {
      total: 0,
      priorTotal: 0,
      changeAbsolute: 0,
      changePercent: null,
    } satisfies KpiSummary,
    trend: bucketByDay([], range),
    sourceBreakdown: [] as SourceCount[],
    utmBreakdown: [] as UtmRow[],
    recent: [] as Array<{
      id: string;
      classification: "ai" | "other";
      source: string | null;
      utmCampaign: string | null;
      landingPath: string | null;
      referrerDomain: string | null;
      occurredAt: string;
    }>,
    totalEventsInRange: 0,
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

export default function TrackingDashboard() {
  const data = useLoaderData<LoaderData>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();

  const isLoading = navigation.state !== "idle";

  const onRangeChange = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("range", value);
      next.delete("page"); // reset pagination when range changes
      setSearchParams(next, { preventScrollReset: true });
    },
    [searchParams, setSearchParams],
  );

  const setPage = useCallback(
    (nextPage: number) => {
      const next = new URLSearchParams(searchParams);
      if (nextPage <= 1) {
        next.delete("page");
      } else {
        next.set("page", String(nextPage));
      }
      setSearchParams(next, { preventScrollReset: true });
    },
    [searchParams, setSearchParams],
  );

  const noEventsYet =
    data.totalEventsInRange === 0 && data.kpi.priorTotal === 0;

  return (
    <Page
      title="AI referral tracking"
      subtitle="Visits that landed on your store from AI assistants"
    >
      <ui-title-bar title="AI referral tracking" />

      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="300" align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Date range
                </Text>
                <div style={{ minWidth: 220 }}>
                  <Select
                    label="Date range"
                    labelHidden
                    options={RANGE_PRESETS.map((p) => ({
                      label: p.label,
                      value: p.value,
                    }))}
                    value={String(data.rangeDays)}
                    onChange={onRangeChange}
                    disabled={isLoading}
                  />
                </div>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Comparing against the prior {data.rangeDays}-day window.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <KpiCard kpi={data.kpi} rangeDays={data.rangeDays} />
        </Layout.Section>

        {noEventsYet ? (
          <Layout.Section>
            <Card>
              <EmptyState
                heading="No AI-referred visits yet"
                image=""
              >
                <p>
                  We haven&apos;t seen any AI-referred visits yet. Once your{" "}
                  <code>llms.txt</code> is discovered, traffic will appear
                  here.
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        ) : (
          <>
            <Layout.Section>
              <TrendCard trend={data.trend} rangeDays={data.rangeDays} />
            </Layout.Section>

            <Layout.Section variant="oneHalf">
              <SourceBreakdownCard breakdown={data.sourceBreakdown} />
            </Layout.Section>

            <Layout.Section variant="oneHalf">
              <ExplainerCard />
            </Layout.Section>

            <Layout.Section>
              <RecentVisitsCard
                rows={data.recent}
                page={data.page}
                pageSize={data.pageSize}
                total={data.totalRecent}
                onPageChange={setPage}
                disabled={isLoading}
              />
            </Layout.Section>

            <Layout.Section>
              <UtmBreakdownCard rows={data.utmBreakdown} />
            </Layout.Section>
          </>
        )}
      </Layout>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — kept in the same file because they're tightly coupled to
// the loader shape and not reused anywhere else.
// ---------------------------------------------------------------------------

function KpiCard({
  kpi,
  rangeDays,
}: {
  kpi: KpiSummary;
  rangeDays: number;
}) {
  const tone =
    kpi.changeAbsolute > 0
      ? "success"
      : kpi.changeAbsolute < 0
      ? "critical"
      : undefined;
  const changeLabel = formatChange(kpi);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          AI-referred visits
        </Text>
        <InlineStack gap="400" blockAlign="center" wrap>
          <Text as="p" variant="heading2xl">
            {kpi.total.toLocaleString()}
          </Text>
          {tone ? (
            <Badge tone={tone}>{changeLabel}</Badge>
          ) : (
            <Text as="span" variant="bodyMd" tone="subdued">
              {changeLabel}
            </Text>
          )}
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          vs {kpi.priorTotal.toLocaleString()} in the previous {rangeDays} days.
        </Text>
      </BlockStack>
    </Card>
  );
}

function formatChange(kpi: KpiSummary): string {
  const sign = kpi.changeAbsolute > 0 ? "+" : kpi.changeAbsolute < 0 ? "" : "±";
  const abs = `${sign}${kpi.changeAbsolute.toLocaleString()}`;
  if (kpi.changePercent === null) {
    return kpi.changeAbsolute === 0 ? "No change" : `${abs} (new)`;
  }
  const pct = `${kpi.changePercent > 0 ? "+" : ""}${kpi.changePercent.toFixed(1)}%`;
  return `${abs} (${pct})`;
}

function TrendCard({
  trend,
  rangeDays,
}: {
  trend: BucketPoint[];
  rangeDays: number;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Daily trend
        </Text>
        <TrendLine points={trend} />
        <Text as="p" variant="bodySm" tone="subdued">
          AI-referred visits per day across the last {rangeDays} days.
        </Text>
      </BlockStack>
    </Card>
  );
}

function TrendLine({ points }: { points: BucketPoint[] }) {
  const max = useMemo(
    () => Math.max(1, ...points.map((p) => p.count)),
    [points],
  );
  const width = 800;
  const height = 180;
  const padX = 32;
  const padY = 16;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  if (points.length === 0) {
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        No data in this range.
      </Text>
    );
  }

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const toX = (i: number) => padX + i * stepX;
  const toY = (count: number) => padY + innerH - (count / max) * innerH;

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.count).toFixed(1)}`)
    .join(" ");

  // Area fill for visual weight; same path closed back along the baseline.
  const areaPath = `${path} L ${toX(points.length - 1).toFixed(1)} ${(padY + innerH).toFixed(1)} L ${toX(0).toFixed(1)} ${(padY + innerH).toFixed(1)} Z`;

  const firstLabel = points[0]?.bucket;
  const lastLabel = points[points.length - 1]?.bucket;

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        role="img"
        aria-label={`Daily trend of AI-referred visits, peak ${max}`}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", maxWidth: width }}
      >
        <line
          x1={padX}
          y1={padY + innerH}
          x2={width - padX}
          y2={padY + innerH}
          stroke="#dde0e4"
          strokeWidth={1}
        />
        <path d={areaPath} fill="#2c6ecb" fillOpacity={0.12} />
        <path d={path} stroke="#2c6ecb" strokeWidth={2} fill="none" />
        {points.map((p, i) => (
          <circle
            key={p.bucket}
            cx={toX(i)}
            cy={toY(p.count)}
            r={p.count > 0 ? 2.5 : 1.5}
            fill="#2c6ecb"
          />
        ))}
        <text
          x={padX}
          y={height - 2}
          fontSize={11}
          fill="#6d7175"
        >
          {firstLabel}
        </text>
        <text
          x={width - padX}
          y={height - 2}
          fontSize={11}
          textAnchor="end"
          fill="#6d7175"
        >
          {lastLabel}
        </text>
        <text x={padX} y={padY - 4} fontSize={11} fill="#6d7175">
          peak {max.toLocaleString()}
        </text>
      </svg>
    </div>
  );
}

function SourceBreakdownCard({ breakdown }: { breakdown: SourceCount[] }) {
  const max = useMemo(
    () => Math.max(1, ...breakdown.map((b) => b.count)),
    [breakdown],
  );

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          By AI source
        </Text>
        {breakdown.length === 0 ? (
          <Text as="p" variant="bodyMd" tone="subdued">
            No AI-classified visits in this range.
          </Text>
        ) : (
          <BlockStack gap="200">
            {breakdown.map((row) => {
              const pct = (row.count / max) * 100;
              const label = labelForSource(row.source);
              return (
                <BlockStack key={row.source} gap="100">
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodyMd">
                      {label}
                    </Text>
                    <Text as="span" variant="bodyMd" tone="subdued">
                      {row.count.toLocaleString()}
                    </Text>
                  </InlineStack>
                  <div
                    role="img"
                    aria-label={`${label}: ${row.count.toLocaleString()} visits`}
                    style={{
                      width: "100%",
                      height: 8,
                      background: "#f1f2f4",
                      borderRadius: 4,
                    }}
                  >
                    <div
                      aria-hidden="true"
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: "#2c6ecb",
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </BlockStack>
              );
            })}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function ExplainerCard() {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          What is and isn&apos;t counted
        </Text>
        <Text as="p" variant="bodyMd">
          We count one row per browser session when the landing page carries a
          known AI <code>utm_source</code> (chatgpt, perplexity, gemini,
          claude, copilot…) or arrives from a known AI assistant domain.
        </Text>
        <Text as="p" variant="bodyMd" tone="subdued">
          We do <strong>not</strong> attribute revenue or sessions to AI tools,
          and we do not track repeat page views within a session. If a referrer
          is hidden by the AI client, that visit will not appear here.
        </Text>
      </BlockStack>
    </Card>
  );
}

function RecentVisitsCard({
  rows,
  page,
  pageSize,
  total,
  onPageChange,
  disabled,
}: {
  rows: LoaderData["recent"];
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (nextPage: number) => void;
  disabled: boolean;
}) {
  const resourceName = { singular: "visit", plural: "visits" };

  // We don't need bulk selection on this table, but Polaris IndexTable still
  // requires the resource-state hook to render headers correctly.
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(rows.map((r) => ({ id: r.id })));

  const hasPrev = page > 1;
  const hasNext = page * pageSize < total;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Recent visits
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {total === 0
              ? "0 visits in range"
              : `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()} of ${total.toLocaleString()}`}
          </Text>
        </InlineStack>

        <IndexTable
          resourceName={resourceName}
          itemCount={rows.length}
          selectedItemsCount={
            allResourcesSelected ? "All" : selectedResources.length
          }
          onSelectionChange={handleSelectionChange}
          selectable={false}
          headings={[
            { title: "Source" },
            { title: "Campaign" },
            { title: "Landing page" },
            { title: "Time" },
          ]}
          emptyState={
            <EmptyState
              heading="No visits on this page"
              image=""
            >
              <p>Try a wider date range, or go back to the first page.</p>
            </EmptyState>
          }
        >
          {rows.map((row, index) => (
            <IndexTable.Row
              key={row.id}
              id={row.id}
              position={index}
            >
              <IndexTable.Cell>
                {row.classification === "ai" ? (
                  <InlineStack gap="100" blockAlign="center">
                    <Badge tone="info">AI</Badge>
                    <Text as="span" variant="bodyMd">
                      {row.source ? labelForSource(row.source) : "Unknown"}
                    </Text>
                  </InlineStack>
                ) : (
                  <Text as="span" variant="bodyMd" tone="subdued">
                    {row.source || row.referrerDomain || "Direct"}
                  </Text>
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd">
                  {row.utmCampaign || "—"}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd">
                  {row.landingPath || "/"}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd" tone="subdued">
                  {formatRelative(row.occurredAt)}
                </Text>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>

        {total > pageSize ? (
          <InlineStack align="center">
            <Pagination
              hasPrevious={hasPrev && !disabled}
              onPrevious={() => onPageChange(page - 1)}
              hasNext={hasNext && !disabled}
              onNext={() => onPageChange(page + 1)}
              label={`Page ${page} of ${Math.max(1, Math.ceil(total / pageSize))}`}
            />
          </InlineStack>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function UtmBreakdownCard({ rows }: { rows: UtmRow[] }) {
  const resourceName = { singular: "row", plural: "rows" };
  const items = rows.map((r, i) => ({ ...r, id: `${i}-${r.source}-${r.medium}-${r.campaign}` }));

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            All UTM sources
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            Includes non-AI traffic so you can compare channels.
          </Text>
        </InlineStack>

        <IndexTable
          resourceName={resourceName}
          itemCount={items.length}
          selectable={false}
          headings={[
            { title: "Source" },
            { title: "Medium" },
            { title: "Campaign" },
            { title: "Visits" },
          ]}
          emptyState={
            <EmptyState
              heading="No UTM-tagged visits in this range"
              image=""
            >
              <p>
                Tagged links from emails, ads, and AI tools will land here once
                they arrive.
              </p>
            </EmptyState>
          }
        >
          {items.map((row, index) => (
            <IndexTable.Row key={row.id} id={row.id} position={index}>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd">
                  {row.source}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd">
                  {row.medium}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd">
                  {row.campaign}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodyMd" tone="subdued">
                  {row.count.toLocaleString()}
                </Text>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </BlockStack>
    </Card>
  );
}

function formatRelative(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function ErrorBoundary() {
  return <PageErrorBoundary pageTitle="AI referral tracking" />;
}

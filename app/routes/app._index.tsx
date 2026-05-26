// Home dashboard. PRD §11.1 / TODO Phase 5.
//
// Two cards: a welcome / quick-links tile and the 30-day AI-referral
// headline that deep-links into /app/tracking. The headline reuses the same
// aggregation helpers as the full dashboard so the two are guaranteed to
// agree on the number.

import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { PageErrorBoundary } from "../components/PageErrorBoundary";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  priorPeriod,
  rangeLastNDays,
  summarizeAiKpi,
  type AggregateRow,
  type KpiSummary,
} from "../lib/tracking/aggregate";

const HOME_WINDOW_DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  const range = rangeLastNDays(HOME_WINDOW_DAYS);
  const prior = priorPeriod(range);

  if (!shop) {
    return {
      kpi: {
        total: 0,
        priorTotal: 0,
        changeAbsolute: 0,
        changePercent: null,
      } satisfies KpiSummary,
      hasFile: false,
    };
  }

  const [currentRows, priorRows, fileExists] = await Promise.all([
    prisma.trackingEvent.findMany({
      where: {
        shopId: shop.id,
        classification: "ai",
        occurredAt: { gte: range.start, lt: range.end },
      },
      take: 20_000,
      select: { classification: true },
    }),
    prisma.trackingEvent.findMany({
      where: {
        shopId: shop.id,
        classification: "ai",
        occurredAt: { gte: prior.start, lt: prior.end },
      },
      take: 20_000,
      select: { classification: true },
    }),
    prisma.llmsFile.findUnique({
      where: { shopId: shop.id },
      select: { id: true },
    }),
  ]);

  const toAgg = (rows: Array<{ classification: "ai" | "other" }>): AggregateRow[] =>
    rows.map((r) => ({
      classification: r.classification,
      source: null,
      matchedBy: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      referrerDomain: null,
      landingPath: null,
      occurredAt: new Date(),
    }));

  return {
    kpi: summarizeAiKpi(toAgg(currentRows), toAgg(priorRows)),
    hasFile: Boolean(fileExists),
  };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

export default function Index() {
  const { kpi, hasFile } = useLoaderData<LoaderData>();
  return (
    <Page>
      <ui-title-bar title="Davnoot LLMs Generator" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Welcome
              </Text>
              <Text as="p" variant="bodyMd">
                Davnoot generates a plain-text summary of your store
                (<code>llms.txt</code>) so AI assistants like ChatGPT, Claude
                and Perplexity can represent your store accurately when
                shoppers ask about you.
              </Text>
              <InlineStack gap="200">
                <Link to="/app/llms">
                  <Button variant="primary">
                    {hasFile ? "Open llms.txt editor" : "Generate llms.txt"}
                  </Button>
                </Link>
                <Link to="/app/tracking">
                  <Button>View AI referrals</Button>
                </Link>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                AI referrals · last 30 days
              </Text>
              <InlineStack gap="300" blockAlign="center" wrap>
                <Text as="p" variant="heading2xl">
                  {kpi.total.toLocaleString()}
                </Text>
                <ChangeBadge kpi={kpi} />
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                vs {kpi.priorTotal.toLocaleString()} in the previous 30 days.
              </Text>
              <Link to="/app/tracking">
                <Button variant="plain">See full breakdown →</Button>
              </Link>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return <PageErrorBoundary pageTitle="Home" />;
}

function ChangeBadge({ kpi }: { kpi: KpiSummary }) {
  if (kpi.changeAbsolute === 0 && kpi.priorTotal === 0) {
    return (
      <Text as="span" variant="bodyMd" tone="subdued">
        No data yet
      </Text>
    );
  }
  const tone =
    kpi.changeAbsolute > 0
      ? "success"
      : kpi.changeAbsolute < 0
      ? "critical"
      : undefined;
  const sign = kpi.changeAbsolute > 0 ? "+" : "";
  const abs = `${sign}${kpi.changeAbsolute.toLocaleString()}`;
  const pct =
    kpi.changePercent === null
      ? "new"
      : `${kpi.changePercent > 0 ? "+" : ""}${kpi.changePercent.toFixed(0)}%`;
  const label = `${abs} (${pct})`;
  return tone ? (
    <Badge tone={tone}>{label}</Badge>
  ) : (
    <Text as="span" variant="bodyMd" tone="subdued">
      {label}
    </Text>
  );
}

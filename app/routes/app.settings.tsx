// Settings + repair page. PRD §12.6 / TODO Phase 6.
//
// Read-only view of the app's configuration on this shop:
//
//   - Public llms.txt URL + the proxy subpath we declared in shopify.app.toml.
//   - Access scopes the install was granted (read from process.env.SCOPES so
//     the page stays in sync with the toml without an Admin API round-trip).
//   - Web pixel install status, with a "Reinstall web pixel" repair button
//     that re-runs ensureWebPixel against the Admin API. Useful when a
//     merchant deletes the pixel from their Customer Events admin by hand.
//   - Billing posture — currently always "Free (MVP)" because PRD §12.6 ships
//     billing disabled. The label is driven by isBillingEnabled() so flipping
//     the env var lights this up without code changes.

import { useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Link as PolarisLink,
  Page,
  Text,
  TextField,
  useBreakpoints,
} from "@shopify/polaris";

import { PageErrorBoundary } from "../components/PageErrorBoundary";
import prisma from "../db.server";
import { isBillingEnabled } from "../lib/billing";
import { ensureWebPixel } from "../lib/shopify/web-pixel";
import { authenticate } from "../shopify.server";

interface RepairResult {
  ok: boolean;
  error?: string;
  created?: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: {
      proxyPath: true,
      redirectId: true,
      webPixelId: true,
      status: true,
    },
  });

  return {
    shopDomain: session.shop,
    publicUrl: `https://${session.shop}/llms.txt`,
    proxyPath: shop?.proxyPath ?? "/apps/llms",
    scopes: (process.env.SCOPES ?? "").split(",").filter(Boolean),
    redirectInstalled: Boolean(shop?.redirectId),
    pixelInstalled: Boolean(shop?.webPixelId),
    billingEnabled: isBillingEnabled(),
    status: shop?.status ?? "active",
  };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

// POST /app/settings — `intent=reinstall-pixel` re-runs ensureWebPixel.
// Kept as a same-route action so the page can `useFetcher` against itself
// without a sibling resource route.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "reinstall-pixel") {
    return Response.json(
      { ok: false, error: "Unknown intent." } satisfies RepairResult,
      { status: 400 },
    );
  }

  const shopRow = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true, webPixelId: true },
  });
  if (!shopRow) {
    return Response.json(
      { ok: false, error: "Shop is not installed." } satisfies RepairResult,
      { status: 409 },
    );
  }

  try {
    const { webPixelId, created } = await ensureWebPixel(admin, session.shop);
    if (shopRow.webPixelId !== webPixelId) {
      await prisma.shop.update({
        where: { id: shopRow.id },
        data: { webPixelId },
      });
    }
    return Response.json(
      { ok: true, created } satisfies RepairResult,
      { status: 200 },
    );
  } catch (err) {
    console.error(`[app.settings] reinstall pixel failed for ${session.shop}:`, err);
    return Response.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Could not reinstall the web pixel. Try again in a moment.",
      } satisfies RepairResult,
      { status: 500 },
    );
  }
};

export default function SettingsPage() {
  const data = useLoaderData<LoaderData>();
  const repairFetcher = useFetcher<RepairResult>();
  const breakpoints = useBreakpoints();

  const repairing = repairFetcher.state !== "idle";
  const repairResult =
    repairFetcher.state === "idle" ? repairFetcher.data ?? null : null;

  const onReinstallPixel = useCallback(() => {
    repairFetcher.submit(
      { intent: "reinstall-pixel" },
      { method: "post", action: "/app/settings" },
    );
  }, [repairFetcher]);

  return (
    <Page
      title="Settings"
      subtitle="Configuration and repair tools for your install"
    >
      <ui-title-bar title="Settings" />

      <Layout>
        {repairResult?.ok ? (
          <Layout.Section>
            <Banner
              title={
                repairResult.created
                  ? "Web pixel installed"
                  : "Web pixel already up to date"
              }
              tone="success"
              onDismiss={() => undefined}
            >
              <p>AI referral tracking is active for this store.</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {repairResult && !repairResult.ok ? (
          <Layout.Section>
            <Banner title="Web pixel repair failed" tone="critical">
              <p>{repairResult.error ?? "Try again in a moment."}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Public file
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                AI crawlers fetch your llms.txt from this address. The redirect
                from <code>/llms.txt</code> to{" "}
                <code>{data.proxyPath}</code> is installed automatically — if
                it ever goes missing, reinstall the app from your Shopify admin
                to repair it.
              </Text>
              <TextField
                label="Public URL"
                labelHidden
                value={data.publicUrl}
                autoComplete="off"
                readOnly
                onChange={() => undefined}
              />
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={data.redirectInstalled ? "success" : "warning"}>
                  {data.redirectInstalled ? "Redirect active" : "Redirect missing"}
                </Badge>
                <Text as="span" variant="bodySm" tone="subdued">
                  Proxy path: <code>{data.proxyPath}</code>
                </Text>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Scopes
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Permissions this install was granted. Changes require a fresh
                OAuth flow.
              </Text>
              <InlineStack gap="200" wrap>
                {data.scopes.length === 0 ? (
                  <Text as="span" variant="bodyMd" tone="subdued">
                    No scopes configured.
                  </Text>
                ) : (
                  data.scopes.map((scope) => (
                    <Badge key={scope}>{scope}</Badge>
                  ))
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack
                gap="300"
                align="space-between"
                blockAlign={breakpoints.smUp ? "center" : "start"}
                wrap
              >
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    AI referral pixel
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Tracks one row per browser session when a visitor lands
                    from a known AI assistant. No personal data is stored.
                  </Text>
                </BlockStack>
                <Badge tone={data.pixelInstalled ? "success" : "warning"}>
                  {data.pixelInstalled ? "Installed" : "Not installed"}
                </Badge>
              </InlineStack>
              <Box>
                <Button
                  onClick={onReinstallPixel}
                  loading={repairing}
                  disabled={repairing}
                >
                  {data.pixelInstalled
                    ? "Reinstall web pixel"
                    : "Install web pixel"}
                </Button>
              </Box>
              <Text as="p" variant="bodySm" tone="subdued">
                Use this if you removed the pixel from Customer Events in your
                Shopify admin and want it back.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Plan
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={data.billingEnabled ? "info" : "success"}>
                  {data.billingEnabled ? "Pro" : "Free"}
                </Badge>
                <Text as="span" variant="bodyMd" tone="subdued">
                  {data.billingEnabled
                    ? "You are on the Pro plan."
                    : "Davnoot is free while we are in MVP."}
                </Text>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Support
              </Text>
              <Text as="p" variant="bodyMd">
                Found a bug, or need help? Reach us at{" "}
                <PolarisLink url="mailto:support@davnoot.com">
                  support@davnoot.com
                </PolarisLink>
                .
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return <PageErrorBoundary pageTitle="Settings" />;
}

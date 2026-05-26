// Shared error boundary for embedded admin routes. PRD §11 / TODO Phase 6.
//
// Shopify's `boundary.error(useRouteError())` is required for OAuth bounce
// pages and 401/410 reauthentication flows — without it, a thrown Response
// from authenticate.admin() never reaches App Bridge. We delegate to it
// first (it returns its own Response component when the error is one Shopify
// owns) and only fall through to our friendly page when it returns
// `undefined`, which is what happens for plain runtime errors.

import { useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  BlockStack,
  Box,
  Button,
  Card,
  Layout,
  Link as PolarisLink,
  Page,
  Text,
} from "@shopify/polaris";

interface Props {
  // Page title shown in the breadcrumb-style heading. Falls back to a
  // generic label when the caller doesn't pass one.
  pageTitle?: string;
}

function reload() {
  if (typeof window !== "undefined") window.location.reload();
}

export function PageErrorBoundary({ pageTitle }: Props = {}) {
  const error = useRouteError();
  // boundary.error returns a React node Shopify-owned (e.g. for the embedded
  // auth bounce). If it returns something truthy, render that — otherwise
  // fall through to our friendly card.
  const shopifyBoundary = boundary.error(error);
  if (shopifyBoundary) return shopifyBoundary;

  const message =
    error instanceof Error
      ? error.message
      : "An unexpected error occurred while loading this page.";

  return (
    <Page title={pageTitle ?? "Something went wrong"}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                We could not load this page
              </Text>
              <Text as="p" variant="bodyMd">
                {message}
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Try reloading. If the problem keeps happening, email{" "}
                <PolarisLink url="mailto:support@davnoot.com">
                  support@davnoot.com
                </PolarisLink>{" "}
                and we&apos;ll take a look.
              </Text>
              <Box>
                <Button onClick={reload}>Reload page</Button>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

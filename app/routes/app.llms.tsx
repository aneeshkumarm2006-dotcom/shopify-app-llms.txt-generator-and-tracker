// Editor UI for the generated llms.txt file. PRD §11.2.
//
// Single Polaris page wired to four sibling resource routes:
//   - /app/llms/save        — persist a manual edit
//   - /app/llms/regenerate  — enqueue a new Claude generation
//   - /app/llms/restore     — swap content ↔ previous_content
//   - /app/llms/status      — polled every 3s while a job is in flight
//
// Action submissions are made via useFetcher. React Router 7 automatically
// revalidates this route's loader after each non-GET fetcher submission, so
// the page picks up fresh content / job state without a manual reload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
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
  Modal,
  Page,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

import { PageErrorBoundary } from "../components/PageErrorBoundary";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

// Mirror the cap used by generate.ts so a manual edit cannot push the file
// past what the public proxy is willing to serve.
const MAX_BODY_BYTES = 80_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { llmsFile: true },
  });

  const latestJob = shop
    ? await prisma.generationJob.findFirst({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          error: true,
          createdAt: true,
          completedAt: true,
        },
      })
    : null;

  return {
    shopDomain: session.shop,
    // The file is served via the Shopify App Proxy at this storefront path
    // (default /apps/llms). It is NOT at /llms.txt — Shopify serves its own
    // native agent file there, so advertising /llms.txt was misleading.
    publicUrl: `https://${session.shop}${shop?.proxyPath ?? "/apps/llms"}`,
    file: shop?.llmsFile
      ? {
          content: shop.llmsFile.content,
          version: shop.llmsFile.version,
          source: shop.llmsFile.source,
          updatedAt: shop.llmsFile.updatedAt.toISOString(),
          hasPrevious: Boolean(shop.llmsFile.previousContent),
        }
      : null,
    latestJob: latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          error: latestJob.error,
          createdAt: latestJob.createdAt.toISOString(),
          completedAt: latestJob.completedAt?.toISOString() ?? null,
        }
      : null,
    maxBytes: MAX_BODY_BYTES,
  };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

interface ActionResult {
  ok: boolean;
  error?: string;
  reason?: "cooldown" | "monthly_cap" | "validation" | "no_previous" | "no_file";
}

interface StatusResult {
  jobId: string | null;
  status: "queued" | "running" | "done" | "failed" | null;
  error: string | null;
  completedAt: string | null;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function LlmsEditor() {
  const data = useLoaderData<LoaderData>();
  const { file, latestJob, publicUrl, maxBytes } = data;

  const saveFetcher = useFetcher<ActionResult>();
  const regenFetcher = useFetcher<ActionResult>();
  const restoreFetcher = useFetcher<ActionResult>();
  const statusFetcher = useFetcher<StatusResult>();
  const revalidator = useRevalidator();

  const [draft, setDraft] = useState(file?.content ?? "");
  const [savedAtVersion, setSavedAtVersion] = useState(file?.version ?? 0);
  const [regenOpen, setRegenOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [copyOk, setCopyOk] = useState(false);

  // When the loader brings in a different version (after save / restore /
  // regeneration completes), reset the local draft so we don't keep showing
  // stale text that the user already committed.
  useEffect(() => {
    if (!file) return;
    if (file.version !== savedAtVersion) {
      setDraft(file.content);
      setSavedAtVersion(file.version);
    }
  }, [file, savedAtVersion]);

  const jobInFlight =
    latestJob?.status === "queued" || latestJob?.status === "running";

  // PRD §11.2 / TODO step "poll the job status every 3s via a Remix useFetcher
  // until done." Only run while a job is in flight; bail out cleanly if the
  // status flips to done / failed so we trigger one final revalidation.
  const lastPolledStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!jobInFlight) return;
    const id = setInterval(() => {
      statusFetcher.load("/app/llms/status");
    }, 3000);
    return () => clearInterval(id);
  }, [jobInFlight, statusFetcher]);

  useEffect(() => {
    if (statusFetcher.state !== "idle" || !statusFetcher.data) return;
    const polled = statusFetcher.data;
    if (polled.status && polled.status !== lastPolledStatus.current) {
      lastPolledStatus.current = polled.status;
      if (polled.status === "done" || polled.status === "failed") {
        revalidator.revalidate();
      }
    }
  }, [statusFetcher.state, statusFetcher.data, revalidator]);

  const draftBytes = useMemo(() => byteLength(draft), [draft]);
  const tooLarge = draftBytes > maxBytes;
  const draftDirty = file ? draft !== file.content : draft.length > 0;

  const onSave = useCallback(() => {
    if (tooLarge) return;
    saveFetcher.submit(
      { content: draft },
      { method: "post", action: "/app/llms/save", encType: "application/x-www-form-urlencoded" },
    );
  }, [draft, saveFetcher, tooLarge]);

  const onRegenerate = useCallback(() => {
    setRegenOpen(false);
    regenFetcher.submit(
      {},
      { method: "post", action: "/app/llms/regenerate" },
    );
  }, [regenFetcher]);

  const onRestore = useCallback(() => {
    setRestoreOpen(false);
    restoreFetcher.submit(
      {},
      { method: "post", action: "/app/llms/restore" },
    );
  }, [restoreFetcher]);

  const onCopyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2500);
    } catch {
      // Clipboard permission can be denied inside embedded iframes — leave
      // the field selectable so merchants can copy manually.
    }
  }, [publicUrl]);

  const saving = saveFetcher.state !== "idle";
  const regenerating =
    regenFetcher.state !== "idle" ||
    jobInFlight; // disable until the worker finishes
  const restoring = restoreFetcher.state !== "idle";

  const saveError =
    saveFetcher.state === "idle" && saveFetcher.data && !saveFetcher.data.ok
      ? saveFetcher.data.error ?? "Save failed."
      : null;

  const regenError =
    regenFetcher.state === "idle" && regenFetcher.data && !regenFetcher.data.ok
      ? regenFetcher.data.error ?? "Could not start regeneration."
      : null;

  const restoreError =
    restoreFetcher.state === "idle" &&
    restoreFetcher.data &&
    !restoreFetcher.data.ok
      ? restoreFetcher.data.error ?? "Restore failed."
      : null;

  const lastJobFailed = latestJob?.status === "failed";

  return (
    <Page
      title="llms.txt"
      subtitle="The file AI assistants read to learn about your store"
    >
      <ui-title-bar title="llms.txt editor" />

      <Layout>
        {lastJobFailed && !regenError ? (
          <Layout.Section>
            <Banner
              title="Last generation failed"
              tone="critical"
              action={{
                content: "Try again",
                onAction: () => setRegenOpen(true),
                disabled: regenerating,
              }}
            >
              <p>
                {latestJob?.error ??
                  "Claude could not produce a valid llms.txt. Try regenerating."}
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        {regenError ? (
          <Layout.Section>
            <Banner
              title="Could not start regeneration"
              tone="critical"
              action={{
                content: "Try again",
                onAction: () => setRegenOpen(true),
              }}
            >
              <p>{regenError}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {saveError ? (
          <Layout.Section>
            <Banner title="Save failed" tone="critical">
              <p>{saveError}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {restoreError ? (
          <Layout.Section>
            <Banner title="Restore failed" tone="critical">
              <p>{restoreError}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {jobInFlight ? (
          <Layout.Section>
            <Banner title="Generating…" tone="info">
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" accessibilityLabel="Generating" />
                <Text as="span" variant="bodyMd">
                  Claude is rebuilding your llms.txt from the latest store
                  content. This usually takes under a minute.
                </Text>
              </InlineStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  File contents
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  {file ? (
                    <Badge
                      tone={file.source === "manual_edit" ? "info" : "success"}
                    >
                      {file.source === "manual_edit"
                        ? "Manual edit"
                        : "Generated"}
                    </Badge>
                  ) : null}
                  {file ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      v{file.version} · last updated {formatTimestamp(file.updatedAt)}
                    </Text>
                  ) : (
                    <Text as="span" variant="bodySm" tone="subdued">
                      No file yet
                    </Text>
                  )}
                </InlineStack>
              </InlineStack>

              <TextField
                label="llms.txt"
                labelHidden
                multiline={20}
                autoComplete="off"
                value={draft}
                onChange={setDraft}
                disabled={saving || restoring || !file}
                monospaced
                helpText={`${draftBytes.toLocaleString()} / ${maxBytes.toLocaleString()} bytes${
                  draftDirty ? " · unsaved changes" : ""
                }`}
                error={
                  tooLarge
                    ? `File exceeds the ${maxBytes.toLocaleString()}-byte limit.`
                    : undefined
                }
              />

              <InlineStack gap="200" align="start">
                <Button
                  variant="primary"
                  onClick={onSave}
                  loading={saving}
                  disabled={!file || !draftDirty || tooLarge || regenerating}
                >
                  Save
                </Button>
                <Button
                  onClick={() => setRegenOpen(true)}
                  loading={regenerating}
                  disabled={regenerating || saving || restoring}
                >
                  Regenerate
                </Button>
                <Button
                  tone="critical"
                  variant="tertiary"
                  onClick={() => setRestoreOpen(true)}
                  disabled={
                    !file ||
                    !file.hasPrevious ||
                    regenerating ||
                    saving ||
                    restoring
                  }
                  loading={restoring}
                >
                  Restore previous
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Public URL
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  AI crawlers fetch your file from this address.
                </Text>
                <TextField
                  label="Public URL"
                  labelHidden
                  value={publicUrl}
                  autoComplete="off"
                  readOnly
                  onChange={() => {}}
                />
                <InlineStack gap="200">
                  <Button onClick={onCopyUrl}>
                    {copyOk ? "Copied" : "Copy URL"}
                  </Button>
                  <Button
                    url={publicUrl}
                    target="_blank"
                    accessibilityLabel="Open public URL in a new tab"
                  >
                    Open
                  </Button>
                </InlineStack>
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    overflow: "hidden",
                    clip: "rect(0 0 0 0)",
                  }}
                >
                  {copyOk ? "URL copied to clipboard" : ""}
                </div>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  What is llms.txt?
                </Text>
                <Text as="p" variant="bodyMd">
                  A plain-text summary of your store written for AI assistants
                  like ChatGPT, Claude, and Perplexity. They read this file
                  instead of crawling every product page, so your store gets
                  represented accurately.
                </Text>
                <Box>
                  <PolarisLink
                    url="https://llmstxt.org"
                    target="_blank"
                    accessibilityLabel="Learn more about the llms.txt specification"
                  >
                    Learn more about the llms.txt spec
                  </PolarisLink>
                </Box>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={regenOpen}
        onClose={() => setRegenOpen(false)}
        title="Regenerate llms.txt?"
        primaryAction={{
          content: "Regenerate",
          onAction: onRegenerate,
          destructive: true,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setRegenOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              Regenerating will overwrite the current file with a freshly
              generated version. Any manual edits you have not exported will
              be lost.
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              You can recover the previous version with the “Restore previous”
              button after regeneration finishes.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title="Restore the previous version?"
        primaryAction={{
          content: "Restore",
          onAction: onRestore,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setRestoreOpen(false) },
        ]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            This swaps the current file with the previous version. The version
            you are replacing will become the new “previous” snapshot, so you
            can swap back if needed.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  return <PageErrorBoundary pageTitle="llms.txt" />;
}

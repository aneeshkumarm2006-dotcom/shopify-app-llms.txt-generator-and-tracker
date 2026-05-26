// Billing scaffold — intentionally disabled. PRD §12.6 / TODO Phase 6.
//
// Davnoot LLMs Generator ships free at MVP. The paid tier (PRD §18.1) is a
// post-launch decision, so this file exists to declare the shape we expect
// when we flip the switch — not to enable billing today.
//
// To turn billing on later:
//   1. Set BILLING_REQUIRED=true in the host env.
//   2. Pass `buildBillingConfig()` into `shopifyApp({ billing: ... })` in
//      shopify.server.ts (currently commented out there).
//   3. Wire a billing gate in the admin loader (`authenticate.admin` returns
//      `billing` once the SDK is configured — call billing.require()).
//
// Keeping this entirely off the shopifyApp() options object means
// `authenticate.admin` will not attempt to enforce any plan — the editor and
// tracking dashboard stay free.

import { BillingInterval } from "@shopify/shopify-api";
import type {
  BillingConfigOneTimePlan,
  BillingConfigSubscriptionLineItemPlan,
} from "@shopify/shopify-api";

// Matches @shopify/shopify-app-react-router's internal
// `BillingConfigWithLineItems` type, which is declared but not exported.
type BillingConfig = Record<
  string,
  BillingConfigOneTimePlan | BillingConfigSubscriptionLineItemPlan
>;

// Future plan id — referenced from a single place so the env flag, the
// requireBilling() call, and the listing form stay in sync.
export const PRO_PLAN = "Pro" as const;

// Read at process boot. Defaults to false so a missing env var keeps the app
// free, even in production. We never read the env var inline elsewhere — all
// billing decisions route through this module.
export function isBillingEnabled(): boolean {
  return process.env.BILLING_REQUIRED === "true";
}

/**
 * Returns the billing config we'll eventually pass to shopifyApp(). Returns
 * `undefined` while billing stays disabled, so the helper is safe to spread
 * into the options object without a conditional.
 *
 * The numbers below are placeholders — finalize against the PRD §18.1 plan
 * sheet before flipping BILLING_REQUIRED=true in production.
 */
export function buildBillingConfig(): BillingConfig | undefined {
  if (!isBillingEnabled()) return undefined;
  return {
    [PRO_PLAN]: {
      lineItems: [
        {
          amount: 9,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  };
}

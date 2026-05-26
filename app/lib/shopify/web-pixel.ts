// Register / deregister the AI Referral Pixel via the Shopify Admin API.
// PRD §7, §12.4.
//
// The pixel itself lives in extensions/ai-referral-pixel and is published
// with the app via `shopify app deploy`. webPixelCreate tells Shopify to
// instantiate that extension on a specific shop's storefront with our
// settings (here: the shop domain, so the pixel knows which `shop` to
// report). One pixel row per shop — calling create twice is rejected by
// the Admin API, so we look up an existing pixel first.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Settings JSON must serialise into one of the field types declared in
// shopify.extension.toml — here `accountID` (single_line_text_field).
interface PixelSettings {
  accountID: string;
}

const FIND_PIXELS_QUERY = /* GraphQL */ `
  query FindWebPixels {
    webPixel {
      id
      settings
    }
  }
`;

interface FindPixelsResult {
  webPixel: { id: string; settings: string } | null;
}

const CREATE_PIXEL_MUTATION = /* GraphQL */ `
  mutation CreateWebPixel($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel {
        id
        settings
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CreatePixelResult {
  webPixelCreate: {
    webPixel: { id: string; settings: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

const UPDATE_PIXEL_MUTATION = /* GraphQL */ `
  mutation UpdateWebPixel($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      webPixel {
        id
        settings
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface UpdatePixelResult {
  webPixelUpdate: {
    webPixel: { id: string; settings: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

const DELETE_PIXEL_MUTATION = /* GraphQL */ `
  mutation DeleteWebPixel($id: ID!) {
    webPixelDelete(id: $id) {
      deletedWebPixelId
      userErrors {
        field
        message
      }
    }
  }
`;

interface DeletePixelResult {
  webPixelDelete: {
    deletedWebPixelId: string | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

async function gql<T>(
  admin: AdminApiContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(
      `Shopify Admin GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!payload.data) {
    throw new Error("Shopify Admin GraphQL returned no data");
  }
  return payload.data;
}

export interface EnsureWebPixelResult {
  webPixelId: string;
  created: boolean;
}

/**
 * Idempotent: returns the existing pixel's id if one already exists for this
 * shop, otherwise creates a fresh one with the given settings. If a pixel
 * exists but its settings drift from what we want, updates in place.
 *
 * Safe to call on every install and on re-auth.
 */
export async function ensureWebPixel(
  admin: AdminApiContext,
  shopDomain: string,
): Promise<EnsureWebPixelResult> {
  const settings: PixelSettings = { accountID: shopDomain };
  // Settings is a JSON-encoded string per the Admin API contract.
  const settingsJson = JSON.stringify(settings);

  const existing = await gql<FindPixelsResult>(admin, FIND_PIXELS_QUERY);
  if (existing.webPixel) {
    // Compare existing settings; only call update if they drift. The Admin
    // API returns settings as a JSON string already.
    if (existing.webPixel.settings !== settingsJson) {
      const updated = await gql<UpdatePixelResult>(
        admin,
        UPDATE_PIXEL_MUTATION,
        { id: existing.webPixel.id, webPixel: { settings: settingsJson } },
      );
      const userErrors = updated.webPixelUpdate.userErrors;
      if (userErrors.length > 0) {
        throw new Error(
          `webPixelUpdate failed: ${userErrors.map((e) => e.message).join("; ")}`,
        );
      }
    }
    return { webPixelId: existing.webPixel.id, created: false };
  }

  const created = await gql<CreatePixelResult>(admin, CREATE_PIXEL_MUTATION, {
    webPixel: { settings: settingsJson },
  });

  const userErrors = created.webPixelCreate.userErrors;
  if (userErrors.length > 0) {
    // "Already exists" / duplicate race — re-query and return the existing id.
    const isDuplicate = userErrors.some((e) =>
      /already (exists|been taken)|duplicate/i.test(e.message),
    );
    if (isDuplicate) {
      const retry = await gql<FindPixelsResult>(admin, FIND_PIXELS_QUERY);
      if (retry.webPixel) {
        return { webPixelId: retry.webPixel.id, created: false };
      }
    }
    throw new Error(
      `webPixelCreate failed: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }

  const pixel = created.webPixelCreate.webPixel;
  if (!pixel) {
    throw new Error("webPixelCreate returned no pixel");
  }

  return { webPixelId: pixel.id, created: true };
}

/**
 * Delete the web pixel on uninstall. Tolerates a missing pixel (returns
 * true so callers can stay idempotent). Phase 6's uninstall handler will
 * call this.
 */
export async function deleteWebPixel(
  admin: AdminApiContext,
  webPixelId: string,
): Promise<boolean> {
  const result = await gql<DeletePixelResult>(admin, DELETE_PIXEL_MUTATION, {
    id: webPixelId,
  });

  const userErrors = result.webPixelDelete.userErrors;
  if (userErrors.length > 0) {
    const alreadyGone = userErrors.some((e) =>
      /not found|does not exist/i.test(e.message),
    );
    if (alreadyGone) return true;
    throw new Error(
      `webPixelDelete failed: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  return result.webPixelDelete.deletedWebPixelId !== null;
}

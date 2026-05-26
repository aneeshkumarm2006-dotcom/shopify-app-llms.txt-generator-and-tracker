// Create / clean up the storefront URL redirect that points /llms.txt at
// /apps/llms (the App Proxy subpath). PRD §6.4, §12.3.
//
// Why a redirect instead of a route file: Shopify storefronts do not let an
// app register a top-level path like /llms.txt — only theme files (which we
// can't write without theme scope) or URL redirects (which we can, with
// write_content). The crawler hits /llms.txt, gets a 302 to /apps/llms, and
// the App Proxy fronts /apps/llms with our /proxy/llms loader.
//
// All callers go through this module so the duplicate-detection logic
// (urlRedirects query) lives in exactly one place.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const REDIRECT_PATH = "/llms.txt";
const REDIRECT_TARGET = "/apps/llms";

// Look up an existing redirect from /llms.txt by path. Shopify lets you
// `query: "path:'/llms.txt'"` on the urlRedirects connection. Returns the
// redirect's gid if one is already present.
const FIND_REDIRECT_QUERY = /* GraphQL */ `
  query FindLlmsRedirect($query: String!) {
    urlRedirects(first: 5, query: $query) {
      edges {
        node {
          id
          path
          target
        }
      }
    }
  }
`;

interface FindRedirectResult {
  urlRedirects: {
    edges: Array<{
      node: { id: string; path: string; target: string };
    }>;
  };
}

const CREATE_REDIRECT_MUTATION = /* GraphQL */ `
  mutation CreateLlmsRedirect($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect {
        id
        path
        target
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CreateRedirectResult {
  urlRedirectCreate: {
    urlRedirect: { id: string; path: string; target: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

const DELETE_REDIRECT_MUTATION = /* GraphQL */ `
  mutation DeleteLlmsRedirect($id: ID!) {
    urlRedirectDelete(id: $id) {
      deletedUrlRedirectId
      userErrors {
        field
        message
      }
    }
  }
`;

interface DeleteRedirectResult {
  urlRedirectDelete: {
    deletedUrlRedirectId: string | null;
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

export interface EnsureRedirectResult {
  redirectId: string;
  created: boolean;
}

// Idempotent: returns the existing redirect id if one already points at our
// target, otherwise creates a new one. Safe to call on every install and on
// re-auth.
export async function ensureLlmsRedirect(
  admin: AdminApiContext,
): Promise<EnsureRedirectResult> {
  // Shopify's `query` arg here uses their search syntax. Path matches are
  // exact when wrapped in single quotes.
  const lookup = await gql<FindRedirectResult>(admin, FIND_REDIRECT_QUERY, {
    query: `path:'${REDIRECT_PATH}'`,
  });

  const existing = lookup.urlRedirects.edges
    .map((edge) => edge.node)
    .find((node) => node.path === REDIRECT_PATH);

  if (existing) {
    return { redirectId: existing.id, created: false };
  }

  const created = await gql<CreateRedirectResult>(
    admin,
    CREATE_REDIRECT_MUTATION,
    {
      urlRedirect: { path: REDIRECT_PATH, target: REDIRECT_TARGET },
    },
  );

  const userErrors = created.urlRedirectCreate.userErrors;
  if (userErrors.length > 0) {
    // "Path has already been taken" is the only userError we treat as
    // recoverable — it means another concurrent install raced us. Re-query
    // to pick up the existing id rather than failing.
    const isDuplicate = userErrors.some((e) =>
      e.message.toLowerCase().includes("already been taken"),
    );
    if (isDuplicate) {
      const retry = await gql<FindRedirectResult>(admin, FIND_REDIRECT_QUERY, {
        query: `path:'${REDIRECT_PATH}'`,
      });
      const recovered = retry.urlRedirects.edges
        .map((edge) => edge.node)
        .find((node) => node.path === REDIRECT_PATH);
      if (recovered) {
        return { redirectId: recovered.id, created: false };
      }
    }
    throw new Error(
      `urlRedirectCreate failed: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }

  const redirect = created.urlRedirectCreate.urlRedirect;
  if (!redirect) {
    throw new Error("urlRedirectCreate returned no redirect");
  }

  return { redirectId: redirect.id, created: true };
}

// Delete the redirect on uninstall. Returns true if deletion succeeded or the
// redirect was already gone; throws on any other failure. Safe to call with
// a stale id — Shopify treats a missing id as a no-op userError that we
// treat as success.
export async function deleteLlmsRedirect(
  admin: AdminApiContext,
  redirectId: string,
): Promise<boolean> {
  const result = await gql<DeleteRedirectResult>(
    admin,
    DELETE_REDIRECT_MUTATION,
    { id: redirectId },
  );

  const userErrors = result.urlRedirectDelete.userErrors;
  if (userErrors.length > 0) {
    const alreadyGone = userErrors.some((e) =>
      /not found|does not exist/i.test(e.message),
    );
    if (alreadyGone) return true;
    throw new Error(
      `urlRedirectDelete failed: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  return result.urlRedirectDelete.deletedUrlRedirectId !== null;
}

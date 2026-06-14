// Paginated GraphQL queries against the Shopify Admin API to pull every piece
// of content that feeds the llms.txt generator. PRD §6.2: products,
// collections, pages, policies, blog articles, and the shop profile.
//
// This file is deliberately framework-agnostic: it accepts an `AdminApiContext`
// (the same shape returned by `authenticate.admin(request)` and
// `unauthenticated.admin(shop)`), so the same fetcher is callable from a
// Remix loader, the afterAuth hook, or the BullMQ worker.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Soft caps. We do not need a literally complete catalog dump in the brief —
// PRD §6.2 says "summarise rather than dump". Anything beyond the cap shows up
// as a name-only link in the brief's link index. Tunable without changing
// callers.
const MAX_PRODUCTS = 250;
const MAX_COLLECTIONS = 100;
const MAX_PAGES = 50;
const MAX_BLOG_ARTICLES = 100;
const PAGE_SIZE = 50;

export interface ShopProfile {
  name: string;
  description: string | null;
  primaryDomain: string;
  email: string | null;
  contactEmail: string | null;
}

export interface ProductSummary {
  id: string;
  title: string;
  handle: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  description: string | null;
  priceRange: {
    min: string;
    max: string;
    currencyCode: string;
  } | null;
  status: string;
}

export interface CollectionSummary {
  id: string;
  title: string;
  handle: string;
  description: string | null;
}

export interface PageSummary {
  id: string;
  title: string;
  handle: string;
  bodySummary: string | null;
}

export interface PolicySummary {
  id: string;
  title: string;
  url: string;
  body: string | null;
}

export interface BlogArticleSummary {
  id: string;
  title: string;
  handle: string;
  blogHandle: string;
  summary: string | null;
}

export interface StoreData {
  shop: ShopProfile;
  products: ProductSummary[];
  productCount: number;
  collections: CollectionSummary[];
  collectionCount: number;
  pages: PageSummary[];
  policies: PolicySummary[];
  blogArticles: BlogArticleSummary[];
  blogArticleCount: number;
}

// Truncate body text aggressively before we even leave Shopify — we do not
// want full HTML bodies in memory or in the Claude prompt.
function truncate(body: string | null | undefined, max = 400): string | null {
  if (!body) return null;
  const stripped = body.replace(/\s+/g, " ").trim();
  if (!stripped) return null;
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

// Run any GraphQL query and JSON-parse the response. Shopify's admin client
// returns a Fetch-style Response, so we have to .json() it ourselves.
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

// --- shop profile ---------------------------------------------------------
const SHOP_QUERY = /* GraphQL */ `
  query LlmsShopProfile {
    shop {
      name
      description
      email
      contactEmail
      primaryDomain {
        url
        host
      }
    }
  }
`;

interface ShopQueryResult {
  shop: {
    name: string;
    description: string | null;
    email: string | null;
    contactEmail: string | null;
    primaryDomain: { url: string; host: string };
  };
}

export async function fetchShopProfile(admin: AdminApiContext): Promise<ShopProfile> {
  const data = await gql<ShopQueryResult>(admin, SHOP_QUERY);
  return {
    name: data.shop.name,
    description: truncate(data.shop.description, 600),
    primaryDomain: data.shop.primaryDomain.url,
    email: data.shop.email,
    contactEmail: data.shop.contactEmail,
  };
}

// --- products -------------------------------------------------------------
const PRODUCTS_QUERY = /* GraphQL */ `
  query LlmsProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          productType
          vendor
          tags
          status
          description
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
            maxVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

interface ProductsQueryResult {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{
      node: {
        id: string;
        title: string;
        handle: string;
        productType: string | null;
        vendor: string | null;
        tags: string[];
        status: string;
        description: string | null;
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
          maxVariantPrice: { amount: string; currencyCode: string };
        } | null;
      };
    }>;
  };
}

export async function fetchProducts(
  admin: AdminApiContext,
  limit = MAX_PRODUCTS,
): Promise<{ products: ProductSummary[]; total: number }> {
  const products: ProductSummary[] = [];
  let cursor: string | null = null;
  let total = 0;

  while (products.length < limit) {
    const data: ProductsQueryResult = await gql<ProductsQueryResult>(
      admin,
      PRODUCTS_QUERY,
      { first: Math.min(PAGE_SIZE, limit - products.length), after: cursor },
    );

    for (const edge of data.products.edges) {
      const p = edge.node;
      products.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        productType: p.productType,
        vendor: p.vendor,
        tags: p.tags,
        description: truncate(p.description, 280),
        status: p.status,
        priceRange: p.priceRangeV2
          ? {
              min: p.priceRangeV2.minVariantPrice.amount,
              max: p.priceRangeV2.maxVariantPrice.amount,
              currencyCode: p.priceRangeV2.minVariantPrice.currencyCode,
            }
          : null,
      });
      total += 1;
    }

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  return { products, total };
}

// --- collections ----------------------------------------------------------
const COLLECTIONS_QUERY = /* GraphQL */ `
  query LlmsCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          description
        }
      }
    }
  }
`;

interface CollectionsQueryResult {
  collections: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{
      node: {
        id: string;
        title: string;
        handle: string;
        description: string | null;
      };
    }>;
  };
}

export async function fetchCollections(
  admin: AdminApiContext,
  limit = MAX_COLLECTIONS,
): Promise<{ collections: CollectionSummary[]; total: number }> {
  const collections: CollectionSummary[] = [];
  let cursor: string | null = null;
  let total = 0;

  while (collections.length < limit) {
    const data: CollectionsQueryResult = await gql<CollectionsQueryResult>(
      admin,
      COLLECTIONS_QUERY,
      { first: Math.min(PAGE_SIZE, limit - collections.length), after: cursor },
    );

    for (const edge of data.collections.edges) {
      const c = edge.node;
      collections.push({
        id: c.id,
        title: c.title,
        handle: c.handle,
        description: truncate(c.description, 300),
      });
      total += 1;
    }

    if (!data.collections.pageInfo.hasNextPage) break;
    cursor = data.collections.pageInfo.endCursor;
  }

  return { collections, total };
}

// --- pages ----------------------------------------------------------------
const PAGES_QUERY = /* GraphQL */ `
  query LlmsPages($first: Int!, $after: String) {
    pages(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          body
        }
      }
    }
  }
`;

interface PagesQueryResult {
  pages: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{
      node: { id: string; title: string; handle: string; body: string | null };
    }>;
  };
}

export async function fetchPages(
  admin: AdminApiContext,
  limit = MAX_PAGES,
): Promise<PageSummary[]> {
  const out: PageSummary[] = [];
  let cursor: string | null = null;

  while (out.length < limit) {
    const data: PagesQueryResult = await gql<PagesQueryResult>(
      admin,
      PAGES_QUERY,
      { first: Math.min(PAGE_SIZE, limit - out.length), after: cursor },
    );

    for (const edge of data.pages.edges) {
      const p = edge.node;
      out.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        bodySummary: truncate(p.body, 500),
      });
    }

    if (!data.pages.pageInfo.hasNextPage) break;
    cursor = data.pages.pageInfo.endCursor;
  }

  return out;
}

// --- policies -------------------------------------------------------------
// Shop policies are a fixed, finite set returned by `Shop.shopPolicies` — no
// pagination needed.
const POLICIES_QUERY = /* GraphQL */ `
  query LlmsPolicies {
    shop {
      shopPolicies {
        id
        title
        url
        body
      }
    }
  }
`;

interface PoliciesQueryResult {
  shop: {
    shopPolicies: Array<{
      id: string;
      title: string;
      url: string;
      body: string | null;
    }>;
  };
}

export async function fetchPolicies(admin: AdminApiContext): Promise<PolicySummary[]> {
  const data = await gql<PoliciesQueryResult>(admin, POLICIES_QUERY);
  return data.shop.shopPolicies.map((p) => ({
    id: p.id,
    title: p.title,
    url: p.url,
    body: truncate(p.body, 400),
  }));
}

// --- blog articles --------------------------------------------------------
// Articles come from blogs (containers). We pull a flat list across all blogs;
// the parent blog's handle is captured so we can build /blogs/<blog>/<article>
// URLs in the brief.
const BLOG_ARTICLES_QUERY = /* GraphQL */ `
  query LlmsBlogArticles($first: Int!, $after: String) {
    articles(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          summary
          blog {
            handle
          }
        }
      }
    }
  }
`;

interface BlogArticlesQueryResult {
  articles: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{
      node: {
        id: string;
        title: string;
        handle: string;
        summary: string | null;
        blog: { handle: string };
      };
    }>;
  };
}

export async function fetchBlogArticles(
  admin: AdminApiContext,
  limit = MAX_BLOG_ARTICLES,
): Promise<{ articles: BlogArticleSummary[]; total: number }> {
  const articles: BlogArticleSummary[] = [];
  let cursor: string | null = null;
  let total = 0;

  while (articles.length < limit) {
    let data: BlogArticlesQueryResult;
    try {
      data = await gql<BlogArticlesQueryResult>(admin, BLOG_ARTICLES_QUERY, {
        first: Math.min(PAGE_SIZE, limit - articles.length),
        after: cursor,
      });
    } catch (err) {
      // Stores without the online-store-content scope or with no blogs at all
      // will surface here; treat as zero blog content rather than failing the
      // whole pipeline.
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("ACCESS_DENIED") ||
        message.includes("does not exist") ||
        message.includes("not authorized")
      ) {
        return { articles: [], total: 0 };
      }
      throw err;
    }

    for (const edge of data.articles.edges) {
      const a = edge.node;
      articles.push({
        id: a.id,
        title: a.title,
        handle: a.handle,
        blogHandle: a.blog.handle,
        summary: truncate(a.summary, 240),
      });
      total += 1;
    }

    if (!data.articles.pageInfo.hasNextPage) break;
    cursor = data.articles.pageInfo.endCursor;
  }

  return { articles, total };
}

// Single entry point — fetch everything in parallel and assemble the store
// snapshot the brief-builder consumes.
export async function fetchStoreData(admin: AdminApiContext): Promise<StoreData> {
  const [shop, productsResult, collectionsResult, pages, policies, blogResult] =
    await Promise.all([
      fetchShopProfile(admin),
      fetchProducts(admin),
      fetchCollections(admin),
      fetchPages(admin),
      fetchPolicies(admin),
      fetchBlogArticles(admin),
    ]);

  return {
    shop,
    products: productsResult.products,
    productCount: productsResult.total,
    collections: collectionsResult.collections,
    collectionCount: collectionsResult.total,
    pages,
    policies,
    blogArticles: blogResult.articles,
    blogArticleCount: blogResult.total,
  };
}

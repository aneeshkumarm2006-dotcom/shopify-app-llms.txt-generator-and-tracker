// Turn the raw StoreData snapshot into a compact, structured brief that the
// Claude prompt can consume without blowing past the token budget. PRD §6.2
// scale handling: "for large catalogs, the app paginates the Admin API and
// summarises rather than dumps. Products are grouped by collection and type;
// only representative detail is sent to the Claude API so the prompt stays
// within a sensible token budget. The full per-product list still appears in
// the file as a link index."
//
// The brief itself is a plain JS object — generate.ts serialises it as JSON
// and interpolates that into the user prompt. Keeping the structure as data
// (not a pre-formatted string) means the prompt can evolve without touching
// the fetcher, and tests can assert on the structure directly.

import type {
  BlogArticleSummary,
  CollectionSummary,
  PageSummary,
  PolicySummary,
  ProductSummary,
  StoreData,
} from "../shopify/admin-fetcher";

// How much detail we send to Claude per category. Anything beyond the cap is
// represented as a link-only entry in the link index — Claude still knows it
// exists, but does not get a full description.
const DETAILED_PRODUCT_CAP = 60;
const DETAILED_COLLECTION_CAP = 30;
const DETAILED_BLOG_CAP = 20;
// Max characters of free text we keep per product/collection/page. The fetcher
// already truncates; this is a second safety net.
const PRODUCT_DETAIL_CHARS = 220;
const COLLECTION_DETAIL_CHARS = 240;
const PAGE_DETAIL_CHARS = 360;

export interface BriefProduct {
  title: string;
  url: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  description: string | null;
  price: string | null;
}

export interface BriefCollection {
  title: string;
  url: string;
  description: string | null;
}

export interface BriefPage {
  title: string;
  url: string;
  bodySummary: string | null;
}

export interface BriefPolicy {
  title: string;
  url: string;
  body: string | null;
}

export interface BriefBlogArticle {
  title: string;
  url: string;
  summary: string | null;
}

export interface ContentBrief {
  shop: {
    name: string;
    description: string | null;
    domain: string;
    contact: {
      email: string | null;
      contactEmail: string | null;
    };
  };
  // Curated subset Claude gets the full detail for — grouped by type so the
  // model can pattern-match and write tight sections.
  productGroups: Array<{
    type: string; // productType bucket — "Other" when missing
    products: BriefProduct[];
  }>;
  collections: BriefCollection[];
  pages: BriefPage[];
  policies: BriefPolicy[];
  blogArticles: BriefBlogArticle[];
  // Complete link index — every URL the merchant has, even if the title-only
  // form. The prompt instructs Claude to emit these as a flat link list under
  // "## All products" so AI crawlers see the whole catalog.
  linkIndex: {
    products: Array<{ title: string; url: string }>;
    collections: Array<{ title: string; url: string }>;
    pages: Array<{ title: string; url: string }>;
    blogArticles: Array<{ title: string; url: string }>;
  };
  totals: {
    products: number;
    productsInBrief: number;
    collections: number;
    collectionsInBrief: number;
    pages: number;
    policies: number;
    blogArticles: number;
    blogArticlesInBrief: number;
  };
}

function cut(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Storefront URLs all live under the shop's primary domain. The Admin API
// returns the domain as a full URL ("https://store.xyz"), so we strip a
// trailing slash before concatenating.
function origin(primaryDomain: string): string {
  return primaryDomain.replace(/\/+$/, "");
}

function productUrl(domain: string, p: { handle: string }) {
  return `${origin(domain)}/products/${p.handle}`;
}
function collectionUrl(domain: string, c: { handle: string }) {
  return `${origin(domain)}/collections/${c.handle}`;
}
function pageUrl(domain: string, p: { handle: string }) {
  return `${origin(domain)}/pages/${p.handle}`;
}
function articleUrl(
  domain: string,
  a: { blogHandle: string; handle: string },
) {
  return `${origin(domain)}/blogs/${a.blogHandle}/${a.handle}`;
}

function priceLabel(p: ProductSummary): string | null {
  if (!p.priceRange) return null;
  const { min, max, currencyCode } = p.priceRange;
  if (min === max) return `${min} ${currencyCode}`;
  return `${min}–${max} ${currencyCode}`;
}

// Group products by `productType` so Claude can write themed sections (e.g.
// "Mugs", "Beans", "Subscriptions"). Products without a type land in "Other".
function groupProductsByType(
  domain: string,
  products: ProductSummary[],
): Array<{ type: string; products: BriefProduct[] }> {
  const buckets = new Map<string, BriefProduct[]>();

  for (const p of products) {
    const type = (p.productType ?? "").trim() || "Other";
    const item: BriefProduct = {
      title: p.title,
      url: productUrl(domain, p),
      productType: p.productType,
      vendor: p.vendor,
      tags: p.tags.slice(0, 8),
      description: cut(p.description, PRODUCT_DETAIL_CHARS),
      price: priceLabel(p),
    };
    const bucket = buckets.get(type);
    if (bucket) bucket.push(item);
    else buckets.set(type, [item]);
  }

  // Stable order — biggest buckets first so the file leads with the most
  // representative product type.
  return [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, products]) => ({ type, products }));
}

export function buildContentBrief(storeData: StoreData): ContentBrief {
  const domain = storeData.shop.primaryDomain;

  // Cap how many products get the full-detail treatment in the prompt.
  const detailedProducts = storeData.products.slice(0, DETAILED_PRODUCT_CAP);
  const detailedCollections: CollectionSummary[] = storeData.collections.slice(
    0,
    DETAILED_COLLECTION_CAP,
  );
  const detailedBlog: BlogArticleSummary[] = storeData.blogArticles.slice(
    0,
    DETAILED_BLOG_CAP,
  );

  const productGroups = groupProductsByType(domain, detailedProducts);

  const collections: BriefCollection[] = detailedCollections.map(
    (c: CollectionSummary) => ({
      title: c.title,
      url: collectionUrl(domain, c),
      description: cut(c.description, COLLECTION_DETAIL_CHARS),
    }),
  );

  const pages: BriefPage[] = storeData.pages.map((p: PageSummary) => ({
    title: p.title,
    url: pageUrl(domain, p),
    bodySummary: cut(p.bodySummary, PAGE_DETAIL_CHARS),
  }));

  const policies: BriefPolicy[] = storeData.policies.map((p: PolicySummary) => ({
    title: p.title,
    url: p.url,
    body: cut(p.body, 300),
  }));

  const blogArticles: BriefBlogArticle[] = detailedBlog.map(
    (a: BlogArticleSummary) => ({
      title: a.title,
      url: articleUrl(domain, a),
      summary: cut(a.summary, 200),
    }),
  );

  return {
    shop: {
      name: storeData.shop.name,
      description: storeData.shop.description,
      domain: domain,
      contact: {
        email: storeData.shop.email,
        contactEmail: storeData.shop.contactEmail,
      },
    },
    productGroups,
    collections,
    pages,
    policies,
    blogArticles,
    linkIndex: {
      products: storeData.products.map((p) => ({
        title: p.title,
        url: productUrl(domain, p),
      })),
      collections: storeData.collections.map((c) => ({
        title: c.title,
        url: collectionUrl(domain, c),
      })),
      pages: storeData.pages.map((p) => ({
        title: p.title,
        url: pageUrl(domain, p),
      })),
      blogArticles: storeData.blogArticles.map((a) => ({
        title: a.title,
        url: articleUrl(domain, a),
      })),
    },
    totals: {
      products: storeData.productCount,
      productsInBrief: detailedProducts.length,
      collections: storeData.collectionCount,
      collectionsInBrief: detailedCollections.length,
      pages: storeData.pages.length,
      policies: storeData.policies.length,
      blogArticles: storeData.blogArticleCount,
      blogArticlesInBrief: detailedBlog.length,
    },
  };
}

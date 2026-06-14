import type { ReactNode } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import enTranslations from "@shopify/polaris/locales/en.json";

import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

// Make every Polaris link/button `url` navigate client-side through React
// Router instead of rendering a plain <a>. A full-document <a> load to an
// in-app path (e.g. /app/llms) drops the embedded App Bridge session token,
// so the server sees an unauthenticated request and bounces to re-install
// (the "accounts.shopify.com refused to connect" failure). External/absolute
// URLs keep normal anchor behaviour.
function PolarisLinkComponent({
  children,
  url = "",
  external,
  ...rest
}: {
  children?: ReactNode;
  url?: string;
  external?: boolean;
  [key: string]: unknown;
}) {
  // Only true in-app paths (absolute "/..." but not protocol-relative "//...")
  // go through React Router, which preserves the embedded App Bridge session
  // token. Everything else — absolute URLs of any scheme (http, mailto, tel),
  // protocol-relative URLs, hash anchors, empty hrefs — renders as a normal
  // anchor. `target="_blank"` is driven by Polaris's `external` flag (matching
  // its own behaviour); callers can still override target/rel via props.
  const isInAppPath = url.startsWith("/") && !url.startsWith("//");
  if (!isInAppPath) {
    return (
      <a
        href={url}
        rel="noopener noreferrer"
        {...(external ? { target: "_blank" } : null)}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <Link to={url} {...rest}>
      {children}
    </Link>
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations} linkComponent={PolarisLinkComponent}>
        <NavMenu>
          <Link to="/app" rel="home">
            Home
          </Link>
          <Link to="/app/llms">LLMs.txt</Link>
          <Link to="/app/tracking">Tracking</Link>
          <Link to="/app/settings">Settings</Link>
        </NavMenu>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

// Shopify needs Remix-style error/headers helpers wired up for embedded auth.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Davnoot LLMs Generator</h1>
      <p>
        Generate and serve <code>llms.txt</code> for your Shopify store, and
        track AI-referred traffic.
      </p>
      <p>Install the app from the Shopify App Store to get started.</p>
    </div>
  );
}

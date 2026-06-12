import type { LoaderFunctionArgs } from "react-router";
import {
  BlockStack,
  Card,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <Page>
      <ui-title-bar title="Davnoot LLMs Generator" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Welcome
              </Text>
              <Text as="p" variant="bodyMd">
                Your store's <code>llms.txt</code> file will appear here once
                generation lands in Phase 1.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

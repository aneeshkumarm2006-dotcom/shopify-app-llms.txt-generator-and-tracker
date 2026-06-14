import type { LoaderFunctionArgs } from "react-router";
import {
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
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
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Welcome
              </Text>
              <Text as="p" variant="bodyMd">
                Generate and serve an <code>llms.txt</code> file for your store
                — the plain-text summary AI assistants like ChatGPT, Claude, and
                Perplexity read to represent your store accurately.
              </Text>
              <List>
                <List.Item>
                  <strong>LLMs.txt</strong> — view, edit, and regenerate your
                  store's file.
                </List.Item>
                <List.Item>
                  <strong>Tracking</strong> — see how much traffic AI assistants
                  send your store.
                </List.Item>
                <List.Item>
                  <strong>Settings</strong> — your public file URL and app
                  configuration.
                </List.Item>
              </List>
              <InlineStack gap="200">
                <Button variant="primary" url="/app/llms">
                  Open llms.txt editor
                </Button>
                <Button url="/app/tracking">View tracking</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

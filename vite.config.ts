import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "react-router" {
  interface Future {
    unstable_optimizeDeps: true;
  }
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64998,
    clientPort: 64998,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host,
    port: parseInt(process.env.FRONTEND_PORT || "8002") || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    // `host` is derived from SHOPIFY_APP_URL (the prod/Render URL). During
    // `shopify app dev` the app is served through a random *.trycloudflare.com
    // tunnel that changes each run, so we allow the whole tunnel domain.
    // Leading-dot entries match any subdomain. Add ".ngrok-free.app" etc. if
    // you switch the CLI tunnel provider.
    allowedHosts: [host, ".trycloudflare.com"],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react", "@shopify/polaris"],
  },
});

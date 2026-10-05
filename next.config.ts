import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Lets a second dev server (e.g. a parallel Playwright run) use its own build directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // ...and its own tsconfig, which `next dev` rewrites with that directory's type paths.
  typescript: { tsconfigPath: process.env.NEXT_TSCONFIG || "tsconfig.json" },
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["pg-boss", "pino"],
};

export default withNextIntl(nextConfig);

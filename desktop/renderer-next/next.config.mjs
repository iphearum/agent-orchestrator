import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "../..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.NODE_ENV === "development" ? {} : { output: "export", assetPrefix: "./" }),
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  transpilePackages: ["monaco-editor"],
  // The home page renders the extension's React surfaces straight from webview-ui/.
  experimental: { externalDir: true },
  webpack(config, { isServer }) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@webview": path.join(repoRoot, "webview-ui/src"),
      "@shared": path.join(repoRoot, "backend/src/shared")
    };
    if (!isServer) {
      config.output.environment = { ...config.output.environment, asyncFunction: true };
    }
    return config;
  }
};

export default nextConfig;

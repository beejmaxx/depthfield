import { defineConfig } from "vite";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: process.env.GITHUB_PAGES === "true" ? "/depthfield/" : "/",
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});

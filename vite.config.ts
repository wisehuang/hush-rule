import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(projectDir, "src");

export default defineConfig(({ mode }) => ({
  root,
  publicDir: resolve(projectDir, "public"),
  base: "./",
  build: {
    outDir: resolve(projectDir, "dist"),
    emptyOutDir: true,
    target: "chrome120",
    sourcemap: mode === "development",
    minify: mode !== "development",
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(root, "background/index.ts"),
        options: resolve(root, "options/options.html"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: {
    root: projectDir,
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
}));

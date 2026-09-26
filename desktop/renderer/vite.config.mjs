import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, base: "./", server: { host: "127.0.0.1", port: 5173, strictPort: true }, build: { outDir: "dist", emptyOutDir: true } });

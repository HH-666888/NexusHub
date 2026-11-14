import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: "/",
  build: {
    outDir: fileURLToPath(new URL("../web/settings-dist", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "settings/assets",
    rollupOptions: {
      input: {
        settings: fileURLToPath(new URL("settings/index.html", import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
  root: rootDir,
});
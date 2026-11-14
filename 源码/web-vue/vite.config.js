import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: "/",
  build: {
    outDir: fileURLToPath(new URL("../web/vue-dist", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "vue-assets",
    cssMinify: false,
    rollupOptions: {
      input: {
        settings: fileURLToPath(new URL("settings/index.html", import.meta.url)),
        login: fileURLToPath(new URL("login/index.html", import.meta.url)),
        register: fileURLToPath(new URL("register/index.html", import.meta.url)),
        projects: fileURLToPath(new URL("projects/index.html", import.meta.url)),
        memory: fileURLToPath(new URL("memory/index.html", import.meta.url)),
        assist: fileURLToPath(new URL("assist/index.html", import.meta.url)),
        workspace: fileURLToPath(new URL("assist/workspace/index.html", import.meta.url)),
        welcome: fileURLToPath(new URL("welcome/index.html", import.meta.url)),
        workbench: fileURLToPath(new URL("workbench/index.html", import.meta.url)),
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
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
    rollupOptions: {
      input: {
        settings: fileURLToPath(new URL("settings/index.html", import.meta.url)),
        login: fileURLToPath(new URL("login/index.html", import.meta.url)),
        register: fileURLToPath(new URL("register/index.html", import.meta.url)),
        projects: fileURLToPath(new URL("projects/index.html", import.meta.url)),
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
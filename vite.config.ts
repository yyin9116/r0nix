import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import packageMeta from "./package.json";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "inject-app-version",
      transformIndexHtml(html) {
        return html.replace(/%APP_VERSION%/g, packageMeta.version);
      },
    },
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  optimizeDeps: {
    include: ["pdfjs-dist"],
  },
});

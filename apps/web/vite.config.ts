import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

export default defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "../../assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: import.meta.dirname,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port,
    proxy: { "/api": "http://127.0.0.1:5001" },
  },
  build: { outDir: "dist/public", emptyOutDir: true },
});
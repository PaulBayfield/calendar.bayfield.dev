import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/** Dev only: serve the booking page for /book/<id>, like the production server does. */
const bookingRoute: Plugin = {
  name: "booking-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith("/book/")) req.url = "/book.html";
      next();
    });
  },
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), bookingRoute],

  build: {
    rollupOptions: {
      input: { main: "index.html", book: "book.html" },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    // The scheduling server (npm run server) during web development.
    proxy: {
      "/api": "http://localhost:8787",
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/server/**"],
    },
  },
}));

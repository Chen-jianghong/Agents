import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "apps/desktop/renderer",
  base: "./",
  build: {
    outDir: "../../../apps/desktop/dist-renderer",
    emptyOutDir: true,
  },
});

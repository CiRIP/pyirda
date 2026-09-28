import { defineConfig } from "vite"

export default defineConfig({
  assetsInclude: ["**/*.sb"],
  build: { rollupOptions: { input: ["index.html", "demo.html"] } },
})

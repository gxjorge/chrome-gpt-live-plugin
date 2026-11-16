import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import manifest from "./manifest.config";

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

// pdf.js needs its character maps to extract text from PDFs that use CJK and other CID fonts.
function copyPdfjsCmaps(): Plugin {
  return {
    name: "copy-pdfjs-cmaps",
    apply: "build",
    generateBundle() {
      const source = join(pdfjsRoot, "cmaps");
      for (const file of readdirSync(source)) {
        this.emitFile({ type: "asset", fileName: `pdfjs/cmaps/${file}`, source: readFileSync(join(source, file)) });
      }
    },
  };
}

export default defineConfig({
  define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(new Date().toISOString()) },
  plugins: [react(), crx({ manifest }), copyPdfjsCmaps()],
  build: {
    sourcemap: true,
    // Chrome retains the unpacked manifest until Reload is clicked.
    rollupOptions: {
      input: { offscreen: "src/offscreen/index.html" },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});

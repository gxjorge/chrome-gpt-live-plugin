import { defineManifest } from "@crxjs/vite-plugin";
import extensionKey from "./extension-key.json";

export default defineManifest({
  manifest_version: 3,
  name: "Chrome GPT Live",
  version: "0.1.0",
  description: "Discuss and autonomously browse the web with GPT-Live and Astra.",
  minimum_chrome_version: "116",
  // A fixed public key keeps the unpacked extension ID stable for the native messaging host.
  key: extensionKey.key,
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  },
  permissions: ["activeTab", "sidePanel", "storage", "tabs", "scripting", "offscreen", "nativeMessaging"],
  host_permissions: ["<all_urls>", "http://127.0.0.1:4317/*", "http://localhost:4317/*"],
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  action: {
    default_title: "Open Chrome GPT Live",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_ui: {
    page: "src/permissions/index.html",
    open_in_tab: true,
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content.ts"],
      run_at: "document_idle",
    },
  ],
});

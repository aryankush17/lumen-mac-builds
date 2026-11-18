import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import prefixSelector from "postcss-prefix-selector";
export default defineConfig({
  base: "/pages-app/",
  css: {
    postcss: {
      plugins: [
        prefixSelector({
          prefix: "#lumen-workspace",
          includeFiles: [/src[\\/](style|appearance)\.css$/],
          ignoreFiles: [/node_modules/],
          transform(prefix, selector, prefixedSelector) {
            if (
              selector === ":root" ||
              selector === "body" ||
              selector === "html"
            )
              return prefix;
            if (selector.startsWith("[data-theme")) return prefix + selector;
            return prefixedSelector;
          },
        }),
      ],
    },
  },
  plugins: [
    react(),
    {
      name: "lumen-development-csrf",
      apply: "serve",
      async transformIndexHtml(html) {
        const response = await fetch("http://127.0.0.1:5000/pages-app/");
        const source = await response.text();
        const token = source.match(/name="csrf-token" content="([^"]+)"/);
        if (!response.ok || !token)
          throw new Error(
            "Start the local Lumen backend before the Pages development server.",
          );
        return html.replace("__CSRF_TOKEN__", token[1]);
      },
    },
  ],
  build: { sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:5000" } },
});

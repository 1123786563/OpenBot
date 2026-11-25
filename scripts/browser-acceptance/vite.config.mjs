import { mergeConfig } from "../../app/node_modules/vite/dist/node/index.js";
import original from "../../app/vite.config";
export default mergeConfig(original, {
  cacheDir: "node_modules/.vite-browser-acceptance",
  plugins: [
    {
      name: "acceptance-desktop-shell",
      transformIndexHtml(html) {
        return html.replace(
          "<head>",
          '<head><script src="/api/__fixture/desktop.js"></script>',
        );
      },
    },
  ],
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Router } from "express";

// Readable API docs at /api/v1 (D-020): Redoc, served from our own node_modules (no CDN),
// rendering /api/v1/openapi.json. Public, like the spec itself.

const bundle = createRequire(import.meta.url).resolve("redoc/bundles/redoc.standalone.js");

const theme = {
  colors: { primary: { main: "#c8441b" }, text: { primary: "#1c1b19" } },
  typography: {
    fontFamily: "Inter, system-ui, sans-serif",
    headings: { fontFamily: "'Space Grotesk', Inter, system-ui, sans-serif", fontWeight: "700" },
    code: { fontFamily: "ui-monospace, 'JetBrains Mono', monospace" },
  },
  sidebar: { backgroundColor: "#f4f1ea" },
  rightPanel: { backgroundColor: "#1c1b19" },
};

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Burrow API</title>
  <style>
    body { margin: 0; padding-top: 44px; background: #fff; }
    .bar { position: fixed; top: 0; left: 0; right: 0; height: 24px; z-index: 10; display: flex; gap: 16px; align-items: center; padding: 10px 20px; background: #f4f1ea;
      border-bottom: 1px solid #e0d9ca; font: 14px Inter, system-ui, sans-serif; color: #1c1b19; }
    .bar strong { font-family: 'Space Grotesk', Inter, system-ui, sans-serif; font-size: 17px; }
    .bar a { color: #c8441b; text-decoration: none; }
    .bar .gap { flex: 1; }
  </style>
</head>
<body>
  <div class="bar">
    <strong>Burrow API</strong>
    <span class="gap"></span>
    <a href="/integrations">Tokens</a>
    <a href="/api/v1/openapi.json">openapi.json</a>
    <a href="/">Burrow</a>
  </div>
  <div id="docs"></div>
  <script src="/api/v1/redoc.standalone.js"></script>
  <script>
    Redoc.init("/api/v1/openapi.json", ${JSON.stringify({
      theme,
      hideDownloadButton: false,
      expandResponses: "200,201",
      jsonSampleExpandLevel: 3,
      sortTagsAlphabetically: false,
      hideHostname: false,
      scrollYOffset: ".bar",
    })}, document.getElementById("docs"));
  </script>
</body>
</html>`;

export function docsRoutes(): Router {
  const r = Router();
  let js: Buffer | null = null;
  r.get(["/api/v1", "/api/v1/"], (_req, res) => {
    res.type("html").setHeader("cache-control", "no-cache").send(page);
  });
  r.get("/api/v1/redoc.standalone.js", (_req, res) => {
    js ??= readFileSync(bundle);
    res.type("js").setHeader("cache-control", "public, max-age=86400").send(js);
  });
  return r;
}

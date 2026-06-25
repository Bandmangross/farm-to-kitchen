/**
 * Zero-dependency static file server for the frontend.
 *   node serveClient.js        → serves ../client on http://localhost:3000
 *
 * Backend API is expected on http://localhost:5050 (see api.js / .env).
 * This keeps the requested split: frontend :3000, backend :5050.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.CLIENT_PORT || 3000;
const ROOT = path.join(__dirname, "..", "client");

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, path.normalize(urlPath));

  // Prevent path traversal outside the client folder.
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-style fallback to index.html for unknown routes.
      return fs.readFile(path.join(ROOT, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`✔ Farm To Kitchen client on http://localhost:${PORT}`));

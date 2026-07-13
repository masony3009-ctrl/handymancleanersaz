// Local dev server: node serve.js  ->  http://127.0.0.1:4174
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, "");
    if (!p || p === ".") p = "index.html";
    let file = path.join(root, p);
    // Directory-style URLs (e.g. /services/office-cleaning/) -> serve its index.html.
    // Mirrors how Cloudflare Pages resolves clean directory paths in production.
    if (!path.extname(file)) file = path.join(file, "index.html");
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        // Serve the branded 404 page (mirrors Cloudflare Pages behavior).
        return fs.readFile(path.join(root, "404.html"), (err2, page) => {
          res.writeHead(404, { "Content-Type": err2 ? "text/plain" : "text/html" });
          res.end(err2 ? "Not found" : page);
        });
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(4174, "127.0.0.1", () => console.log("serving http://127.0.0.1:4174"));

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
};

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, "");
    if (!p || p === ".") p = "index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(4174, "127.0.0.1", () => console.log("serving http://127.0.0.1:4174"));

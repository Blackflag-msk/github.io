#!/usr/bin/env node
'use strict';

/*
  Локальный предпросмотр книги перед публикацией.

  Нужен потому, что при открытии index.html двойным кликом (file://) браузер
  блокирует fetch() для JSON — читалка в этом случае показывает только то, что
  лежит в localStorage этого браузера, и вы не увидите результат сборки.

  node serve.js            корень каталога, http://localhost:8080
  node serve.js dist       собраннный сайт из dist/
  node serve.js 9000       порт 9000 для корня каталога
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const root = process.cwd();

let dir = root;
let port = 8080;
process.argv.slice(2).forEach(function (a) {
  if (/^\d+$/.test(a)) port = Number(a);
  else if (!a.startsWith('-')) {
    const p = path.resolve(root, a);
    if (!fs.existsSync(p)) { console.error('✖ нет папки: ' + p); process.exit(1); }
    dir = p;
  }
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8'
};

http.createServer(function (req, res) {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400).end(); return; }
  if (url.endsWith('/')) url += 'index.html';

  /* Путь не должен выйти за пределы отдаваемой папки. */
  const file = path.normalize(path.join(dir, url));
  if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(403).end('403'); return; }

  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — нет файла: ' + url + '\nПапка: ' + dir);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(port, function () {
  console.log('Кника отдаётся из ' + dir);
  console.log('Откройте  http://localhost:' + port + '/   (Ctrl+C — остановить)');
});

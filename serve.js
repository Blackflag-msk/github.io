#!/usr/bin/env node
'use strict';

/*
  Локальный предпросмотр книги и публикация на GitHub Pages.

  Нужен потому, что при открытии index.html двойным кликом (file://) браузер
  блокирует fetch() для JSON — читалка в этом случае показывает только то, что
  лежит в localStorage этого браузера, и вы не увидите результат сборки.

  node serve.js            корень каталога, http://localhost:8080
  node serve.js dist       собранный сайт из dist/ (только чтение, как на хостинге)
  node serve.js 9000       порт 9000 для корня каталога
  node serve.js --no-publish отключить кнопку «Опубликовать» (только просмотр)

  В корне каталога кабинет автора с PIN доступен; собранный dist/ помечен как
  читальня и показывает редактор нигде — так же, как опубликованная страница.

  Публикация: редактор отдаёт копию книги на /api/publish этого сервера, сервер
  пишет src/book.json (и book.en.json), пересобирает издание publish.js и
  отправляет коммит в main. GitHub Actions собирает dist/ и перезаписывает
  Pages. Учётные данные GitHub при этом в браузере не появляются: пушит тот же
  git, которым вы пользуетесь в консоли.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const root = process.cwd();

let dir = root;
let port = 8080;
let publishOn = true;
process.argv.slice(2).forEach(function (a) {
  if (a === '--no-publish') publishOn = false;
  else if (/^\d+$/.test(a)) port = Number(a);
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

/* ---------------- публикация ---------------- */

/* Публиковать умеем только из корня репозитория: там лежат src/ и .git.
   Предпросмотр собранного dist/ публикации не имеет по определению. */
const CAN_PUBLISH = publishOn && path.resolve(dir) === path.resolve(root) &&
  fs.existsSync(path.join(root, '.git')) && fs.existsSync(path.join(root, 'src'));
const PUBLISH_LIMIT = 96 * 1024 * 1024; /* копия книги с base64-картинками */
/* Файлы издания, которые пересобираются из src/: их и коммитим. */
const PUBLISH_PATHS = ['src/book.json', 'src/book.en.json', 'book.json', 'book.en.json', 'book-data.js', 'images'];

let publishing = false;

function git(args) {
  return new Promise(function (resolve, reject) {
    execFile('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      function (err, stdout, stderr) {
        if (err) { err.gitMessage = String(stderr || err.message).trim(); reject(err); return; }
        resolve(String(stdout || '').trim());
      });
  });
}

function nodeScript(script, args) {
  return new Promise(function (resolve, reject) {
    execFile(process.execPath, [path.join(root, script)].concat(args || []),
      { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      function (err, stdout, stderr) {
        if (err) { err.gitMessage = String(stderr || err.message).trim(); reject(err); return; }
        resolve(String(stdout || '').trim());
      });
  });
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = 0, parts = [];
    req.on('data', function (c) {
      chunks += c.length;
      if (chunks > limit) { reject(new Error('Слишком большая копия книги (' + Math.round(chunks / 1048576) + ' МБ).')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(parts).toString('utf8')); });
    req.on('error', reject);
  });
}

/* Копия из редактора превращается в файл src/: тот же формат, что отдаёт «⤓ Копия книги». */
function srcJson(payload, keepVersion) {
  var b = payload && payload.book;
  if (!b || !Array.isArray(b.chapters) || !b.chapters.length) throw new Error('в копии нет глав');
  return JSON.stringify({ app: 'pereplet', version: keepVersion || Number(payload.version) || Date.now(),
    updated: new Date().toISOString(), book: b }, null, 1);
}

async function publish(payload) {
  const log = [];
  const step = function (ok, msg) { log.push({ ok: !!ok, msg: msg }); console.log((ok ? '  ✓ ' : '  ✗ ') + msg); };

  var ruPayload = payload && payload.ru;
  var enPayload = payload && payload.en;

  var ruJson, enJson = null;
  try { ruJson = srcJson(ruPayload, 0); } catch (e) { throw new Error('русская версия: ' + e.message); }
  if (enPayload) { try { enJson = srcJson(enPayload, 0); } catch (e) { enJson = null; } }

  var branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('git: отделённая голова — сначала вернитесь на ветку main');
  step(true, 'Ветка ' + branch);

  /* Правки интерфейса в коммит издания не попадают — предупреждаем, но не мешаем. */
  var untouched = await git(['status', '--porcelain', '--', 'index.html', 'publish.js', '.github']);
  if (untouched) step(true, 'Внимание: index.html / publish.js изменены, но не закоммичены — на Pages останется их версия из git');

  /* Издание публикуется поверх актуального origin: иначе push отклонят. */
  await git(['fetch', 'origin', branch]);
  var local = await git(['rev-parse', 'HEAD']);
  var remote = await git(['rev-parse', 'origin/' + branch]).catch(function () { return local; });
  if (local !== remote) {
    var behind = await git(['rev-list', '--count', 'HEAD..origin/' + branch]).catch(function () { return '?' });
    if (behind !== '0') throw new Error('На GitHub есть более новая версия (' + behind + ' комм. впереди). Выполните git pull и повторите.');
    var ahead = await git(['rev-list', '--count', 'origin/' + branch + '..HEAD']).catch(function () { return '?' });
    step(true, 'Вместе с изданием уйдёт ещё ' + ahead + ' локальных комм.');
  }

  /* Всегда пишем src/ из payload: publish.js должен собрать издание заново,
     даже если содержание совпадает с прошлым коммитом. */
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'book.json'), ruJson);
  step(true, 'src/book.json записан (' + Math.round(ruJson.length / 1024) + ' КБ)');
  if (enJson) { fs.writeFileSync(path.join(root, 'src', 'book.en.json'), enJson); step(true, 'src/book.en.json записан (' + Math.round(enJson.length / 1024) + ' КБ)'); }

  /* Тот же шаг, что делаете вы руками: картинки из data:URL в файлы images/. */
  var build = await nodeScript('publish.js', []);
  step(true, (build.split(/\r?\n/).filter(function (l) { return l.trim(); }).pop() || 'издание пересобрано').trim());

  /* Версии, которые реально легли в публикуемые файлы — редактор сверит с ними
     свой флаг «есть несохранённые правки». */
  var versions = {};
  [['ru', 'book.json'], ['en', 'book.en.json']].forEach(function (p) {
    try { versions[p[0]] = Number(JSON.parse(fs.readFileSync(path.join(root, p[1]), 'utf8')).version) || null; }
    catch (e) { versions[p[0]] = null; }
  });

  var status = await git(['status', '--porcelain', '--'].concat(PUBLISH_PATHS));
  if (!status) { step(true, 'Содержимое книги совпадает с опубликованным — публиковать нечего'); return { log: log, committed: false, versions: versions }; }
  var files = status.split(/\r?\n/).filter(Boolean);
  step(true, 'Изменено файлов: ' + files.length);

  var msg = 'docs: обновить издание «' + ((payload.ru.book && payload.ru.book.title) || 'книга') + '»';
  await git(['add', '-A', '--'].concat(PUBLISH_PATHS));
  /* Partial commit: в историю уходит только издание, чужие файлы индекса не трогаем. */
  await git(['commit', '-m', msg, '--'].concat(PUBLISH_PATHS));
  var sha = await git(['rev-parse', '--short', 'HEAD']);
  step(true, 'Коммит ' + sha + ' создан');

  await git(['push', 'origin', 'HEAD:' + branch]);
  step(true, 'Отправлено в origin/' + branch + ' — GitHub Pages обновится автоматически (1–3 минуты)');

  return { log: log, committed: true, sha: sha, branch: branch, versions: versions };
}

function json(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    /* Редактор иногда открывают двойным кликом (origin «null») — публичный
       доступ к этим запросам закрыт проверкой localhost выше, поэтому широкий
       CORS здесь безопасен. */
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true'
  });
  res.end(body);
}

http.createServer(function (req, res) {
  if (req.url.indexOf('/api/') === 0) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }
    var localReq = ['localhost', '127.0.0.1', '::1', '[::1]', ''].indexOf((req.headers.host || '').split(':')[0]) >= 0;
    if (!localReq) { json(res, 403, { error: 'публикация доступна только с этой машины' }); return; }

    if (req.url.indexOf('/api/publish-status') === 0) {
      json(res, 200, { enabled: CAN_PUBLISH, reason: CAN_PUBLISH ? '' :
        (publishOn ? 'предпросмотр собранного издания — публикация отключена' : 'публикация отключена ключом --no-publish') });
      return;
    }
    if (req.url.indexOf('/api/publish') === 0 && req.method === 'POST') {
      if (!CAN_PUBLISH) { json(res, 409, { error: 'Этот сервер не публикует: запускайте node serve.js из корня каталога' }); return; }
      if (publishing) { json(res, 409, { error: 'Публикация уже идёт — дождитесь её окончания' }); return; }
      publishing = true;
      console.log('\n→ публикация по запросу из редактора');
      readBody(req, PUBLISH_LIMIT).then(function (raw) {
        var payload = JSON.parse(raw || '{}');
        return publish(payload);
      }).then(function (out) {
        publishing = false;
        json(res, 200, out);
      }).catch(function (err) {
        publishing = false;
        var msg = err && (err.gitMessage || err.message) || 'неизвестная ошибка';
        console.error('  ✗ ' + msg);
        json(res, 500, { error: msg });
      });
      return;
    }
    json(res, 404, { error: 'нет такого запроса' });
    return;
  }

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
}).on('error', function (err) {
  /* Двойной запуск из publish.bat — самое частое. Окно закрываем молча,
     второй сервер не нужен: первый уже всё делает. */
  if (err.code === 'EADDRINUSE') {
    console.log('Сервер уже работает на http://localhost:' + port + ' — второй не нужен.');
    console.log('Если это окно запустилось случайно, просто закройте его.');
    setTimeout(function () { process.exit(0); }, 4000);
    return;
  }
  console.error('✖ сервер не поднялся: ' + (err.message || err));
  process.exit(1);
}).listen(port, function () {
  console.log('Книга отдаётся из ' + dir);
  console.log('Откройте  http://localhost:' + port + '/   (Ctrl+C — остановить)');
  console.log(CAN_PUBLISH
    ? 'Публикация: кнопка «⇧ Опубликовать» в кабинете автора'
    : 'Публикация недоступна' + (publishOn ? ' (открыт собранный dist/)' : ' (--no-publish)'));
  console.log('');
  console.log('Это окно — сервер издания. Держите его открытым, пока публикуете');
  console.log('книгу. Закрывать его не нужно: он работает в фоне и не мешает.');
});

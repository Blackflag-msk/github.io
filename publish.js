#!/usr/bin/env node
'use strict';

/*
  Публикация книги «Переплёт» — без единой внешней зависимости.

  Редактор хранит картинки как data:URL (base64), иначе автор не увидел бы их
  прямо на странице. На хостинге такой JSON раздувается и упирается в лимит
  localStorage читателя (~5 МБ). Скрипт выносит все data:URL в файлы images/ и
  оставляет в публикуемом JSON только ссылки: текст весит килобайты, картинки
  отдаются как обычные файлы и кэшируются браузером и CDN.

  src/book.json      — сырая копия из редактора («⤓ Копия книги»), живёт в git
  src/book.en.json   — то же для английской версии (необязателен)
  book.json, images/ — лёгкая публикаемая копия

  index.html в корне — локальный «толстый клиент» автора: чтение + кабинет с PIN.
  dist/index.html — читальня: метка pereplet-build=reader скрывает кабинет,
  даже если собранный сайт открыть локально.

  node publish.js              пишет книгу в корень каталога
  node publish.js --dist       собирает готовый сайт в dist/ (для GitHub Pages)
  node publish.js --dist out   собирает в out/
  node publish.js --check      только проверка и отчёт, ничего не пишет
  node publish.js --no-prune   не удалять неиспользуемые файлы в images/
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif',
  'image/apng': 'apng', 'image/tiff': 'tif', 'image/x-icon': 'ico'
};

/* src="data:..." / src='data:...' — закрывающая кавычка того же типа, что и открывающая. */
const IMG_SRC_RE = /(\bsrc\s*=\s*)(["'])(data:[\s\S]*?)\2/g;
/* Ссылки на уже вынесенные файлы: src="images/img-ab12cd.jpg". */
const PUB_SRC_RE = /(\bsrc\s*=\s*)(["'])(images\/[\w.\-]+)\2/g;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseArgs(argv) {
  const o = { src: path.join(ROOT, 'src'), out: ROOT, prune: true, dist: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') {
      o.dist = true;
      const next = argv[i + 1];
      o.out = next && !next.startsWith('--') ? path.resolve(next) : path.join(ROOT, 'dist');
    } else if (a === '--root') o.out = ROOT;
    else if (a === '--src') o.src = path.resolve(argv[++i]);
    else if (a === '--check') o.check = true;
    else if (a === '--no-prune') o.prune = false;
    else if (a === '-h' || a === '--help') { console.log('node publish.js [--dist [папка]] [--root] [--src <папка>] [--check] [--no-prune]'); process.exit(0); }
    else { console.error('Неизвестный аргумент: ' + a); process.exit(2); }
  }
  if (o.dist && o.out === ROOT) o.out = path.join(ROOT, 'dist');
  return o;
}

function fail(msg) { console.error('✖ ' + msg); process.exit(1); }
function kb(n) { return (n / 1024).toFixed(1) + ' КБ'; }

/* data:<mime>[;параметры][;base64],<тело>. Запятая в метаданных запрещена,
   поэтому первая запятая надёжно отделяет тип от данных. */
function parseDataUrl(url) {
  if (!/^data:/i.test(url)) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const parts = url.slice(5, comma).split(';');
  const mime = (parts[0] || '').trim().toLowerCase();
  const base64 = parts.slice(1).some(function (p) { return /^base64$/i.test(p.trim()); });
  const body = url.slice(comma + 1);
  if (!mime || !body) return null;
  let buf;
  try {
    if (base64) {
      const clean = body.replace(/\s+/g, '');
      if (!B64_RE.test(clean)) return null;
      buf = Buffer.from(clean, 'base64');
    } else {
      buf = Buffer.from(decodeURIComponent(body), 'utf8');
    }
  } catch (e) { return null; }
  if (!buf || !buf.length) return null;
  return { mime: mime, buf: buf };
}

function readBook(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { fail('Не читается ' + rel(p) + ': ' + e.message); }
  const book = data.book || data;
  if (!book || !Array.isArray(book.chapters)) fail('В ' + rel(p) + ' нет book.chapters — это выгрузка из «Переплёта»?');
  return { book: book, meta: data };
}

function rel(p) { return path.relative(ROOT, p) || '.'; }

/* Одинаковые картинки (обложка, повтор в RU и EN) пишутся один раз — по хешу содержимого. */
function makeStore() {
  const by = new Map();
  return {
    put: function (buf, mime) {
      const sum = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
      const ext = EXT[mime] || 'bin';
      const file = 'img-' + sum + '.' + ext;
      if (!by.has(file)) by.set(file, { buf: buf, bytes: buf.length, mime: mime });
      return file;
    },
    all: function () { return by; }
  };
}

function slimHtml(html, store, report) {
  return String(html).replace(IMG_SRC_RE, function (whole, pre, q, url) {
    const d = parseDataUrl(url);
    if (!d) { report.unparsed++; return whole; }
    report.bytes += url.length;
    report.converted++;
    return pre + q + 'images/' + store.put(d.buf, d.mime) + q;
  });
}

function collectPublished(html, set) {
  String(html).replace(PUB_SRC_RE, function (w, pre, q, url) { set.add(url.split('/').pop()); return w; });
}

/* Стабильная метка контента: одинаковый текст даёт одинаковый хеш. */
function contentHash(book) {
  return crypto.createHash('sha1').update(JSON.stringify(book), 'utf8').digest('hex');
}

/* Если книга не изменилась с прошлой сборки — сохраняем её version,
   иначе читатели каждый раз видели бы ложное «доступно обновление».
   Ищем в целевой папке и в корне (публикуемая копия может лежать там). */
function reuseVersion(dirs, name, hash) {
  for (const dir of dirs) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    let prev;
    try { prev = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    const pb = prev.book || prev;
    if (!pb || contentHash(pb) !== hash) continue;
    const v = Number(prev.version);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/* В опубликованном издании редактора быть не должно: сборка помечается как
   читальня, и открытие этого index.html где угодно — даже с диска — не покажет
   ни кнопки «Редактировать», ни запроса PIN. Локальный файл в корне проекта
   такой метки не имеет и остаётся полноценным клиентом автора. */
function readerHtml() {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tag = '<meta name="pereplet-build" content="reader">';
  if (src.indexOf('<meta name="pereplet-build"') !== -1) fail('index.html уже содержит метку pereplet-build');
  if (src.indexOf('<title>') === -1) fail('В index.html нет <title> — не к чему добавить метку читальни');
  return src.replace('<title>', tag + '\n<title>');
}

function main() {
  const opt = parseArgs(process.argv.slice(2));

  const ru = readBook(opt.src, 'book.json');
  const en = readBook(opt.src, 'book.en.json');
  if (!ru) fail('Нет исходника ' + rel(path.join(opt.src, 'book.json')) +
    '\n  Скачайте «⤓ Копия книги» в редакторе и положите файл в папку src/.');

  const store = makeStore();
  const referenced = new Set();
  const stamp = Number(process.env.BOOK_VERSION) || Date.now();
  const built = [];
  let unparsed = 0;

  [['book.json', ru], ['book.en.json', en]].forEach(function (pair) {
    const name = pair[0], src = pair[1];
    if (!src) return;
    const report = { converted: 0, bytes: 0, unparsed: 0 };
    const book = JSON.parse(JSON.stringify(src.book));
    book.chapters.forEach(function (ch) {
      ch.html = slimHtml(ch.html || '', store, report);
      collectPublished(ch.html, referenced);
    });
    unparsed += report.unparsed;
    const version = reuseVersion([opt.out, ROOT], name, contentHash(book)) ||
      (stamp + (name === 'book.en.json' ? 1 : 0));
    const json = JSON.stringify({ app: 'pereplet', version: version, updated: new Date().toISOString(), book: book }, null, 1);
    const after = Buffer.byteLength(json, 'utf8');
    built.push({
      name: name, json: json, version: version, converted: report.converted,
      before: Buffer.byteLength(JSON.stringify(src.book), 'utf8'),
      after: after
    });
    console.log('  ' + name + ': ' + book.chapters.length + ' глав, картинок вынесено ' + report.converted +
      ', data:URL ' + kb(report.bytes) + ' → JSON на хостинг ' + kb(after) + ' (v' + version + ')');
  });

  let imagesBytes = 0;
  store.all().forEach(function (v) { imagesBytes += v.buf.length; });

  const totalBefore = built.reduce(function (s, b) { return s + b.before; }, 0);
  const totalAfter = built.reduce(function (s, b) { return s + b.after; }, 0);
  const target = path.relative(ROOT, opt.out) || '.';

  if (opt.check) {
    console.log('\n-- check -- ' + target);
    console.log('  JSON: ' + kb(totalBefore) + ' → ' + kb(totalAfter) + ' (экономия ' + (100 - Math.round(totalAfter / totalBefore * 100)) + '%)');
    console.log('  картинок уникальных: ' + store.all().size + ', вес ' + kb(imagesBytes));
    console.log('  ничего не записано');
    if (unparsed) console.log('  ⚠ data:URL не распознано: ' + unparsed);
    return;
  }

  fs.mkdirSync(opt.out, { recursive: true });
  const imgDir = path.join(opt.out, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  store.all().forEach(function (v, file) { fs.writeFileSync(path.join(imgDir, file), v.buf); });
  built.forEach(function (b) { fs.writeFileSync(path.join(opt.out, b.name), b.json); });

  /* Та же книга, но подключённая скриптом: при открытии index.html двойным
     кликом браузер не отдаёт fetch() к локальным JSON. */
  const inline = {};
  built.forEach(function (b) { inline[b.name === 'book.en.json' ? 'en' : 'ru'] = JSON.parse(b.json); });
  fs.writeFileSync(path.join(opt.out, 'book-data.js'),
    'window.__PEREPLET_BOOKS=' + JSON.stringify(inline) + ';\n');

  /* Сборка полного сайта: вместе с dist/ кладём читалку и служебные файлы. */
  if (path.resolve(opt.out) !== path.resolve(ROOT)) {
    fs.writeFileSync(path.join(opt.out, 'index.html'), readerHtml());
    ['.nojekyll', 'README.md'].forEach(function (f) {
      if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(opt.out, f));
    });
    /* Ссылки на файлы, которые уже были опубликованы и редактором не менялись. */
    const prev = path.join(ROOT, 'images');
    if (fs.existsSync(prev)) {
      fs.readdirSync(prev).forEach(function (f) {
        if (!referenced.has(f)) return;
        const dst = path.join(imgDir, f);
        if (!fs.existsSync(dst)) fs.copyFileSync(path.join(prev, f), dst);
      });
    }
  }
  fs.writeFileSync(path.join(opt.out, '.nojekyll'), '');

  if (opt.prune) {
    const known = store.all();
    const gone = fs.readdirSync(imgDir).filter(function (f) {
      return f !== '.gitkeep' && !referenced.has(f) && !known.has(f);
    });
    gone.forEach(function (f) { fs.unlinkSync(path.join(imgDir, f)); });
    if (gone.length) console.log('  убрано неиспользуемых файлов: ' + gone.length);
  }

  console.log('\n✔ собрано в ' + target + '/');
  console.log('  JSON на хостинг: ' + kb(totalAfter) + ' (в исходниках ' + kb(totalBefore) + ', экономия ' + (100 - Math.round(totalAfter / totalBefore * 100)) + '%)');
  console.log('  картинок уникальных: ' + store.all().size + ', ' + kb(imagesBytes) + ' — файлы, кэшируются браузером и CDN');
  console.log('  ' + built.map(function (b) { return b.name + ' v' + b.version; }).join(', '));
  if (unparsed) console.log('  ⚠ не распознано data:URL: ' + unparsed + ' — проверьте эти главы');
  console.log('\n  просмотр локально: node serve.js' + (opt.dist ? ' ' + target : ''));
}

main();

// يقرأ المقالات المنشورة والكتب من Firestore (قراءة عامة — لا يحتاج مفاتيح سرية)
const fs = require('fs');
const path = require('path');

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'test-book-2eb74';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyC3-hqM2iYAH4LqaAyOm_Wwo2_jxBS_yh4';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { const o = {}; for (const k in f) o[k] = fromValue(f[k]); return o; }

async function queryCollection(collection, where) {
  const body = { structuredQuery: { from: [{ collectionId: collection }] } };
  if (where) body.structuredQuery.where = { fieldFilter: { field: { fieldPath: where[0] }, op: 'EQUAL', value: { stringValue: where[1] } } };
  const res = await fetch(`${BASE}:runQuery?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Firestore ${collection}: HTTP ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.filter((r) => r.document).map((r) => ({ id: r.document.name.split('/').pop(), ...fromFields(r.document.fields || {}) }));
}
const byDesc = (k) => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));
const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const httpImg = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
async function getSetting(key) {
  const res = await fetch(`${BASE}/settings/${key}?key=${API_KEY}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d.fields ? fromFields(d.fields).value : null;
}


function slug(text) {
  return (text || '').replace(/\s+/g, '-').replace(/[^\u0600-\u06FFa-zA-Z0-9-]/g, '').slice(0, 60);
}

function articleHTML(a) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${a.title} | وَرَق</title>
<meta name="description" content="${(a.excerpt || a.body || '').slice(0, 160).replace(/"/g, '&quot;')}">
<meta property="og:title" content="${a.title} | وَرَق">
<meta property="og:description" content="${(a.excerpt || '').replace(/"/g, '&quot;')}">
<meta property="og:url" content="https://waraq-adab.com/articles/${slug(a.title)}/">
<meta property="og:type" content="article">
${httpImg(a.image) ? `<meta property="og:image" content="${esc(a.image)}">
<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<link rel="canonical" href="https://waraq-adab.com/articles/${slug(a.title)}/">
${jsonLd({ '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.excerpt || '', author: { '@type': 'Person', name: a.author_name || 'وَرَق' }, datePublished: a.published_at || undefined, image: httpImg(a.image) || undefined, publisher: { '@type': 'Organization', name: 'مركز الأدب العربي' }, inLanguage: 'ar', mainEntityOfPage: `https://waraq-adab.com/articles/${slug(a.title)}/` })}
<meta http-equiv="refresh" content="0; url=https://waraq-adab.com/#art/${a.id}">
<style>
body{font-family:Cairo,sans-serif;direction:rtl;max-width:800px;margin:40px auto;padding:0 20px;color:#111;}
h1{font-size:28px;margin-bottom:12px;}
p{font-size:15px;line-height:1.9;color:#444;}
a{color:#1A7A7A;}
.meta{font-size:12px;color:#888;margin-bottom:20px;}
</style>
</head>
<body>
<h1>${a.title}</h1>
<div class="meta">${a.author_name || ''} · ${a.category || ''} · ${a.published_at ? new Date(a.published_at).toLocaleDateString('ar-SA') : ''}</div>
<p>${(a.excerpt || '')}</p>
<p>${(a.body || '').replace(/<[^>]*>/g, '').slice(0, 500)}...</p>
<p><a href="https://waraq-adab.com/#art/${a.id}">اقرأ المقالة كاملة على وَرَق ←</a></p>
</body>
</html>`;
}

function bookHTML(b) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${b.title} | وَرَق</title>
<meta name="description" content="${(b.description || b.desc || '').slice(0, 160).replace(/"/g, '&quot;')}">
<meta property="og:title" content="${b.title} | وَرَق">
<meta property="og:description" content="${(b.description || b.desc || '').replace(/"/g, '&quot;')}">
<meta property="og:url" content="https://waraq-adab.com/books/${slug(b.title)}/">
<meta property="og:type" content="book">
${httpImg(b.image) ? `<meta property="og:image" content="${esc(b.image)}">` : ''}
${jsonLd({ '@context': 'https://schema.org', '@type': 'Book', name: b.title, author: { '@type': 'Person', name: b.author || '' }, genre: b.genre || undefined, description: b.description || b.desc || '', image: httpImg(b.image) || undefined, publisher: { '@type': 'Organization', name: 'مركز الأدب العربي' }, inLanguage: 'ar', url: b.url || undefined })}
<link rel="canonical" href="https://waraq-adab.com/books/${slug(b.title)}/">
<meta http-equiv="refresh" content="0; url=https://waraq-adab.com/#book/${b.id}">
<style>
body{font-family:Cairo,sans-serif;direction:rtl;max-width:800px;margin:40px auto;padding:0 20px;color:#111;}
h1{font-size:28px;margin-bottom:12px;}
p{font-size:15px;line-height:1.9;color:#444;}
a{color:#1A7A7A;}
.meta{font-size:12px;color:#888;margin-bottom:20px;}
</style>
</head>
<body>
<h1>${b.title}</h1>
<div class="meta">${b.author || ''} · ${b.genre || ''}</div>
<p>${(b.description || b.desc || '')}</p>
<p><a href="https://waraq-adab.com/#book/${b.id}">عرض الكتاب على وَرَق ←</a></p>
</body>
</html>`;
}

async function generate() {
  const urls = ['<url><loc>https://waraq-adab.com/</loc></url>'];
  // remove old generated pages so hidden/archived/deleted items disappear from the site and the sitemap
  ['articles', 'books', 'pages'].forEach((d) => { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); });

  // مقالات
  const now = new Date();
  const arts = (await queryCollection('articles', ['status', 'published'])).filter((a) => !a.published_at || new Date(a.published_at) <= now).sort(byDesc('published_at'));
  if (arts && arts.length) {
    fs.mkdirSync('articles', { recursive: true });
    for (const a of arts) {
      const s = slug(a.title);
      if (!s) continue;
      const dir = path.join('articles', s);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), articleHTML(a));
      urls.push(`<url><loc>https://waraq-adab.com/articles/${s}/</loc><lastmod>${new Date().toISOString().slice(0,10)}</lastmod></url>`);
    }
    console.log(`✓ ${arts.length} مقالة`);
  }

  // كتب
  const books = (await queryCollection('books')).filter((b) => b.archived !== true).sort(byDesc('created_at'));
  if (books && books.length) {
    fs.mkdirSync('books', { recursive: true });
    for (const b of books) {
      const s = slug(b.title);
      if (!s) continue;
      const dir = path.join('books', s);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), bookHTML(b));
      urls.push(`<url><loc>https://waraq-adab.com/books/${s}/</loc><lastmod>${new Date().toISOString().slice(0,10)}</lastmod></url>`);
    }
    console.log(`✓ ${books.length} كتاب`);
  }

  // صفحات مخصصة من لوحة التحكم
  const pages = (await getSetting('pages')) || [];
  for (const pg of pages) {
    if (!pg || !pg.id || pg.hidden) continue;
    const dir = path.join('pages', String(pg.id).replace(/[^a-z0-9_-]/gi, ''));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(pg.title)} | وَرَق</title><meta name="description" content="${esc(pg.subtitle || pg.title)}"><meta property="og:title" content="${esc(pg.title)} | وَرَق"><link rel="canonical" href="https://waraq-adab.com/pages/${pg.id}/"><meta http-equiv="refresh" content="0; url=https://waraq-adab.com/#p-${pg.id}"></head><body><h1>${esc(pg.title)}</h1><p>${esc(pg.subtitle || '')}</p><p><a href="https://waraq-adab.com/#p-${pg.id}">افتح الصفحة على وَرَق</a></p></body></html>`);
    urls.push(`<url><loc>https://waraq-adab.com/pages/${pg.id}/</loc></url>`);
  }
  if (pages.length) console.log(`✓ ${pages.length} صفحة مخصصة`);

  // data.js: نسخة محلية محدّثة للعرض الفوري (بدون المخفي والمؤرشف والمجدول)
  const clean = (o, keys) => { const r = {}; keys.forEach((k) => { if (o[k] !== undefined && o[k] !== null) r[k] = typeof o[k] === 'string' && k !== 'body' && k !== 'image' ? o[k].replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, '”') : o[k]; }); return r; };
  const artKeys = ['id', 'title', 'author_name', 'category', 'badge', 'published_at', 'excerpt', 'body', 'image', 'status'];
  const settingsRows = (await queryCollection('settings')).filter((r) => !String(r.id).startsWith('media_')).map((r) => ({ key: r.id, value: r.value }));
  const snapshot = {
    articles: arts.filter((a) => a.category !== 'أخبار').map((a) => clean(a, artKeys)),
    news: arts.filter((a) => a.category === 'أخبار').map((a) => clean(a, artKeys)),
    books: books.map((b) => clean(b, ['id', 'title', 'author', 'genre', 'stars', 'description', 'quote', 'url', 'color', 'image', 'created_at'])),
    settings: settingsRows,
  };
  fs.writeFileSync('data.js', '/* وَرَق — نسخة محلية تُحدَّث يومياً تلقائياً من قاعدة البيانات. لا تعدّلها يدوياً. */\nwindow.WARAQ_DATA = ' + JSON.stringify(snapshot, null, 1).replace(/<\/script/gi, '<\/script') + ';\n');
  console.log(`✓ data.js: ${snapshot.articles.length} مقالة، ${snapshot.news.length} خبر، ${snapshot.books.length} كتاب`);

  // sitemap
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
  fs.writeFileSync('sitemap.xml', sitemap);
  console.log(`✓ sitemap: ${urls.length} رابط`);
}

generate().catch(e => { console.error(e); process.exit(1); });

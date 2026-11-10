const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const fs = require('fs');
const path = require('path');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } });

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
<link rel="canonical" href="https://waraq-adab.com/articles/${slug(a.title)}/">
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

  // مقالات
  const { data: arts } = await sb.from('articles').select('*').eq('status', 'published').order('published_at', { ascending: false });
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
  const { data: books } = await sb.from('books').select('*').neq('archived', true).order('created_at', { ascending: false });
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

  // sitemap
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
  fs.writeFileSync('sitemap.xml', sitemap);
  console.log(`✓ sitemap: ${urls.length} رابط`);
}

generate().catch(e => { console.error(e); process.exit(1); });

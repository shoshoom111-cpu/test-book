/*
 * وَرَق — طبقة توافق: نفس واجهة supabase-js التي يستخدمها الموقع، لكن البيانات في Firebase.
 * Requires (before this file): firebase-app-compat, firebase-auth-compat, firebase-firestore-compat, firebase-config.js
 *
 * Supported: from(t).select(cols).eq().neq().order().limit().single().maybeSingle()
 *            .insert(obj|arr) .update(obj) .upsert(obj) .delete()   (all awaitable / .then)
 *            auth.getSession/getUser/signInWithPassword/signOut/signUp/resetPasswordForEmail/updateUser/onAuthStateChange
 */
(function () {
  'use strict';
  if (typeof firebase === 'undefined' || typeof FIREBASE_CONFIG === 'undefined') {
    console.error('Firebase SDK or FIREBASE_CONFIG missing');
    return;
  }
  var app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
  var auth = app.auth();

  // ── Firestore عبر REST ──
  // موانع الإعلانات تحجب قناة Firestore المباشرة (Listen/Write channel) فتفشل القراءة والحفظ.
  // واجهة REST العادية لا تُحجب، وتطبّق نفس قواعد الحماية.
  var PID = FIREBASE_CONFIG.projectId, KEY = FIREBASE_CONFIG.apiKey;
  var ROOT = 'projects/' + PID + '/databases/(default)/documents';
  var API = 'https://firestore.googleapis.com/v1/';
  function docName(t, id) { return ROOT + '/' + t + '/' + id; }
  function docUrl(t, id) { return API + ROOT + '/' + encodeURIComponent(t) + '/' + encodeURIComponent(id); }
  function fpath(k) { return /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + String(k).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'; }
  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(enc) } : {} };
    if (typeof v === 'object') return { mapValue: { fields: encFields(v) } };
    return { stringValue: String(v) };
  }
  function encFields(o) { var f = {}; Object.keys(o).forEach(function (k) { if (o[k] !== undefined) f[k] = enc(o[k]); }); return f; }
  function dec(v) {
    if (!v) return null;
    if ('nullValue' in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('stringValue' in v) return v.stringValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
    if ('mapValue' in v) return decFields(v.mapValue.fields || {});
    if ('referenceValue' in v) return v.referenceValue;
    if ('bytesValue' in v) return v.bytesValue;
    if ('geoPointValue' in v) return v.geoPointValue;
    return null;
  }
  function decFields(f) { var o = {}; Object.keys(f || {}).forEach(function (k) { o[k] = dec(f[k]); }); return o; }
  function restErr(status, body) {
    if (Array.isArray(body)) body = body[0];
    var e = (body && body.error) || {}, st = String(e.status || '');
    if (!st && status === 403) st = 'PERMISSION_DENIED';
    var code = st === 'PERMISSION_DENIED' ? 'permission-denied' : st === 'NOT_FOUND' ? 'not-found' : st === 'UNAUTHENTICATED' ? 'unauthenticated' : (st.toLowerCase().replace(/_/g, '-') || ('http-' + status));
    var x = new Error(e.message || ('HTTP ' + status)); x.code = code; return x;
  }
  function rest(method, url, body, ms) {
    return ready.then(function () {
      return auth.currentUser ? auth.currentUser.getIdToken() : null;
    }).then(function (tok) {
      var h = { 'Content-Type': 'application/json' };
      if (tok) h.Authorization = 'Bearer ' + tok;
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 45000) : null;
      return fetch(url + (url.indexOf('?') > -1 ? '&' : '?') + 'key=' + encodeURIComponent(KEY), {
        method: method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: ctl ? ctl.signal : undefined, cache: 'no-store'
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        return r.text().then(function (txt) {
          var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
          if (!r.ok) { if (r.status === 404 && method === 'GET') return null; throw restErr(r.status, j); }
          return j;
        });
      }, function (e) {
        if (timer) clearTimeout(timer);
        var x = new Error(e && e.name === 'AbortError' ? 'انتهت مهلة الاتصال بقاعدة البيانات' : 'تعذر الاتصال بقاعدة البيانات'); x.code = 'unavailable'; throw x;
      });
    });
  }
  function commit(writes) { return rest('POST', API + ROOT + ':commit', { writes: writes }, 120000); }
  function newId() { var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', o = ''; var r = (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(20)) : null; for (var i = 0; i < 20; i++) o += c[(r ? r[i] : Math.floor(Math.random() * 256)) % 62]; return o; }

  // primary key per table (document id)
  var PK = { settings: 'key', article_views: 'article_id', site_visits: 'visit_date' };
  // column defaults that Postgres used to fill in
  var DEFAULTS = {
    articles: { status: 'pending' },
    comments: { status: 'pending' },
    books: { archived: false },
    profiles: { role: 'writer' }
  };
  function pkOf(t) { return PK[t] || 'id'; }
  function nowIso() { return new Date().toISOString(); }
  function clean(o) { var r = {}; Object.keys(o).forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; }); return r; }
  function err(e) {
    var code = (e && e.code) || '';
    var msg = (e && e.message) || String(e);
    return { message: msg + (code ? ' (' + code + ')' : ''), code: code };
  }
  function cmp(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    return a < b ? -1 : 1;
  }

  function Query(table) {
    this.t = table; this.f = []; this.ord = []; this.lim = null;
    this.cols = null; this.mode = 'select'; this.payload = null; this.one = 0; this.returning = false;
  }
  Query.prototype.select = function (cols) {
    if (this.mode !== 'select') this.returning = true;
    this.cols = (!cols || cols === '*') ? null : cols.split(',').map(function (c) { return c.trim(); });
    return this;
  };
  Query.prototype.eq = function (c, v) { this.f.push(['==', c, v]); return this; };
  Query.prototype.neq = function (c, v) { this.f.push(['!=', c, v]); return this; };
  Query.prototype['in'] = function (c, v) { this.f.push(['in', c, v]); return this; };
  Query.prototype.order = function (c, o) { this.ord.push([c, !(o && o.ascending === false)]); return this; };
  Query.prototype.limit = function (n) { this.lim = n; return this; };
  Query.prototype.single = function () { this.one = 1; return this; };
  Query.prototype.maybeSingle = function () { this.one = 2; return this; };
  Query.prototype.insert = function (p) { this.mode = 'insert'; this.payload = p; return this; };
  Query.prototype.update = function (p) { this.mode = 'update'; this.payload = p; return this; };
  Query.prototype.upsert = function (p) { this.mode = 'upsert'; this.payload = p; return this; };
  Query.prototype['delete'] = function () { this.mode = 'delete'; return this; };
  Query.prototype.then = function (res, rej) { return this._run().then(res, rej); };
  Query.prototype['catch'] = function (rej) { return this._run()['catch'](rej); };

  Query.prototype._match = function (row) {
    return this.f.every(function (x) {
      var v = row[x[1]];
      if (x[0] === '==') return v === x[2] || (v !== undefined && v !== null && String(v) === String(x[2]) && typeof x[2] !== 'boolean');
      if (x[0] === '!=') return !(v === x[2] || (v !== undefined && v !== null && String(v) === String(x[2])));
      if (x[0] === 'in') return (x[2] || []).indexOf(v) > -1;
      return true;
    });
  };
  // fetch matching docs: equality filters go to the server (so security rules can verify them), the rest client-side
  Query.prototype._fetch = function () {
    var self = this, pk = pkOf(this.t), t = this.t;
    var idEq = this.f.filter(function (x) { return x[0] === '==' && x[1] === pk; })[0];
    if (idEq) {
      return rest('GET', docUrl(t, String(idEq[2]))).then(function (d) {
        if (!d || !d.fields && !d.name) return [];
        var row = decFields(d.fields); if (row[pk] === undefined) row[pk] = String(idEq[2]);
        return self._match(row) ? [{ ref: d.name, row: row }] : [];
      });
    }
    var filters = this.f.filter(function (x) { return x[0] === '=='; }).map(function (x) {
      return { fieldFilter: { field: { fieldPath: fpath(x[1]) }, op: 'EQUAL', value: enc(x[2]) } };
    });
    var q = { from: [{ collectionId: t }] };
    if (filters.length === 1) q.where = filters[0];
    else if (filters.length > 1) q.where = { compositeFilter: { op: 'AND', filters: filters } };
    return rest('POST', API + ROOT + ':runQuery', { structuredQuery: q }).then(function (res) {
      var out = [];
      (res || []).forEach(function (x) {
        if (!x || !x.document) return;
        var row = decFields(x.document.fields);
        if (row[pk] === undefined) row[pk] = decodeURIComponent(x.document.name.split('/').pop());
        if (self._match(row)) out.push({ ref: x.document.name, row: row });
      });
      return out;
    });
  };
  // حماية: نصوص المقالات والكتب تُنظَّف من رموز HTML قبل أن تصل للصفحة (نص المقالة نفسه يُنظَّف بـ DOMPurify عند العرض)
  var SAFE_TEXT = ['title', 'excerpt', 'author_name', 'author', 'category', 'genre', 'description', 'desc', 'badge', 'quote', 'stars', 'pen_name', 'name'];
  var SAFE_URL = ['image', 'url'];
  function safeRow(t, r) {
    if (!r || (t !== 'articles' && t !== 'books')) return r;
    var o = Object.assign({}, r);
    SAFE_TEXT.forEach(function (k) { if (typeof o[k] === 'string') o[k] = o[k].replace(/</g, '‹').replace(/>/g, '›').replace(/"/g, '”'); });
    SAFE_URL.forEach(function (k) { if (typeof o[k] === 'string' && o[k] && (!/^(https?:\/\/|data:image\/|[\w\-./]+$)/i.test(o[k]) || /["'<>\s]/.test(o[k]))) o[k] = ''; });
    if (typeof o.color === 'string' && o.color && !/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(o.color.trim())) o.color = '';
    return o;
  }
  Query.prototype._shape = function (rows) {
    var self = this;
    rows = rows.map(function (r) { return safeRow(self.t, r); });
    if (this.ord.length) {
      rows.sort(function (a, b) {
        for (var i = 0; i < self.ord.length; i++) {
          var c = self.ord[i][0], r = cmp(a[c], b[c]);
          if (r) return self.ord[i][1] ? r : -r;
        }
        return 0;
      });
    }
    if (this.lim !== null) rows = rows.slice(0, this.lim);
    if (this.cols) rows = rows.map(function (r) { var o = {}; self.cols.forEach(function (c) { o[c] = r[c] === undefined ? null : r[c]; }); return o; });
    if (this.one) {
      if (!rows.length) return this.one === 1 ? { data: null, error: { message: 'No rows found', code: 'PGRST116' } } : { data: null, error: null };
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  };
  Query.prototype._run = function () {
    var self = this, t = this.t, pk = pkOf(t);
    var p;
    if (this.mode === 'select') {
      p = this._fetch().then(function (docs) { return self._shape(docs.map(function (d) { return d.row; })); });
    } else if (this.mode === 'insert' || this.mode === 'upsert') {
      var list = Array.isArray(this.payload) ? this.payload : [this.payload];
      var writes = [], saved = [];
      list.forEach(function (obj) {
        var row = clean(Object.assign({}, obj));
        if (self.mode === 'insert') {
          row = Object.assign({}, DEFAULTS[t] || {}, row);
          if (row.created_at === undefined && t !== 'settings') row.created_at = nowIso();
          if (row[pk] === undefined || row[pk] === null) row[pk] = newId();
          writes.push({ update: { name: docName(t, String(row[pk])), fields: encFields(row) } });
        } else {
          if (t === 'settings') row.updated_at = nowIso();
          writes.push({ update: { name: docName(t, String(row[pk])), fields: encFields(row) }, updateMask: { fieldPaths: Object.keys(row).map(fpath) } });
        }
        saved.push(row);
      });
      p = commit(writes).then(function () { return self._shape(saved); });
    } else if (this.mode === 'update') {
      var patch = clean(Object.assign({}, this.payload));
      p = this._fetch().then(function (docs) {
        if (!docs.length) return self._shape([]);
        var writes = docs.map(function (d) { return { update: { name: d.ref, fields: encFields(patch) }, updateMask: { fieldPaths: Object.keys(patch).map(fpath) }, currentDocument: { exists: true } }; });
        return commit(writes).then(function () { return self._shape(docs.map(function (d) { return Object.assign({}, d.row, patch); })); });
      });
    } else if (this.mode === 'delete') {
      p = this._fetch().then(function (docs) {
        if (!docs.length) return { data: [], error: null };
        return commit(docs.map(function (d) { return { 'delete': d.ref }; })).then(function () { return { data: docs.map(function (d) { return d.row; }), error: null }; });
      });
    }
    return p.then(function (r) {
      if (!self.returning && self.mode !== 'select') return { data: null, error: null };
      return r;
    }, function (e) {
      console.warn('[waraq-db]', t, self.mode, e && e.code, e && e.message);
      return { data: null, error: err(e) };
    });
  };

  // ── auth ──
  var ready = new Promise(function (resolve) { var off = auth.onAuthStateChanged(function () { off(); resolve(); }); });
  function sess(u) { return u ? { user: { id: u.uid, email: u.email }, access_token: 'firebase' } : null; }
  function authErr(e) {
    var c = (e && e.code) || '', m = (e && e.message) || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-login|invalid-email/.test(c)) m = 'Invalid login credentials';
    else if (/too-many-requests/.test(c)) m = 'Too many requests';
    else if (/email-already-in-use/.test(c)) m = 'User already registered';
    else if (/weak-password/.test(c)) m = 'Password should be at least 6 characters';
    else if (/requires-recent-login/.test(c)) m = 'Please sign in again before changing the password';
    return { message: m, code: c };
  }
  var authApi = {
    getSession: function () { return ready.then(function () { return { data: { session: sess(auth.currentUser) }, error: null }; }); },
    getUser: function () { return ready.then(function () { var s = sess(auth.currentUser); return { data: { user: s && s.user }, error: null }; }); },
    signInWithPassword: function (o) {
      return auth.signInWithEmailAndPassword(o.email, o.password)
        .then(function (c) { var s = sess(c.user); return { data: { user: s.user, session: s }, error: null }; })
        ['catch'](function (e) { return { data: { user: null, session: null }, error: authErr(e) }; });
    },
    signOut: function () { return auth.signOut().then(function () { return { error: null }; }); },
    // create an account WITHOUT logging the current admin out (uses a secondary app instance)
    signUp: function (o) {
      var sec = firebase.apps.filter(function (a) { return a.name === 'waraq-secondary'; })[0] || firebase.initializeApp(FIREBASE_CONFIG, 'waraq-secondary');
      return sec.auth().createUserWithEmailAndPassword(o.email, o.password)
        .then(function (c) { var u = { id: c.user.uid, email: c.user.email }; return sec.auth().signOut().then(function () { return { data: { user: u, session: null }, error: null }; }); })
        ['catch'](function (e) { return { data: { user: null, session: null }, error: authErr(e) }; });
    },
    resetPasswordForEmail: function (email) {
      return auth.sendPasswordResetEmail(email).then(function () { return { data: {}, error: null }; })['catch'](function (e) { return { data: null, error: authErr(e) }; });
    },
    updateUser: function (o) {
      return ready.then(function () {
        if (!auth.currentUser) return { data: null, error: { message: 'Not signed in' } };
        var jobs = [];
        if (o.password) jobs.push(auth.currentUser.updatePassword(o.password));
        if (o.email) jobs.push(auth.currentUser.updateEmail(o.email));
        return Promise.all(jobs).then(function () { return { data: { user: sess(auth.currentUser).user }, error: null }; })['catch'](function (e) { return { data: null, error: authErr(e) }; });
      });
    },
    onAuthStateChange: function (cb) {
      var off = auth.onAuthStateChanged(function (u) { cb(u ? 'SIGNED_IN' : 'SIGNED_OUT', sess(u)); });
      return { data: { subscription: { unsubscribe: off } } };
    }
  };

  var client = {
    from: function (t) { return new Query(t); },
    auth: authApi,
    channel: function () { return { on: function () { return this; }, subscribe: function () { return this; } }; },
    removeChannel: function () {},
    // زيادة عدّاد بمقدار واحد (عدّاد القراءات)
    increment: function (t, id, field, extra) {
      var w = { update: { name: docName(t, String(id)), fields: encFields(extra || {}) }, updateMask: { fieldPaths: Object.keys(extra || {}).map(fpath) }, updateTransforms: [{ fieldPath: fpath(field), increment: { integerValue: '1' } }] };
      return commit([w]);
    },
    _firebase: { app: app, auth: auth }
  };
  window.supabase = { createClient: function () { return client; } };
  window.waraqDB = client;
})();

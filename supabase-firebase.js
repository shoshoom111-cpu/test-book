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
  var db = app.firestore();
  // اتصال بديل تلقائي عند حجب الاتصال العادي (موانع الإعلانات، الشبكات المقيّدة، أخطاء QUIC)
  try { db.settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) {}
  var auth = app.auth();

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
    var self = this, pk = pkOf(this.t), ref = db.collection(this.t);
    var idEq = this.f.filter(function (x) { return x[0] === '==' && x[1] === pk; })[0];
    if (idEq) {
      return ref.doc(String(idEq[2])).get().then(function (d) {
        if (!d.exists) return [];
        var row = d.data(); row[pk] = row[pk] !== undefined ? row[pk] : d.id;
        return self._match(row) ? [{ ref: d.ref, row: row }] : [];
      });
    }
    var q = ref;
    this.f.forEach(function (x) { if (x[0] === '==') q = q.where(x[1], '==', x[2]); });
    return q.get().then(function (snap) {
      var out = [];
      snap.forEach(function (d) {
        var row = d.data(); if (row[pk] === undefined) row[pk] = d.id;
        if (self._match(row)) out.push({ ref: d.ref, row: row });
      });
      return out;
    });
  };
  Query.prototype._shape = function (rows) {
    var self = this;
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
      var batch = db.batch(), saved = [];
      list.forEach(function (obj) {
        var row = clean(Object.assign({}, obj));
        var ref;
        if (self.mode === 'insert') {
          row = Object.assign({}, DEFAULTS[t] || {}, row);
          if (row.created_at === undefined && t !== 'settings') row.created_at = nowIso();
          ref = row[pk] !== undefined && row[pk] !== null ? db.collection(t).doc(String(row[pk])) : db.collection(t).doc();
          if (row[pk] === undefined || row[pk] === null) row[pk] = ref.id;
          batch.set(ref, row);
        } else {
          if (t === 'settings') row.updated_at = nowIso();
          ref = db.collection(t).doc(String(row[pk]));
          batch.set(ref, row, { mergeFields: Object.keys(row) });
        }
        saved.push(row);
      });
      p = batch.commit().then(function () { return self._shape(saved); });
    } else if (this.mode === 'update') {
      var patch = clean(Object.assign({}, this.payload));
      p = this._fetch().then(function (docs) {
        var batch = db.batch();
        docs.forEach(function (d) { batch.update(d.ref, patch); });
        return batch.commit().then(function () { return self._shape(docs.map(function (d) { return Object.assign({}, d.row, patch); })); });
      });
    } else if (this.mode === 'delete') {
      p = this._fetch().then(function (docs) {
        var batch = db.batch();
        docs.forEach(function (d) { batch['delete'](d.ref); });
        return batch.commit().then(function () { return { data: docs.map(function (d) { return d.row; }), error: null }; });
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
    _firebase: { app: app, db: db, auth: auth }
  };
  window.supabase = { createClient: function () { return client; } };
  window.waraqDB = client;
})();

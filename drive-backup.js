/* Drive Backup v1
 * Backup & restore otomatis ke Google Drive lewat Google Apps Script.
 * Dipakai bersama oleh: Service Report, Weekly Report, Permohonan UC.
 * Konfigurasi per aplikasi lewat window.DRIVE_BACKUP (lihat snippet di index.html).
 */
(function () {
  'use strict';
  var C = window.DRIVE_BACKUP;
  if (!C || !C.app || !C.keys || !C.keys.length || !window.localStorage) return;

  var APP = C.app, KEYS = C.keys, MAIN = KEYS[0], LABEL = C.label || C.app;
  var CFG_KEY = 'drivebackup:cfg';
  var META_KEY = 'drivebackup:meta:' + APP;
  var FLAG_KEY = 'drivebackup:restored:' + APP;
  var DEBOUNCE = 15000;

  var proto = Storage.prototype;
  var origSet = proto.setItem;
  var restoring = false, timer = null, busy = false;

  /* ---------- penyimpanan lokal ---------- */
  function rawGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function rawSet(k, v) { try { origSet.call(localStorage, k, v); } catch (e) {} }
  function jget(k, d) { try { var v = rawGet(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function cfg() { return jget(CFG_KEY, null); }
  function meta() { return jget(META_KEY, {}); }
  function setMeta(p) { var m = meta(); for (var k in p) m[k] = p[k]; rawSet(META_KEY, JSON.stringify(m)); }

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }
  function snapshot() {
    var o = {};
    KEYS.forEach(function (k) { var v = rawGet(k); if (v !== null) o[k] = v; });
    return o;
  }
  function isEmpty(keysObj) {
    var d = null;
    try { d = keysObj[MAIN] != null ? JSON.parse(keysObj[MAIN]) : null; } catch (e) { return false; }
    if (d === null) return true;
    try { return C.isEmpty ? !!C.isEmpty(d) : false; } catch (e) { return false; }
  }

  // Tangkap setiap penyimpanan data aplikasi supaya backup berjalan sendiri
  proto.setItem = function (k, v) {
    if (this === localStorage && KEYS.indexOf(k) >= 0) {
      if (restoring) return; // cegah data lama menimpa hasil restore saat halaman dimuat ulang
      origSet.call(this, k, v);
      markDirty();
      return;
    }
    return origSet.call(this, k, v);
  };

  /* ---------- komunikasi dengan Apps Script ---------- */
  function call(action, extra) {
    var c = cfg();
    if (!c || !c.url) return Promise.reject(new Error('Belum tersambung ke Drive'));
    var body = { action: action, secret: c.secret, app: APP };
    for (var k in (extra || {})) body[k] = extra[k];
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 90000);
    return fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (txt) {
      var j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('Balasan script tidak valid. Pastikan deploy dengan akses "Anyone".'); }
      if (!j.ok) throw new Error(j.error || 'Gagal');
      return j;
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw new Error('Waktu habis, sinyal lemah');
      if (e && /Failed to fetch|NetworkError|Load failed/i.test(e.message)) throw new Error('Tidak bisa menghubungi Drive (cek sinyal)');
      throw e;
    }).finally(function () { clearTimeout(t); });
  }

  /* ---------- backup ---------- */
  function markDirty() {
    setMeta({ dirty: true });
    updateDot();
    schedule(DEBOUNCE);
  }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { flush(false); }, ms);
  }
  function flush(force) {
    clearTimeout(timer);
    var c = cfg();
    if (!c || !c.url) { updateDot(); return Promise.resolve(false); }
    if (busy) { schedule(5000); return Promise.resolve(false); }
    var keys = snapshot();
    if (isEmpty(keys)) { // data kosong tidak pernah dikirim, supaya backup yang bagus tidak tertimpa
      setMeta({ dirty: false });
      updateDot();
      if (force) toast('Data masih kosong, tidak ada yang di-backup');
      return Promise.resolve(false);
    }
    var h = hash(JSON.stringify(keys));
    if (!force && meta().hash === h) { setMeta({ dirty: false }); updateDot(); return Promise.resolve(true); }
    if (navigator.onLine === false) { updateDot(); if (force) toast('Sedang offline, backup dikirim saat online'); return Promise.resolve(false); }
    busy = true;
    updateDot('sync');
    return call('backup', { data: { format: 1, app: APP, savedAt: new Date().toISOString(), keys: keys } })
      .then(function (r) {
        var p = { dirty: false, hash: h, last: new Date().toISOString(), error: '' };
        setMeta(p);
        if (r.folderUrl) { var cc = cfg(); if (cc) { cc.folderUrl = r.folderUrl; rawSet(CFG_KEY, JSON.stringify(cc)); } }
        if (force) toast('Backup tersimpan di Google Drive');
        return true;
      })
      .catch(function (e) {
        setMeta({ error: String(e.message || e) });
        if (force) toast('Backup gagal: ' + (e.message || e));
        schedule(60000);
        return false;
      })
      .then(function (ok) { busy = false; updateDot(); renderPanel(); return ok; });
  }

  /* ---------- restore ---------- */
  function applyBackup(data) {
    if (!data || !data.keys) { toast('Isi backup tidak dikenali'); return; }
    restoring = true;
    KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    Object.keys(data.keys).forEach(function (k) { if (KEYS.indexOf(k) >= 0) rawSet(k, data.keys[k]); });
    setMeta({ dirty: false, hash: hash(JSON.stringify(snapshot())), error: '' });
    try { sessionStorage.setItem(FLAG_KEY, data.savedAt || '1'); } catch (e) {}
    location.reload();
  }
  function restore(name) {
    toast('Mengambil backup dari Drive…');
    return call('get', name ? { name: name } : {}).then(function (r) {
      if (!r.data || !r.data.keys || isEmpty(r.data.keys)) { toast('Belum ada backup di Drive untuk ' + LABEL); return; }
      toast('Memulihkan backup ' + fmt(r.data.savedAt) + '…');
      setTimeout(function () { applyBackup(r.data); }, 500);
    }).catch(function (e) { toast('Gagal mengambil backup: ' + (e.message || e)); });
  }
  function autoRestore() {
    var flag = null;
    try { flag = sessionStorage.getItem(FLAG_KEY); sessionStorage.removeItem(FLAG_KEY); } catch (e) {}
    if (flag) { toast('Data dipulihkan dari backup ' + fmt(flag)); return; }
    if (!isEmpty(snapshot())) return;
    var c = cfg();
    if (!c || !c.url) {
      setTimeout(function () { toast('Data kosong. Ketuk tombol \u2601 untuk menyambungkan Google Drive dan memulihkan data.', 6000); }, 800);
      if (btn) btn.classList.add('dbk-pulse');
      return;
    }
    if (navigator.onLine === false) return;
    toast('Data kosong, mengecek backup di Google Drive…');
    restore();
  }

  /* ---------- tampilan ---------- */
  var BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  function fmt(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getDate() + ' ' + BLN[d.getMonth()] + ' ' + d.getFullYear() + ', ' + p(d.getHours()) + '.' + p(d.getMinutes());
  }
  function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function openUrl(u) {
    if (window.AndroidBridge && window.AndroidBridge.openUrl) window.AndroidBridge.openUrl(u);
    else window.open(u, '_blank', 'noopener');
  }

  var css = '' +
    '.dbk-fab{position:fixed;right:12px;bottom:calc(140px + env(safe-area-inset-bottom));z-index:9990;width:46px;height:46px;border-radius:50%;border:1px solid #d0d6e2;background:#fff;box-shadow:0 3px 10px rgba(0,0,0,.18);font-size:21px;line-height:1;cursor:pointer;display:grid;place-items:center;color:#1c2233;padding:0}' +
    '.dbk-fab i{position:absolute;right:3px;top:3px;width:11px;height:11px;border-radius:50%;border:2px solid #fff;background:#9aa3b2}' +
    '.dbk-fab.ok i{background:#16a34a}.dbk-fab.wait i{background:#f59e0b}.dbk-fab.err i{background:#dc2626}' +
    '.dbk-fab.dbk-pulse{animation:dbkp 1.4s infinite}' +
    '@keyframes dbkp{0%{box-shadow:0 0 0 0 rgba(37,99,235,.55)}70%{box-shadow:0 0 0 14px rgba(37,99,235,0)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0)}}' +
    '.dbk-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9995;display:none;align-items:flex-end;justify-content:center}' +
    '.dbk-bg.on{display:flex}' +
    '.dbk-sheet{background:#fff;color:#1c2233;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;border-radius:16px 16px 0 0;padding:16px 16px calc(18px + env(safe-area-inset-bottom));font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}' +
    '.dbk-sheet *{box-sizing:border-box}' +
    '.dbk-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}' +
    '.dbk-hd b{font-size:16px}' +
    '.dbk-x{background:none;border:0;font-size:26px;line-height:1;color:#6b7280;cursor:pointer;padding:0 4px}' +
    '.dbk-sheet p{margin:0 0 10px;color:#4b5563}' +
    '.dbk-lbl{display:block;font-size:12px;color:#6b7280;margin:6px 0 4px}' +
    '.dbk-in{width:100%;padding:10px;border:1px solid #d0d6e2;border-radius:10px;font:13px/1.4 ui-monospace,monospace;background:#f8fafc;color:#1c2233}' +
    '.dbk-hint{font-size:12px;color:#6b7280;margin:4px 0 12px}' +
    '.dbk-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #eef0f4;font-size:13px}' +
    '.dbk-row span{color:#6b7280;flex:none}.dbk-row b{text-align:right;font-weight:600}' +
    '.dbk-row a{color:#2563eb;font-weight:600}' +
    '.dbk-err{color:#dc2626}' +
    '.dbk-acts{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 6px}' +
    '.dbk-btn{flex:1 1 auto;min-height:44px;padding:10px 12px;border-radius:10px;border:1px solid #d0d6e2;background:#fff;color:#1c2233;font:600 14px system-ui,sans-serif;cursor:pointer}' +
    '.dbk-btn.dbk-pri{background:#2563eb;border-color:#2563eb;color:#fff}' +
    '.dbk-btn:disabled{opacity:.55}' +
    '.dbk-list{margin-top:8px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}' +
    '.dbk-list button{display:flex;justify-content:space-between;width:100%;text-align:left;padding:12px;border:0;border-bottom:1px solid #eef0f4;background:#fff;font:14px system-ui,sans-serif;color:#1c2233;cursor:pointer}' +
    '.dbk-list button:last-child{border-bottom:0}.dbk-list small{color:#6b7280}' +
    '.dbk-link{display:block;margin:14px auto 0;background:none;border:0;color:#dc2626;font:600 13px system-ui,sans-serif;text-decoration:underline;cursor:pointer}' +
    '.dbk-toast{position:fixed;left:50%;top:calc(14px + env(safe-area-inset-top));transform:translateX(-50%);z-index:9999;background:#1f2937;color:#fff;padding:10px 14px;border-radius:10px;font:13px/1.4 system-ui,sans-serif;max-width:92vw;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.25);display:none}' +
    '.dbk-toast.on{display:block}';

  var btn, panel, toastEl;
  function build() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dbk-fab';
    btn.setAttribute('aria-label', 'Backup Google Drive');
    btn.innerHTML = '\u2601<i></i>';
    btn.onclick = function () { btn.classList.remove('dbk-pulse'); openPanel(); };
    document.body.appendChild(btn);

    panel = document.createElement('div');
    panel.className = 'dbk-bg';
    panel.innerHTML = '<div class="dbk-sheet" role="dialog" aria-label="Backup Google Drive">' +
      '<div class="dbk-hd"><b>Backup Google Drive</b><button class="dbk-x" data-a="close" aria-label="Tutup">×</button></div>' +
      '<div class="dbk-body"></div></div>';
    panel.addEventListener('click', onPanelClick);
    document.body.appendChild(panel);

    toastEl = document.createElement('div');
    toastEl.className = 'dbk-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
    updateDot();
  }
  function toast(msg, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.classList.remove('on'); }, ms || 3200);
  }
  function updateDot(state) {
    if (!btn) return;
    var c = cfg(), m = meta();
    btn.classList.remove('ok', 'wait', 'err');
    if (!c || !c.url) return;
    if (state === 'sync' || m.dirty) btn.classList.add('wait');
    else if (m.error) btn.classList.add('err');
    else btn.classList.add('ok');
  }
  function openPanel() { renderPanel(); panel.classList.add('on'); }
  function closePanel() { panel.classList.remove('on'); }

  function renderPanel() {
    if (!panel) return;
    var body = panel.querySelector('.dbk-body');
    var c = cfg(), m = meta();
    if (!c || !c.url) {
      body.innerHTML =
        '<p>Sambungkan ke Google Drive supaya data <b>' + esc(LABEL) + '</b> ter-backup otomatis dan bisa dipulihkan kapan saja.</p>' +
        '<label class="dbk-lbl" for="dbkCode">Kode sambung</label>' +
        '<textarea class="dbk-in" id="dbkCode" rows="4" placeholder="https://script.google.com/macros/s/…/exec#kode-rahasia"></textarea>' +
        '<div class="dbk-hint">Alamat Web App Apps Script, lalu tanda #, lalu kode rahasia.</div>' +
        '<div class="dbk-acts"><button class="dbk-btn dbk-pri" data-a="connect">Sambungkan</button></div>';
      return;
    }
    var status = m.error ? '<span class="dbk-err">Gagal: ' + esc(m.error) + '</span>'
      : (m.dirty ? 'Ada perubahan, segera dikirim' : 'Semua data sudah ter-backup');
    body.innerHTML =
      '<p>Data <b>' + esc(LABEL) + '</b> dikirim otomatis ke Drive setiap ada perubahan.</p>' +
      '<div class="dbk-row"><span>Status</span><b>' + status + '</b></div>' +
      '<div class="dbk-row"><span>Backup terakhir</span><b>' + (m.last ? fmt(m.last) : 'belum ada') + '</b></div>' +
      (c.folderUrl ? '<div class="dbk-row"><span>Folder</span><a href="#" data-a="folder">Buka folder Drive</a></div>' : '') +
      '<div class="dbk-acts">' +
      '<button class="dbk-btn dbk-pri" data-a="now">Backup sekarang</button>' +
      '<button class="dbk-btn" data-a="latest">Pulihkan terbaru</button>' +
      '<button class="dbk-btn" data-a="list">Pilih versi</button>' +
      '</div>' +
      '<div id="dbkList"></div>' +
      '<button class="dbk-link" data-a="disconnect">Putuskan sambungan</button>';
  }

  function parseCode(s) {
    s = String(s || '').trim().replace(/\s+/g, ' ');
    var i = s.lastIndexOf('#');
    var url = (i > 0 ? s.slice(0, i) : s).trim();
    var secret = i > 0 ? s.slice(i + 1).trim() : '';
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^\s]+\/exec$/.test(url)) return null;
    if (!secret) return null;
    return { url: url, secret: secret };
  }

  function onPanelClick(ev) {
    if (ev.target === panel) { closePanel(); return; }
    var t = ev.target.closest('[data-a]');
    if (!t) return;
    ev.preventDefault();
    var a = t.getAttribute('data-a');
    if (a === 'close') closePanel();
    else if (a === 'connect') {
      var parsed = parseCode(panel.querySelector('#dbkCode').value);
      if (!parsed) { toast('Kode sambung belum benar. Contoh: https://script.google.com/macros/s/…/exec#kodeRahasia', 5000); return; }
      var old = cfg();
      rawSet(CFG_KEY, JSON.stringify(parsed));
      t.disabled = true; t.textContent = 'Mengecek…';
      call('ping').then(function (r) {
        parsed.folderUrl = r.folderUrl || '';
        rawSet(CFG_KEY, JSON.stringify(parsed));
        setMeta({ error: '' });
        toast('Tersambung ke Google Drive');
        renderPanel(); updateDot();
        if (isEmpty(snapshot())) restore(); else flush(true);
      }).catch(function (e) {
        if (old) rawSet(CFG_KEY, JSON.stringify(old)); else { try { localStorage.removeItem(CFG_KEY); } catch (x) {} }
        toast('Gagal tersambung: ' + (e.message || e), 5000);
        t.disabled = false; t.textContent = 'Sambungkan';
      });
    }
    else if (a === 'now') { t.disabled = true; flush(true).then(function () { t.disabled = false; }); }
    else if (a === 'latest') {
      var warn = meta().dirty ? '\n\nAda perubahan yang belum ter-backup dan akan hilang.' : '';
      if (confirm('Ganti data di HP ini dengan backup terbaru dari Drive?' + warn)) restore();
    }
    else if (a === 'list') {
      var box = panel.querySelector('#dbkList');
      box.innerHTML = '<p>Memuat daftar backup…</p>';
      call('list').then(function (r) {
        if (!r.files || !r.files.length) { box.innerHTML = '<p>Belum ada backup.</p>'; return; }
        box.innerHTML = '<div class="dbk-list">' + r.files.map(function (f) {
          return '<button data-a="pick" data-n="' + esc(f.name) + '"><span>' + esc(fmt(f.time)) + '</span><small>' + kb(f.size) + '</small></button>';
        }).join('') + '</div>';
      }).catch(function (e) { box.innerHTML = '<p class="dbk-err">Gagal memuat: ' + esc(e.message || e) + '</p>'; });
    }
    else if (a === 'pick') {
      if (confirm('Pulihkan backup ' + t.querySelector('span').textContent + '? Data di HP ini akan diganti.')) restore(t.getAttribute('data-n'));
    }
    else if (a === 'folder') { var c = cfg(); if (c && c.folderUrl) openUrl(c.folderUrl); }
    else if (a === 'disconnect') {
      if (!confirm('Putuskan sambungan Drive? Backup yang sudah ada di Drive tetap aman. Aplikasi lain di alamat yang sama juga ikut terputus.')) return;
      try { localStorage.removeItem(CFG_KEY); } catch (e) {}
      renderPanel(); updateDot();
    }
  }

  /* ---------- pemicu otomatis ---------- */
  function flushIfDirty() { if (meta().dirty) flush(false); }
  window.addEventListener('online', flushIfDirty);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushIfDirty(); });

  // Perbaikan kecil untuk Permohonan UC: fungsi renderApp dipanggil tapi tidak pernah dibuat
  if (typeof window.renderApp !== 'function' && typeof window.renderAll === 'function') window.renderApp = window.renderAll;

  function start() {
    build();
    autoRestore();
    if (meta().dirty) schedule(3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

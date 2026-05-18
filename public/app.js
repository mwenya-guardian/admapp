(function () {
  'use strict';

  var LEGACY_USERNAME_KEY = 'adm_pwa_username';
  var CUG_KEY = 'adm_pwa_cug';
  var API_BASE_KEY = 'adm_api_base';
  var SESSION_KEY = 'adm_session_scans_v1';
  var SERVER_IMEI_CACHE_KEY = 'adm_server_imeis_cache_v1';
  var HISTORY_KEY = 'adm_history_v1';
  var OUTBOX_KEY = 'adm_outbox_v1';

  var DEFAULT_API_BASE = 'https://adm-backend-s1wt.onrender.com/api';

  /* Higher fps = more decode attempts per second (snappier). Native BarcodeDetector when available is faster on many phones. */
  var SCAN_CAMERA = { facingMode: 'environment' };
  var SCAN_CONFIG = {
    fps: 26,
    qrbox: { width: 260, height: 182 },
    experimentalFeatures: {
      useBarCodeDetectorIfSupported: true
    }
  };

  var state = {
    scanner: null,
    scanning: false,
    lastCode: '',
    lastCodeAt: 0,
    scanChoiceOpen: false,
    cug: '',
    apiBase: DEFAULT_API_BASE,
    sessionScans: [],
    serverImeiKeys: {},
    history: [],
    outbox: [],
    submitting: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function getApiBase() {
    try {
      var u = (localStorage.getItem(API_BASE_KEY) || '').trim();
      if (u) return u.replace(/\/$/, '');
    } catch (e) {}
    return DEFAULT_API_BASE;
  }

  function setApiBase(value) {
    var v = String(value || '').trim().replace(/\/$/, '');
    if (!v) {
      localStorage.removeItem(API_BASE_KEY);
      state.apiBase = DEFAULT_API_BASE;
      return;
    }
    localStorage.setItem(API_BASE_KEY, v);
    state.apiBase = v;
  }

  function loadCug() {
    try {
      var c = (localStorage.getItem(CUG_KEY) || '').trim();
      if (c) return c;
      var legacy = (localStorage.getItem(LEGACY_USERNAME_KEY) || '').trim();
      if (legacy && validateCug(legacy)) {
        localStorage.setItem(CUG_KEY, legacy);
        return legacy;
      }
    } catch (e) {}
    return '';
  }

  function saveCug(value) {
    localStorage.setItem(CUG_KEY, value.trim());
    state.cug = value.trim();
  }

  function validateCug(v) {
    var t = String(v || '').trim();
    return t.length === 9 && /^[0-9]+$/.test(t);
  }

  function normDigits(s) {
    return String(s || '').replace(/\D/g, '');
  }

  function dayKeyFromIso(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return (
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0')
      );
    } catch (e) {
      return '';
    }
  }

  function formatWhen(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || '');
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return String(iso || '');
    }
  }

  function newLocalId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return String(Date.now()) + '-' + String(Math.random()).slice(2, 10);
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function persistSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.sessionScans));
  }

  function loadServerCache() {
    try {
      var raw = localStorage.getItem(SERVER_IMEI_CACHE_KEY);
      if (!raw) return { cug: '', keys: {} };
      var o = JSON.parse(raw);
      if (!o || typeof o.keys !== 'object') return { cug: '', keys: {} };
      return { cug: String(o.cug || ''), keys: o.keys || {} };
    } catch (e) {
      return { cug: '', keys: {} };
    }
  }

  function persistServerCache() {
    localStorage.setItem(
      SERVER_IMEI_CACHE_KEY,
      JSON.stringify({ cug: state.cug, keys: state.serverImeiKeys })
    );
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function persistHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  }

  function loadOutbox() {
    try {
      var raw = localStorage.getItem(OUTBOX_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function persistOutbox() {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(state.outbox));
  }

  function mergeServerImeisFromItems(items) {
    (items || []).forEach(function (row) {
      var imei = String((row && row.imei) || '').trim();
      var k = normDigits(imei);
      if (k) state.serverImeiKeys[k] = true;
    });
  }

  function historyForCurrentCug() {
    return state.history.filter(function (row) {
      if (!state.cug) return false;
      if (!row.cug) return true;
      return row.cug === state.cug;
    });
  }

  function syncHistoryFromServer(items, cug) {
    var cugClean = String(cug || '').trim();
    if (!cugClean) return;

    var fromServer = [];
    var seen = {};
    (items || []).forEach(function (row) {
      var imei = String((row && row.imei) || '').trim();
      if (!imei) return;
      var norm = normDigits(imei);
      if (!norm || seen[norm]) return;
      seen[norm] = true;
      var ts = row.timestamp || new Date().toISOString();
      var uploadedAt =
        typeof ts === 'string' ? ts : new Date(ts).toISOString();
      fromServer.push({
        cug: cugClean,
        dayKey: dayKeyFromIso(uploadedAt) || dayKeyFromIso(new Date().toISOString()),
        imei: imei,
        uploadedAt: uploadedAt
      });
    });

    var localOnly = state.history.filter(function (h) {
      if (h.cug !== cugClean) return false;
      return !seen[normDigits(h.imei)];
    });

    state.history = state.history.filter(function (h) {
      return h.cug !== cugClean;
    });
    state.history = state.history.concat(fromServer, localOnly);
    persistHistory();
  }

  function migrateHistoryCug() {
    if (!state.cug) return;
    var changed = false;
    state.history.forEach(function (h) {
      if (!h.cug) {
        h.cug = state.cug;
        changed = true;
      }
    });
    if (changed) persistHistory();
  }

  function refreshHistoryFromServer(showToastOnSuccess) {
    if (!state.cug) {
      showToast('Set your CUG in Settings first.', 'error', 3500);
      return Promise.reject(new Error('no cug'));
    }
    if (!navigator.onLine) {
      showToast('Offline — connect to the internet to refresh.', 'error', 4000);
      return Promise.reject(new Error('offline'));
    }

    var btn = $('history-refresh');
    if (btn) btn.disabled = true;

    return fetchScannerDeviceRecords()
      .then(function (data) {
        state.serverImeiKeys = {};
        mergeServerImeisFromItems(data.items || []);
        persistServerCache();
        syncHistoryFromServer(data.items || [], state.cug);
        renderHistory();
        if (showToastOnSuccess) {
          var n = (data.items || []).length;
          showToast('History updated — ' + n + ' record(s) from server.', 'success', 4000);
        }
        return data;
      })
      .catch(function () {
        showToast('Could not refresh history. Check connection and API URL.', 'error', 4500);
        throw new Error('refresh failed');
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function rememberServerImei(barcode) {
    var k = normDigits(barcode);
    if (k) {
      state.serverImeiKeys[k] = true;
      persistServerCache();
    }
  }

  function sessionHasNorm(norm) {
    return state.sessionScans.some(function (p) {
      return normDigits(p.barcode) === norm;
    });
  }

  function serverHasNorm(norm) {
    return !!state.serverImeiKeys[norm];
  }

  function closeMenu() {
    var d = $('topbar-menu');
    if (d && d.tagName === 'DETAILS') d.open = false;
  }

  function showView(name) {
    closeMenu();
    var scan = $('view-scan');
    var hist = $('view-history');
    var sett = $('view-settings');
    if (scan) scan.classList.toggle('view--hidden', name !== 'scan');
    if (hist) hist.classList.toggle('view--hidden', name !== 'history');
    if (sett) sett.classList.toggle('view--hidden', name !== 'settings');

    var back = $('settings-back');
    if (back) {
      back.classList.toggle('hidden', name !== 'settings' || !state.cug);
    }

    if (name === 'history') {
      $('history-cug').textContent = state.cug || '—';
      renderHistory();
    }
    if (name === 'settings') {
      $('settings-cug-input').value = state.cug;
      $('settings-api-input').value =
        state.apiBase === DEFAULT_API_BASE ? '' : state.apiBase;
    }
  }

  function setStatus(message, kind) {
    var el = $('status');
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('error', 'success');
    if (kind) el.classList.add(kind);
  }

  function updateConnPill() {
    var el = $('conn-pill');
    if (!el) return;
    var online = typeof navigator !== 'undefined' && navigator.onLine;
    el.textContent = online ? 'Online' : 'Offline';
    el.classList.toggle('conn-pill--online', online);
    el.classList.toggle('conn-pill--offline', !online);
  }

  function getOutboxForCurrentCug() {
    if (!state.cug) return [];
    return state.outbox.filter(function (job) {
      return String(job.cug || '').trim() === state.cug;
    });
  }

  function updateOutboxHint() {
    var el = $('outbox-hint');
    if (!el) return;
    var pending = getOutboxForCurrentCug();
    var n = pending.length;
    if (n === 0) {
      el.classList.add('hidden');
      el.textContent = '';
      el.removeAttribute('aria-label');
      return;
    }
    el.classList.remove('hidden');
    var label =
      n === 1
        ? '1 scan waiting to sync — tap to view signed date'
        : n + ' scans waiting to sync — tap to view signed dates';
    el.textContent = label;
    el.setAttribute('aria-label', label);
  }

  function renderOutboxPanel() {
    var body = $('outbox-panel-body');
    if (!body) return;
    var pending = getOutboxForCurrentCug();
    if (!pending.length) {
      body.innerHTML = '<p class="history-empty">Nothing waiting to sync.</p>';
      return;
    }

    var byDay = {};
    pending.forEach(function (job) {
      var signedIso = job.scannedAt || job.createdAt || '';
      var day = dayKeyFromIso(signedIso) || 'Unknown date';
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push({
        imei: job.imei,
        signedIso: signedIso
      });
    });

    var days = Object.keys(byDay).sort(function (a, b) {
      if (a === 'Unknown date') return 1;
      if (b === 'Unknown date') return -1;
      return b.localeCompare(a);
    });

    body.innerHTML = '';
    days.forEach(function (day) {
      var section = document.createElement('section');
      section.className = 'history-day';
      var h = document.createElement('h3');
      h.className = 'history-day__title';
      h.textContent = day === 'Unknown date' ? day : formatHistoryDayTitle(day);
      var ol = document.createElement('ol');
      byDay[day]
        .sort(function (a, b) {
          return new Date(b.signedIso) - new Date(a.signedIso);
        })
        .forEach(function (row) {
          var li = document.createElement('li');
          var wrap = document.createElement('div');
          wrap.className = 'outbox-row';
          var code = document.createElement('span');
          code.className = 'outbox-row__imei';
          code.textContent = row.imei;
          var when = document.createElement('span');
          when.className = 'outbox-row__when';
          when.textContent = 'Signed ' + formatWhen(row.signedIso);
          wrap.appendChild(code);
          wrap.appendChild(when);
          li.appendChild(wrap);
          ol.appendChild(li);
        });
      section.appendChild(h);
      section.appendChild(ol);
      body.appendChild(section);
    });
  }

  function openOutboxPanel() {
    if (!getOutboxForCurrentCug().length) return;
    renderOutboxPanel();
    $('outbox-panel-backdrop').classList.remove('hidden');
  }

  function closeOutboxPanel() {
    $('outbox-panel-backdrop').classList.add('hidden');
  }

  /* ── Toast (position: top via CSS) ───────────────────────────── */
  var _toastTimer = null;
  function showToast(message, kind, duration) {
    var container = $('toast-container');
    if (!container) return;
    if (_toastTimer) {
      clearTimeout(_toastTimer);
      _toastTimer = null;
    }
    var old = container.querySelector('.toast');
    if (old) old.remove();

    var toast = document.createElement('div');
    toast.className = 'toast toast--' + (kind || 'info');
    toast.setAttribute('role', 'alert');

    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = kind === 'success' ? '✓' : kind === 'error' ? '✕' : 'ℹ';

    var text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message || '';

    var close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', function () {
      toast.classList.add('toast--out');
      setTimeout(function () {
        toast.remove();
      }, 250);
    });

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(close);
    container.appendChild(toast);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        toast.classList.add('toast--in');
      });
    });

    var ms = duration || (kind === 'error' ? 5500 : 3200);
    _toastTimer = setTimeout(function () {
      toast.classList.add('toast--out');
      setTimeout(function () {
        if (toast.parentNode) toast.remove();
      }, 280);
    }, ms);
  }

  /* ── Scanner engine (preserve behavior) ───────────────────────── */
  function buildScanner() {
    try {
      if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
        return new Html5Qrcode('reader', {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.CODE_39
          ]
        });
      }
    } catch (e) {
      console.warn('Barcode formats fallback', e);
    }
    return new Html5Qrcode('reader');
  }

  function clearReaderDom() {
    var el = $('reader');
    if (el) el.innerHTML = '';
  }

  function applyReaderVideoAttrs() {
    var wrap = $('reader-wrap');
    if (!wrap) return;
    var vid = wrap.querySelector('video');
    if (vid) {
      vid.setAttribute('playsinline', '');
      vid.setAttribute('webkit-playsinline', '');
      vid.playsInline = true;
      vid.muted = true;
    }
  }

  function startScanner() {
    if (state.scanning) return;
    if (!state.cug) {
      setStatus('Save your CUG in Settings first.', 'error');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Camera is not available in this browser.', 'error');
      return;
    }
    setStatus('Starting camera…');
    clearReaderDom();

    var readerWrap = $('reader-wrap');
    readerWrap.classList.remove('hidden');
    readerWrap.setAttribute('aria-hidden', 'false');

    state.scanner = buildScanner();
    state.scanner
      .start(SCAN_CAMERA, SCAN_CONFIG, onScanSuccess, function () {})
      .then(function () {
        state.scanning = true;
        setStatus('Point the camera at a barcode or QR code.');
        applyReaderVideoAttrs();
      })
      .catch(function (err) {
        console.error(err);
        setStatus(err.message || 'Could not start camera.', 'error');
        try {
          if (state.scanner) state.scanner.clear();
        } catch (e) {}
        state.scanner = null;
        state.scanning = false;
        clearReaderDom();
        readerWrap.classList.add('hidden');
        readerWrap.setAttribute('aria-hidden', 'true');
      });
  }

  function stopScanner() {
    if (!state.scanner || !state.scanning) {
      return Promise.resolve();
    }
    var readerWrap = $('reader-wrap');
    return state.scanner
      .stop()
      .then(function () {
        try {
          state.scanner.clear();
        } catch (e) {}
        state.scanner = null;
        state.scanning = false;
        clearReaderDom();
        if (readerWrap) {
          readerWrap.classList.add('hidden');
          readerWrap.setAttribute('aria-hidden', 'true');
        }
        setStatus('Camera stopped.');
      })
      .catch(function (err) {
        console.error(err);
        state.scanner = null;
        state.scanning = false;
        clearReaderDom();
        if (readerWrap) {
          readerWrap.classList.add('hidden');
          readerWrap.setAttribute('aria-hidden', 'true');
        }
      });
  }

  function resumeScannerForNextScan() {
    if (!state.scanner || !state.scanning) {
      state.scanChoiceOpen = false;
      return;
    }
    setStatus('Restarting camera…');
    var prev = state.scanner;
    prev
      .stop()
      .then(function () {
        try {
          prev.clear();
        } catch (e) {}
        clearReaderDom();
        state.scanner = buildScanner();
        return state.scanner.start(SCAN_CAMERA, SCAN_CONFIG, onScanSuccess, function () {});
      })
      .then(function () {
        state.scanning = true;
        state.scanChoiceOpen = false;
        applyReaderVideoAttrs();
        setStatus('Point the camera at the next code.');
      })
      .catch(function (err) {
        console.error(err);
        state.scanChoiceOpen = false;
        state.scanner = null;
        state.scanning = false;
        clearReaderDom();
        var readerWrap = $('reader-wrap');
        if (readerWrap) {
          readerWrap.classList.add('hidden');
          readerWrap.setAttribute('aria-hidden', 'true');
        }
        setStatus(err.message || 'Could not restart camera. Use Retry camera.', 'error');
      });
  }

  function checkRecordOnline(norm, rawBarcode) {
    var base = state.apiBase;
    var q =
      base +
      '/imeis/scanner/check-record?cug=' +
      encodeURIComponent(state.cug) +
      '&imei=' +
      encodeURIComponent(rawBarcode);
    return fetch(q, { method: 'GET' }).then(function (res) {
      if (!res.ok) throw new Error('check failed');
      return res.json();
    });
  }

  function fetchScannerDeviceRecords() {
    var base = state.apiBase;
    var url = base + '/imeis/scanner/device-records?cug=' + encodeURIComponent(state.cug);
    return fetch(url, { method: 'GET' }).then(function (res) {
      if (!res.ok) throw new Error('sync failed');
      return res.json();
    });
  }

  function handleDecodedScan(rawText) {
    var text = String(rawText || '').trim();
    var norm = normDigits(text);
    if (!norm) {
      showToast('Invalid code', 'error', 3000);
      resumeScannerForNextScan();
      return;
    }

    if (sessionHasNorm(norm)) {
      showToast('Already scanned', 'info', 2800);
      resumeScannerForNextScan();
      return;
    }

    if (serverHasNorm(norm)) {
      showToast('This device has already been signed for', 'error', 4000);
      resumeScannerForNextScan();
      return;
    }

    if (navigator.onLine) {
      checkRecordOnline(norm, text)
        .then(function (data) {
          if (data && data.exists) {
            rememberServerImei(text);
            showToast('This device has already been signed for', 'error', 4000);
            return;
          }
          state.sessionScans.push({
            id: newLocalId(),
            barcode: text,
            scannedAt: new Date().toISOString()
          });
          persistSession();
          renderSessionList();
          showToast('IMEI added', 'success', 2600);
        })
        .catch(function () {
          state.sessionScans.push({
            id: newLocalId(),
            barcode: text,
            scannedAt: new Date().toISOString()
          });
          persistSession();
          renderSessionList();
          showToast('IMEI added', 'success', 2600);
        })
        .finally(function () {
          resumeScannerForNextScan();
        });
    } else {
      state.sessionScans.push({
        id: newLocalId(),
        barcode: text,
        scannedAt: new Date().toISOString()
      });
      persistSession();
      renderSessionList();
      showToast('IMEI added', 'success', 2600);
      resumeScannerForNextScan();
    }
  }

  function onScanSuccess(decodedText) {
    if (state.scanChoiceOpen) return;
    var text = String(decodedText || '').trim();
    if (!text) return;
    var now = Date.now();
    if (text === state.lastCode && now - state.lastCodeAt < 1100) return;
    state.scanChoiceOpen = true;
    state.lastCode = text;
    state.lastCodeAt = now;

    if (state.scanner && state.scanning) {
      try {
        state.scanner.pause(false);
      } catch (e) {
        try {
          state.scanner.pause();
        } catch (e2) {
          console.warn(e2);
        }
      }
    }

    handleDecodedScan(text);
  }

  function renderSessionList() {
    var list = $('session-list');
    var empty = $('session-empty');
    var submit = $('btn-submit');
    if (!list || !empty) return;
    list.innerHTML = '';
    state.sessionScans.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'session-row';
      row.setAttribute('role', 'listitem');

      var code = document.createElement('div');
      code.className = 'session-row__code';
      code.textContent = item.barcode;

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'session-row__remove';
      rm.setAttribute('aria-label', 'Remove ' + item.barcode);
      rm.textContent = '×';
      rm.addEventListener('click', function () {
        state.sessionScans = state.sessionScans.filter(function (p) {
          return p.id !== item.id;
        });
        persistSession();
        renderSessionList();
        showToast('Removed from list', 'info', 2000);
      });

      row.appendChild(code);
      row.appendChild(rm);
      list.appendChild(row);
    });

    empty.classList.toggle('hidden', state.sessionScans.length > 0);
    if (submit) submit.disabled = state.sessionScans.length === 0 || state.submitting;
  }

  function appendHistoryEntries(items, uploadedAtIso) {
    var d = new Date(uploadedAtIso);
    var dayKey =
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0');
    items.forEach(function (barcode) {
      state.history.push({
        cug: state.cug,
        dayKey: dayKey,
        imei: String(barcode).trim(),
        uploadedAt: uploadedAtIso
      });
    });
    persistHistory();
  }

  function formatHistoryDayTitle(dayKey) {
    try {
      var parts = dayKey.split('-');
      var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
      return dayKey;
    }
  }

  function renderHistory() {
    var body = $('history-body');
    if (!body) return;
    var rows = historyForCurrentCug();
    if (!rows.length) {
      body.innerHTML =
        '<p class="history-empty">No signed devices yet. Save your CUG to sync from the server, or submit scans from the scanner.</p>';
      return;
    }
    var byDay = {};
    rows.forEach(function (row) {
      var k = row.dayKey || dayKeyFromIso(row.uploadedAt) || '';
      if (!k) return;
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(row);
    });
    var days = Object.keys(byDay).sort(function (a, b) {
      return b.localeCompare(a);
    });
    body.innerHTML = '';
    days.forEach(function (day) {
      var section = document.createElement('section');
      section.className = 'history-day';
      var h = document.createElement('h3');
      h.className = 'history-day__title';
      h.textContent = formatHistoryDayTitle(day);
      var ol = document.createElement('ol');
      byDay[day]
        .sort(function (a, b) {
          return new Date(b.uploadedAt) - new Date(a.uploadedAt);
        })
        .forEach(function (row) {
          var li = document.createElement('li');
          li.textContent = row.imei;
          ol.appendChild(li);
        });
      section.appendChild(h);
      section.appendChild(ol);
      body.appendChild(section);
    });
  }

  function writeImeiToApi(pendingItem) {
    var scannedDate = new Date(pendingItem.scannedAt);
    if (isNaN(scannedDate.getTime())) scannedDate = new Date();
    var payload = {
      cug: String(state.cug || '').trim(),
      imei: String(pendingItem.barcode).trim(),
      timestamp: scannedDate.toISOString()
    };
    return fetch(state.apiBase + '/imeis/device-records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.status === 409) {
        return { _conflict: true, barcode: payload.imei };
      }
      if (!res.ok) {
        return res.text().then(function (msg) {
          throw new Error('Server error ' + res.status + ': ' + msg);
        });
      }
      return res.json().catch(function () {
        return {};
      });
    });
  }

  function openSubmitModal() {
    if (!state.sessionScans.length) return;
    $('submit-confirm-backdrop').classList.remove('hidden');
  }

  function closeSubmitModal() {
    $('submit-confirm-backdrop').classList.add('hidden');
  }

  function submitConfirmed() {
    if (state.submitting || !state.sessionScans.length) return;
    state.submitting = true;
    renderSessionList();
    closeSubmitModal();

    if (!navigator.onLine) {
      state.sessionScans.slice().forEach(function (item) {
        state.outbox.push({
          id: newLocalId(),
          cug: state.cug,
          imei: item.barcode,
          scannedAt: item.scannedAt,
          createdAt: new Date().toISOString()
        });
      });
      state.sessionScans = [];
      persistSession();
      persistOutbox();
      updateOutboxHint();
      state.submitting = false;
      renderSessionList();
      showToast('Saved offline — will sync when you are back online.', 'info', 5000);
      return;
    }

    var uploadedAt = new Date().toISOString();
    var okImeis = [];

    function processNext() {
      if (!state.sessionScans.length) {
        if (okImeis.length) appendHistoryEntries(okImeis, uploadedAt);
        persistSession();
        state.submitting = false;
        renderSessionList();
        setStatus('Submit complete.', 'success');
        showToast('Submit complete.', 'success', 3500);
        return;
      }

      var item = state.sessionScans[0];
      writeImeiToApi(item)
        .then(function (resp) {
          state.sessionScans.shift();
          if (resp && resp._conflict) {
            rememberServerImei(item.barcode);
          } else {
            rememberServerImei(item.barcode);
            okImeis.push(item.barcode);
          }
          persistSession();
          renderSessionList();
          processNext();
        })
        .catch(function () {
          state.sessionScans.shift();
          state.outbox.push({
            id: newLocalId(),
            cug: state.cug,
            imei: item.barcode,
            scannedAt: item.scannedAt,
            createdAt: new Date().toISOString()
          });
          persistOutbox();
          persistSession();
          updateOutboxHint();
          renderSessionList();
          processNext();
        });
    }

    processNext();
  }

  function flushOutbox() {
    if (!navigator.onLine || !state.outbox.length || !state.cug) return;
    var copy = state.outbox.slice();
    var remaining = [];
    var uploadedAt = new Date().toISOString();
    var saved = [];

    function step(idx) {
      if (idx >= copy.length) {
        state.outbox = remaining;
        persistOutbox();
        updateOutboxHint();
        closeOutboxPanel();
        if (saved.length) {
          appendHistoryEntries(saved, uploadedAt);
          showToast('Synced ' + saved.length + ' offline scan(s).', 'success', 4000);
        }
        return;
      }
      var job = copy[idx];
      if (String(job.cug || '').trim() !== state.cug) {
        remaining.push(job);
        step(idx + 1);
        return;
      }
      writeImeiToApi({ barcode: job.imei, scannedAt: job.scannedAt })
        .then(function (resp) {
          if (!resp || !resp._conflict) {
            saved.push(job.imei);
            rememberServerImei(job.imei);
          }
          step(idx + 1);
        })
        .catch(function () {
          remaining.push(job);
          step(idx + 1);
        });
    }

    step(0);
  }

  function tryAutoStartCamera() {
    if (!state.cug) return;
    setTimeout(function () {
      if ($('view-scan') && !$('view-scan').classList.contains('view--hidden')) {
        startScanner();
      }
    }, 450);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var ok = location.protocol === 'https:' || location.hostname === 'localhost';
    if (!ok) return;
    navigator.serviceWorker.register('/sw.js').catch(function (e) {
      console.warn('SW register failed', e);
    });
  }

  function wireUi() {
    $('menu-history').addEventListener('click', function () {
      showView('history');
    });
    $('menu-settings').addEventListener('click', function () {
      showView('settings');
    });

    $('history-back').addEventListener('click', function () {
      showView('scan');
      tryAutoStartCamera();
    });

    $('history-refresh').addEventListener('click', function () {
      refreshHistoryFromServer(true);
    });

    $('settings-back').addEventListener('click', function () {
      showView('scan');
      tryAutoStartCamera();
    });

    $('settings-save').addEventListener('click', function () {
      var v = $('settings-cug-input').value;
      if (!validateCug(v)) {
        showToast('Enter a valid 9-digit CUG.', 'error', 4000);
        return;
      }
      var apiIn = $('settings-api-input').value.trim();
      if (apiIn) setApiBase(apiIn);
      else setApiBase('');

      saveCug(v);
      state.apiBase = getApiBase();

      refreshHistoryFromServer(false)
        .then(function (data) {
          showToast(
            'CUG saved — ' + (data.count || 0) + ' record(s) synced to History.',
            'success',
            4000
          );
        })
        .catch(function () {
          showToast('CUG saved (server sync failed — use History refresh when online).', 'info', 5000);
        })
        .finally(function () {
          showView('scan');
          tryAutoStartCamera();
        });
    });

    $('btn-retry').addEventListener('click', function () {
      stopScanner().then(function () {
        startScanner();
      });
    });

    $('btn-submit').addEventListener('click', function () {
      openSubmitModal();
    });

    $('submit-cancel').addEventListener('click', closeSubmitModal);
    $('submit-confirm').addEventListener('click', submitConfirmed);

    $('submit-confirm-backdrop').addEventListener('click', function (e) {
      if (e.target === $('submit-confirm-backdrop')) closeSubmitModal();
    });

    $('outbox-hint').addEventListener('click', openOutboxPanel);
    $('outbox-panel-close').addEventListener('click', closeOutboxPanel);
    $('outbox-panel-backdrop').addEventListener('click', function (e) {
      if (e.target === $('outbox-panel-backdrop')) closeOutboxPanel();
    });

    window.addEventListener('online', function () {
      updateConnPill();
      flushOutbox();
    });
    window.addEventListener('offline', updateConnPill);
  }

  function init() {
    state.apiBase = getApiBase();
    state.cug = loadCug();
    state.sessionScans = loadSession();
    state.history = loadHistory();
    state.outbox = loadOutbox();
    migrateHistoryCug();

    var cache = loadServerCache();
    if (cache.cug === state.cug && cache.keys) {
      state.serverImeiKeys = cache.keys;
    } else if (state.cug) {
      state.serverImeiKeys = {};
    }

    updateConnPill();
    updateOutboxHint();
    wireUi();
    registerServiceWorker();

    if (!state.cug) {
      showView('settings');
    } else {
      showView('scan');
      renderSessionList();
      tryAutoStartCamera();
    }

    flushOutbox();

    if (state.cug && navigator.onLine) {
      refreshHistoryFromServer(false).catch(function () {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

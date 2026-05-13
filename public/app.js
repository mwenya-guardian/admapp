(function () {
  'use strict';

  var USERNAME_KEY = 'adm_pwa_username';
  var PENDING_KEY = 'adm_pending_v2';
  var UPLOADED_KEY = 'adm_uploaded_log_v2';
  var SCAN_CAMERA = { facingMode: 'environment' };
  var SCAN_CONFIG = { fps: 12, qrbox: { width: 280, height: 200 } };

  var state = {
    scanner: null,
    scanning: false,
    lastCode: '',
    lastCodeAt: 0,
    username: '',
    pending: [],
    uploaded: [],
    panelMode: null,
    uploading: false,
    scanChoiceOpen: false,
    lastSavedId: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function todayKey() {
    var d = new Date();
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
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
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
      return String(iso);
    }
  }

  function newLocalId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return String(Date.now()) + '-' + String(Math.random()).slice(2, 10);
  }

  function loadUsername() {
    try {
      return (localStorage.getItem(USERNAME_KEY) || '').trim();
    } catch (e) {
      return '';
    }
  }

  function saveUsername(value) {
    localStorage.setItem(USERNAME_KEY, value.trim());
  }

  function loadPending() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function persistPending() {
    localStorage.setItem(PENDING_KEY, JSON.stringify(state.pending));
  }

  function loadUploaded() {
    try {
      var raw = localStorage.getItem(UPLOADED_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function persistUploaded() {
    localStorage.setItem(UPLOADED_KEY, JSON.stringify(state.uploaded));
  }

  function countUploadedToday() {
    var tk = todayKey();
    return state.uploaded.filter(function (u) {
      return dayKeyFromIso(u.uploadedAt) === tk;
    }).length;
  }

  function renderStats() {
    $('stat-today').textContent = String(countUploadedToday());
    $('stat-all').textContent = String(state.uploaded.length);
    $('stat-pending').textContent = String(state.pending.length);
  }

  function setStatus(message, kind) {
    var el = $('status');
    el.textContent = message || '';
    el.classList.remove('error', 'success');
    if (kind) el.classList.add(kind);
  }

  /* ── Toast notifications ───────────────────────────────────────── */
  var _toastTimer = null;
  function showToast(message, kind, duration) {
    var container = $('toast-container');
    if (!container) return;
    // Clear any existing toast
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    // Remove old toasts immediately
    var old = container.querySelector('.toast');
    if (old) { old.remove(); }

    var toast = document.createElement('div');
    toast.className = 'toast toast--' + (kind || 'info');
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');

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
      setTimeout(function () { toast.remove(); }, 300);
    });

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(close);
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        toast.classList.add('toast--in');
      });
    });

    var ms = duration || (kind === 'error' ? 6000 : 4000);
    _toastTimer = setTimeout(function () {
      toast.classList.add('toast--out');
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 300);
    }, ms);
  }

  function showUserPill() {
    var pill = $('user-pill');
    if (!state.username) {
      pill.classList.add('hidden');
      return;
    }
    pill.textContent = 'Number: ' + state.username;
    pill.classList.remove('hidden');
  }

  function openModal(allowCancel) {
    var backdrop = $('modal-backdrop');
    var cancel = $('modal-cancel');
    $('username-input').value = state.username;
    backdrop.classList.remove('hidden');
    if (allowCancel) {
      cancel.classList.remove('hidden');
    } else {
      cancel.classList.add('hidden');
    }
    setTimeout(function () {
      $('username-input').focus();
    }, 50);
  }

  function closeModal() {
    $('modal-backdrop').classList.add('hidden');
  }

  function validateUsername(v) {
    var t = String(v || '').trim();
    return t.length === 9 && /^[0-9]+$/.test(t);
  }

  function ensureAuth() {
    return firebase
      .auth()
      .signInAnonymously()
      .catch(function (err) {
        console.error(err);
        setStatus('Sign-in failed. Check Firebase Auth (Anonymous) is enabled.', 'error');
        throw err;
      });
  }

  function ensureFirestorePersistence() {
    return firebase
      .firestore()
      .enablePersistence({ synchronizeTabs: true })
      .catch(function (err) {
        if (err.code === 'failed-precondition') {
          console.warn('Persistence: multi-tab');
        } else if (err.code === 'unimplemented') {
          console.warn('Persistence not available');
        } else {
          console.warn(err);
        }
      });
  }

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

  function enqueuePendingScan(barcode) {
    var code = String(barcode || '').trim();
    if (!code) return false;
    // Duplicate check — already in pending list?
    var alreadyPending = state.pending.some(function (p) {
      return p.barcode === code;
    });
    if (alreadyPending) {
      showToast('\u26a0\ufe0f Duplicate — "' + code + '" is already in pending.', 'error', 4000);
      return false; // signal: not saved
    }
    var scannedAt = new Date().toISOString();
    state.lastSavedId = null; // clear before push
    var entry = {
      id: newLocalId(),
      barcode: code,
      scannedAt: scannedAt
    };
    state.pending.push(entry);
    state.lastSavedId = entry.id; // track so re-entry btn can remove it
    persistPending();
    renderStats();
    return true; // signal: saved
  }

  function showScanChoiceSheet(code, isDuplicate) {
    $('scan-choice-code').textContent = code;
    var dupEl = $('scan-choice-dup');
    var descEl = $('scan-choice-desc');
    if (isDuplicate) {
      dupEl.classList.remove('hidden');
      descEl.classList.add('hidden');
    } else {
      dupEl.classList.add('hidden');
      descEl.classList.remove('hidden');
    }
    $('scan-choice-backdrop').classList.remove('hidden');
    setTimeout(function () {
      $('btn-scan-next').focus();
    }, 50);
  }

  function hideScanChoiceSheet() {
    state.scanChoiceOpen = false;
    $('scan-choice-backdrop').classList.add('hidden');
  }

  function resumeScannerForNextScan() {
    if (!state.scanner || !state.scanning) {
      state.scanChoiceOpen = false;
      $('scan-choice-backdrop').classList.add('hidden');
      setStatus('Camera was stopped. Tap start scanning again.', 'error');
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
        $('reader-wrap').classList.add('hidden');
        $('reader-wrap').setAttribute('aria-hidden', 'true');
        $('btn-stop').classList.add('hidden');
        $('btn-camera').disabled = false;
        setStatus(err.message || 'Could not restart camera. Tap start scanning.', 'error');
      });
  }

  var API_ENDPOINT = 'https://adm-backend-s1wt.onrender.com/api/imeis/device-records';

  function writeImeiToApi(pendingItem) {
    var scannedDate = new Date(pendingItem.scannedAt);
    if (isNaN(scannedDate.getTime())) scannedDate = new Date();
    var payload = {
      cug: String(state.username || '').trim(),
      imei: String(pendingItem.barcode).trim(),
      timestamp: scannedDate.toISOString()
    };
    return fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (msg) {
          throw new Error('Server error ' + res.status + ': ' + msg);
        });
      }
      return res.json().catch(function () { return {}; });
    });
  }

  function removePendingById(id) {
    state.pending = state.pending.filter(function (p) {
      return p.id !== id;
    });
    persistPending();
  }

  function appendUploadedRecord(pendingItem, uploadedAtIso, firestoreId) {
    state.uploaded.push({
      id: pendingItem.id,
      barcode: pendingItem.barcode,
      scannedAt: pendingItem.scannedAt,
      uploadedAt: uploadedAtIso,
      firestoreId: firestoreId || ''
    });
    persistUploaded();
  }

  function openListPanel(mode) {
    state.panelMode = mode;
    var title = $('list-panel-title');
    var sub = $('list-panel-sub');
    var footer = $('list-panel-footer');
    sub.classList.add('hidden');
    sub.textContent = '';

    if (mode === 'pending') {
      title.textContent = 'Pending upload';
      sub.textContent = 'Select one or more, then upload to Firestore (imeis).';
      sub.classList.remove('hidden');
      footer.classList.remove('hidden');
    } else if (mode === 'today') {
      title.textContent = 'Uploaded today';
      footer.classList.add('hidden');
    } else {
      title.textContent = 'Uploaded (all time)';
      footer.classList.add('hidden');
    }

    $('list-panel-backdrop').classList.remove('hidden');
    renderListPanelBody();
  }

  function closeListPanel() {
    state.panelMode = null;
    $('list-panel-backdrop').classList.add('hidden');
  }

  function renderListPanelBody() {
    var body = $('list-panel-body');
    body.innerHTML = '';
    var mode = state.panelMode;

    if (mode === 'pending') {
      if (!state.pending.length) {
        body.innerHTML = '<p class="list-empty">Nothing pending. Scans go here until you upload.</p>';
        return;
      }
      state.pending.forEach(function (item) {
        var row = document.createElement('label');
        row.className = 'list-row';
        row.setAttribute('for', 'cb-' + item.id);
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'cb-' + item.id;
        cb.setAttribute('data-id', item.id);
        var main = document.createElement('div');
        main.className = 'list-row-main';
        var code = document.createElement('div');
        code.className = 'list-row-code';
        code.textContent = item.barcode;
        var meta = document.createElement('div');
        meta.className = 'list-row-meta';
        meta.textContent = 'Scanned ' + formatWhen(item.scannedAt);
        main.appendChild(code);
        main.appendChild(meta);
        row.appendChild(cb);
        row.appendChild(main);
        body.appendChild(row);
      });
      return;
    }

    var list =
      mode === 'today'
        ? state.uploaded.filter(function (u) {
            return dayKeyFromIso(u.uploadedAt) === todayKey();
          })
        : state.uploaded.slice();

    list.sort(function (a, b) {
      return new Date(b.uploadedAt) - new Date(a.uploadedAt);
    });

    if (!list.length) {
      body.innerHTML =
        '<p class="list-empty">' +
        (mode === 'today' ? 'No uploads yet today.' : 'No uploads recorded yet.') +
        '</p>';
      return;
    }

    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'list-row';
      var main = document.createElement('div');
      main.className = 'list-row-main';
      var code = document.createElement('div');
      code.className = 'list-row-code';
      code.textContent = item.barcode;
      var meta = document.createElement('div');
      meta.className = 'list-row-meta';
      meta.textContent =
        'Uploaded ' + formatWhen(item.uploadedAt) + ' · scanned ' + formatWhen(item.scannedAt);
      main.appendChild(code);
      main.appendChild(meta);
      row.appendChild(main);
      body.appendChild(row);
    });
  }

  function getSelectedPendingIds() {
    var body = $('list-panel-body');
    var boxes = body.querySelectorAll('input[type="checkbox"]:checked');
    return Array.prototype.map.call(boxes, function (cb) {
      return cb.getAttribute('data-id');
    });
  }

  function uploadSelectedPending() {
    if (state.uploading) return;
    if (!state.username) {
      setStatus('Save your number first.', 'error');
      return;
    }
    var ids = getSelectedPendingIds();
    if (!ids.length) {
      setStatus('Select at least one pending item.', 'error');
      return;
    }

    state.uploading = true;
    var btn = $('list-upload');
    btn.disabled = true;
    setStatus('Uploading…');

    var failed = [];

    function uploadNext(index) {
      if (index >= ids.length) {
        state.uploading = false;
        btn.disabled = false;
        renderStats();
        renderListPanelBody();
        if (failed.length) {
          showToast(
            'Failed to upload ' + failed.length + ' item(s): ' + failed.join(', '),
            'error'
          );
          setStatus('Some uploads failed (' + failed.length + ').', 'error');
        } else {
          showToast('Upload complete! ' + ids.length + ' record(s) saved.', 'success');
          setStatus('Upload complete.', 'success');
        }
        return;
      }

      var id = ids[index];
      var item = state.pending.find(function (p) {
        return p.id === id;
      });
      if (!item) {
        uploadNext(index + 1);
        return;
      }

      var uploadedAt = new Date();
      writeImeiToApi(item)
        .then(function (resp) {
          var serverId = (resp && (resp._id || resp.id)) || '';
          removePendingById(item.id);
          appendUploadedRecord(item, uploadedAt.toISOString(), serverId);
          showToast('Saved: ' + item.barcode, 'success', 2500);
          uploadNext(index + 1);
        })
        .catch(function (err) {
          console.error(err);
          failed.push(item.barcode);
          showToast('Error saving ' + item.barcode + ': ' + (err.message || 'Network error'), 'error', 5000);
          uploadNext(index + 1);
        });
    }

    uploadNext(0);
  }

  function selectAllPendingCheckboxes() {
    var body = $('list-panel-body');
    var boxes = body.querySelectorAll('input[type="checkbox"]');
    Array.prototype.forEach.call(boxes, function (cb) {
      cb.checked = true;
    });
  }

  function onScanSuccess(decodedText) {
    if (state.scanChoiceOpen) return;
    var text = String(decodedText || '').trim();
    if (!text) return;
    var now = Date.now();
    if (text === state.lastCode && now - state.lastCodeAt < 2000) return;
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

    var saved = enqueuePendingScan(text);
    showScanChoiceSheet(text, !saved); // pass isDuplicate flag
  }

  function startScanner() {
    if (state.scanning) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Camera is not available in this browser.', 'error');
      return;
    }
    setStatus('Starting camera…');
    clearReaderDom();
    
    // Unhide the wrapper BEFORE starting the scanner so the library can calculate dimensions
    $('reader-wrap').classList.remove('hidden');
    $('reader-wrap').setAttribute('aria-hidden', 'false');
    
    state.scanner = buildScanner();
    state.scanner
      .start(SCAN_CAMERA, SCAN_CONFIG, onScanSuccess, function () {})
      .then(function () {
        state.scanning = true;
        $('btn-stop').classList.remove('hidden');
        $('btn-camera').disabled = true;
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
        $('reader-wrap').classList.add('hidden');
        $('reader-wrap').setAttribute('aria-hidden', 'true');
      });
  }

  function stopScanner() {
    if (!state.scanner || !state.scanning) {
      return Promise.resolve();
    }
    return state.scanner
      .stop()
      .then(function () {
        try {
          state.scanner.clear();
        } catch (e) {}
        state.scanner = null;
        state.scanning = false;
        clearReaderDom();
        $('reader-wrap').classList.add('hidden');
        $('reader-wrap').setAttribute('aria-hidden', 'true');
        $('btn-stop').classList.add('hidden');
        $('btn-camera').disabled = false;
        setStatus('Camera stopped.');
      })
      .catch(function (err) {
        console.error(err);
        state.scanner = null;
        state.scanning = false;
        clearReaderDom();
        $('btn-camera').disabled = false;
      });
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
    $('btn-camera').addEventListener('click', function () {
      if (!state.username) {
        openModal(false);
        setStatus('Save your number first.', 'error');
        return;
      }
      startScanner();
    });
    $('btn-stop').addEventListener('click', function () {
      hideScanChoiceSheet();
      stopScanner();
    });
    $('modal-save').addEventListener('click', function () {
      var v = $('username-input').value;
      if (!validateUsername(v)) {
        setStatus('Enter a 9-digit number.', 'error');
        return;
      }
      state.username = v.trim();
      saveUsername(state.username);
      showUserPill();
      closeModal();
      setStatus('Number saved on this device.');
    });
    $('modal-cancel').addEventListener('click', closeModal);
    $('btn-change-user').addEventListener('click', function () {
      openModal(true);
    });

    $('card-pending').addEventListener('click', function () {
      openListPanel('pending');
    });
    $('card-today').addEventListener('click', function () {
      openListPanel('today');
    });
    $('card-all').addEventListener('click', function () {
      openListPanel('all');
    });

    $('list-panel-close').addEventListener('click', closeListPanel);
    $('list-panel-backdrop').addEventListener('click', function (e) {
      if (e.target === $('list-panel-backdrop')) {
        closeListPanel();
      }
    });

    $('list-select-all').addEventListener('click', selectAllPendingCheckboxes);
    $('list-upload').addEventListener('click', uploadSelectedPending);

    $('btn-scan-next').addEventListener('click', function () {
      $('scan-choice-backdrop').classList.add('hidden');
      resumeScannerForNextScan();
    });
    $('btn-scan-done').addEventListener('click', function () {
      hideScanChoiceSheet();
      stopScanner().then(function () {
        openListPanel('pending');
        setStatus('Select items to upload when you are ready.');
      });
    });
    // Re-entry button: discard the last-saved scan (wrong code) and resume
    $('btn-scan-reentry').addEventListener('click', function () {
      if (state.lastSavedId) {
        removePendingById(state.lastSavedId);
        state.lastSavedId = null;
        renderStats();
        showToast('Scan removed. Point camera at the correct code.', 'info', 3000);
      } else {
        showToast('No scan to remove. Ready for next code.', 'info', 2500);
      }
      $('scan-choice-backdrop').classList.add('hidden');
      resumeScannerForNextScan();
    });
  }

  function init() {
    state.username = loadUsername();
    state.pending = loadPending();
    state.uploaded = loadUploaded();
    renderStats();
    showUserPill();
    wireUi();
    registerServiceWorker();

    if (!state.username) {
      openModal(false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

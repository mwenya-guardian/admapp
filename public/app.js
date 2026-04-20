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
    scanChoiceOpen: false
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
    return t.length > 0 && t.length <= 64;
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
    if (!code) return;
    var scannedAt = new Date().toISOString();
    state.pending.push({
      id: newLocalId(),
      barcode: code,
      scannedAt: scannedAt
    });
    persistPending();
    renderStats();
  }

  function showScanChoiceSheet(code) {
    $('scan-choice-code').textContent = code;
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

  function writeImeiToFirestore(pendingItem, uploadedAt) {
    var user = firebase.auth().currentUser;
    if (!user) return Promise.reject(new Error('Not signed in'));
    var scannedDate = new Date(pendingItem.scannedAt);
    if (isNaN(scannedDate.getTime())) scannedDate = new Date();
    var db = firebase.firestore();
    return db.collection('imeis').add({
      uid: user.uid,
      username: String(state.username || '').trim(),
      imei: String(pendingItem.barcode).trim(),
      scannedAt: firebase.firestore.Timestamp.fromDate(scannedDate),
      uploadedAt: firebase.firestore.Timestamp.fromDate(uploadedAt)
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

    var user = firebase.auth().currentUser;
    if (!user) {
      setStatus('Not signed in yet. Try again in a moment.', 'error');
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
          setStatus('Some uploads failed (' + failed.length + '). Check connection and rules.', 'error');
        } else {
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
      writeImeiToFirestore(item, uploadedAt)
        .then(function (ref) {
          removePendingById(item.id);
          appendUploadedRecord(item, uploadedAt.toISOString(), ref.id);
          uploadNext(index + 1);
        })
        .catch(function (err) {
          console.error(err);
          failed.push(item.barcode);
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

    enqueuePendingScan(text);
    showScanChoiceSheet(text);
  }

  function startScanner() {
    if (state.scanning) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Camera is not available in this browser.', 'error');
      return;
    }
    setStatus('Starting camera…');
    clearReaderDom();
    state.scanner = buildScanner();
    state.scanner
      .start(SCAN_CAMERA, SCAN_CONFIG, onScanSuccess, function () {})
      .then(function () {
        state.scanning = true;
        $('reader-wrap').classList.remove('hidden');
        $('reader-wrap').setAttribute('aria-hidden', 'false');
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
        setStatus('Enter a number (1–64 characters).', 'error');
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

    ensureFirestorePersistence().then(function () {
      return ensureAuth();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

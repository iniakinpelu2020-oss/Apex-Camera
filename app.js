/* Apex Camera - offline photo and video capture for the Apex suite.
 *
 * Runs standalone (https://.../index.html) or bundled inside ApexOS at
 * /apps/camera/. Every fetch and registration is relative, so the same folder
 * works from any depth.
 *
 * Captures are written to the shared gallery database in IndexedDB:
 *
 *   database  apex-gallery   version 1
 *   store     photos         keyPath 'id'   indexes 'createdAt', 'kind'
 *   record    { id, kind: 'photo' | 'video', name, type, size, width, height,
 *               duration, createdAt, source: 'apex-camera', blob }
 *
 * Apex Gallery only has to open 'apex-gallery' and read 'photos' to show them.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'apex-gallery';
  var DB_VERSION = 1;
  var STORE = 'photos';
  var MAX_RECORDING_MS = 5 * 60 * 1000;
  var PHOTO_QUALITY = 0.92;

  var els = {};
  var stream = null;
  var facing = 'environment';
  var mode = 'photo';
  var recorder = null;
  var chunks = [];
  var recording = false;
  var recordStartedAt = 0;
  var timerHandle = 0;
  var lastRecord = null;
  var reviewUrl = '';
  var busy = false;
  var counts = { photo: 0, video: 0 };
  var dbPromise = null;

  /* ---------- IndexedDB: the shared Apex Gallery store ---------- */

  function db() {
    if (!('indexedDB' in global)) {
      return Promise.reject(new Error('indexeddb-unavailable'));
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          var store = database.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('kind', 'kind', { unique: false });
        }
      };

      request.onsuccess = function () {
        var database = request.result;
        database.onversionchange = function () {
          database.close();
          dbPromise = null;
        };
        resolve(database);
      };

      request.onerror = function () { reject(request.error || new Error('indexeddb-open-failed')); };
      request.onblocked = function () { reject(new Error('indexeddb-blocked')); };
    });

    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function saveRecord(record) {
    return db().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx = database.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { reject(tx.error || new Error('indexeddb-write-failed')); };
        tx.onabort = function () { reject(tx.error || new Error('indexeddb-write-aborted')); };
      });
    });
  }

  /* Counts only - the frames themselves stay in the gallery for Apex Gallery
     to read, not in this tab. */
  function readCounts() {
    return db().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx = database.transaction(STORE, 'readonly');
        var store = tx.objectStore(STORE);
        var out = { photo: 0, video: 0 };
        var photoRequest = store.index('kind').count('photo');
        var videoRequest = store.index('kind').count('video');
        photoRequest.onsuccess = function () { out.photo = photoRequest.result || 0; };
        videoRequest.onsuccess = function () { out.video = videoRequest.result || 0; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error || new Error('indexeddb-read-failed')); };
      });
    });
  }

  function refreshCounts() {
    return readCounts().then(function (next) {
      counts = next;
      paintCounts();
    }).catch(function () {
      if (els.libStamp) els.libStamp.textContent = 'Gallery storage is not available in this browser';
    });
  }

  function paintCounts() {
    if (!els.libStamp) return;
    var photos = counts.photo;
    var videos = counts.video;
    if (!photos && !videos) {
      els.libStamp.textContent = 'Nothing saved yet - shots land in Apex Gallery.';
      return;
    }
    els.libStamp.textContent =
      photos + (photos === 1 ? ' photo' : ' photos') + ' · ' +
      videos + (videos === 1 ? ' video' : ' videos') + ' in Apex Gallery';
  }

  /* ---------- small helpers ---------- */

  function two(value) { return String(value).padStart(2, '0'); }

  function stamp(date) {
    return String(date.getFullYear()) + two(date.getMonth() + 1) + two(date.getDate()) +
      '-' + two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
  }

  function idFor() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'cam-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function bytes(size) {
    if (!size) return '0 B';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(0) + ' KB';
    return (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function duration(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0));
    return Math.floor(total / 60) + ':' + two(total % 60);
  }

  function clock(ms) {
    var total = Math.floor(Math.max(0, ms) / 1000);
    return two(Math.floor(total / 60)) + ':' + two(total % 60);
  }

  function extensionFor(type) {
    return String(type || '').indexOf('mp4') !== -1 ? 'mp4' : 'webm';
  }

  function setStatus(text) {
    if (els.lensChip) els.lensChip.textContent = text;
  }

  var toastTimer = 0;
  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { els.toast.hidden = true; }, 3000);
  }

  /* ---------- camera ---------- */

  function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (err) { /* already gone */ }
    });
    stream = null;
    if (els.video) els.video.srcObject = null;
    if (els.finder) els.finder.dataset.live = 'false';
  }

  function requestStream(anyCamera) {
    var constraints = anyCamera
      ? { video: true, audio: false }
      : { video: { facingMode: facing }, audio: false };
    return global.navigator.mediaDevices.getUserMedia(constraints);
  }

  function startCamera(nextFacing) {
    if (recording) {
      toast('Stop recording before changing the camera');
      return;
    }

    facing = nextFacing || facing;
    stopStream();
    hideFallback();
    setStatus('Starting…');
    if (els.finder) els.finder.dataset.facing = facing;

    if (!global.isSecureContext) {
      showFallback(
        'Camera needs a secure page',
        'Browsers only expose the camera on https:// or on localhost. Open this page from the bundled ApexOS site or your own https deployment, then retry.'
      );
      return;
    }

    if (!global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
      showFallback(
        'No camera API here',
        'This browser does not expose getUserMedia to this page. Try Chrome, Edge or Safari over https, or open Apex Camera directly instead of inside a frame.'
      );
      return;
    }

    requestStream(false).then(attach).catch(function (err) {
      /* A laptop with one fixed camera still rejects facingMode: take what is
         there rather than showing a permission error that is not one. */
      if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        requestStream(true).then(attach).catch(failed);
        return;
      }
      failed(err);
    });

    function failed(err) {
      setStatus('No camera');
      updateControls();
      showFallback(titleFor(err), bodyFor(err));
    }
  }

  function attach(got) {
    stream = got;
    var track = got.getVideoTracks()[0] || null;

    if (track) {
      track.addEventListener('ended', function () {
        if (stream !== got) return;
        stopStream();
        setStatus('Camera stopped');
        updateControls();
        showFallback(
          'The camera stopped',
          'Another app or tab took the camera, or it was unplugged. Press Retry Camera to start it again.'
        );
      });

      var settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
      paintLens(settings);
    }

    els.video.srcObject = got;
    els.finder.dataset.live = 'true';
    var playing = els.video.play();
    if (playing && typeof playing.catch === 'function') playing.catch(function () { /* autoplay is muted */ });

    setStatus('Live');
    hideFallback();
    updateControls();
  }

  function paintLens(settings) {
    if (!els.lensChip) return;
    var facingMode = settings && settings.facingMode;
    var front = facingMode ? facingMode === 'user' : facing === 'user';
    els.lensChip.textContent = front ? 'Front camera' : 'Rear camera';
    paintResolution();
  }

  function paintResolution() {
    if (!els.resChip) return;
    var width = els.video.videoWidth;
    var height = els.video.videoHeight;
    if (!width || !height) {
      els.resChip.hidden = true;
      return;
    }
    els.resChip.textContent = width + '×' + height;
    els.resChip.hidden = false;
  }

  function titleFor(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access is blocked';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera found';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'The camera is busy';
    if (name === 'OverconstrainedError') return 'This camera cannot start';
    return 'Camera unavailable';
  }

  function bodyFor(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'The browser refused the camera. Allow Camera for this site (the padlock or camera icon in the address bar), then press Retry Camera. Inside ApexOS the app window asks for the same permission once.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'There is no camera this page can see. Plug one in or open this page on the phone itself, then press Retry Camera.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Another app is holding the camera. Close it - a video call, another browser tab - then press Retry Camera.';
    }
    if (name === 'OverconstrainedError') {
      return 'The camera rejected the requested settings. Press Retry Camera; Apex Camera falls back to whatever the device offers.';
    }
    return 'The camera did not start' + (name ? ' (' + name + ')' : '') +
      '. Press Retry Camera. If it keeps failing, reload the page and allow camera access when asked.';
  }

  function showFallback(title, body) {
    if (!els.fallback) return;
    els.fallbackTitle.textContent = title;
    els.fallbackBody.textContent = body;
    els.fallback.hidden = false;
    if (els.finder) els.finder.dataset.live = 'false';
    updateControls();
  }

  function hideFallback() {
    if (els.fallback) els.fallback.hidden = true;
  }

  /* ---------- controls ---------- */

  function canSwitch() {
    return Boolean(stream) && !recording && !busy;
  }

  function updateControls() {
    if (!els.shutter) return;
    var ready = Boolean(stream) && !busy && !(mode === 'video' && !global.MediaRecorder);
    els.shutter.disabled = !ready;
    els.shutter.classList.toggle('is-recording', recording);
    els.shutter.setAttribute('aria-label', mode === 'video'
      ? (recording ? 'Stop recording' : 'Start recording')
      : 'Take photo');

    if (els.switchBtn) els.switchBtn.disabled = !canSwitch();
    if (els.photoMode) els.photoMode.disabled = recording;
    if (els.videoMode) {
      els.videoMode.disabled = recording || !global.MediaRecorder;
      els.videoMode.title = global.MediaRecorder ? '' : 'This browser cannot record video';
    }
  }

  function setMode(next) {
    if (recording) {
      toast('Stop recording to change mode');
      return;
    }
    mode = next === 'video' ? 'video' : 'photo';
    document.body.dataset.mode = mode;

    [els.photoMode, els.videoMode].forEach(function (button) {
      if (!button) return;
      var on = button === (mode === 'photo' ? els.photoMode : els.videoMode);
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });

    if (els.modeTag) els.modeTag.textContent = mode === 'video' ? 'Video' : 'Photo';
    if (els.finderHint) {
      els.finderHint.textContent = mode === 'video'
        ? 'Press record, then stop when you are done.'
        : 'Point, then press the shutter.';
    }
    updateControls();
  }

  function switchCamera() {
    if (!canSwitch()) return;
    startCamera(facing === 'environment' ? 'user' : 'environment');
  }

  /* ---------- photos ---------- */

  function capturePhoto() {
    if (!stream || busy || recording) return;
    var video = els.video;
    var width = video.videoWidth;
    var height = video.videoHeight;

    if (!width || !height) {
      toast('The camera is still warming up');
      return;
    }

    var canvas = els.canvas;
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d');
    context.save();
    /* Match the mirrored front-camera preview so the photo looks like the
       frame you pressed the shutter on. */
    if (els.finder.dataset.facing === 'user') {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, width, height);
    context.restore();

    busy = true;
    updateControls();

    canvas.toBlob(function (blob) {
      busy = false;
      updateControls();

      if (!blob) {
        toast('The snapshot failed - try again');
        return;
      }

      saveAndReview({
        id: idFor(),
        kind: 'photo',
        name: 'apex-camera-' + stamp(new Date()) + '.jpg',
        type: 'image/jpeg',
        size: blob.size,
        width: width,
        height: height,
        duration: 0,
        createdAt: new Date().toISOString(),
        source: 'apex-camera',
        blob: blob
      });
    }, 'image/jpeg', PHOTO_QUALITY);
  }

  /* ---------- video ---------- */

  function pickMime() {
    if (!global.MediaRecorder) return '';
    var options = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
    ];
    for (var i = 0; i < options.length; i += 1) {
      if (global.MediaRecorder.isTypeSupported(options[i])) return options[i];
    }
    return '';
  }

  function startRecording() {
    if (!stream || recording) return;

    var mime = pickMime();
    if (!mime) {
      toast('This browser cannot record video');
      return;
    }

    chunks = [];
    try {
      recorder = new global.MediaRecorder(stream, { mimeType: mime });
    } catch (err) {
      toast('This camera cannot be recorded in this browser');
      recorder = null;
      return;
    }

    recorder.addEventListener('dataavailable', function (event) {
      if (event.data && event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener('stop', finishRecording);
    recorder.addEventListener('error', function () {
      toast('Recording stopped unexpectedly');
    });

    try {
      recorder.start(1000);
    } catch (err) {
      recorder = null;
      toast('The recorder did not start');
      return;
    }

    recording = true;
    recordStartedAt = Date.now();
    if (els.timerTag) els.timerTag.hidden = false;
    if (els.timerText) els.timerText.textContent = '00:00';
    global.clearInterval(timerHandle);
    timerHandle = global.setInterval(paintTimer, 250);
    setStatus('Recording');
    updateControls();
  }

  function paintTimer() {
    var elapsed = Date.now() - recordStartedAt;
    if (els.timerText) els.timerText.textContent = clock(elapsed);
    if (elapsed >= MAX_RECORDING_MS) {
      toast('Recording stopped at 5:00');
      stopRecording();
    }
  }

  function stopRecording() {
    if (!recorder || !recording) return;
    try {
      recorder.stop();
    } catch (err) {
      recording = false;
      updateControls();
    }
  }

  function finishRecording() {
    var mime = (recorder && recorder.mimeType) || (chunks[0] && chunks[0].type) || 'video/webm';
    var elapsed = recordStartedAt ? Date.now() - recordStartedAt : 0;

    recording = false;
    recorder = null;
    recordStartedAt = 0;
    global.clearInterval(timerHandle);
    timerHandle = 0;
    if (els.timerTag) els.timerTag.hidden = true;
    setStatus(stream ? 'Live' : 'Idle');
    updateControls();

    if (!chunks.length) {
      toast('Nothing was recorded');
      return;
    }

    var blob = new Blob(chunks, { type: mime });
    chunks = [];

    saveAndReview({
      id: idFor(),
      kind: 'video',
      name: 'apex-camera-' + stamp(new Date()) + '.' + extensionFor(mime),
      type: mime,
      size: blob.size,
      width: els.video.videoWidth || 0,
      height: els.video.videoHeight || 0,
      duration: Math.round(elapsed / 100) / 10,
      createdAt: new Date().toISOString(),
      source: 'apex-camera',
      blob: blob
    });
  }

  /* ---------- review + download ---------- */

  function describe(record) {
    var size = record.kind === 'video'
      ? record.width + '×' + record.height + ' · ' + duration(record.duration) + ' · ' + bytes(record.size)
      : record.width + '×' + record.height + ' · ' + bytes(record.size);
    return record.kind === 'video' ? 'Video · ' + size : 'Photo · ' + size;
  }

  function saveAndReview(record) {
    saveRecord(record).then(function () {
      refreshCounts();
      showReview(record, true);
    }).catch(function () {
      showReview(record, false);
      toast('Could not write to Apex Gallery - download this file instead');
    });
  }

  function showReview(record, saved) {
    lastRecord = record;

    if (reviewUrl) URL.revokeObjectURL(reviewUrl);
    reviewUrl = URL.createObjectURL(record.blob);

    var isVideo = record.kind === 'video';
    els.reviewTitle.textContent = isVideo ? 'Video recorded' : 'Photo captured';

    if (isVideo) {
      els.reviewVideo.hidden = false;
      els.reviewImg.hidden = true;
      els.reviewImg.removeAttribute('src');
      els.reviewVideo.src = reviewUrl;
    } else {
      els.reviewImg.hidden = false;
      els.reviewVideo.hidden = true;
      els.reviewVideo.removeAttribute('src');
      els.reviewImg.src = reviewUrl;
      els.reviewImg.alt = 'Captured photo';
    }

    els.reviewMeta.textContent = describe(record) + (saved ? ' · saved to Apex Gallery' : ' · not saved');
    els.review.hidden = false;
    els.reviewDownload.focus();
  }

  function closeReview() {
    if (!els.review || els.review.hidden) return;
    els.review.hidden = true;
    if (els.reviewVideo) {
      try { els.reviewVideo.pause(); } catch (err) { /* nothing playing */ }
    }
    if (reviewUrl) {
      URL.revokeObjectURL(reviewUrl);
      reviewUrl = '';
    }
    if (els.shutter) els.shutter.focus();
  }

  function downloadLast() {
    if (!lastRecord) return;
    var url = URL.createObjectURL(lastRecord.blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = lastRecord.name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Download started');
  }

  /* ---------- wiring ---------- */

  function bind() {
    els.shutter.addEventListener('click', function () {
      if (mode === 'video') {
        if (recording) stopRecording();
        else startRecording();
        return;
      }
      capturePhoto();
    });

    els.switchBtn.addEventListener('click', switchCamera);
    els.retryBtn.addEventListener('click', function () {
      hideFallback();
      startCamera(facing);
    });

    els.photoMode.addEventListener('click', function () { setMode('photo'); });
    els.videoMode.addEventListener('click', function () { setMode('video'); });

    els.reviewDownload.addEventListener('click', downloadLast);
    els.reviewClose.addEventListener('click', closeReview);
    els.review.addEventListener('click', function (event) {
      if (event.target === els.review) closeReview();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!els.review.hidden) {
        closeReview();
        return;
      }
      if (mode === 'video' && recording) stopRecording();
    });

    els.video.addEventListener('loadedmetadata', paintResolution);

    global.addEventListener('pagehide', function () {
      if (recorder && recording) {
        try { recorder.stop(); } catch (err) { /* page is going away */ }
      }
      stopStream();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && recording) stopRecording();
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in global.navigator)) return;
    global.navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {
      /* Camera works online without the offline shell. */
    });
  }

  function boot() {
    els.video = document.getElementById('viewfinder');
    els.finder = document.getElementById('finder');
    els.canvas = document.getElementById('snapshot');
    els.shutter = document.getElementById('shutter');
    els.switchBtn = document.getElementById('switchBtn');
    els.photoMode = document.getElementById('photoMode');
    els.videoMode = document.getElementById('videoMode');
    els.retryBtn = document.getElementById('retryBtn');
    els.fallback = document.getElementById('fallback');
    els.fallbackTitle = document.getElementById('fallbackTitle');
    els.fallbackBody = document.getElementById('fallbackBody');
    els.lensChip = document.getElementById('lensChip');
    els.resChip = document.getElementById('resChip');
    els.timerTag = document.getElementById('timerTag');
    els.timerText = document.getElementById('timerText');
    els.modeTag = document.getElementById('modeTag');
    els.finderHint = document.getElementById('finderHint');
    els.libStamp = document.getElementById('libStamp');
    els.review = document.getElementById('review');
    els.reviewTitle = document.getElementById('reviewTitle');
    els.reviewImg = document.getElementById('reviewImg');
    els.reviewVideo = document.getElementById('reviewVideo');
    els.reviewMeta = document.getElementById('reviewMeta');
    els.reviewDownload = document.getElementById('reviewDownload');
    els.reviewClose = document.getElementById('reviewClose');
    els.toast = document.getElementById('toast');

    if (!els.video || !els.shutter) return;

    els.canvas = els.canvas || document.createElement('canvas');

    bind();
    setMode('photo');
    refreshCounts();
    registerServiceWorker();
    startCamera('environment');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.ApexCamera = {
    dbName: DB_NAME,
    storeName: STORE,
    photo: capturePhoto,
    start: startCamera,
    switchCamera: switchCamera,
    counts: function () { return counts; }
  };
})(window);

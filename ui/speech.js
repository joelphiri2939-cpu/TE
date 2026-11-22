/* TeachMate offline dictation — sherpa-onnx streaming Zipformer.
 * Loads only when a user taps a microphone. Audio is processed locally;
 * no microphone audio is uploaded or stored by this module.
 */
(function () {
  'use strict';

  if (window.__teachMateSpeechInstalled) return;
  window.__teachMateSpeechInstalled = true;

  var BASE = 'https://pub-973c201b010448d9a1bb7e1ddf042487.r2.dev';
  var API_URL = BASE + '/sherpa-onnx-asr.js';
  var LOADER_URL = BASE + '/sherpa-onnx-wasm-main-asr.js';
  var DATA_URL = BASE + '/sherpa-onnx-wasm-main-asr.data';
  var WASM_URL = BASE + '/sherpa-onnx-wasm-main-asr.wasm';
  // Keep this cache outside the 'teachmate-' prefix: service-worker.js removes old app-shell caches on deploy.
  var CACHE_NAME = 'tm-speech-engine-v1';
  var EXPECTED_MODEL_BYTES = 190951044;

  var enginePromise = null;
  var recognizer = null;
  var active = null;
  var startInProgress = false;
  var cacheAvailable = !!(window.caches && window.fetch);
  var pendingCacheWrites = [];
  var toast = null;
  var toastText = null;
  var toastBar = null;
  var toastProgress = null;
  var controls = new Map();
  var repositionQueued = false;

  function ensureToast() {
    if (toast) return;
    var style = document.createElement('style');
    style.textContent = [
      '.tm-speech-mic{position:fixed;z-index:2147483000;width:32px;height:32px;border:1px solid rgba(15,23,42,.18);border-radius:50%;background:#fff;color:#0f766e;box-shadow:0 2px 8px rgba(15,23,42,.20);font:700 15px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
      '.tm-speech-mic.tm-speaking{background:#dc2626;color:#fff;border-color:#dc2626}',
      '.tm-speech-mic:disabled{opacity:.72;cursor:wait}',
      '.tm-speech-target{padding-right:calc(var(--tm-speech-original-pr, 10px) + 38px)!important}',
      '#tm-speech-status{position:fixed;z-index:2147483001;left:50%;bottom:18px;transform:translateX(-50%);width:min( min(92vw, 420px), 420px);box-sizing:border-box;padding:12px 14px;border-radius:12px;background:#102a43;color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.28);font:13px/1.45 system-ui,sans-serif;display:none}',
      '#tm-speech-status .tm-speech-progress{height:5px;background:rgba(255,255,255,.2);border-radius:8px;margin-top:8px;overflow:hidden}',
      '#tm-speech-status .tm-speech-progress span{display:block;height:100%;width:0;background:#34d399;transition:width .15s linear}',
      '#tm-speech-status .tm-speech-note{opacity:.78;font-size:11px;margin-top:4px}'
    ].join('\n');
    document.head.appendChild(style);

    toast = document.createElement('div');
    toast.id = 'tm-speech-status';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toastText = document.createElement('div');
    toastText.className = 'tm-speech-message';
    toastBar = document.createElement('div');
    toastBar.className = 'tm-speech-progress';
    toastProgress = document.createElement('span');
    toastBar.appendChild(toastProgress);
    toast.appendChild(toastText);
    toast.appendChild(toastBar);
    document.body.appendChild(toast);
  }

  function showStatus(message, percent) {
    ensureToast();
    toastText.textContent = message;
    toast.style.display = 'block';
    toastBar.style.display = typeof percent === 'number' ? 'block' : 'none';
    if (typeof percent === 'number') {
      toastProgress.style.width = Math.max(0, Math.min(100, percent)) + '%';
    }
  }

  function hideStatus(delay) {
    window.setTimeout(function () {
      if (toast && toastText && !active) toast.style.display = 'none';
    }, delay || 1800);
  }

  async function loadCachedScript(url) {
    var response = null;
    var cache = null;
    if (cacheAvailable) {
      try {
        cache = await caches.open(CACHE_NAME);
        response = await cache.match(url);
      } catch (e) {
        cacheAvailable = false;
      }
    }
    if (!response) {
      response = await fetch(url);
      if (!response.ok) throw new Error('HTTP ' + response.status + ' while loading speech engine script.');
      if (cache) {
        try { await cache.put(url, response.clone()); }
        catch (e) { cacheAvailable = false; console.warn('[TeachMate speech] Could not cache engine script', e); }
      }
    }
    var source = await response.text();
    var blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      await new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = blobUrl;
        script.async = false;
        script.onload = function () { resolve(); };
        script.onerror = function () { reject(new Error('Could not execute cached speech engine script.')); };
        document.head.appendChild(script);
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  function installPersistentFetchCache() {
    if (!cacheAvailable || window.__tmSpeechFetchWrapped) return;
    window.__tmSpeechFetchWrapped = true;
    var originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url !== DATA_URL && url !== WASM_URL) {
        return originalFetch(input, init);
      }
      var cache;
      try {
        cache = await caches.open(CACHE_NAME);
        var saved = await cache.match(url);
        if (saved) {
          showStatus(url === DATA_URL ? 'Using the saved speech model…' : 'Loading saved speech runtime…');
          return saved;
        }
      } catch (e) {
        cacheAvailable = false;
      }

      var response;
      try {
        response = await originalFetch(input, init);
      } catch (error) {
        if (typeof window.__tmSpeechLoadFailure === 'function') window.__tmSpeechLoadFailure(error);
        throw error;
      }
      if (response && !response.ok && typeof window.__tmSpeechLoadFailure === 'function') {
        window.__tmSpeechLoadFailure(new Error('HTTP ' + response.status + ' while downloading speech runtime data.'));
      }
      if (response && response.ok && cache) {
        var write = cache.put(url, response.clone()).catch(function (error) {
          cacheAvailable = false;
          console.warn('[TeachMate speech] Browser could not cache ' + url, error);
        });
        pendingCacheWrites.push(write);
      }
      return response;
    };
  }

  function ensureRecognizer() {
    if (recognizer) return Promise.resolve(recognizer);
    if (enginePromise) return enginePromise;

    enginePromise = (async function () {
      showStatus('Preparing offline speech engine… The first download is about 205 MB in total.');
      try {
        if (navigator.storage && navigator.storage.persist) {
          try { await navigator.storage.persist(); } catch (e) {}
        }
        installPersistentFetchCache();
        await loadCachedScript(API_URL);

        var resolveReady;
        var rejectReady;
        var ready = new Promise(function (resolve, reject) {
          resolveReady = resolve;
          rejectReady = reject;
        });
        window.__tmSpeechLoadFailure = rejectReady;

        var moduleConfig = {
          locateFile: function (path) {
            if (path === 'sherpa-onnx-wasm-main-asr.data') return DATA_URL;
            if (path === 'sherpa-onnx-wasm-main-asr.wasm') return WASM_URL;
            return BASE + '/' + path;
          },
          setStatus: function (status) {
            if (!status) return;
            var match = /Downloading data\.\.\. \((\d+)\/(\d+)\)/.exec(status);
            if (match) {
              var loaded = Number(match[1]);
              var total = Number(match[2]) || EXPECTED_MODEL_BYTES;
              var pct = total ? (loaded / total) * 100 : 0;
              var mb = (loaded / 1048576).toFixed(1);
              var totalMb = (total / 1048576).toFixed(1);
              showStatus('Downloading speech model… ' + pct.toFixed(1) + '% (' + mb + ' / ' + totalMb + ' MB)', pct);
            } else if (status === 'Running...') {
              showStatus('Speech model downloaded. Initializing recognizer…');
            }
          },
          onAbort: function (reason) {
            rejectReady(new Error('Speech engine stopped: ' + reason));
          }
        };

        moduleConfig.onRuntimeInitialized = async function () {
          try {
            await Promise.allSettled(pendingCacheWrites);
            if (typeof window.createOnlineRecognizer !== 'function') {
              throw new Error('The sherpa recognizer API did not load correctly.');
            }
            recognizer = window.createOnlineRecognizer(moduleConfig);
            resolveReady(recognizer);
          } catch (error) {
            rejectReady(error);
          }
        };

        window.Module = moduleConfig;
        await loadCachedScript(LOADER_URL);
        var readyRecognizer = await ready;
        window.__tmSpeechLoadFailure = null;
        if (cacheAvailable) showStatus('Speech model ready. The engine files have been saved in browser storage when permitted.');
        else showStatus('Speech model ready, but browser storage caching failed. Offline use is not guaranteed.');
        return readyRecognizer;
      } catch (error) {
        enginePromise = null;
        window.__tmSpeechLoadFailure = null;
        showStatus('Speech engine could not load: ' + (error.message || error));
        throw error;
      }
    })();

    return enginePromise;
  }

  function downsample(input, inputRate, outputRate) {
    if (inputRate === outputRate) return new Float32Array(input);
    var ratio = inputRate / outputRate;
    var length = Math.floor(input.length / ratio);
    var output = new Float32Array(length);
    for (var i = 0; i < length; i++) {
      var start = Math.floor(i * ratio);
      var end = Math.min(Math.floor((i + 1) * ratio), input.length);
      var sum = 0;
      for (var j = start; j < end; j++) sum += input[j];
      output[i] = end > start ? sum / (end - start) : 0;
    }
    return output;
  }

  function insertTranscript(field, transcript) {
    transcript = String(transcript || '').trim();
    if (!transcript || !field || !field.isConnected) return;
    var value = field.value || '';
    var start = value.length;
    var end = value.length;
    try {
      if (typeof field.selectionStart === 'number') {
        start = field.selectionStart;
        end = field.selectionEnd;
      }
    } catch (e) {}

    var before = value.slice(0, start);
    var after = value.slice(end);
    var leftSpace = before && !/\s$/.test(before) ? ' ' : '';
    var rightSpace = after && !/^\s/.test(after) ? ' ' : '';
    var insertion = leftSpace + transcript + rightSpace;
    var nextValue = before + insertion + after;

    var proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(field, nextValue);
    else field.value = nextValue;

    field.dispatchEvent(new Event('input', { bubbles: true }));
    var caret = before.length + insertion.length;
    try { field.setSelectionRange(caret, caret); } catch (e) {}
    try { field.focus({ preventScroll: true }); } catch (e) { try { field.focus(); } catch (e2) {} }
  }

  async function stopRecording() {
    if (!active) return;
    var session = active;
    active = null;
    try {
      if (session.processor) {
        session.processor.onaudioprocess = null;
        try { session.processor.disconnect(); } catch (e) {}
      }
      if (session.source) {
        try { session.source.disconnect(); } catch (e) {}
      }
      if (session.stream && recognizer) {
        try {
          session.stream.inputFinished();
          while (recognizer.isReady(session.stream)) recognizer.decode(session.stream);
          var finalText = recognizer.getResult(session.stream).text || session.lastText || '';
          if (finalText.trim()) insertTranscript(session.field, finalText);
        } catch (e) {
          if (session.lastText) insertTranscript(session.field, session.lastText);
        }
        try { session.stream.free(); } catch (e) {}
      }
      if (session.media) session.media.getTracks().forEach(function (track) { track.stop(); });
      if (session.context) {
        try { await session.context.close(); } catch (e) {}
      }
    } finally {
      if (session.button) {
        session.button.textContent = '🎙';
        session.button.classList.remove('tm-speaking');
        session.button.disabled = false;
        session.button.title = 'Dictate into this field';
        session.button.setAttribute('aria-label', 'Dictate into this field');
      }
      if (toastText) showStatus('Dictation finished. Your words were inserted into the field.', undefined);
      hideStatus(2200);
    }
  }

  async function startRecording(field, button) {
    if (startInProgress) return;
    startInProgress = true;
    if (active) await stopRecording();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      startInProgress = false;
      showStatus('Microphone access is not available in this browser.');
      return;
    }

    button.disabled = true;
    button.textContent = '…';
    showStatus('Requesting microphone permission…');
    var context = null;
    var media = null;
    try {
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('This browser does not support audio capture.');
      context = new AudioContextClass({ sampleRate: 16000 });
      if (context.state === 'suspended') await context.resume();
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      var engine = await ensureRecognizer();
      var stream = engine.createStream();
      var source = context.createMediaStreamSource(media);
      var processor = context.createScriptProcessor(4096, 1, 1);
      var session = {
        field: field,
        button: button,
        context: context,
        media: media,
        source: source,
        processor: processor,
        stream: stream,
        lastText: ''
      };
      active = session;

      processor.onaudioprocess = function (event) {
        if (active !== session) return;
        var input = event.inputBuffer.getChannelData(0);
        var samples = downsample(input, context.sampleRate, 16000);
        if (!samples.length) return;
        stream.acceptWaveform(16000, samples);
        while (engine.isReady(stream)) engine.decode(stream);
        var result = engine.getResult(stream);
        var text = result && result.text ? result.text.trim() : '';
        if (text) session.lastText = text;
        if (engine.isEndpoint(stream)) {
          var completedText = text || session.lastText;
          if (completedText) insertTranscript(field, completedText);
          session.lastText = '';
          engine.reset(stream);
        }
        var output = event.outputBuffer.getChannelData(0);
        output.fill(0);
      };

      source.connect(processor);
      processor.connect(context.destination);
      button.disabled = false;
      button.textContent = '■';
      button.classList.add('tm-speaking');
      button.title = 'Stop dictation';
      button.setAttribute('aria-label', 'Stop dictation');
      showStatus('Listening… Tap the red stop button when you are finished.');
    } catch (error) {
      if (media) media.getTracks().forEach(function (track) { track.stop(); });
      if (context) { try { await context.close(); } catch (e) {} }
      button.disabled = false;
      button.textContent = '🎙';
      button.classList.remove('tm-speaking');
      button.title = 'Dictate into this field';
      showStatus('Dictation could not start: ' + (error.message || error));
      hideStatus(5000);
    } finally {
      startInProgress = false;
    }
  }

  function eligible(field) {
    if (!field || field.disabled || field.readOnly) return false;
    if (field.tagName === 'TEXTAREA') {
      // Free-form text areas are eligible, except search-like fields.
    } else if (field.tagName === 'INPUT') {
      var type = (field.type || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') return false;
      if (type === 'search') return false;
    } else {
      return false;
    }
    var descriptor = [field.id, field.name, field.placeholder, field.getAttribute('aria-label'), field.getAttribute('autocomplete')]
      .filter(Boolean).join(' ').toLowerCase();
    if (/search|password|e-?mail|phone|mobile|telephone|student.?id|teacher.?id|school.?id|school.?code|ts.?number|\bmarks?\b|score|amount|quantity|number|date|time|otp|one.?time.?code/.test(descriptor)) return false;
    if (field.closest('[data-no-dictation], .tm-no-dictation, #tm-speech-status')) return false;
    return true;
  }

  function scheduleReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    window.requestAnimationFrame(function () {
      repositionQueued = false;
      controls.forEach(function (button, field) {
        if (!field.isConnected) {
          if (active && active.field === field) stopRecording();
          button.remove();
          controls.delete(field);
          return;
        }
        var rect = field.getBoundingClientRect();
        var style = window.getComputedStyle(field);
        var visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
        button.style.display = visible ? 'flex' : 'none';
        if (visible) {
          button.style.left = Math.max(2, Math.min(window.innerWidth - 34, rect.right - 37)) + 'px';
          button.style.top = Math.max(2, Math.min(window.innerHeight - 34, rect.top + Math.min(6, Math.max(0, (rect.height - 32) / 2)))) + 'px';
        }
      });
    });
  }

  function attachField(field) {
    if (controls.has(field) || !eligible(field)) return;
    var computed = window.getComputedStyle(field);
    var padding = parseFloat(computed.paddingRight) || 8;
    field.style.setProperty('--tm-speech-original-pr', padding + 'px');
    field.classList.add('tm-speech-target');

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'tm-speech-mic';
    button.textContent = '🎙';
    button.title = 'Dictate into this field';
    button.setAttribute('aria-label', 'Dictate into this field');
    button.addEventListener('mousedown', function (event) { event.preventDefault(); });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (active && active.field === field) stopRecording();
      else startRecording(field, button);
    });
    document.body.appendChild(button);
    controls.set(field, button);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.matches && root.matches('input,textarea')) attachField(root);
    if (root.querySelectorAll) root.querySelectorAll('input,textarea').forEach(attachField);
    scheduleReposition();
  }

  function boot() {
    ensureToast();
    scan(document);
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) scan(node);
        });
      });
      scheduleReposition();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    window.addEventListener('scroll', scheduleReposition, true);
    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('orientationchange', scheduleReposition);
    window.addEventListener('pagehide', function () { if (active) stopRecording(); });
    console.info('[TeachMate speech] Dictation controls ready. The model loads only after a microphone button is tapped.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();

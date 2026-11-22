/*
 * TeachMate Neural Voice Output
 * Offline Kokoro TTS through sherpa-onnx WebAssembly.
 * The model is downloaded once from the public model repository and cached
 * by the service worker. Speech generation itself runs locally on-device.
 */
(function () {
  'use strict';
  if (window.TeachMateTTS && window.TeachMateTTS.engine === 'kokoro-wasm') return;

  var ASSET_BASE = 'https://huggingface.co/datasets/jiangzhuo9357/sherpa-onnx-tts-models/resolve/main/wasm-kokoro-v1_0-fp32/';
  var enabled = true;
  var rate = 1.0;
  var speakerId = 3;
  var panel = null;
  var statusNode = null;
  var loadButton = null;
  var tts = null;
  var loadingPromise = null;
  var loadStarted = false;
  var queuedText = '';
  var audioContext = null;
  var currentSource = null;
  var chunks = [];
  var speaking = false;
  var generationToken = 0;
  var runtimeScriptReady = false;
  var wrapperScriptReady = false;
  var cacheSaveFailures = 0;

  // Kokoro v1.0 speaker IDs. The first 20 are US English, next 8 are UK English.
  var SPEAKERS = [
    ['af_alloy', 'Alloy — US female'], ['af_aoede', 'Aoede — US female'],
    ['af_bella', 'Bella — US female'], ['af_heart', 'Heart — US female'],
    ['af_jessica', 'Jessica — US female'], ['af_kore', 'Kore — US female'],
    ['af_nicole', 'Nicole — US female'], ['af_nova', 'Nova — US female'],
    ['af_river', 'River — US female'], ['af_sarah', 'Sarah — US female'],
    ['af_sky', 'Sky — US female'], ['am_adam', 'Adam — US male'],
    ['am_echo', 'Echo — US male'], ['am_eric', 'Eric — US male'],
    ['am_fenrir', 'Fenrir — US male'], ['am_liam', 'Liam — US male'],
    ['am_michael', 'Michael — US male'], ['am_onyx', 'Onyx — US male'],
    ['am_puck', 'Puck — US male'], ['am_santa', 'Santa — US male'],
    ['bf_alice', 'Alice — UK female'], ['bf_emma', 'Emma — UK female'],
    ['bf_isabella', 'Isabella — UK female'], ['bf_lily', 'Lily — UK female'],
    ['bm_daniel', 'Daniel — UK male'], ['bm_fable', 'Fable — UK male'],
    ['bm_george', 'George — UK male'], ['bm_lewis', 'Lewis — UK male']
  ];

  function setStatus(message, kind) {
    if (!statusNode) return;
    statusNode.textContent = message;
    statusNode.className = 'tm-tts-status' + (kind ? ' ' + kind : '');
  }

  function getAudioContext() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('This browser does not support Web Audio.');
    if (!audioContext) audioContext = new AudioCtx();
    if (audioContext.state === 'suspended') audioContext.resume().catch(function () {});
    return audioContext;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Could not load neural voice runtime: ' + src)); };
      document.head.appendChild(script);
    });
  }

  function waitForServiceWorkerControl() {
    return new Promise(function (resolve, reject) {
      if (!('serviceWorker' in navigator)) {
        reject(new Error('Offline voice storage needs a service worker. Open TeachMate over HTTPS and reload it.'));
        return;
      }
      if (navigator.serviceWorker.controller) { resolve(true); return; }
      var finished = false;
      var timer = window.setTimeout(function () {
        if (finished) return;
        finished = true;
        navigator.serviceWorker.removeEventListener('controllerchange', onControl);
        reject(new Error('TeachMate offline storage is not active yet. Reload the page once, then try again.'));
      }, 15000);
      function onControl() {
        if (finished || !navigator.serviceWorker.controller) return;
        finished = true;
        window.clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', onControl);
        resolve(true);
      }
      navigator.serviceWorker.addEventListener('controllerchange', onControl);
      navigator.serviceWorker.ready.then(onControl).catch(function () {});
    });
  }

  // The Sherpa wrapper uses Emscripten's own memory and UTF-8 helpers.
  // Do not synthesize allocator functions: only the initialized WASM runtime
  // can provide valid pointers into its linear memory.
  function verifyEmscriptenRuntime(module) {
    if (!module) throw new Error('The WebAssembly Module object is missing.');
    var required = ['_malloc', '_free', 'lengthBytesUTF8', 'stringToUTF8', 'HEAPU8', 'HEAPF32', 'HEAP32'];
    var missing = required.filter(function (name) {
      if (name.indexOf('HEAP') === 0) return !module[name];
      return typeof module[name] !== 'function';
    });
    if (missing.length) {
      throw new Error('Kokoro WebAssembly initialized without required exports: ' + missing.join(', ') + '. The runtime and wrapper files may not match.');
    }
  }

  function initializeTts() {
    if (tts) return Promise.resolve(tts);
    if (loadingPromise) return loadingPromise;
    loadStarted = true;
    runtimeScriptReady = false;
    wrapperScriptReady = false;
    if (loadButton) { loadButton.disabled = true; loadButton.textContent = 'Loading neural voice…'; }
    setStatus('Checking offline storage, then preparing the neural voice. First download is about 310 MB; keep internet on until setup completes.', 'loading');

    // Ask the browser to retain the model cache when persistent storage is available.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }

    loadingPromise = new Promise(function (resolve, reject) {
      var settled = false;
      var timeout = window.setTimeout(function () {
        if (!settled && !tts) finishError(new Error('The neural voice took too long to initialize. Check your connection and reload TeachMate.'));
      }, 12 * 60 * 1000);

      function finishError(error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        loadingPromise = null;
        if (loadButton) { loadButton.disabled = false; loadButton.textContent = 'Retry / load neural voice'; }
        setStatus(error && error.message ? error.message : 'Neural voice initialization failed.', 'error');
        reject(error || new Error('Neural voice initialization failed.'));
      }

      function finishReady() {
        if (settled || tts || !runtimeScriptReady || !wrapperScriptReady) return;
        try {
          if (typeof window.createOfflineTts !== 'function') {
            throw new Error('The Kokoro TTS interface did not load correctly.');
          }
          var config = {
            offlineTtsModelConfig: {
              offlineTtsKokoroModelConfig: {
                model: './model.onnx',
                voices: './voices.bin',
                tokens: './tokens.txt',
                dataDir: './espeak-ng-data',
                lexicon: './lexicon-us-en.txt,./lexicon-zh.txt',
                lengthScale: 1.0,
                lang: ''
              },
              numThreads: 1,
              debug: 0,
              provider: 'cpu'
            },
            ruleFsts: '',
            ruleFars: '',
            maxNumSentences: 1
          };
          verifyEmscriptenRuntime(window.Module);
          tts = window.createOfflineTts(window.Module, config);
          if (!tts || typeof tts.generate !== 'function') throw new Error('Kokoro initialized without a speech generator.');
          settled = true;
          window.clearTimeout(timeout);
          if (loadButton) { loadButton.disabled = false; loadButton.textContent = 'Neural voice ready'; }
          setStatus(cacheSaveFailures
            ? 'Neural voice initialized, but ' + cacheSaveFailures + ' asset(s) failed to save. Offline playback is not guaranteed.'
            : 'Neural voice initialized. Cached files should be reusable offline; verify once with data disabled.',
            cacheSaveFailures ? 'error' : 'ready');
          resolve(tts);
          if (queuedText && enabled) {
            var pending = queuedText;
            queuedText = '';
            speak(pending);
          }
        } catch (error) {
          finishError(error);
        }
      }

      window.Module = {
        locateFile: function (path) { return ASSET_BASE + path; },
        setStatus: function (message) {
          if (message) {
            var match = String(message).match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
            if (match) {
              var percent = Math.min(100, Math.round(Number(match[1]) / Math.max(1, Number(match[2])) * 100));
              setStatus('Downloading neural voice model… ' + percent + '% (first setup only)', 'loading');
            } else {
              setStatus(String(message), 'loading');
            }
          }
          // An empty status message is NOT a reliable runtime-ready signal.
          // Emscripten calls onRuntimeInitialized only after its exports and
          // memory views are available.
        },
        onRuntimeInitialized: function () {
          runtimeScriptReady = true;
          setStatus('WebAssembly runtime initialized; preparing Kokoro…', 'loading');
          finishReady();
        },
        onAbort: function (reason) {
          finishError(new Error('Neural voice runtime stopped: ' + (reason || 'unknown error')));
        }
      };

      waitForServiceWorkerControl()
        .then(function () {
          return loadScript(ASSET_BASE + 'sherpa-onnx-wasm-main-tts.js');
        })
        .then(function () {
          // The main Emscripten runtime and its wrapper are separate scripts.
          // The runtime's empty setStatus callback can fire before this wrapper
          // has loaded, so initialization must wait for BOTH signals.
          runtimeScriptReady = true;
          return loadScript(ASSET_BASE + 'sherpa-onnx-tts.js');
        })
        .then(function () {
          wrapperScriptReady = true;
          finishReady();
        })
        .catch(finishError);
    });
    return loadingPromise;
  }

  function splitIntoChunks(text) {
    var normalized = String(text).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    var sentences = normalized.match(/[^.!?]+[.!?]?/g) || [normalized];
    var result = [];
    sentences.forEach(function (sentence) {
      sentence = sentence.trim();
      while (sentence.length > 260) {
        var cut = sentence.lastIndexOf(' ', 260);
        if (cut < 100) cut = 260;
        result.push(sentence.slice(0, cut).trim());
        sentence = sentence.slice(cut).trim();
      }
      if (sentence) result.push(sentence);
    });
    return result;
  }

  function stop() {
    generationToken++;
    chunks = [];
    speaking = false;
    if (currentSource) {
      try { currentSource.onended = null; currentSource.stop(); } catch (_) {}
      currentSource = null;
    }
  }

  function playNext(token) {
    if (token !== generationToken || !chunks.length) {
      if (token === generationToken) speaking = false;
      return;
    }
    var text = chunks.shift();
    try {
      setStatus('Speaking with the offline neural voice…', 'ready');
      var result = tts.generate({ text: text, sid: speakerId, speed: rate });
      if (!result || !result.samples || !result.samples.length || !result.sampleRate) {
        throw new Error('The neural voice returned empty audio.');
      }
      var samples = result.samples;
      var finiteCount = 0;
      var nonZeroCount = 0;
      for (var i = 0; i < samples.length; i++) {
        if (Number.isFinite(samples[i])) finiteCount++;
        if (Number.isFinite(samples[i]) && Math.abs(samples[i]) > 0.000001) nonZeroCount++;
      }
      if (finiteCount !== samples.length || !nonZeroCount) {
        throw new Error('The model produced invalid or silent audio. Stop and reload TeachMate, then retry.');
      }
      var ctx = getAudioContext();
      var buffer = ctx.createBuffer(1, samples.length, result.sampleRate);
      var channel = buffer.getChannelData(0);
      for (var j = 0; j < samples.length; j++) channel[j] = samples[j];
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      currentSource = source;
      source.onended = function () {
        if (currentSource === source) currentSource = null;
        if (token === generationToken) window.setTimeout(function () { playNext(token); }, 20);
      };
      source.start(0);
    } catch (error) {
      stop();
      setStatus(error.message || 'Speech generation failed.', 'error');
      console.error('[TeachMate TTS]', error);
    }
  }

  function speak(text) {
    if (!enabled || !text) return false;
    var clean = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return false;
    if (!tts) {
      queuedText = clean;
      if (!loadStarted) setStatus('Tap “Download & enable neural voice” once. Your next response will then be spoken.', 'warn');
      if (panel) panel.hidden = false;
      return false;
    }
    stop();
    chunks = splitIntoChunks(clean);
    if (!chunks.length) return false;
    speaking = true;
    var token = generationToken;
    playNext(token);
    return true;
  }

  function buildPanel() {
    if (panel) return;
    var style = document.createElement('style');
    style.textContent = '#tm-tts-panel{position:fixed;right:16px;bottom:76px;z-index:100000;background:#fff;color:#17202a;border:1px solid #ccd3d8;border-radius:14px;padding:14px;width:min(320px,calc(100vw - 32px));max-height:70vh;overflow:auto;box-shadow:0 8px 30px #0003;font:14px system-ui}#tm-tts-panel label{display:block;margin:10px 0 5px}#tm-tts-panel select,#tm-tts-panel input{width:100%;box-sizing:border-box}#tm-tts-panel button{margin:8px 6px 0 0;padding:9px 12px;border:0;border-radius:8px;background:#087f5b;color:white;font:inherit}#tm-tts-panel button:disabled{opacity:.55}#tm-tts-panel .tm-tts-status{font-size:12px;line-height:1.45;margin:10px 0;padding:9px;border-radius:8px;background:#edf2f4;overflow-wrap:anywhere}#tm-tts-panel .tm-tts-status.ready{background:#e5f6ec;color:#176b3a}#tm-tts-panel .tm-tts-status.error{background:#fff0f0;color:#a11}#tm-tts-panel .tm-tts-status.warn{background:#fff7df;color:#785500}#tm-tts-panel .tm-tts-status.loading{background:#eaf2ff;color:#174b8b}#tm-tts-panel .tm-tts-note{font-size:11px;color:#5e6870;line-height:1.4;margin-top:8px}#tm-tts-toggle{position:fixed;right:16px;bottom:16px;z-index:100000;border:0;border-radius:50%;width:50px;height:50px;background:#087f5b;color:white;font-size:22px;box-shadow:0 3px 12px #0004}';
    document.head.appendChild(style);

    var toggle = document.createElement('button');
    toggle.id = 'tm-tts-toggle'; toggle.type = 'button'; toggle.textContent = '🔊';
    toggle.title = 'Neural voice settings'; toggle.setAttribute('aria-label', 'Neural voice settings');

    panel = document.createElement('div');
    panel.id = 'tm-tts-panel'; panel.hidden = true;
    panel.innerHTML = '<strong>TeachMate neural voice</strong>' +
      '<div id="tm-tts-status" class="tm-tts-status">Neural voice has not been downloaded yet.</div>' +
      '<button type="button" id="tm-tts-load">Download &amp; enable neural voice</button>' +
      '<label for="tm-tts-voice">Voice</label><select id="tm-tts-voice"></select>' +
      '<label for="tm-tts-rate">Speaking speed: <span id="tm-tts-rate-value">1.0×</span></label>' +
      '<input id="tm-tts-rate" type="range" min="0.8" max="1.2" step="0.05" value="1">' +
      '<label><input id="tm-tts-enabled" type="checkbox" checked> Speak assistant responses automatically</label>' +
      '<button type="button" id="tm-tts-test">Test voice</button><button type="button" id="tm-tts-stop">Stop</button>' +
      '<div class="tm-tts-note">First setup downloads approximately 310 MB. After setup, speech generation runs on this device. Keep enough free storage available; the browser must retain the model cache for offline use.</div>';

    document.body.appendChild(toggle);
    document.body.appendChild(panel);
    statusNode = panel.querySelector('#tm-tts-status');
    loadButton = panel.querySelector('#tm-tts-load');

    var voiceSelect = panel.querySelector('#tm-tts-voice');
    SPEAKERS.forEach(function (speaker, id) {
      var option = document.createElement('option');
      option.value = String(id);
      option.textContent = speaker[1];
      voiceSelect.appendChild(option);
    });
    voiceSelect.value = String(speakerId);
    voiceSelect.addEventListener('change', function (event) { speakerId = Number(event.target.value) || 0; });

    toggle.addEventListener('click', function () { panel.hidden = !panel.hidden; });
    panel.querySelector('#tm-tts-enabled').addEventListener('change', function (event) { enabled = event.target.checked; if (!enabled) stop(); });
    panel.querySelector('#tm-tts-rate').addEventListener('input', function (event) {
      rate = Number(event.target.value);
      panel.querySelector('#tm-tts-rate-value').textContent = rate.toFixed(2).replace(/0$/, '') + '×';
    });
    loadButton.addEventListener('click', function () {
      try { getAudioContext(); } catch (error) { setStatus(error.message, 'error'); return; }
      initializeTts().catch(function (error) { console.error('[TeachMate TTS]', error); });
    });
    panel.querySelector('#tm-tts-test').addEventListener('click', function () {
      try { getAudioContext(); } catch (error) { setStatus(error.message, 'error'); return; }
      if (!tts) {
        initializeTts().then(function () { speak('Hello! This is TeachMate speaking with its offline neural voice.'); })
          .catch(function (error) { console.error('[TeachMate TTS]', error); });
      } else {
        speak('Hello! This is TeachMate speaking with its offline neural voice.');
      }
    });
    panel.querySelector('#tm-tts-stop').addEventListener('click', stop);
  }

  window.TeachMateTTS = {
    engine: 'kokoro-wasm',
    speak: speak,
    stop: stop,
    setAutoSpeak: function (value) { enabled = !!value; if (panel) panel.querySelector('#tm-tts-enabled').checked = enabled; if (!enabled) stop(); },
    isAutoSpeakEnabled: function () { return enabled; },
    isReady: function () { return !!tts; },
    load: initializeTts
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type !== 'TEACHMATE_TTS_CACHE') return;
      if (data.status === 'saved') {
        setStatus('Saved offline asset: ' + (data.detail || 'model file'), 'loading');
      } else if (data.status === 'save-failed') {
        cacheSaveFailures++;
        setStatus('The voice loaded, but the browser could not save one model file for offline use. Free storage may be insufficient. Details: ' + data.detail, 'error');
      } else if (data.status === 'offline-miss') {
        setStatus('Offline file missing from cache: ' + (data.detail || 'model asset') + '. Connect to the internet and load the voice again.', 'error');
      }
    });
  }

  window.addEventListener('teachmate:assistant-response', function (event) {
    var detail = event.detail || {};
    if (detail.text) speak(detail.text);
  });
  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-tts-speak]');
    if (target) speak(target.getAttribute('data-tts-speak'));
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
  else buildPanel();
})();

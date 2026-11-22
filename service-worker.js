// TeachMate 3.0 — Service Worker
// Network-first for app pages/UI; model assets are cached for offline neural TTS.
const CACHE_VERSION = 'teachmate-v8';
const CACHE_NAME = `${CACHE_VERSION}-shell`;
const TTS_MODEL_CACHE = 'teachmate-kokoro-v1_0-fp32';
const TTS_MODEL_PATH = '/datasets/jiangzhuo9357/sherpa-onnx-tts-models/resolve/main/wasm-kokoro-v1_0-fp32/';
const APP_SHELL = [
  './','./manifest.json','./ui/theme.css','./ui/home.js','./ui/features.css',
  './ui/modals.css','./ui/screens.css','./ui/features.js','./ui/speech.js',
  './ui/voice-tts.js','./ui/vendor/react.production.min.js',
  './ui/vendor/react-dom.production.min.js','./ui/vendor/htm.js',
  './icons/icon-192.png','./icons/icon-512.png','./auth-bg.jpg','./auth-bg-blur.jpg'
];
const NETWORK_ONLY_HOSTS = ['firestore.googleapis.com','firebaseio.com','firebaseinstallations.googleapis.com','identitytoolkit.googleapis.com','securetoken.googleapis.com','googleapis.com','gstatic.com','onrender.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(err => console.error('[SW] App shell cache failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key =>
      key.startsWith('teachmate-') && key !== CACHE_NAME && key !== TTS_MODEL_CACHE
    ).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Keep the large Kokoro runtime/model files available after the first download.
  // CORS responses are cacheable when the asset host permits cross-origin access.
  const isKokoroAsset = url.hostname === 'huggingface.co' && url.pathname.includes(TTS_MODEL_PATH);
  if (isKokoroAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(TTS_MODEL_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response && response.ok && (response.type === 'cors' || response.type === 'basic')) {
        try { await cache.put(request, response.clone()); }
        catch (error) { console.warn('[SW] Could not persist Kokoro asset; offline use may be unavailable:', error); }
      }
      return response;
    })());
    return;
  }

  if (NETWORK_ONLY_HOSTS.some(host => url.hostname.includes(host))) return;
  const isOwn = url.origin === self.location.origin;
  const isPage = request.mode === 'navigate' || request.destination === 'document';
  const isUi = isOwn && (url.pathname.includes('/ui/') || /\.(html|js|css)$/.test(url.pathname));

  if (isPage || isUi) {
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request).then(cached => cached || caches.match('./')))
    );
    return;
  }

  event.respondWith(caches.match(request).then(cached => {
    const network = fetch(request).then(response => {
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => cached);
    return cached || network;
  }));
});

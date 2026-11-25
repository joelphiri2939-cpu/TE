// TeachMate 3.0 — Service Worker
// App shell is refreshed online; Kokoro runtime/model assets are cache-first
// and retained in a dedicated cache for offline speech generation.
const CACHE_VERSION = 'teachmate-v16';
const CACHE_NAME = `${CACHE_VERSION}-shell`;
// Keep this name stable: it preserves the model cache created by the previous build.
const TTS_MODEL_CACHE = 'teachmate-kokoro-v1_0-fp32';
const TTS_ASSET_PREFIX = '/datasets/jiangzhuo9357/sherpa-onnx-tts-models/resolve/main/wasm-kokoro-v1_0-fp32/';
const APP_SHELL = [
  './','./manifest.json','./ui/theme.css','./ui/home.js','./ui/features.css',
  './ui/modals.css','./ui/screens.css','./ui/features.js','./ui/speech.js',
  './ui/voice-tts.js','./ui/voice-audio.js','./ui/voice-verify.js','./ui/voice-match.js','./ui/kokoro-frame.html','./ui/voice-actions.js','./ui/voice-actions-ui.js','./ui/voice-knowledge.js','./ui/voice-actions-data.js','./ui/voice-commands.js','./ui/vendor/react.production.min.js',
  './ui/vendor/react-dom.production.min.js','./ui/vendor/htm.js',
  './icons/icon-192.png','./icons/icon-512.png','./auth-bg.jpg','./auth-bg-blur.jpg'
];
const NETWORK_ONLY_HOSTS = ['firestore.googleapis.com','firebaseio.com','firebaseinstallations.googleapis.com','identitytoolkit.googleapis.com','securetoken.googleapis.com','googleapis.com','gstatic.com','onrender.com'];

async function notifyTtsCache(status, detail) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'TEACHMATE_TTS_CACHE', status, detail: detail || '' });
  } catch (_) {}
}

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
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Hugging Face redirects these requests to its file CDN. The service worker
  // sees the original Hugging Face URL and stores the completed response under
  // that stable URL, so the same request can be fulfilled without internet.
  const isKokoroAsset = url.hostname === 'huggingface.co' && url.pathname.startsWith(TTS_ASSET_PREFIX);
  if (isKokoroAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(TTS_MODEL_CACHE);
      const cacheKey = new Request(url.href, { method: 'GET', mode: 'cors', credentials: 'omit' });
      const cached = await cache.match(cacheKey, { ignoreVary: true });
      if (cached) {
        notifyTtsCache('hit', url.pathname.split('/').pop());
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response && response.status === 200 && response.type !== 'opaque') {
          try {
            await cache.put(cacheKey, response.clone());
            notifyTtsCache('saved', url.pathname.split('/').pop());
          } catch (cacheError) {
            console.error('[SW] Kokoro asset could not be saved for offline use:', cacheError);
            notifyTtsCache('save-failed', String(cacheError && cacheError.message || cacheError));
          }
        } else {
          notifyTtsCache('not-saved', 'The model host did not return a cacheable full response.');
        }
        return response;
      } catch (networkError) {
        const fallback = await cache.match(cacheKey, { ignoreVary: true });
        if (fallback) return fallback;
        notifyTtsCache('offline-miss', url.pathname.split('/').pop());
        throw networkError;
      }
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

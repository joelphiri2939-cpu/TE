// TeachMate 3.0 - Service Worker
// Strategy: cache-first for the app shell, network-only for Firebase/Firestore
// so live data is never served stale. Bump CACHE_VERSION on every deploy so
// old caches get cleaned up and users get the new build.

const CACHE_VERSION = 'teachmate-v1';
const CACHE_NAME = `${CACHE_VERSION}-shell`;

// Add every file that makes up the app shell. Keep this list in sync with
// your actual file names on Render.
const APP_SHELL = [
  './',
  './manifest.json',
  // Rename your main HTML file to index.html on deploy, or update this
  // path to match your actual entry file name.
  // './TeachMate3_0-PREMIUM-5.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './auth-bg.jpg'
];

// Domains that must ALWAYS go to the network - never cached, never
// intercepted. This is what keeps Firestore/Firebase data live and
// prevents the multi-teacher stale-state bugs you've been chasing.
const NETWORK_ONLY_HOSTS = [
  'firestore.googleapis.com',
  'firebaseio.com',
  'firebaseinstallations.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'googleapis.com',
  'gstatic.com',
  'onrender.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.error('[SW] App shell cache failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('teachmate-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests - POST/PUT/etc (writes) always go straight
  // to the network untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept Firebase/Firestore/backend calls - these must always
  // be live, never cached.
  if (NETWORK_ONLY_HOSTS.some((host) => url.hostname.includes(host))) {
    return; // let the browser handle it normally
  }

  // Cache-first for the app shell and static assets, with a network
  // fallback that refreshes the cache when online.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to cache if network fails

      // Serve cached immediately if we have it, refresh in background;
      // otherwise wait on the network.
      return cached || networkFetch;
    })
  );
});
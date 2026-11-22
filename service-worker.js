// TeachMate 3.0 — Service Worker
// Network-first for app pages/UI; Firebase and backend calls remain network-only.
const CACHE_VERSION = 'teachmate-v7';
const CACHE_NAME = `${CACHE_VERSION}-shell`;
const APP_SHELL = [
  './','./manifest.json','./ui/theme.css','./ui/home.js','./ui/features.css',
  './ui/modals.css','./ui/screens.css','./ui/features.js','./ui/speech.js',
  './ui/voice-tts.js','./ui/vendor/react.production.min.js',
  './ui/vendor/react-dom.production.min.js','./ui/vendor/htm.js',
  './icons/icon-192.png','./icons/icon-512.png','./auth-bg.jpg','./auth-bg-blur.jpg'
];
const NETWORK_ONLY_HOSTS = ['firestore.googleapis.com','firebaseio.com','firebaseinstallations.googleapis.com','identitytoolkit.googleapis.com','securetoken.googleapis.com','googleapis.com','gstatic.com','onrender.com'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).catch(err=>console.error('[SW] App shell cache failed:',err)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('teachmate-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))));self.clients.claim();});
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(NETWORK_ONLY_HOSTS.some(host=>url.hostname.includes(host)))return;const isOwn=url.origin===self.location.origin;const isPage=request.mode==='navigate'||request.destination==='document';const isUi=isOwn&&(url.pathname.includes('/ui/')||/\.(html|js|css)$/.test(url.pathname));if(isPage||isUi){event.respondWith(fetch(request,{cache:'no-cache'}).then(response=>{if(response&&response.status===200&&response.type==='basic'){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}return response;}).catch(()=>caches.match(request).then(cached=>cached||caches.match('./'))));return;}event.respondWith(caches.match(request).then(cached=>{const network=fetch(request).then(response=>{if(response&&response.status===200&&response.type==='basic'){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}return response;}).catch(()=>cached);return cached||network;}));});

// Service Worker — Elektro Challenge PWA
// Caches all assets for fully offline operation on Quest

const CACHE_NAME = 'elektro-vr-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './main.js',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/hdri/empty_warehouse_1k.hdr',
  './assets/sketchfab/bulb_edison.glb',
  // PBR textures
  './assets/textures/concrete_floor_02/concrete_floor_02_diff_1k.jpg',
  './assets/textures/concrete_floor_02/concrete_floor_02_nor_gl_1k.jpg',
  './assets/textures/concrete_floor_02/concrete_floor_02_rough_1k.jpg',
  './assets/textures/plastered_wall_04/plastered_wall_04_diff_1k.jpg',
  './assets/textures/plastered_wall_04/plastered_wall_04_nor_gl_1k.jpg',
  './assets/textures/plastered_wall_04/plastered_wall_04_rough_1k.jpg',
  './assets/textures/wood_table_001/wood_table_001_diff_1k.jpg',
  './assets/textures/wood_table_001/wood_table_001_nor_gl_1k.jpg',
  './assets/textures/wood_table_001/wood_table_001_rough_1k.jpg',
  './assets/textures/metal_plate/metal_plate_diff_1k.jpg',
  './assets/textures/metal_plate/metal_plate_nor_gl_1k.jpg',
  './assets/textures/metal_plate/metal_plate_rough_1k.jpg',
];

// CDN resources (three.js from unpkg)
const CDN_ASSETS = [
  'https://unpkg.com/three@0.160.0/build/three.module.js',
  'https://unpkg.com/three@0.160.0/examples/jsm/webxr/VRButton.js',
  'https://unpkg.com/three@0.160.0/examples/jsm/webxr/XRControllerModelFactory.js',
  'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js',
  'https://unpkg.com/three@0.160.0/examples/jsm/loaders/RGBELoader.js',
];

// Install: pre-cache all local + CDN assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing, caching assets...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache local assets
      const localPromise = cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('[SW] Some local assets failed to cache:', err);
      });
      // Cache CDN assets individually (cross-origin)
      const cdnPromises = CDN_ASSETS.map((url) =>
        fetch(url, { mode: 'cors' })
          .then((resp) => {
            if (resp.ok) return cache.put(url, resp);
            console.warn(`[SW] CDN fetch failed: ${url}`, resp.status);
          })
          .catch((err) => console.warn(`[SW] CDN unreachable: ${url}`, err))
      );
      return Promise.all([localPromise, ...cdnPromises]);
    }).then(() => {
      console.log('[SW] All assets cached');
      return self.skipWaiting();
    })
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
  console.log('[SW] Activated');
});

// Fetch: cache-first, then network fallback
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful GET responses for future offline use
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline and not in cache
      console.warn('[SW] Offline, not cached:', event.request.url);
    })
  );
});

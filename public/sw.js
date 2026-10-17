const CACHE_NAME = 'air-legends-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './images/player.png',
  './images/player2.png',
  './images/background.png',
  './images/bullet.png',
  './images/bullet2.png',
  './images/ebullet.png',
  './images/boss.png',
  './images/enemy_grunt.png',
  './images/enemy_tank.png',
  './images/enemy_zig.png',
  './images/powerup_life.png',
  './images/powerup_power.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null)
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

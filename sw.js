/* 小西家：通知を受け取るためのファイル＋画面キャッシュ（速く開く・通信量を減らす・オフラインでも開く） */
var CACHE = 'konishike-v1';
var SHELL = ['./family-app.html', './push-config.js', './manifest.webmanifest', './family-config.json',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './badge-96.png', './badge-512.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // 1つ失敗しても全体は止めない
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase・天気など外部はそのまま通す
  var isPage = req.mode === 'navigate' || url.pathname.endsWith('/family-app.html') || url.pathname.endsWith('/family-app/');
  if (isPage) {
    // 画面：まずネット（新しい版を取りこぼさない）、ダメなら控えを出す
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put('./family-app.html', copy); });
      return res;
    }).catch(function () {
      return caches.match('./family-app.html', { ignoreSearch: true });
    }));
  } else {
    // 画像・設定など：控えがあればそれを使い、裏で新しい物に差し替える
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    }));
  }
});

self.addEventListener('push',function(e){
  var p={};
  try{p=e.data?e.data.json():{}}catch(_){try{p={title:'小西家',body:e.data.text()}}catch(__){}}
  var d=(p.data&&typeof p.data==='object')?p.data:(p.notification&&typeof p.notification==='object'?p.notification:p);
  var title=d.title||'🐾 小西家';
  var opts={body:d.body||'',icon:'icon-192.png',badge:'badge-96.png',data:{url:d.url||'./family-app.html'}};
  if(d.tag)opts.tag=d.tag;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
    // アプリを開いて見ているときは、アプリ内のお知らせに任せる
    if(cs.some(function(c){return c.visibilityState==='visible'}))return;
    return self.registration.showNotification(title,opts);
  }));
});

self.addEventListener('notificationclick',function(e){
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)||'./family-app.html';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cs){
    for(var i=0;i<cs.length;i++){if('focus' in cs[i])return cs[i].focus()}
    return self.clients.openWindow(url);
  }));
});

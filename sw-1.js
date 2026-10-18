/* 小西家：通知を受け取るためのファイル（このまま置くだけでOK） */
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(){});

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

'use strict';

const CACHE_NAME='nihility-shell-v1';
const scopeUrl=new URL(self.registration.scope);
const shellUrls=[
  new URL('./',scopeUrl).href,
  new URL('./index.html',scopeUrl).href
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(shellUrls))
      .then(()=>self.skipWaiting())
      .catch(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key.startsWith('nihility-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;

  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;

  if(request.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const response=await fetch(request);
        if(response?.ok){
          const cache=await caches.open(CACHE_NAME);
          void cache.put(new URL('./index.html',scopeUrl).href,response.clone());
        }
        return response;
      }catch{
        const cached=await caches.match(new URL('./index.html',scopeUrl).href);
        if(cached)return cached;
        return caches.match(new URL('./',scopeUrl).href);
      }
    })());
    return;
  }

  event.respondWith((async()=>{
    const cached=await caches.match(request);
    const update=fetch(request).then(async response=>{
      if(response?.ok&&response.type==='basic'){
        const cache=await caches.open(CACHE_NAME);
        await cache.put(request,response.clone());
      }
      return response;
    }).catch(()=>null);

    if(cached){
      event.waitUntil(update);
      return cached;
    }

    const response=await update;
    if(response)return response;
    return new Response('Offline',{status:503,statusText:'Offline'});
  })());
});

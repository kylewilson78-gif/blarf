const C='blarf-v4';
const A=['./','index.html','hark.css','hark-charts.css','hark.js','blarf-p2a.css','blarf-vault.js','blarf-lib.js','blarf-needs.js','blarf-needs.css','blarf-avatar.js','blarf-avatar.css','blarf-avatar3d.mjs'];
/* P3a: pinned three.js / three-vrm modules from jsDelivr, cache-first once fetched (only ever downloaded when 3D is on) */
const CDN='blarf-cdn-v1';
const CDN_OK=/^https:\/\/cdn\.jsdelivr\.net\/npm\/(three@0\.170\.0|@pixiv\/three-vrm@3\.5\.5)\//;
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)).then(()=>self.skipWaiting()).catch(()=>{}))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C&&x!==CDN).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;
if(CDN_OK.test(r.url)){e.respondWith(caches.open(CDN).then(c=>c.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res}))));return}
if(new URL(r.url).origin!==location.origin)return;
e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res}).catch(()=>caches.match(r).then(m=>m||caches.match('index.html'))))});

(()=>{
  'use strict';

  const DB_NAME='nihility-emergency-v1';
  const DB_VERSION=2;
  const SNAPSHOT_STORE='snapshots';
  const QUEUE_STORE='operations';
  const KEY_STORE='keys';
  const SNAPSHOT_FIELDS=[
    'profile','members','fronts','frontMembers','integration','pkConnected','pkImported',
    'groups','memberGroups','memberFieldDefinitions','memberFieldValues','memberTags',
    'memberTagLinks','memberConnections','timelineEvents','timelineHasMore','timelineLoaded',
    'systemProfile','historyHasMore'
  ];

  let dbPromise=null;
  let active=false;
  let reason='';
  let failureTimes=[];
  let retryHandler=null;
  let autoRetryTimer=null;
  let networkBypass=0;
  let currentUserId=null;
  let lastSnapshotAt=null;

  function openDb(){
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,DB_VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains(SNAPSHOT_STORE)){
          db.createObjectStore(SNAPSHOT_STORE,{keyPath:'user_id'});
        }
        if(!db.objectStoreNames.contains(QUEUE_STORE)){
          const store=db.createObjectStore(QUEUE_STORE,{keyPath:'id'});
          store.createIndex('by_user','user_id',{unique:false});
          store.createIndex('by_user_created',['user_id','created_at'],{unique:false});
        }
        if(!db.objectStoreNames.contains(KEY_STORE)){
          db.createObjectStore(KEY_STORE,{keyPath:'id'});
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('Emergency cache unavailable.'));
    });
    return dbPromise;
  }

  async function transaction(storeName,mode,run){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(storeName,mode);
      const store=tx.objectStore(storeName);
      let value;
      try{value=run(store,tx)}catch(error){reject(error);return}
      tx.oncomplete=()=>resolve(value);
      tx.onerror=()=>reject(tx.error||new Error('Emergency cache transaction failed.'));
      tx.onabort=()=>reject(tx.error||new Error('Emergency cache transaction was aborted.'));
    });
  }

  function requestResult(request){
    return new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('Emergency cache request failed.'));
    });
  }


  function bytesToB64(bytes){
    let binary='';
    const array=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    for(let i=0;i<array.length;i++)binary+=String.fromCharCode(array[i]);
    return btoa(binary);
  }
  function b64ToBytes(value){
    const binary=atob(String(value||''));
    const out=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);
    return out;
  }
  async function getCacheKey(userId){
    if(!userId)throw new Error('Emergency cache key requires a user.');
    const db=await openDb();
    const readTx=db.transaction(KEY_STORE,'readonly');
    const existing=await requestResult(readTx.objectStore(KEY_STORE).get(userId));
    if(existing?.key)return existing.key;

    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    await transaction(KEY_STORE,'readwrite',store=>store.put({id:userId,key,created_at:new Date().toISOString()}));
    return key;
  }
  async function encryptValue(userId,value){
    const key=await getCacheKey(userId);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const plaintext=new TextEncoder().encode(JSON.stringify(value));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plaintext);
    return{iv:bytesToB64(iv),ciphertext:bytesToB64(new Uint8Array(ciphertext))};
  }
  async function decryptValue(userId,record){
    if(record?.data!==undefined)return cloneSafe(record.data);
    if(!record?.iv||!record?.ciphertext)return null;
    const key=await getCacheKey(userId);
    const plaintext=await crypto.subtle.decrypt(
      {name:'AES-GCM',iv:b64ToBytes(record.iv)},
      key,
      b64ToBytes(record.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  function cloneSafe(value){
    if(value===undefined)return null;
    return structuredClone(value);
  }

  function scrubMediaUrls(value){
    if(Array.isArray(value))return value.map(scrubMediaUrls);
    if(!value||typeof value!=='object')return value;
    const out={};
    for(const [key,item] of Object.entries(value)){
      if((key==='avatar_url'||key==='banner_url'||key==='avatar_display_url'||key==='banner_display_url'||key==='icon_display_url')&&typeof item==='string'&&item.startsWith('blob:')){
        out[key]=null;
      }else out[key]=scrubMediaUrls(item);
    }
    return out;
  }

  function sanitizeIntegration(value){
    if(!value||typeof value!=='object')return value||null;
    const blocked=/token|secret|password|credential|key_material|cipher|nonce|salt/i;
    return Object.fromEntries(Object.entries(value).filter(([key])=>!blocked.test(key)).map(([key,item])=>[key,scrubMediaUrls(item)]));
  }

  function makeSnapshot(userId,state){
    const data={};
    for(const field of SNAPSHOT_FIELDS){
      if(!(field in state))continue;
      data[field]=field==='integration'?sanitizeIntegration(state[field]):scrubMediaUrls(state[field]);
    }
    return{
      user_id:userId,
      saved_at:new Date().toISOString(),
      version:1,
      data:cloneSafe(data)
    };
  }

  async function captureState(userId,state){
    if(!userId||!state)return null;
    currentUserId=userId;
    const snapshot=makeSnapshot(userId,state);
    const encrypted=await encryptValue(userId,snapshot.data);
    const stored={
      user_id:userId,
      saved_at:snapshot.saved_at,
      version:2,
      iv:encrypted.iv,
      ciphertext:encrypted.ciphertext
    };
    await transaction(SNAPSHOT_STORE,'readwrite',store=>store.put(stored));
    lastSnapshotAt=snapshot.saved_at;
    updateBanner();
    return snapshot;
  }

  async function getSnapshot(userId){
    if(!userId)return null;
    const db=await openDb();
    const tx=db.transaction(SNAPSHOT_STORE,'readonly');
    const stored=await requestResult(tx.objectStore(SNAPSHOT_STORE).get(userId));
    if(!stored)return null;
    const data=await decryptValue(userId,stored);
    if(!data)return null;
    return{user_id:userId,saved_at:stored.saved_at||null,version:stored.version||1,data};
  }

  async function restoreState(userId,state){
    const snapshot=await getSnapshot(userId);
    if(!snapshot?.data)return null;
    currentUserId=userId;
    lastSnapshotAt=snapshot.saved_at||null;
    for(const field of SNAPSHOT_FIELDS){
      if(Object.prototype.hasOwnProperty.call(snapshot.data,field)){
        state[field]=cloneSafe(snapshot.data[field]);
      }
    }
    return snapshot;
  }

  async function deleteSnapshot(userId){
    if(!userId)return;
    await transaction(SNAPSHOT_STORE,'readwrite',store=>store.delete(userId));
    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(QUEUE_STORE,'readwrite');
      const index=tx.objectStore(QUEUE_STORE).index('by_user');
      const request=index.openCursor(IDBKeyRange.only(userId));
      request.onsuccess=()=>{
        const cursor=request.result;
        if(!cursor)return;
        cursor.delete();
        cursor.continue();
      };
      request.onerror=()=>reject(request.error||new Error('Unable to clear queued Emergency Mode changes.'));
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error||new Error('Unable to clear queued Emergency Mode changes.'));
      tx.onabort=()=>reject(tx.error||new Error('Unable to clear queued Emergency Mode changes.'));
    });
    await transaction(KEY_STORE,'readwrite',store=>store.delete(userId));
  }

  async function queueOperation(userId,type,payload){
    if(!userId)throw new Error('Emergency changes require a signed-in account.');
    const encrypted=await encryptValue(userId,cloneSafe(payload));
    const stored={
      id:crypto.randomUUID(),
      user_id:userId,
      type:String(type),
      payload_iv:encrypted.iv,
      payload_ciphertext:encrypted.ciphertext,
      created_at:new Date().toISOString(),
      attempts:0,
      last_error:null
    };
    await transaction(QUEUE_STORE,'readwrite',store=>store.put(stored));
    currentUserId=userId;
    await updateBanner();
    document.dispatchEvent(new CustomEvent('nihility-emergency-queue-change',{detail:{userId}}));
    return{...stored,payload:cloneSafe(payload)};
  }

  async function listOperations(userId=currentUserId){
    if(!userId)return[];
    const db=await openDb();
    const tx=db.transaction(QUEUE_STORE,'readonly');
    const index=tx.objectStore(QUEUE_STORE).index('by_user');
    const rows=await requestResult(index.getAll(userId));
    const result=[];
    for(const row of rows||[]){
      const payload=row.payload!==undefined
        ?cloneSafe(row.payload)
        :await decryptValue(userId,{iv:row.payload_iv,ciphertext:row.payload_ciphertext});
      result.push({...row,payload});
    }
    return result.sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  }

  async function queueCount(userId=currentUserId){
    return (await listOperations(userId)).length;
  }

  async function removeOperation(id){
    if(!id)return;
    await transaction(QUEUE_STORE,'readwrite',store=>store.delete(id));
  }

  async function updateOperation(operation){
    const encrypted=await encryptValue(operation.user_id,operation.payload);
    const stored={...operation,payload_iv:encrypted.iv,payload_ciphertext:encrypted.ciphertext};
    delete stored.payload;
    await transaction(QUEUE_STORE,'readwrite',store=>store.put(stored));
  }

  async function flushQueue(userId,replayer){
    const operations=await listOperations(userId);
    let completed=0;
    for(const operation of operations){
      try{
        await replayer(operation);
        await removeOperation(operation.id);
        completed++;
      }catch(error){
        operation.attempts=Number(operation.attempts||0)+1;
        operation.last_error=String(error?.message||error||'Replay failed').slice(0,500);
        await updateOperation(operation);
        await updateBanner();
        throw error;
      }
    }
    await updateBanner();
    return{completed,remaining:await queueCount(userId)};
  }

  function formatAge(value){
    if(!value)return'No cached snapshot yet';
    const ms=Math.max(0,Date.now()-new Date(value).getTime());
    const min=Math.floor(ms/60000);
    if(min<1)return'Synced less than a minute ago';
    if(min<60)return'Synced '+min+'m ago';
    const hours=Math.floor(min/60);
    if(hours<24)return'Synced '+hours+'h ago';
    return'Synced '+Math.floor(hours/24)+'d ago';
  }

  function ensureBanner(){
    let banner=document.querySelector('#emergencyModeBanner');
    if(banner)return banner;
    banner=document.createElement('aside');
    banner.id='emergencyModeBanner';
    banner.className='emergency-mode-banner';
    banner.hidden=true;
    banner.setAttribute('role','status');
    banner.setAttribute('aria-live','polite');
    banner.innerHTML=`
      <div class="emergency-mode-icon" aria-hidden="true">!</div>
      <div class="emergency-mode-copy">
        <strong>Emergency mode</strong>
        <span id="emergencyModeText">Using cached Nihility data.</span>
        <small id="emergencyModeMeta"></small>
      </div>
      <span id="emergencyQueueBadge" class="emergency-queue-badge" hidden></span>
      <button id="emergencyRetryButton" class="secondary-button emergency-retry-button" type="button">Retry</button>
    `;
    document.body.append(banner);
    banner.querySelector('#emergencyRetryButton').onclick=()=>{void retryNow()};
    return banner;
  }

  async function updateBanner(){
    const banner=ensureBanner();
    banner.hidden=!active;
    document.documentElement.classList.toggle('nihility-emergency-active',active);
    if(!active)return;
    const count=await queueCount().catch(()=>0);
    const text=banner.querySelector('#emergencyModeText');
    const meta=banner.querySelector('#emergencyModeMeta');
    const badge=banner.querySelector('#emergencyQueueBadge');
    text.textContent=reason||'Supabase is temporarily unavailable. Showing your last cached data.';
    meta.textContent=formatAge(lastSnapshotAt)+(count?' · Queued front changes will sync after recovery.':' · Browsing cached data.');
    badge.hidden=count===0;
    badge.textContent=count===1?'1 front queued':count+' fronts queued';
  }

  function startAutoRetry(){
    clearInterval(autoRetryTimer);
    autoRetryTimer=setInterval(()=>{
      if(active&&navigator.onLine&&retryHandler)void retryHandler({automatic:true});
    },30000);
  }

  function enter(message='Supabase is temporarily unavailable. Showing your last cached data.'){
    reason=String(message||'').trim()||'Supabase is temporarily unavailable. Showing your last cached data.';
    if(!active){
      active=true;
      document.dispatchEvent(new CustomEvent('nihility-emergency-enter',{detail:{reason}}));
    }
    startAutoRetry();
    void updateBanner();
  }

  function exit(message='Supabase connection restored.'){
    const wasActive=active;
    active=false;
    reason='';
    failureTimes=[];
    clearInterval(autoRetryTimer);
    autoRetryTimer=null;
    void updateBanner();
    if(wasActive){
      document.dispatchEvent(new CustomEvent('nihility-emergency-exit',{detail:{message}}));
      if(typeof window.toast==='function')window.toast('Emergency mode ended',message);
    }
  }

  function noteFailure(details={}){
    const status=Number(details.status||0);
    if(status&&status<500)return;
    const now=Date.now();
    failureTimes=failureTimes.filter(time=>now-time<30000);
    failureTimes.push(now);
    if(navigator.onLine===false||failureTimes.length>=2){
      enter(navigator.onLine===false
        ?'You appear to be offline. Showing cached Nihility data.'
        :'Supabase is not responding reliably. Showing cached Nihility data.');
    }
  }

  function noteSuccess(){
    const now=Date.now();
    failureTimes=failureTimes.filter(time=>now-time<30000);
  }

  function isActive(){return active}
  function canUseNetwork(){return !active||networkBypass>0}
  async function withNetworkAccess(callback){
    networkBypass++;
    try{return await callback()}
    finally{networkBypass=Math.max(0,networkBypass-1)}
  }

  function setRetryHandler(handler){
    retryHandler=typeof handler==='function'?handler:null;
  }

  async function retryNow(){
    if(!retryHandler||!navigator.onLine)return;
    const button=ensureBanner().querySelector('#emergencyRetryButton');
    if(button){button.disabled=true;button.textContent='Checking...'}
    try{await retryHandler({automatic:false})}
    finally{if(button){button.disabled=false;button.textContent='Retry'}}
  }

  function setCurrentUser(userId){
    currentUserId=userId||null;
    if(userId)void getSnapshot(userId).then(snapshot=>{lastSnapshotAt=snapshot?.saved_at||null;void updateBanner()});
  }

  async function registerServiceWorker(){
    if(!('serviceWorker' in navigator)||location.protocol!=='https:')return;
    try{
      await navigator.serviceWorker.register(new URL('./sw.js',document.baseURI),{scope:'./'});
    }catch(error){
      console.warn('Emergency app-shell cache could not start',error);
    }
  }

  window.addEventListener('offline',()=>enter('You appear to be offline. Showing cached Nihility data.'));
  window.addEventListener('online',()=>{if(active&&retryHandler)void retryHandler({automatic:true})});

  window.nihilityEmergency={
    captureState,
    restoreState,
    getSnapshot,
    deleteSnapshot,
    queueOperation,
    listOperations,
    queueCount,
    flushQueue,
    enter,
    exit,
    noteFailure,
    noteSuccess,
    isActive,
    canUseNetwork,
    withNetworkAccess,
    setRetryHandler,
    setCurrentUser,
    updateBanner,
    registerServiceWorker
  };

  void registerServiceWorker();
})();
'use strict';
(function(){
  const cfg=window.NIHILITY_CONFIG||{};
  const SESSION_KEY='nihility_supabase_session';
  const PKCE_KEY='nihility_auth_pkce_v1';
  const BUCKETS={avatar:'nihility-avatars',banner:'nihility-banners',profile:'nihility-profile-avatars'};
  const configured=()=>Boolean(cfg.SUPABASE_URL&&cfg.SUPABASE_ANON_KEY);
  const getSession=()=>{try{return JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null')}catch{return null}};
  const saveSession=s=>s?sessionStorage.setItem(SESSION_KEY,JSON.stringify(s)):sessionStorage.removeItem(SESSION_KEY);

  function decodeJwtPayload(token){
    try{
      const part=String(token||'').split('.')[1];
      if(!part)return null;
      const normalized=part.replace(/-/g,'+').replace(/_/g,'/');
      const padded=normalized+'='.repeat((4-normalized.length%4)%4);
      return JSON.parse(atob(padded));
    }catch{return null}
  }
  function cachedSessionUser(session=getSession()){
    if(!session?.access_token)return null;
    if(session.expires_at&&Number(session.expires_at)<=Date.now())return null;
    const payload=decodeJwtPayload(session.access_token);
    if(!payload?.sub)return null;
    return{
      id:payload.sub,
      email:payload.email||null,
      aud:payload.aud||'authenticated',
      role:payload.role||'authenticated',
      app_metadata:payload.app_metadata||{},
      user_metadata:payload.user_metadata||{},
      __emergency_cached_identity:true
    };
  }
  function emergencyBlocksNetwork(){
    return Boolean(window.nihilityEmergency?.isActive?.()&&!window.nihilityEmergency?.canUseNetwork?.());
  }
  function serviceError(message,status=0,cause=null){
    const error=new Error(message);
    error.status=Number(status||0);
    if(cause)error.cause=cause;
    return error;
  }
  function reportFailure(error,path,status=0){
    const code=Number(status||error?.status||0);
    if(code===0||code>=500){
      window.nihilityEmergency?.noteFailure?.({status:code,path,message:error?.message||String(error)});
    }
  }
  function reportSuccess(){
    window.nihilityEmergency?.noteSuccess?.();
  }

  async function raw(path,options={}){
    const {timeoutMs=0,...requestOptions}=options;
    if(emergencyBlocksNetwork())throw serviceError('Emergency mode is using cached data. Retry when Supabase is available.',0);

    const session=getSession(),headers={apikey:cfg.SUPABASE_ANON_KEY,...(requestOptions.headers||{})};
    if(session?.access_token)headers.Authorization='Bearer '+session.access_token;
    if(requestOptions.body!==undefined&&requestOptions.body!==null&&typeof requestOptions.body!=='string'&&!(requestOptions.body instanceof Blob))headers['Content-Type']='application/json';

    let controller=null,timer=null;
    if(timeoutMs>0&&!requestOptions.signal){
      controller=new AbortController();
      requestOptions.signal=controller.signal;
      timer=setTimeout(()=>controller.abort(),timeoutMs);
    }

    try{
      const response=await fetch(cfg.SUPABASE_URL+path,{
        ...requestOptions,
        headers,
        body:requestOptions.body!==undefined&&requestOptions.body!==null&&typeof requestOptions.body!=='string'&&!(requestOptions.body instanceof Blob)
          ?JSON.stringify(requestOptions.body)
          :requestOptions.body
      });
      const text=await response.text();let data=null;try{data=text?JSON.parse(text):null}catch{data=text}
      if(!response.ok){
        throw serviceError(data?.message||data?.msg||data?.error_description||data?.error||response.statusText,response.status);
      }
      reportSuccess();
      return data;
    }catch(error){
      if(error?.name==='AbortError'){
        const timed=serviceError('The data service took too long to respond.',0,error);
        reportFailure(timed,path,0);
        throw timed;
      }
      reportFailure(error,path,error?.status||0);
      throw error;
    }finally{
      if(timer)clearTimeout(timer);
    }
  }
  function base64url(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
  async function beginPkceFlow(kind){
    const verifier=base64url(crypto.getRandomValues(new Uint8Array(48)));
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
    const challenge=base64url(new Uint8Array(digest));
    localStorage.setItem(PKCE_KEY,JSON.stringify({verifier,kind,createdAt:Date.now()}));
    return challenge;
  }
  function clearPkceFlow(){localStorage.removeItem(PKCE_KEY)}
  function getPkceFlow(){
    try{
      const flow=JSON.parse(localStorage.getItem(PKCE_KEY)||'null');
      if(!flow?.verifier||!flow?.createdAt||Date.now()-Number(flow.createdAt)>20*60*1000){clearPkceFlow();return null}
      return flow;
    }catch{clearPkceFlow();return null}
  }
  async function sendMagicLink(email){
    const challenge=await beginPkceFlow('magiclink');
    const redirect=location.origin+location.pathname;
    try{
      return await raw('/auth/v1/otp?redirect_to='+encodeURIComponent(redirect),{
        method:'POST',
        body:{email,create_user:true,code_challenge:challenge,code_challenge_method:'s256'}
      });
    }catch(error){clearPkceFlow();throw error}
  }
  async function sendPasswordReset(email){
    const challenge=await beginPkceFlow('recovery');
    const redirect=location.origin+location.pathname+'?reset=1';
    try{
      return await raw('/auth/v1/recover?redirect_to='+encodeURIComponent(redirect),{
        method:'POST',
        body:{email,code_challenge:challenge,code_challenge_method:'s256'}
      });
    }catch(error){clearPkceFlow();throw error}
  }
  async function signInWithPassword(email,password){
    const data=await raw('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});
    const s={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Date.now()+Number(data.expires_in||3600)*1000};
    saveSession(s);clearPkceFlow();return data.user||null;
  }
  async function setPassword(password){return raw('/auth/v1/user',{method:'PUT',body:{password}})}
  async function signOut(scope='local'){
    const session=getSession();
    try{
      if(session?.access_token){
        await fetch(cfg.SUPABASE_URL+'/auth/v1/logout?scope='+encodeURIComponent(scope),{
          method:'POST',
          headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:'Bearer '+session.access_token}
        });
      }
    }finally{
      clearPkceFlow();
      saveSession(null);
    }
  }
  async function readSessionFromUrl(){
    const url=new URL(location.href);
    const legacy=new URLSearchParams(location.hash.replace(/^#/,''));
    if(legacy.has('access_token')||legacy.has('refresh_token')){
      history.replaceState(null,'',url.pathname+url.search);
      throw new Error('This sign-in link used the retired login format. Request a new magic link or password-reset email.');
    }
    const code=url.searchParams.get('code');
    if(!code)return null;
    const flow=getPkceFlow();
    if(!flow)throw new Error('This secure sign-in link must be opened in the same browser where it was requested. Request a new link.');
    const data=await raw('/auth/v1/token?grant_type=pkce',{
      method:'POST',
      body:{auth_code:code,code_verifier:flow.verifier}
    });
    const s={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Date.now()+Number(data.expires_in||3600)*1000};
    saveSession(s);clearPkceFlow();
    url.searchParams.delete('code');
    url.searchParams.delete('error');
    url.searchParams.delete('error_code');
    url.searchParams.delete('error_description');
    history.replaceState(null,'',url.pathname+(url.searchParams.toString()?'?'+url.searchParams.toString():''));
    return s;
  }
  async function refresh(){
    let s=getSession();if(!s)return null;
    if(!s.expires_at||s.expires_at-Date.now()>60000)return s;
    if(!s.refresh_token)return s.expires_at&&s.expires_at>Date.now()?s:null;
    if(emergencyBlocksNetwork())return s.expires_at&&s.expires_at>Date.now()?s:null;
    try{
      const r=await fetch(cfg.SUPABASE_URL+'/auth/v1/token?grant_type=refresh_token',{
        method:'POST',
        headers:{apikey:cfg.SUPABASE_ANON_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:s.refresh_token})
      });
      if(!r.ok){
        if(r.status>=500){
          const error=serviceError('Session refresh service is unavailable.',r.status);
          reportFailure(error,'/auth/v1/token',r.status);
          return s.expires_at&&s.expires_at>Date.now()?s:null;
        }
        saveSession(null);return null;
      }
      reportSuccess();
      const d=await r.json();
      s={access_token:d.access_token,refresh_token:d.refresh_token||s.refresh_token,expires_at:Date.now()+Number(d.expires_in||3600)*1000};
      saveSession(s);return s;
    }catch(error){
      reportFailure(error,'/auth/v1/token',0);
      return s.expires_at&&s.expires_at>Date.now()?s:null;
    }
  }
  async function user(){
    const s=await refresh();if(!s)return null;
    const cached=cachedSessionUser(s);
    if(emergencyBlocksNetwork())return cached;
    try{return await raw('/auth/v1/user')}
    catch(error){
      if((Number(error?.status||0)===0||Number(error?.status||0)>=500)&&cached)return cached;
      if(Number(error?.status||0)===401||Number(error?.status||0)===403)saveSession(null);
      return null;
    }
  }
  async function rest(table,{method='GET',query='',body=null,prefer='',timeoutMs=0}={}){const headers={};if(prefer)headers.Prefer=prefer;return raw('/rest/v1/'+table+(query?'?'+query:''),{method,headers,body,timeoutMs})}
  async function rpc(name,body={}){return raw('/rest/v1/rpc/'+encodeURIComponent(name),{method:'POST',body})}
  function encPath(path){return String(path).split('/').map(encodeURIComponent).join('/')}
  async function upload(kind,file){
    if(emergencyBlocksNetwork())throw new Error('Media uploads are unavailable in Emergency Mode. Your cached data is still safe.');
    if(!BUCKETS[kind])throw new Error('Unknown media type.');
    const s=await refresh();if(!s?.access_token)throw new Error('You are signed out.');
    const r=await fetch(cfg.SUPABASE_URL+'/functions/v1/nihility-secure',{
      method:'POST',
      headers:{
        apikey:cfg.SUPABASE_ANON_KEY,
        Authorization:'Bearer '+s.access_token,
        'Content-Type':file.type,
        'x-nihility-action':'upload_media',
        'x-media-kind':kind
      },
      body:file
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data?.error||'Upload failed.');
    if(!data?.path)throw new Error('Upload did not return a storage path.');
    return{path:data.path,url:await privateMediaUrl(kind,data.path),source:'supabase'}
  }
  async function uploadPkSystemMedia(kind,file){
    if(emergencyBlocksNetwork())throw new Error('PluralKit media uploads are unavailable in Emergency Mode.');
    if(!['avatar','banner'].includes(kind))throw new Error('Unknown system media type.');
    if(!(file instanceof Blob)||!file.type.startsWith('image/'))throw new Error('Choose a valid image first.');
    const s=await refresh();if(!s?.access_token)throw new Error('You are signed out.');
    const r=await fetch(cfg.SUPABASE_URL+'/functions/v1/nihility-secure',{
      method:'POST',
      headers:{
        apikey:cfg.SUPABASE_ANON_KEY,
        Authorization:'Bearer '+s.access_token,
        'Content-Type':file.type,
        'x-nihility-action':'upload_pk_system_media',
        'x-media-kind':kind
      },
      body:file
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data?.error||'System image upload failed.');
    if(!data?.path)throw new Error('System image upload did not return a storage path.');
    return{path:data.path};
  }
  const privateMediaCache=new Map();
  async function privateMediaBlob(kind,path){
    if(emergencyBlocksNetwork())throw new Error('Private media is temporarily unavailable in Emergency Mode.');
    if(!path)throw new Error('Media path is required.');
    const bucket=BUCKETS[kind];if(!bucket)throw new Error('Unknown media type.');
    const s=await refresh();if(!s?.access_token)throw new Error('You are signed out.');
    const response=await fetch(
      cfg.SUPABASE_URL+'/storage/v1/object/authenticated/'+encodeURIComponent(bucket)+'/'+encPath(path),
      {headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:'Bearer '+s.access_token}}
    );
    if(!response.ok)throw new Error('Unable to load private media.');
    return response.blob();
  }
  async function privateMediaUrl(kind,path){
    if(!path)return null;
    const bucket=BUCKETS[kind];if(!bucket)throw new Error('Unknown media type.');
    const cacheKey=bucket+':'+path;
    if(privateMediaCache.has(cacheKey))return privateMediaCache.get(cacheKey);
    const blob=await privateMediaBlob(kind,path);
    const objectUrl=URL.createObjectURL(blob);
    privateMediaCache.set(cacheKey,objectUrl);
    return objectUrl;
  }
  async function deleteMedia(kind,path){if(!path)return;const bucket=BUCKETS[kind];if(!bucket)return;const cacheKey=bucket+':'+path;const cached=privateMediaCache.get(cacheKey);if(cached){URL.revokeObjectURL(cached);privateMediaCache.delete(cacheKey)}const s=await refresh();if(!s?.access_token)return;const r=await fetch(cfg.SUPABASE_URL+'/storage/v1/object/'+encodeURIComponent(bucket)+'/'+encPath(path),{method:'DELETE',headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:'Bearer '+s.access_token}});if(!r.ok&&r.status!==404)throw new Error('Unable to delete stored media.')}
  async function sha1Hex(value){
    const bytes=new TextEncoder().encode(value);
    const digest=await crypto.subtle.digest('SHA-1',bytes);
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  async function checkPwnedPassword(password){
    if(typeof password!=='string'||!password)throw new Error('Password is required.');
    const hash=await sha1Hex(password);
    const prefix=hash.slice(0,5);
    const suffix=hash.slice(5);
    const result=await secure('password_range',{prefix});
    const lines=String(result?.range||'').split(/\r?\n/);
    for(const line of lines){
      const separator=line.indexOf(':');
      if(separator<0)continue;
      const candidate=line.slice(0,separator).trim().toUpperCase();
      if(candidate!==suffix)continue;
      const count=Number(line.slice(separator+1).trim())||0;
      return{pwned:count>0,count};
    }
    return{pwned:false,count:0};
  }

  async function secure(action,payload={}){
    if(emergencyBlocksNetwork())throw new Error('This server action is unavailable in Emergency Mode.');
    const s=await refresh();
    if(!s?.access_token)throw new Error('You are signed out.');
    const headers={
      apikey:cfg.SUPABASE_ANON_KEY,
      Authorization:'Bearer '+s.access_token,
      'Content-Type':'application/json'
    };
    if(action==='journal_save')headers['x-nihility-action']='journal_save';
    const r=await fetch(cfg.SUPABASE_URL+'/functions/v1/nihility-secure',{
      method:'POST',
      headers,
      body:JSON.stringify(action==='journal_save'?payload:{action,...payload})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data?.error||data?.message||'Secure request failed.');
    return data;
  }

  async function secureBackup(action,backup,extra={}){
    if(!['backup_preview','backup_restore'].includes(action))throw new Error('Invalid backup action.');
    const s=await refresh();
    if(!s?.access_token)throw new Error('You are signed out.');
    const source=new TextEncoder().encode(JSON.stringify({backup,...extra}));
    let body=new Blob([source],{type:'application/json'});
    let contentType='application/json';
    if('CompressionStream' in window){
      try{
        const stream=new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
        body=await new Response(stream).blob();
        contentType='application/gzip';
      }catch(error){
        console.warn('Backup request compression unavailable; sending JSON.',error);
      }
    }
    const r=await fetch(cfg.SUPABASE_URL+'/functions/v1/nihility-secure',{
      method:'POST',
      headers:{
        apikey:cfg.SUPABASE_ANON_KEY,
        Authorization:'Bearer '+s.access_token,
        'Content-Type':contentType,
        'x-nihility-action':action
      },
      body
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data?.error||data?.message||'Backup request failed.');
    return data;
  }

  window.nihilityApi={configured,getSession,saveSession,cachedSessionUser,sendMagicLink,sendPasswordReset,signInWithPassword,setPassword,signOut,checkPwnedPassword,readSessionFromUrl,refresh,user,rest,rpc,upload,uploadPkSystemMedia,privateMediaBlob,privateMediaUrl,deleteMedia,secure,secureBackup};
})();
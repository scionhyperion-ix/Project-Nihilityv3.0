'use strict';
(function(){
  const cfg=window.NIHILITY_CONFIG||{};
  const SESSION_KEY='nihility_supabase_session',PK_LOCAL='nihility_pk_token',PK_SESSION='nihility_pk_token_session';
  const BUCKETS={avatar:'nihility-avatars',banner:'nihility-banners',profile:'nihility-profile-avatars'};
  const configured=()=>Boolean(cfg.SUPABASE_URL&&cfg.SUPABASE_ANON_KEY);
  const getSession=()=>{try{return JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null')}catch{return null}};
  const saveSession=s=>s?sessionStorage.setItem(SESSION_KEY,JSON.stringify(s)):sessionStorage.removeItem(SESSION_KEY);
  async function raw(path,options={}){
    const session=getSession(),headers={apikey:cfg.SUPABASE_ANON_KEY,...(options.headers||{})};
    if(session?.access_token)headers.Authorization='Bearer '+session.access_token;
    if(options.body!==undefined&&options.body!==null&&typeof options.body!=='string'&&!(options.body instanceof Blob))headers['Content-Type']='application/json';
    const response=await fetch(cfg.SUPABASE_URL+path,{...options,headers,body:options.body!==undefined&&options.body!==null&&typeof options.body!=='string'&&!(options.body instanceof Blob)?JSON.stringify(options.body):options.body});
    const text=await response.text();let data=null;try{data=text?JSON.parse(text):null}catch{data=text}
    if(!response.ok)throw new Error(data?.message||data?.msg||data?.error_description||data?.error||response.statusText);return data;
  }
  async function sendMagicLink(email){const redirect=location.origin+location.pathname;return raw('/auth/v1/otp?redirect_to='+encodeURIComponent(redirect),{method:'POST',body:{email,create_user:true}})}
  function readSessionFromUrl(){const p=new URLSearchParams(location.hash.replace(/^#/,'')),access_token=p.get('access_token');if(!access_token)return null;const s={access_token,refresh_token:p.get('refresh_token'),expires_at:Date.now()+Number(p.get('expires_in')||3600)*1000};saveSession(s);history.replaceState(null,'',location.pathname+location.search);return s}
  async function refresh(){let s=getSession();if(!s)return null;if(!s.expires_at||s.expires_at-Date.now()>60000)return s;if(!s.refresh_token)return s;const r=await fetch(cfg.SUPABASE_URL+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:cfg.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:s.refresh_token})});if(!r.ok){saveSession(null);return null}const d=await r.json();s={access_token:d.access_token,refresh_token:d.refresh_token||s.refresh_token,expires_at:Date.now()+Number(d.expires_in||3600)*1000};saveSession(s);return s}
  async function user(){const s=await refresh();if(!s)return null;try{return await raw('/auth/v1/user')}catch{saveSession(null);return null}}
  async function rest(table,{method='GET',query='',body=null,prefer=''}={}){const headers={};if(prefer)headers.Prefer=prefer;return raw('/rest/v1/'+table+(query?'?'+query:''),{method,headers,body})}
  async function rpc(name,body={}){return raw('/rest/v1/rpc/'+encodeURIComponent(name),{method:'POST',body})}
  function extFor(file){return({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'})[file.type]||'bin'}
  function encPath(path){return String(path).split('/').map(encodeURIComponent).join('/')}
  async function upload(kind,file){const bucket=BUCKETS[kind];if(!bucket)throw new Error('Unknown media type.');const s=await refresh();if(!s?.access_token)throw new Error('You are signed out.');const u=await user();if(!u?.id)throw new Error('Unable to resolve your account.');const path=u.id+'/'+crypto.randomUUID()+'.'+extFor(file);const r=await fetch(cfg.SUPABASE_URL+'/storage/v1/object/'+encodeURIComponent(bucket)+'/'+encPath(path),{method:'POST',headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:'Bearer '+s.access_token,'Content-Type':file.type,'x-upsert':'false'},body:file});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d?.message||d?.error||'Upload failed.');return{path,url:await privateMediaUrl(kind,path),source:'supabase'}}
  async function privateMediaUrl(kind,path){
    if(!path)return null;
    const bucket=BUCKETS[kind];if(!bucket)throw new Error('Unknown media type.');
    const s=await refresh();if(!s?.access_token)throw new Error('You are signed out.');
    const response=await fetch(
      cfg.SUPABASE_URL+'/storage/v1/object/authenticated/'+encodeURIComponent(bucket)+'/'+encPath(path),
      {headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:'Bearer '+s.access_token}}
    );
    if(!response.ok)throw new Error('Unable to load private media.');
    const blob=await response.blob();
    return URL.createObjectURL(blob);
  }
  async function deleteMedia(kind,path){if(!path)return;const bucket=BUCKETS[kind];if(!bucket)return;const s=await refresh();if(!s?.access_token)return;const r=await fetch(cfg.SUPABASE_URL+'/storage/v1/object/'+encodeURIComponent(bucket)+'/'+encPath(path),{method:'DELETE',headers:{apikey:cfg.SUPABASE_ANON_KEY,Authorization:'Bearer '+s.access_token}});if(!r.ok&&r.status!==404)throw new Error('Unable to delete stored media.')}
  function getPkToken(){return localStorage.getItem(PK_LOCAL)||sessionStorage.getItem(PK_SESSION)||''}
  function savePkToken(token,persistent){localStorage.removeItem(PK_LOCAL);sessionStorage.removeItem(PK_SESSION);if(persistent)localStorage.setItem(PK_LOCAL,token);else sessionStorage.setItem(PK_SESSION,token)}
  function clearPkToken(){localStorage.removeItem(PK_LOCAL);sessionStorage.removeItem(PK_SESSION)}
  async function pk(path,{method='GET',body}={}){const token=getPkToken();if(!token)throw new Error('PluralKit is not connected on this device.');const r=await fetch('https://api.pluralkit.me/v2'+path,{method,headers:{Authorization:token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data=null;try{data=text?JSON.parse(text):null}catch{data=text}if(!r.ok)throw new Error(data?.message||data?.error||'PluralKit request failed.');return data}
  window.nihilityApi={configured,getSession,saveSession,sendMagicLink,readSessionFromUrl,refresh,user,rest,rpc,upload,privateMediaUrl,deleteMedia,getPkToken,savePkToken,clearPkToken,pk};
})();
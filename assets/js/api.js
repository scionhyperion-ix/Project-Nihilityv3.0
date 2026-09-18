'use strict';
(function(){
  const cfg=window.NIHILITY_CONFIG||{};
  const KEY='nihility_supabase_session';
  const configured=()=>Boolean(cfg.SUPABASE_URL&&cfg.SUPABASE_ANON_KEY);
  const getSession=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch{return null}};
  const saveSession=s=>s?localStorage.setItem(KEY,JSON.stringify(s)):localStorage.removeItem(KEY);
  async function raw(path,options={}){
    const session=getSession();
    const headers={apikey:cfg.SUPABASE_ANON_KEY,...(options.headers||{})};
    if(session?.access_token)headers.Authorization='Bearer '+session.access_token;
    if(options.body&&typeof options.body!=='string'&&!(options.body instanceof Blob))headers['Content-Type']='application/json';
    const response=await fetch(cfg.SUPABASE_URL+path,{...options,headers,body:options.body&&typeof options.body!=='string'&&!(options.body instanceof Blob)?JSON.stringify(options.body):options.body});
    const text=await response.text();
    let data=null;try{data=text?JSON.parse(text):null}catch{data=text}
    if(!response.ok)throw new Error(data?.msg||data?.message||data?.error_description||data?.error||response.statusText);
    return data;
  }
  async function sendMagicLink(email){
    const redirect=location.origin+location.pathname;
    return raw('/auth/v1/otp?redirect_to='+encodeURIComponent(redirect),{method:'POST',body:{email,create_user:true}});
  }
  function readSessionFromUrl(){
    const p=new URLSearchParams(location.hash.replace(/^#/,''));
    const access_token=p.get('access_token');
    if(!access_token)return null;
    const s={access_token,refresh_token:p.get('refresh_token'),expires_at:Date.now()+Number(p.get('expires_in')||3600)*1000};
    saveSession(s);history.replaceState(null,'',location.pathname+location.search);return s;
  }
  async function refresh(){
    let s=getSession();if(!s)return null;
    if(!s.expires_at||s.expires_at-Date.now()>60000)return s;
    if(!s.refresh_token)return s;
    const r=await fetch(cfg.SUPABASE_URL+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:cfg.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:s.refresh_token})});
    if(!r.ok){saveSession(null);return null}
    const d=await r.json();s={access_token:d.access_token,refresh_token:d.refresh_token||s.refresh_token,expires_at:Date.now()+Number(d.expires_in||3600)*1000};saveSession(s);return s;
  }
  async function user(){const s=await refresh();if(!s)return null;try{return await raw('/auth/v1/user')}catch{saveSession(null);return null}}
  async function rest(table,{method='GET',query='',body=null,prefer=''}={}){
    const headers={};if(prefer)headers.Prefer=prefer;
    return raw('/rest/v1/'+table+(query?'?'+query:''),{method,headers,body});
  }
  async function upload(kind,file){
    if(!cfg.R2_WORKER_URL)throw new Error('R2 upload worker is not configured.');
    const s=await refresh();if(!s?.access_token)throw new Error('You are signed out.');
    const r=await fetch(cfg.R2_WORKER_URL.replace(/\/$/,'')+'/media/'+kind,{method:'PUT',headers:{Authorization:'Bearer '+s.access_token,'Content-Type':file.type,'X-File-Name':file.name},body:file});
    const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Upload failed.');return d;
  }
  window.nihilityApi={configured,getSession,saveSession,sendMagicLink,readSessionFromUrl,refresh,user,rest,upload};
})();
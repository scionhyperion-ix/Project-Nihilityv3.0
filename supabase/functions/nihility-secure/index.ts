import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGIN = "https://scionhyperion-ix.github.io";
const PK_BASE = "https://api.pluralkit.me/v2";
const MIME_EXT: Record<string,string> = {
  "image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif"
};
const BUCKETS: Record<string,{name:string,max:number}> = {
  avatar:{name:"nihility-avatars",max:2*1024*1024},
  banner:{name:"nihility-banners",max:5*1024*1024},
  profile:{name:"nihility-profile-avatars",max:2*1024*1024},
};

function cors(origin:string|null){
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };
}
function json(data:unknown,status=200,origin:string|null=null){
  return new Response(JSON.stringify(data),{status,headers:cors(origin)});
}
function b64(bytes:Uint8Array){
  let s=""; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s);
}
function unb64(s:string){
  const bin=atob(s); const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i); return out;
}
async function key(){
  const material=new TextEncoder().encode("nihility-pk-token-v1\n"+SERVICE_KEY);
  const digest=await crypto.subtle.digest("SHA-256",material);
  return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptToken(token:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},await key(),new TextEncoder().encode(token));
  return {ciphertext:b64(new Uint8Array(cipher)),iv:b64(iv)};
}
async function decryptToken(ciphertext:string,iv:string){
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(iv)},await key(),unb64(ciphertext));
  return new TextDecoder().decode(plain);
}
async function admin(path:string,init:RequestInit={}){
  const headers=new Headers(init.headers||{});
  headers.set("apikey",SERVICE_KEY);
  headers.set("Authorization","Bearer "+SERVICE_KEY);
  if(init.body && !headers.has("Content-Type"))headers.set("Content-Type","application/json");
  const r=await fetch(SUPABASE_URL+path,{...init,headers});
  const text=await r.text();
  let data:any=null; try{data=text?JSON.parse(text):null}catch{data=text}
  if(!r.ok)throw new Error(data?.message||data?.error||r.statusText);
  return data;
}
async function currentUser(req:Request){
  const auth=req.headers.get("Authorization")||"";
  if(!auth.startsWith("Bearer "))throw new Error("Authentication required");
  const r=await fetch(SUPABASE_URL+"/auth/v1/user",{headers:{apikey:SERVICE_KEY,Authorization:auth}});
  if(!r.ok)throw new Error("Invalid or expired session");
  return await r.json();
}
async function getSecret(userId:string){
  const rows=await admin("/rest/v1/integration_secrets?user_id=eq."+encodeURIComponent(userId)+"&provider=eq.pluralkit&select=ciphertext,iv&limit=1");
  if(!rows?.[0])throw new Error("PluralKit is not connected");
  return decryptToken(rows[0].ciphertext,rows[0].iv);
}
async function pk(token:string,path:string,init:RequestInit={}){
  const headers=new Headers(init.headers||{});
  headers.set("Authorization",token);
  if(init.body)headers.set("Content-Type","application/json");
  const r=await fetch(PK_BASE+path,{...init,headers,signal:AbortSignal.timeout(15000)});
  const text=await r.text();
  let data:any=null; try{data=text?JSON.parse(text):null}catch{data=text}
  if(!r.ok)throw new Error(data?.message||data?.error||("PluralKit error "+r.status));
  return data;
}

function privateIPv4(ip:string){
  const p=ip.split(".").map(Number);
  if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return true;
  const [a,b]=p;
  return a===0||a===10||a===127||a>=224||
    (a===100&&b>=64&&b<=127)||(a===169&&b===254)||
    (a===172&&b>=16&&b<=31)||(a===192&&b===168)||
    (a===192&&b===0)||(a===198&&(b===18||b===19));
}
function privateIPv6(ip:string){
  const v=ip.toLowerCase().replace(/^\[|\]$/g,"");
  if(v==="::"||v==="::1")return true;
  if(v.startsWith("fc")||v.startsWith("fd"))return true;
  if(/^fe[89ab]/.test(v))return true;
  if(v.startsWith("ff"))return true;
  if(v.startsWith("::ffff:")){
    const tail=v.slice(7);
    if(/^\d+\.\d+\.\d+\.\d+$/.test(tail))return privateIPv4(tail);
  }
  return false;
}
function literalIp(host:string){
  const h=host.replace(/^\[|\]$/g,"");
  if(/^\d+\.\d+\.\d+\.\d+$/.test(h))return true;
  return h.includes(":");
}
async function validateHost(u:URL){
  if(u.protocol!=="https:")throw new Error("Only HTTPS image URLs are allowed");
  if(u.username||u.password)throw new Error("Credentials in image URLs are not allowed");
  const host=u.hostname.toLowerCase().replace(/\.$/,"").replace(/^\[|\]$/g,"");
  if(host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local")||host.endsWith(".internal"))throw new Error("Local network URLs are not allowed");
  if(literalIp(host)){
    if(host.includes(":")?privateIPv6(host):privateIPv4(host))throw new Error("Private or reserved IP image URLs are not allowed");
  }else{
    const a=await Deno.resolveDns(host,"A").catch(()=>[]);
    const aaaa=await Deno.resolveDns(host,"AAAA").catch(()=>[]);
    if(!a.length&&!aaaa.length)throw new Error("Image host could not be resolved");
    if(a.some(privateIPv4)||aaaa.some(privateIPv6))throw new Error("Private or reserved image hosts are not allowed");
  }
}
async function safeImage(url:string,kind:string){
  const cfg=BUCKETS[kind]; if(!cfg)throw new Error("Invalid media kind");
  let current=new URL(url);
  for(let redirects=0;redirects<4;redirects++){
    await validateHost(current);
    const r=await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(12000),headers:{"User-Agent":"Project-Nihility-Media-Importer/1.0","Accept":"image/png,image/jpeg,image/webp,image/gif"}});
    if([301,302,303,307,308].includes(r.status)){
      const loc=r.headers.get("location"); if(!loc)throw new Error("Invalid image redirect");
      current=new URL(loc,current); continue;
    }
    if(!r.ok)throw new Error("Unable to fetch image");
    const type=(r.headers.get("content-type")||"").split(";")[0].toLowerCase();
    if(!MIME_EXT[type])throw new Error("Unsupported image type");
    const declared=Number(r.headers.get("content-length")||0);
    if(declared>cfg.max)throw new Error("Image exceeds the allowed size");
    const reader=r.body?.getReader(); if(!reader)throw new Error("Empty image response");
    const chunks:Uint8Array[]=[]; let total=0;
    while(true){
      const {done,value}=await reader.read(); if(done)break;
      if(value){total+=value.length;if(total>cfg.max){reader.cancel();throw new Error("Image exceeds the allowed size")}chunks.push(value)}
    }
    const bytes=new Uint8Array(total);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.length}
    return {bytes,type,ext:MIME_EXT[type]};
  }
  throw new Error("Too many image redirects");
}
async function storeImage(userId:string,kind:string,url:string){
  const cfg=BUCKETS[kind]; const img=await safeImage(url,kind);
  const path=userId+"/"+crypto.randomUUID()+"."+img.ext;
  const r=await fetch(SUPABASE_URL+"/storage/v1/object/"+encodeURIComponent(cfg.name)+"/"+path.split("/").map(encodeURIComponent).join("/"),{
    method:"POST",
    headers:{apikey:SERVICE_KEY,Authorization:"Bearer "+SERVICE_KEY,"Content-Type":img.type,"x-upsert":"false"},
    body:img.bytes
  });
  if(!r.ok)throw new Error("Unable to store imported image");
  return path;
}

async function actionConnect(user:any,body:any){
  const token=String(body.token||"").trim(); if(!token)throw new Error("PluralKit token is required");
  const system=await pk(token,"/systems/@me");
  const enc=await encryptToken(token);
  await admin("/rest/v1/integration_secrets?on_conflict=user_id,provider",{
    method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify({user_id:user.id,provider:"pluralkit",ciphertext:enc.ciphertext,iv:enc.iv,cipher_version:1})
  });
  await admin("/rest/v1/external_integrations?on_conflict=user_id,provider",{
    method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify({user_id:user.id,provider:"pluralkit",external_system_id:system.id||null,external_system_name:system.name||system.id||"PluralKit system",share_fronting_updates:true,connected_at:new Date().toISOString()})
  });
  return {connected:true,system:{id:system.id||null,name:system.name||null}};
}
async function actionStatus(user:any){
  const rows=await admin("/rest/v1/integration_secrets?user_id=eq."+encodeURIComponent(user.id)+"&provider=eq.pluralkit&select=provider&limit=1");
  return {connected:Boolean(rows?.length)};
}
async function actionDisconnect(user:any){
  await admin("/rest/v1/integration_secrets?user_id=eq."+encodeURIComponent(user.id)+"&provider=eq.pluralkit",{method:"DELETE"});
  await admin("/rest/v1/external_integrations?user_id=eq."+encodeURIComponent(user.id)+"&provider=eq.pluralkit",{method:"PATCH",body:JSON.stringify({share_fronting_updates:false})});
  return {connected:false};
}
async function actionMirror(user:any,body:any){
  const token=await getSecret(user.id);
  const ids=Array.isArray(body.memberIds)?body.memberIds:[];
  if(!ids.length){
    await pk(token,"/systems/@me/switches",{method:"POST",body:JSON.stringify({members:[],...(body.timestamp?{timestamp:body.timestamp}:{})})});
    return {shared:true};
  }
  const inFilter="("+ids.map((x:string)=>String(x).replace(/[^a-fA-F0-9-]/g,"")).join(",")+")";
  const members=await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&id=in."+encodeURIComponent(inFilter)+"&select=id,pk_id,archived_at");
  if(members.length!==ids.length||members.some((m:any)=>!m.pk_id||m.archived_at))throw new Error("One or more members cannot be shared to PluralKit");
  const payload:any={members:members.map((m:any)=>m.pk_id)}; if(body.timestamp)payload.timestamp=body.timestamp;
  await pk(token,"/systems/@me/switches",{method:"POST",body:JSON.stringify(payload)});
  return {shared:true};
}
async function actionImportPk(user:any,body:any){
  const token=await getSecret(user.id);
  const all=await pk(token,"/systems/@me/members");
  const offset=Math.max(0,Number(body.offset)||0),limit=Math.min(25,Math.max(1,Number(body.limit)||10));
  const batch=(all||[]).slice(offset,offset+limit);
  let added=0,skipped=0,mediaCopied=0;
  for(const m of batch){
    const existing=await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&pk_id=eq."+encodeURIComponent(m.id)+"&select=id&limit=1");
    if(existing?.length){skipped++;continue}
    let avatarPath=null,bannerPath=null;
    const avatar=m.avatar_url||null,banner=m.banner||m.banner_url||null;
    if(avatar){try{avatarPath=await storeImage(user.id,"avatar",avatar);mediaCopied++}catch{}}
    if(banner){try{bannerPath=await storeImage(user.id,"banner",banner);mediaCopied++}catch{}}
    await admin("/rest/v1/members",{
      method:"POST",headers:{Prefer:"return=minimal"},
      body:JSON.stringify({
        user_id:user.id,name:m.name||m.display_name||m.id,display_name:m.display_name||null,
        pronouns:m.pronouns||null,color:m.color||null,description:m.description||null,birthday:m.birthday||null,
        avatar_url:null,avatar_source:avatarPath?"supabase":null,avatar_storage_path:avatarPath,
        banner_url:null,banner_source:bannerPath?"supabase":null,banner_storage_path:bannerPath,
        pk_id:m.id,metadata:{pk_uuid:m.uuid||null},archived_at:null
      })
    });
    added++;
  }
  return {total:(all||[]).length,offset,processed:batch.length,added,skipped,mediaCopied,nextOffset:offset+batch.length<(all||[]).length?offset+batch.length:null};
}
async function actionImportMedia(user:any,body:any){
  const kind=String(body.kind||""); const url=String(body.url||"");
  const path=await storeImage(user.id,kind,url);
  return {path};
}

Deno.serve(async(req)=>{
  const origin=req.headers.get("Origin");
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(origin)});
  if(origin && origin!==ALLOWED_ORIGIN)return json({error:"Origin not allowed"},403,origin);
  if(req.method!=="POST")return json({error:"Method not allowed"},405,origin);
  try{
    const user=await currentUser(req);
    const profile=await admin("/rest/v1/profiles?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id&limit=1");
    if(!profile?.length)throw new Error("Nihility profile required");
    const body=await req.json().catch(()=>({}));
    const action=String(body.action||"");
    let result;
    if(action==="pk_connect")result=await actionConnect(user,body);
    else if(action==="pk_status")result=await actionStatus(user);
    else if(action==="pk_disconnect")result=await actionDisconnect(user);
    else if(action==="pk_mirror_front")result=await actionMirror(user,body);
    else if(action==="pk_import")result=await actionImportPk(user,body);
    else if(action==="import_media")result=await actionImportMedia(user,body);
    else return json({error:"Unknown action"},400,origin);
    return json(result,200,origin);
  }catch(error){
    const message=error instanceof Error?error.message:"Request failed";
    return json({error:message},400,origin);
  }
});
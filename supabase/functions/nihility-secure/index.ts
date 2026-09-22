import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = new Set([
  "https://scionhyperion-ix.github.io",
  "https://projectnihilityofficial.top",
  "https://www.projectnihilityofficial.top",
]);
const PK_BASE = "https://api.pluralkit.me/v2";

// Server-side media fetching is intentionally restricted to image hosts we trust.
// This closes the DNS-rebinding gap that exists when validating DNS and then
// allowing fetch() to resolve an arbitrary attacker-controlled hostname again.
const TRUSTED_MEDIA_HOSTS = new Set([
  "i.pinimg.com",
  "i.postimg.cc",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "i.imgur.com",
]);
const MIME_EXT: Record<string,string> = {
  "image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif"
};
const BUCKETS: Record<string,{name:string,max:number}> = {
  avatar:{name:"nihility-avatars",max:2*1024*1024},
  banner:{name:"nihility-banners",max:5*1024*1024},
  profile:{name:"nihility-profile-avatars",max:2*1024*1024},
};
const MEDIA_QUOTA_BYTES = 1024*1024*1024; // 1 GiB per account.
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;

class ClientError extends Error {
  status:number;
  constructor(message:string,status=400){super(message);this.name="ClientError";this.status=status}
}

function cors(origin:string|null){
  const fallback="https://scionhyperion-ix.github.io";
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : fallback;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-nihility-action, x-media-kind",
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
let vaultKeyPromise:Promise<CryptoKey>|null=null;
async function vaultKey(){
  if(!vaultKeyPromise){
    vaultKeyPromise=(async()=>{
      const encoded=await admin("/rest/v1/rpc/get_nihility_encryption_key",{method:"POST",body:"{}"});
      if(typeof encoded!=="string"||!encoded)throw new Error("Encryption key unavailable");
      return crypto.subtle.importKey("raw",unb64(encoded),{name:"AES-GCM"},false,["encrypt","decrypt"]);
    })();
  }
  return vaultKeyPromise;
}
async function legacyKey(){
  const material=new TextEncoder().encode("nihility-pk-token-v1\n"+SERVICE_KEY);
  const digest=await crypto.subtle.digest("SHA-256",material);
  return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["decrypt"]);
}
async function encryptToken(token:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},await vaultKey(),new TextEncoder().encode(token));
  return {ciphertext:b64(new Uint8Array(cipher)),iv:b64(iv)};
}
async function decryptWith(key:CryptoKey,ciphertext:string,iv:string){
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(iv)},key,unb64(ciphertext));
  return new TextDecoder().decode(plain);
}
async function decryptToken(ciphertext:string,iv:string){
  return decryptWith(await vaultKey(),ciphertext,iv);
}
async function admin(path:string,init:RequestInit={}){
  const headers=new Headers(init.headers||{});
  headers.set("apikey",SERVICE_KEY);
  headers.set("Authorization","Bearer "+SERVICE_KEY);
  if(init.body && !headers.has("Content-Type"))headers.set("Content-Type","application/json");
  const r=await fetch(SUPABASE_URL+path,{...init,headers});
  const text=await r.text();
  let data:any=null; try{data=text?JSON.parse(text):null}catch{data=text}
  if(!r.ok){
    console.error("Supabase admin request failed",r.status,path,typeof data==="string"?data.slice(0,500):data);
    throw new Error("Database operation failed");
  }
  return data;
}
async function currentUser(req:Request){
  const auth=req.headers.get("Authorization")||"";
  if(!auth.startsWith("Bearer "))throw new ClientError("Authentication required",401);
  const r=await fetch(SUPABASE_URL+"/auth/v1/user",{headers:{apikey:SERVICE_KEY,Authorization:auth}});
  if(!r.ok)throw new ClientError("Invalid or expired session",401);
  return await r.json();
}
async function getSecret(userId:string){
  const rows=await admin("/rest/v1/integration_secrets?user_id=eq."+encodeURIComponent(userId)+"&provider=eq.pluralkit&select=ciphertext,iv,cipher_version&limit=1");
  if(!rows?.[0])throw new ClientError("PluralKit is not connected",409);
  const row=rows[0];
  if(Number(row.cipher_version||1)>=2)return decryptToken(row.ciphertext,row.iv);

  // One-time transparent migration from the old service-key-derived key.
  const token=await decryptWith(await legacyKey(),row.ciphertext,row.iv);
  const migrated=await encryptToken(token);
  await admin("/rest/v1/integration_secrets?user_id=eq."+encodeURIComponent(userId)+"&provider=eq.pluralkit",{
    method:"PATCH",
    headers:{Prefer:"return=minimal"},
    body:JSON.stringify({ciphertext:migrated.ciphertext,iv:migrated.iv,cipher_version:2,updated_at:new Date().toISOString()})
  });
  return token;
}
async function pk(token:string,path:string,init:RequestInit={}){
  const headers=new Headers(init.headers||{});
  headers.set("Authorization",token);
  if(init.body)headers.set("Content-Type","application/json");
  const r=await fetch(PK_BASE+path,{...init,headers,signal:AbortSignal.timeout(15000)});
  const text=await r.text();
  let data:any=null; try{data=text?JSON.parse(text):null}catch{data=text}
  if(!r.ok){
    console.warn("PluralKit request failed",r.status,path);
    if(r.status===401||r.status===403)throw new ClientError("PluralKit rejected the connection credentials.",401);
    if(r.status===429)throw new ClientError("PluralKit rate limit reached. Please wait and try again.",429);
    throw new ClientError("PluralKit request failed. Please try again.",502);
  }
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
  if(u.href.length>2048)throw new ClientError("Image URL is too long");
  if(u.protocol!=="https:")throw new ClientError("Only HTTPS image URLs are allowed");
  if(u.username||u.password)throw new ClientError("Credentials in image URLs are not allowed");
  if(u.port&&u.port!=="443")throw new ClientError("Custom image URL ports are not allowed");

  const host=u.hostname.toLowerCase().replace(/\.$/,"").replace(/^\[|\]$/g,"");
  if(!TRUSTED_MEDIA_HOSTS.has(host)){
    throw new ClientError("This image host is not approved for secure server-side import. Upload the image file instead.");
  }

  if(host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local")||host.endsWith(".internal")){
    throw new ClientError("Local network URLs are not allowed");
  }

  if(literalIp(host)){
    if(host.includes(":")?privateIPv6(host):privateIPv4(host)){
      throw new ClientError("Private or reserved IP image URLs are not allowed");
    }
  }else{
    const [a,aaaa]=await Promise.all([
      Deno.resolveDns(host,"A").catch(()=>[]),
      Deno.resolveDns(host,"AAAA").catch(()=>[]),
    ]);
    if(!a.length&&!aaaa.length)throw new ClientError("Image host could not be resolved");
    if(a.some(privateIPv4)||aaaa.some(privateIPv6)){
      throw new ClientError("Private or reserved image hosts are not allowed");
    }
  }
}

function detectedImageType(bytes:Uint8Array){
  if(bytes.length>=8 &&
     bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47&&
     bytes[4]===0x0d&&bytes[5]===0x0a&&bytes[6]===0x1a&&bytes[7]===0x0a) return "image/png";
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff) return "image/jpeg";
  if(bytes.length>=6){
    const sig=String.fromCharCode(...bytes.slice(0,6));
    if(sig==="GIF87a"||sig==="GIF89a") return "image/gif";
  }
  if(bytes.length>=12){
    const riff=String.fromCharCode(...bytes.slice(0,4));
    const webp=String.fromCharCode(...bytes.slice(8,12));
    if(riff==="RIFF"&&webp==="WEBP") return "image/webp";
  }
  return null;
}
function u16be(bytes:Uint8Array,offset:number){return (bytes[offset]<<8)|bytes[offset+1]}
function u16le(bytes:Uint8Array,offset:number){return bytes[offset]|(bytes[offset+1]<<8)}
function u24le(bytes:Uint8Array,offset:number){return bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16)}
function u32be(bytes:Uint8Array,offset:number){return ((bytes[offset]<<24)>>>0)|(bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3]}
function imageDimensions(bytes:Uint8Array,type:string){
  if(type==="image/png"&&bytes.length>=24){
    return {width:u32be(bytes,16),height:u32be(bytes,20)};
  }
  if(type==="image/gif"&&bytes.length>=10){
    return {width:u16le(bytes,6),height:u16le(bytes,8)};
  }
  if(type==="image/jpeg"){
    let i=2;
    const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while(i+8<bytes.length){
      if(bytes[i]!==0xff){i++;continue}
      while(i<bytes.length&&bytes[i]===0xff)i++;
      const marker=bytes[i++];
      if(marker===0xd8||marker===0xd9||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(i+1>=bytes.length)break;
      const length=u16be(bytes,i);
      if(length<2||i+length>bytes.length)break;
      if(sof.has(marker)&&length>=7){
        return {height:u16be(bytes,i+3),width:u16be(bytes,i+5)};
      }
      i+=length;
    }
    return null;
  }
  if(type==="image/webp"&&bytes.length>=30){
    const chunk=String.fromCharCode(...bytes.slice(12,16));
    if(chunk==="VP8X"&&bytes.length>=30){
      return {width:1+u24le(bytes,24),height:1+u24le(bytes,27)};
    }
    if(chunk==="VP8L"&&bytes.length>=25&&bytes[20]===0x2f){
      const b1=bytes[21],b2=bytes[22],b3=bytes[23],b4=bytes[24];
      return {
        width:1+(b1|((b2&0x3f)<<8)),
        height:1+((b2>>6)|(b3<<2)|((b4&0x0f)<<10))
      };
    }
    if(chunk==="VP8 "&&bytes.length>=30&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a){
      return {width:u16le(bytes,26)&0x3fff,height:u16le(bytes,28)&0x3fff};
    }
  }
  return null;
}
function gifFrameCount(bytes:Uint8Array,maxFrames=100){
  if(bytes.length<13)return null;
  const signature=String.fromCharCode(...bytes.slice(0,6));
  if(signature!=="GIF87a"&&signature!=="GIF89a")return null;

  let offset=13;
  const globalPacked=bytes[10];
  if(globalPacked&0x80){
    offset+=3*(1<<((globalPacked&0x07)+1));
    if(offset>bytes.length)return null;
  }

  const skipSubBlocks=()=>{
    while(offset<bytes.length){
      const size=bytes[offset++];
      if(size===0)return true;
      if(offset+size>bytes.length)return false;
      offset+=size;
    }
    return false;
  };

  let frames=0;
  while(offset<bytes.length){
    const introducer=bytes[offset++];
    if(introducer===0x3b)return frames;
    if(introducer===0x21){
      if(offset>=bytes.length)return null;
      offset++; // extension label
      if(!skipSubBlocks())return null;
      continue;
    }
    if(introducer===0x2c){
      if(offset+9>bytes.length)return null;
      const packed=bytes[offset+8];
      offset+=9;
      if(packed&0x80){
        offset+=3*(1<<((packed&0x07)+1));
        if(offset>bytes.length)return null;
      }
      if(offset>=bytes.length)return null;
      offset++; // LZW minimum code size
      if(!skipSubBlocks())return null;
      frames++;
      if(frames>maxFrames)return frames;
      continue;
    }
    return null;
  }
  return null;
}

function validateImageBytes(bytes:Uint8Array,type:string,kind:string){
  const cfg=BUCKETS[kind];
  if(!cfg)throw new ClientError("Invalid media kind");
  if(!MIME_EXT[type])throw new ClientError("Unsupported image type");
  if(bytes.length===0)throw new ClientError("Empty image response");
  if(bytes.length>cfg.max)throw new ClientError("Image exceeds the allowed size");
  if(type==="image/gif"){
    if(bytes.length>2*1024*1024)throw new ClientError("GIF images are limited to 2 MB");
    const frames=gifFrameCount(bytes,100);
    if(frames==null)throw new ClientError("Unable to validate GIF structure");
    if(frames>100)throw new ClientError("Animated GIFs are limited to 100 frames");
  }

  const detected=detectedImageType(bytes);
  if(!detected||detected!==type)throw new ClientError("Image content does not match its declared type");

  const dimensions=imageDimensions(bytes,type);
  if(!dimensions||!dimensions.width||!dimensions.height)throw new ClientError("Unable to read image dimensions");
  const {width,height}=dimensions;
  if(width>MAX_IMAGE_DIMENSION||height>MAX_IMAGE_DIMENSION||width*height>MAX_IMAGE_PIXELS){
    throw new ClientError("Image dimensions are too large");
  }
  return {width,height};
}
async function readRawBody(req:Request|Response,maxBytes:number){
  const declared=Number(req.headers.get("content-length")||0);
  if(Number.isFinite(declared)&&declared>maxBytes)throw new ClientError("Image exceeds the allowed size");
  const reader=req.body?.getReader();
  if(!reader)throw new ClientError("Empty image upload");
  const chunks:Uint8Array[]=[];let total=0;
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    if(value){
      total+=value.length;
      if(total>maxBytes){await reader.cancel();throw new ClientError("Image exceeds the allowed size")}
      chunks.push(value);
    }
  }
  if(!total)throw new ClientError("Empty image upload");
  const bytes=new Uint8Array(total);let off=0;
  for(const chunk of chunks){bytes.set(chunk,off);off+=chunk.length}
  return bytes;
}
async function reserveMediaQuota(userId:string,additionalBytes:number){
  const reservationId=crypto.randomUUID();
  const ok=await admin("/rest/v1/rpc/reserve_nihility_media_quota",{
    method:"POST",
    body:JSON.stringify({
      p_user_id:userId,
      p_reservation_id:reservationId,
      p_bytes:additionalBytes,
      p_limit_bytes:MEDIA_QUOTA_BYTES
    })
  });
  if(ok!==true){
    throw new ClientError("Media storage quota exceeded. Remove unused media before uploading more.",413);
  }
  return reservationId;
}
async function releaseMediaReservation(userId:string,reservationId:string){
  try{
    await admin("/rest/v1/rpc/release_nihility_media_reservation",{
      method:"POST",
      body:JSON.stringify({p_user_id:userId,p_reservation_id:reservationId})
    });
  }catch(error){
    console.warn("Unable to release media quota reservation",error);
  }
}
async function finalizeMediaReservation(userId:string,reservationId:string,bucketId:string,path:string){
  try{
    await admin("/rest/v1/rpc/finalize_nihility_media_reservation",{
      method:"POST",
      body:JSON.stringify({
        p_user_id:userId,
        p_reservation_id:reservationId,
        p_bucket_id:bucketId,
        p_object_path:path
      })
    });
  }catch(error){
    // The unresolved reservation remains counted until it expires, which is
    // intentionally conservative and avoids undercounting concurrent uploads.
    console.warn("Unable to finalize media quota reservation",error);
  }
}
async function storeImageBytes(userId:string,kind:string,bytes:Uint8Array,type:string){
  const cfg=BUCKETS[kind];
  if(!cfg)throw new ClientError("Invalid media kind");
  validateImageBytes(bytes,type,kind);

  const reservationId=await reserveMediaQuota(userId,bytes.length);
  const path=userId+"/"+crypto.randomUUID()+"."+MIME_EXT[type];
  let response:Response;
  try{
    response=await fetch(SUPABASE_URL+"/storage/v1/object/"+encodeURIComponent(cfg.name)+"/"+path.split("/").map(encodeURIComponent).join("/"),{
      method:"POST",
      headers:{apikey:SERVICE_KEY,Authorization:"Bearer "+SERVICE_KEY,"Content-Type":type,"x-upsert":"false"},
      body:bytes
    });
  }catch(error){
    await releaseMediaReservation(userId,reservationId);
    throw error;
  }

  if(!response.ok){
    console.error("Storage upload failed",response.status,await response.text().catch(()=>""));
    await releaseMediaReservation(userId,reservationId);
    throw new Error("Media storage failed");
  }

  await finalizeMediaReservation(userId,reservationId,cfg.name,path);
  return path;
}
async function safeImage(url:string,kind:string){
  const cfg=BUCKETS[kind]; if(!cfg)throw new ClientError("Invalid media kind");
  let current:URL;
  try{current=new URL(url)}catch{throw new ClientError("Invalid image URL")}
  for(let redirects=0;redirects<4;redirects++){
    await validateHost(current);
    const r=await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(12000),headers:{"User-Agent":"Project-Nihility-Media-Importer/1.0","Accept":"image/png,image/jpeg,image/webp,image/gif"}});
    if([301,302,303,307,308].includes(r.status)){
      const loc=r.headers.get("location"); if(!loc)throw new ClientError("Invalid image redirect");
      current=new URL(loc,current); continue;
    }
    if(!r.ok)throw new ClientError("Unable to fetch image");
    const type=(r.headers.get("content-type")||"").split(";")[0].toLowerCase();
    if(!MIME_EXT[type])throw new ClientError("Unsupported image type");
    const declared=Number(r.headers.get("content-length")||0);
    if(declared>cfg.max)throw new ClientError("Image exceeds the allowed size");
    const bytes=await readRawBody(r,cfg.max);
    validateImageBytes(bytes,type,kind);
    return {bytes,type,ext:MIME_EXT[type]};
  }
  throw new ClientError("Too many image redirects");
}
async function storeImage(userId:string,kind:string,url:string){
  const img=await safeImage(url,kind);
  return storeImageBytes(userId,kind,img.bytes,img.type);
}
async function actionUploadMedia(user:any,req:Request){
  const kind=String(req.headers.get("x-media-kind")||"");
  const cfg=BUCKETS[kind];
  if(!cfg)throw new ClientError("Invalid media kind");
  const type=(req.headers.get("content-type")||"").split(";")[0].toLowerCase();
  if(!MIME_EXT[type])throw new ClientError("Unsupported image type");
  const bytes=await readRawBody(req,cfg.max);
  const path=await storeImageBytes(user.id,kind,bytes,type);
  return {path};
}

async function actionConnect(user:any,body:any){
  const token=String(body.token||"").trim();
  if(!token)throw new ClientError("PluralKit token is required");
  if(token.length>512)throw new ClientError("PluralKit token is invalid");
  const system=await pk(token,"/systems/@me");
  const enc=await encryptToken(token);
  await admin("/rest/v1/integration_secrets?on_conflict=user_id,provider",{
    method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify({user_id:user.id,provider:"pluralkit",ciphertext:enc.ciphertext,iv:enc.iv,cipher_version:2})
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
  if(members.length!==ids.length||members.some((m:any)=>!m.pk_id||m.archived_at))throw new ClientError("One or more members cannot be shared to PluralKit");
  const payload:any={members:members.map((m:any)=>m.pk_id)}; if(body.timestamp)payload.timestamp=body.timestamp;
  await pk(token,"/systems/@me/switches",{method:"POST",body:JSON.stringify(payload)});
  return {shared:true};
}
async function actionComparePk(user:any){
  const token=await getSecret(user.id);
  const [pkMembers,localMembers]=await Promise.all([
    pk(token,"/systems/@me/members"),
    admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&pk_id=not.is.null&select=pk_id")
  ]);
  const localIds=new Set((localMembers||[]).map((m:any)=>String(m.pk_id)).filter(Boolean));
  const missingMemberIds=(pkMembers||[])
    .map((m:any)=>String(m?.id||""))
    .filter((id:string)=>id&&!localIds.has(id));
  return {
    memberTotal:(pkMembers||[]).length,
    memberLinked:(pkMembers||[]).length-missingMemberIds.length,
    missingMemberIds
  };
}

async function actionImportPk(user:any,body:any){
  const token=await getSecret(user.id);
  const all=await pk(token,"/systems/@me/members");
  const requestedIds=Array.isArray(body.memberIds)
    ?body.memberIds.map((id:any)=>String(id||"")).filter(Boolean).slice(0,25)
    :null;

  let batch:any[]=[];
  let offset=0;
  if(requestedIds){
    const wanted=new Set(requestedIds);
    batch=(all||[]).filter((m:any)=>wanted.has(String(m?.id||"")));
  }else{
    offset=Math.max(0,Number(body.offset)||0);
    const limit=Math.min(25,Math.max(1,Number(body.limit)||10));
    batch=(all||[]).slice(offset,offset+limit);
  }

  const batchIds=batch.map((m:any)=>String(m.id)).filter(Boolean);
  let existingIds=new Set<string>();
  if(batchIds.length){
    const filter="("+batchIds.map((id:string)=>id.replace(/[^A-Za-z0-9_-]/g,"")).join(",")+")";
    const existing=await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&pk_id=in."+encodeURIComponent(filter)+"&select=pk_id");
    existingIds=new Set((existing||[]).map((m:any)=>String(m.pk_id)));
  }

  let added=0,skipped=0,mediaCopied=0;
  for(const m of batch){
    if(existingIds.has(String(m.id))){skipped++;continue}
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
        pk_id:m.id,metadata:{pk_uuid:m.uuid||null,proxy_tags:Array.isArray(m.proxy_tags)?m.proxy_tags:[],keep_proxy:Boolean(m.keep_proxy)},archived_at:null
      })
    });
    added++;
  }

  return {
    total:requestedIds?batch.length:(all||[]).length,
    offset,
    processed:batch.length,
    added,
    skipped,
    mediaCopied,
    nextOffset:requestedIds?null:(offset+batch.length<(all||[]).length?offset+batch.length:null)
  };
}

function sanitizePkSystem(system:any){
  return {
    id:system?.id||null,
    uuid:system?.uuid||null,
    name:system?.name||null,
    description:system?.description||null,
    tag:system?.tag||null,
    pronouns:system?.pronouns||null,
    color:system?.color||null,
    avatar_url:system?.avatar_url||null,
    banner:system?.banner||system?.banner_url||null
  };
}

async function saveLocalSystemProfile(user:any,system:any,{copyMedia=false}={}){
  const settingsRows=await admin("/rest/v1/app_settings?user_id=eq."+encodeURIComponent(user.id)+"&select=settings&limit=1");
  const existingSettings=settingsRows?.[0]?.settings||{};
  const old=existingSettings?.system_profile||{};
  let avatarPath=old.avatar_storage_path||null;
  let bannerPath=old.banner_storage_path||null;
  if(copyMedia&&system.avatar_url){
    try{avatarPath=await storeImage(user.id,"avatar",system.avatar_url)}catch{}
  }
  if(copyMedia&&system.banner){
    try{bannerPath=await storeImage(user.id,"banner",system.banner)}catch{}
  }
  const profile={...old,...system,avatar_storage_path:avatarPath,banner_storage_path:bannerPath};
  const mergedSettings={...existingSettings,system_profile:profile,system_name:profile.name||null};
  await admin("/rest/v1/app_settings?on_conflict=user_id",{
    method:"POST",
    headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify({user_id:user.id,settings:mergedSettings})
  });
  return profile;
}

async function actionGetPkSystem(user:any){
  const token=await getSecret(user.id);
  const system=sanitizePkSystem(await pk(token,"/systems/@me"));
  return {system};
}

async function actionUpdatePkSystem(user:any,body:any){
  const token=await getSecret(user.id);
  const input=body?.system||{};
  const payload:any={};
  const textFields=["name","description","tag","pronouns","avatar_url","banner"];
  for(const key of textFields){
    if(Object.prototype.hasOwnProperty.call(input,key)){
      const value=input[key];
      payload[key]=value==null||String(value).trim()===""?null:String(value).trim();
    }
  }
  if(Object.prototype.hasOwnProperty.call(input,"color")){
    const color=String(input.color||"").trim().replace(/^#/,"");
    if(color&&!/^[0-9a-fA-F]{6}$/.test(color))throw new ClientError("Color must be a 6-character hex color");
    payload.color=color||null;
  }
  if(payload.avatar_url&&!/^https:\/\//i.test(payload.avatar_url))throw new ClientError("Avatar must use HTTPS");
  if(payload.banner&&!/^https:\/\//i.test(payload.banner))throw new ClientError("Banner must use HTTPS");
  await pk(token,"/systems/@me",{method:"PATCH",body:JSON.stringify(payload)});
  const updated=sanitizePkSystem(await pk(token,"/systems/@me"));
  const local=await saveLocalSystemProfile(user,updated,{copyMedia:true});
  await admin("/rest/v1/external_integrations?user_id=eq."+encodeURIComponent(user.id)+"&provider=eq.pluralkit",{
    method:"PATCH",
    headers:{Prefer:"return=minimal"},
    body:JSON.stringify({external_system_id:updated.id,external_system_name:updated.name||updated.id||"PluralKit system"})
  });
  return {system:{...updated,avatar_storage_path:local.avatar_storage_path||null,banner_storage_path:local.banner_storage_path||null}};
}

async function actionImportPkGroups(user:any){
  const token=await getSecret(user.id);
  const [pkSystem,pkGroups,pkMembers]=await Promise.all([
    pk(token,"/systems/@me"),
    pk(token,"/systems/@me/groups?with_members=true"),
    pk(token,"/systems/@me/members")
  ]);

  const settingsRows=await admin("/rest/v1/app_settings?user_id=eq."+encodeURIComponent(user.id)+"&select=settings&limit=1");
  const existingSettings=settingsRows?.[0]?.settings||{};
  let systemAvatarPath=existingSettings?.system_profile?.avatar_storage_path||null;
  let systemBannerPath=existingSettings?.system_profile?.banner_storage_path||null;
  const systemAvatarUrl=pkSystem?.avatar_url||null;
  const systemBannerUrl=pkSystem?.banner||pkSystem?.banner_url||null;
  if(!systemAvatarPath&&systemAvatarUrl){try{systemAvatarPath=await storeImage(user.id,"avatar",systemAvatarUrl)}catch{}}
  if(!systemBannerPath&&systemBannerUrl){try{systemBannerPath=await storeImage(user.id,"banner",systemBannerUrl)}catch{}}
  const importedSystem={
    id:pkSystem?.id||null,
    uuid:pkSystem?.uuid||null,
    name:pkSystem?.name||null,
    display_name:pkSystem?.display_name||null,
    description:pkSystem?.description||null,
    tag:pkSystem?.tag||null,
    pronouns:pkSystem?.pronouns||null,
    color:pkSystem?.color||null,
    avatar_url:systemAvatarUrl,
    banner:systemBannerUrl,
    avatar_storage_path:systemAvatarPath,
    banner_storage_path:systemBannerPath
  };
  const mergedSettings={...existingSettings,system_profile:importedSystem,system_name:importedSystem.name||importedSystem.display_name||null};
  await admin("/rest/v1/app_settings?on_conflict=user_id",{
    method:"POST",
    headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify({user_id:user.id,settings:mergedSettings})
  });

  const localMembers=await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&select=id,pk_id,metadata");
  const localGroups=await admin("/rest/v1/groups?user_id=eq."+encodeURIComponent(user.id)+"&select=id,name,display_name,description,color,pk_id,metadata");
  const existingLinks=await admin("/rest/v1/member_groups?user_id=eq."+encodeURIComponent(user.id)+"&select=member_id,group_id");

  const memberMap=new Map<string,string>();
  for(const row of localMembers||[]){
    if(row.pk_id)memberMap.set(String(row.pk_id),row.id);
    if(row.metadata?.pk_uuid)memberMap.set(String(row.metadata.pk_uuid),row.id);
  }

  let metadataUpdated=0;
  const localByPk=new Map<string,any>((localMembers||[]).filter((m:any)=>m.pk_id).map((m:any)=>[String(m.pk_id),m]));
  for(const pm of pkMembers||[]){
    const local=localByPk.get(String(pm.id));
    if(!local)continue;
    const metadata={...(local.metadata||{})};
    let changed=false;
    if(metadata.pk_uuid==null&&pm.uuid){metadata.pk_uuid=pm.uuid;changed=true}
    if(metadata.proxy_tags==null&&Array.isArray(pm.proxy_tags)){metadata.proxy_tags=pm.proxy_tags;changed=true}
    if(metadata.keep_proxy==null&&typeof pm.keep_proxy==="boolean"){metadata.keep_proxy=pm.keep_proxy;changed=true}
    if(changed){
      await admin("/rest/v1/members?id=eq."+encodeURIComponent(local.id),{
        method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({metadata})
      });
      metadataUpdated++;
    }
  }

  const groupByPk=new Map<string,any>();
  for(const row of localGroups||[]){
    if(row.pk_id)groupByPk.set(String(row.pk_id),row);
    if(row.metadata?.pk_uuid)groupByPk.set(String(row.metadata.pk_uuid),row);
  }

  const linkSet=new Set((existingLinks||[]).map((x:any)=>String(x.member_id)+":"+String(x.group_id)));
  let added=0,updated=0,unchanged=0,membershipsAdded=0,unresolved=0;

  for(const g of pkGroups||[]){
    let local=groupByPk.get(String(g.id))||(g.uuid?groupByPk.get(String(g.uuid)):null);
    let iconPath=local?.metadata?.icon_storage_path||null;
    let bannerPath=local?.metadata?.banner_storage_path||null;
    const iconUrl=g.icon||g.icon_url||null;
    const bannerUrl=g.banner||g.banner_url||null;
    if(!iconPath&&iconUrl){try{iconPath=await storeImage(user.id,"avatar",iconUrl)}catch{}}
    if(!bannerPath&&bannerUrl){try{bannerPath=await storeImage(user.id,"banner",bannerUrl)}catch{}}
    if(!local){
      const created=await admin("/rest/v1/groups",{
        method:"POST",headers:{Prefer:"return=representation"},
        body:JSON.stringify({
          user_id:user.id,
          name:g.name||g.display_name||g.id,
          display_name:g.display_name||null,
          description:g.description||null,
          color:g.color||null,
          icon_url:null,
          icon_source:null,
          pk_id:g.id,
          metadata:{pk_uuid:g.uuid||null,pk_icon_url:iconUrl,pk_banner_url:bannerUrl,icon_storage_path:iconPath,banner_storage_path:bannerPath}
        })
      });
      local=created?.[0];
      if(local){
        added++;
        groupByPk.set(String(g.id),local);
        if(g.uuid)groupByPk.set(String(g.uuid),local);
      }
    }else{
      const nextName=g.name||g.display_name||local.name;
      const nextDisplayName=g.display_name||null;
      const nextDescription=g.description||null;
      const nextColor=g.color||null;
      const metadata={
        ...(local.metadata||{}),
        pk_uuid:g.uuid||local.metadata?.pk_uuid||null,
        pk_icon_url:iconUrl||local.metadata?.pk_icon_url||null,
        pk_banner_url:bannerUrl||local.metadata?.pk_banner_url||null,
        icon_storage_path:iconPath||local.metadata?.icon_storage_path||null,
        banner_storage_path:bannerPath||local.metadata?.banner_storage_path||null
      };
      const oldMetadata=local.metadata||{};
      const changed=
        local.name!==nextName||
        (local.display_name||null)!==nextDisplayName||
        (local.description||null)!==nextDescription||
        (local.color||null)!==nextColor||
        (oldMetadata.pk_uuid||null)!==(metadata.pk_uuid||null)||
        (oldMetadata.pk_icon_url||null)!==(metadata.pk_icon_url||null)||
        (oldMetadata.pk_banner_url||null)!==(metadata.pk_banner_url||null)||
        (oldMetadata.icon_storage_path||null)!==(metadata.icon_storage_path||null)||
        (oldMetadata.banner_storage_path||null)!==(metadata.banner_storage_path||null);

      if(changed){
        await admin("/rest/v1/groups?id=eq."+encodeURIComponent(local.id),{
          method:"PATCH",
          headers:{Prefer:"return=minimal"},
          body:JSON.stringify({
            name:nextName,
            display_name:nextDisplayName,
            description:nextDescription,
            color:nextColor,
            metadata
          })
        });
        local={...local,name:nextName,display_name:nextDisplayName,description:nextDescription,color:nextColor,metadata};
        updated++;
      }else{
        unchanged++;
      }
    }
    if(!local?.id)continue;

    const refs=Array.isArray(g.members)?g.members:[];
    for(const ref of refs){
      const key=typeof ref==="string"?ref:(ref?.id||ref?.uuid||"");
      const memberId=memberMap.get(String(key));
      if(!memberId){unresolved++;continue}
      const linkKey=String(memberId)+":"+String(local.id);
      if(linkSet.has(linkKey))continue;
      await admin("/rest/v1/member_groups",{
        method:"POST",headers:{Prefer:"return=minimal"},
        body:JSON.stringify({user_id:user.id,member_id:memberId,group_id:local.id})
      });
      linkSet.add(linkKey);
      membershipsAdded++;
    }
  }

  return {
    total:(pkGroups||[]).length,
    added,
    updated,
    unchanged,
    membershipsAdded,
    unresolved,
    metadataUpdated,
    systemName:importedSystem.name||importedSystem.display_name||null,
    systemId:importedSystem.id||null
  };
}
async function actionImportPkFronts(user:any,body:any){
  const token=await getSecret(user.id);
  const limit=Math.min(100,Math.max(1,Number(body.limit)||100));
  const before=body.before?String(body.before):null;
  const query="?limit="+limit+(before?"&before="+encodeURIComponent(before):"");
  const switches=await pk(token,"/systems/@me/switches"+query);
  const validSwitches=(switches||[]).filter((sw:any)=>sw?.id&&sw?.timestamp);

  const switchIds=validSwitches.map((sw:any)=>String(sw.id));
  let existingIds=new Set<string>();
  if(switchIds.length){
    const filter="("+switchIds.map((id:string)=>id.replace(/[^A-Za-z0-9_-]/g,"")).join(",")+")";
    const existing=await admin("/rest/v1/fronts?user_id=eq."+encodeURIComponent(user.id)+"&source=eq.pluralkit&external_id=in."+encodeURIComponent(filter)+"&select=external_id");
    existingIds=new Set((existing||[]).map((f:any)=>String(f.external_id)));
  }

  const allPkMemberIds=[...new Set(validSwitches.flatMap((sw:any)=>
    (Array.isArray(sw.members)?sw.members:[])
      .map((m:any)=>typeof m==="string"?m:m?.id)
      .filter(Boolean)
      .map((id:any)=>String(id))
  ))];

  const localMemberMap=new Map<string,string>();
  if(allPkMemberIds.length){
    const filter="("+allPkMemberIds.map((id:string)=>id.replace(/[^A-Za-z0-9_-]/g,"")).join(",")+")";
    const localMembers=await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&pk_id=in."+encodeURIComponent(filter)+"&select=id,pk_id");
    for(const m of localMembers||[])if(m.pk_id&&m.id)localMemberMap.set(String(m.pk_id),String(m.id));
  }

  let added=0,skipped=0,unresolved=0;
  for(const sw of validSwitches){
    if(existingIds.has(String(sw.id))){skipped++;continue}

    const memberIds=(Array.isArray(sw.members)?sw.members:[])
      .map((m:any)=>typeof m==="string"?m:m?.id)
      .filter(Boolean)
      .map((id:any)=>String(id));

    const localMembers:string[]=[];
    for(const pkId of memberIds){
      const localId=localMemberMap.get(pkId);
      if(localId)localMembers.push(localId);else unresolved++;
    }

    const newer=await admin("/rest/v1/fronts?user_id=eq."+encodeURIComponent(user.id)+"&started_at=gt."+encodeURIComponent(sw.timestamp)+"&order=started_at.asc&select=started_at&limit=1");
    const created=await admin("/rest/v1/fronts",{
      method:"POST",headers:{Prefer:"return=representation"},
      body:JSON.stringify({user_id:user.id,started_at:sw.timestamp,ended_at:newer?.[0]?.started_at||null,note:null,source:"pluralkit",external_id:sw.id})
    });

    const frontId=created?.[0]?.id;
    if(frontId){
      for(const memberId of localMembers){
        await admin("/rest/v1/front_members",{
          method:"POST",headers:{Prefer:"return=minimal"},
          body:JSON.stringify({user_id:user.id,front_id:frontId,member_id:memberId,joined_at:sw.timestamp,left_at:newer?.[0]?.started_at||null})
        });
      }
      const older=await admin("/rest/v1/fronts?user_id=eq."+encodeURIComponent(user.id)+"&started_at=lt."+encodeURIComponent(sw.timestamp)+"&ended_at=is.null&select=id&limit=20");
      for(const f of older||[])await admin("/rest/v1/fronts?id=eq."+encodeURIComponent(f.id),{
        method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({ended_at:sw.timestamp})
      });
      added++;
    }
  }

  const oldest=(switches||[]).length?switches[switches.length-1]?.timestamp:null;
  return {
    processed:(switches||[]).length,
    added,
    skipped,
    unresolved,
    nextBefore:(switches||[]).length===limit?oldest:null
  };
}

async function actionImportMedia(user:any,body:any){
  const kind=String(body.kind||""); const url=String(body.url||"");
  const path=await storeImage(user.id,kind,url);
  return {path};
}

const ACTION_LIMITS:Record<string,{limit:number,window:number}> = {
  pk_connect:{limit:10,window:60},
  pk_status:{limit:120,window:60},
  pk_disconnect:{limit:10,window:60},
  pk_mirror_front:{limit:60,window:60},
  pk_compare:{limit:30,window:60},
  pk_import:{limit:120,window:60},
  pk_import_groups:{limit:10,window:60},
  pk_get_system:{limit:60,window:60},
  pk_update_system:{limit:20,window:60},
  pk_import_fronts:{limit:120,window:60},
  import_media:{limit:30,window:60},
  upload_media:{limit:60,window:60},
};
const AUDITED_ACTIONS=new Set([
  "pk_connect","pk_disconnect","pk_mirror_front","pk_import","pk_import_groups",
  "pk_update_system","pk_import_fronts","import_media","upload_media"
]);
async function consumeRateLimit(userId:string,action:string){
  const spec=ACTION_LIMITS[action]||{limit:30,window:60};
  const globalOk=await admin("/rest/v1/rpc/consume_nihility_rate_limit",{
    method:"POST",
    body:JSON.stringify({p_user_id:userId,p_action:"__global__",p_limit:240,p_window_seconds:60})
  });
  if(globalOk!==true)throw new ClientError("Too many requests. Please wait a moment and try again.",429);
  const actionOk=await admin("/rest/v1/rpc/consume_nihility_rate_limit",{
    method:"POST",
    body:JSON.stringify({p_user_id:userId,p_action:action,p_limit:spec.limit,p_window_seconds:spec.window})
  });
  if(actionOk!==true)throw new ClientError("This action is being used too quickly. Please wait a moment and try again.",429);
}
async function recordSecurityEvent(userId:string|null,eventType:string,success:boolean,details:Record<string,unknown>={}){
  try{
    await admin("/rest/v1/rpc/record_nihility_security_event",{
      method:"POST",
      body:JSON.stringify({p_user_id:userId,p_event_type:eventType,p_success:success,p_details:details})
    });
  }catch(error){
    console.warn("Unable to record security event",eventType,error);
  }
}

async function readJsonBody(req:Request,maxBytes=65536){
  const declared=Number(req.headers.get("content-length")||0);
  if(Number.isFinite(declared)&&declared>maxBytes)throw new ClientError("Request body is too large");
  const reader=req.body?.getReader();
  if(!reader)return {};
  const chunks:Uint8Array[]=[];let total=0;
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    if(value){
      total+=value.length;
      if(total>maxBytes){await reader.cancel();throw new ClientError("Request body is too large")}
      chunks.push(value);
    }
  }
  if(total===0)return {};
  const bytes=new Uint8Array(total);let off=0;
  for(const chunk of chunks){bytes.set(chunk,off);off+=chunk.length}
  const text=new TextDecoder().decode(bytes);
  try{return JSON.parse(text)}catch{throw new ClientError("Invalid JSON request body")}
}

Deno.serve(async(req)=>{
  const origin=req.headers.get("Origin");
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(origin)});
  if(origin && !ALLOWED_ORIGINS.has(origin))return json({error:"Origin not allowed"},403,origin);
  if(req.method!=="POST")return json({error:"Method not allowed"},405,origin);

  let user:any=null;
  let action="unknown";
  try{
    user=await currentUser(req);
    const profile=await admin("/rest/v1/profiles?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id&limit=1");
    if(!profile?.length)throw new ClientError("Nihility profile required",403);

    const headerAction=String(req.headers.get("x-nihility-action")||"");
    if(headerAction==="upload_media"){
      action="upload_media";
      await consumeRateLimit(user.id,action);
      const result=await actionUploadMedia(user,req);
      await recordSecurityEvent(user.id,"edge."+action,true,{origin:origin||null});
      return json(result,200,origin);
    }

    const body=await readJsonBody(req);
    action=String(body.action||"");
    if(!ACTION_LIMITS[action])throw new ClientError("Unknown action",400);
    await consumeRateLimit(user.id,action);

    let result;
    if(action==="pk_connect")result=await actionConnect(user,body);
    else if(action==="pk_status")result=await actionStatus(user);
    else if(action==="pk_disconnect")result=await actionDisconnect(user);
    else if(action==="pk_mirror_front")result=await actionMirror(user,body);
    else if(action==="pk_compare")result=await actionComparePk(user);
    else if(action==="pk_import")result=await actionImportPk(user,body);
    else if(action==="pk_import_groups")result=await actionImportPkGroups(user);
    else if(action==="pk_get_system")result=await actionGetPkSystem(user);
    else if(action==="pk_update_system")result=await actionUpdatePkSystem(user,body);
    else if(action==="pk_import_fronts")result=await actionImportPkFronts(user,body);
    else if(action==="import_media")result=await actionImportMedia(user,body);
    else throw new ClientError("Unknown action",400);

    if(AUDITED_ACTIONS.has(action)){
      await recordSecurityEvent(user.id,"edge."+action,true,{origin:origin||null});
    }
    return json(result,200,origin);
  }catch(error){
    if(user?.id&&AUDITED_ACTIONS.has(action)){
      await recordSecurityEvent(user.id,"edge."+action,false,{origin:origin||null});
    }
    if(error instanceof ClientError)return json({error:error.message},error.status,origin);
    console.error("Unhandled nihility-secure error",action,error);
    return json({error:"Request failed. Please try again."},500,origin);
  }
});

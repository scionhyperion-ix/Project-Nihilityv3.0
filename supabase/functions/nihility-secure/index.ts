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
  "cdn.pluralkit.me",
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
  const headers:Record<string,string>={
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-nihility-action, x-media-kind",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site"
  };
  if(origin&&ALLOWED_ORIGINS.has(origin))headers["Access-Control-Allow-Origin"]=origin;
  return headers;
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

async function adminAll(path:string,pageSize=1000,maxRows=500000){
  const out:any[]=[];
  for(let offset=0;offset<maxRows;offset+=pageSize){
    const join=path.includes("?")?"&":"?";
    const page=await admin(path+join+"limit="+pageSize+"&offset="+offset);
    if(!Array.isArray(page))throw new Error("Expected a database row list");
    out.push(...page);
    if(page.length<pageSize)return out;
  }
  throw new ClientError("Backup is too large to export safely",413);
}
function decodeJwtPayload(token:string){
  const parts=token.split(".");
  if(parts.length!==3)throw new ClientError("Invalid or expired session",401);
  const normalized=parts[1].replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  try{
    const bin=atob(padded);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }catch{throw new ClientError("Invalid or expired session",401)}
}
async function currentUser(req:Request){
  const auth=req.headers.get("Authorization")||"";
  if(!auth.startsWith("Bearer "))throw new ClientError("Authentication required",401);
  const token=auth.slice(7);
  const r=await fetch(SUPABASE_URL+"/auth/v1/user",{headers:{apikey:SERVICE_KEY,Authorization:auth}});
  if(!r.ok)throw new ClientError("Invalid or expired session",401);
  const user=await r.json();
  const payload=decodeJwtPayload(token);
  const sessionId=String(payload?.session_id||"");
  if(!/^[0-9a-fA-F-]{36}$/.test(sessionId))throw new ClientError("Invalid or expired session",401);
  const active=await admin("/rest/v1/rpc/is_nihility_session_active",{
    method:"POST",
    body:JSON.stringify({p_user_id:user.id,p_session_id:sessionId})
  });
  if(active!==true)throw new ClientError("This session has been signed out.",401);
  return user;
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

function pngAnimationFrames(bytes:Uint8Array){
  if(bytes.length<33)return 1;
  let offset=8;
  while(offset+12<=bytes.length){
    const length=u32be(bytes,offset);
    const type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
    const dataStart=offset+8;
    const next=dataStart+length+4;
    if(next>bytes.length)return null;
    if(type==="acTL"){
      if(length<8)return null;
      return u32be(bytes,dataStart);
    }
    offset=next;
  }
  return 1;
}
function webpAnimationFrames(bytes:Uint8Array,maxFrames=100){
  if(bytes.length<12)return null;
  const riff=String.fromCharCode(...bytes.slice(0,4));
  const webp=String.fromCharCode(...bytes.slice(8,12));
  if(riff!=="RIFF"||webp!=="WEBP")return null;
  let offset=12,frames=0,animated=false;
  while(offset+8<=bytes.length){
    const type=String.fromCharCode(...bytes.slice(offset,offset+4));
    const length=(bytes[offset+4]|(bytes[offset+5]<<8)|(bytes[offset+6]<<16)|(bytes[offset+7]<<24))>>>0;
    const dataStart=offset+8;
    const next=dataStart+length+(length&1);
    if(next>bytes.length)return null;
    if(type==="VP8X"&&length>=1) animated=Boolean(bytes[dataStart]&0x02);
    if(type==="ANMF"){
      frames++;
      if(frames>maxFrames)return frames;
    }
    offset=next;
  }
  if(animated&&frames===0)return null;
  return animated?frames:1;
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
  if(type==="image/png"){
    const frames=pngAnimationFrames(bytes);
    if(frames==null)throw new ClientError("Unable to validate PNG structure");
    if(frames>100)throw new ClientError("Animated PNGs are limited to 100 frames");
  }
  if(type==="image/webp"){
    const frames=webpAnimationFrames(bytes,100);
    if(frames==null)throw new ClientError("Unable to validate WebP structure");
    if(frames>100)throw new ClientError("Animated WebP images are limited to 100 frames");
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
async function copyPkImage(userId:string,kind:string,url:string|null,label:string){
  if(!url)return null;
  try{
    return await storeImage(userId,kind,url);
  }catch(error){
    console.warn("Unable to copy PluralKit media",label,error instanceof Error?error.message:String(error));
    return null;
  }
}
function pkMemberMediaUrls(remote:any){
  return{avatar:remote?.avatar_url||null,banner:remote?.banner||remote?.banner_url||null};
}
function pkGroupMediaUrls(remote:any){
  return{icon:remote?.icon||remote?.icon_url||null,banner:remote?.banner||remote?.banner_url||null};
}
async function syncPkMemberMedia(user:any,local:any,remote:any){
  const urls=pkMemberMediaUrls(remote);
  const metadata:any={...(local.metadata||{})};
  const patch:any={};
  const cleanup:Array<{kind:string,path:string}>=[];
  let copied=0,removed=0,failed=0,conflicts=0,changed=false;

  for(const spec of [
    {key:"avatar",kind:"avatar",url:urls.avatar,current:local.avatar_storage_path||null,sourceKey:"avatar_source",pathKey:"avatar_storage_path",urlMeta:"pk_avatar_url",pathMeta:"pk_avatar_storage_path"},
    {key:"banner",kind:"banner",url:urls.banner,current:local.banner_storage_path||null,sourceKey:"banner_source",pathKey:"banner_storage_path",urlMeta:"pk_banner_url",pathMeta:"pk_banner_storage_path"}
  ]){
    const previousUrl=metadata[spec.urlMeta]||null;
    const managedPath=metadata[spec.pathMeta]||null;
    const remoteChanged=previousUrl!==spec.url;
    const missing=Boolean(spec.url&&!spec.current);
    const localStillManaged=Boolean(managedPath&&spec.current===managedPath);

    if(spec.url&&(missing||(remoteChanged&&localStillManaged))){
      const nextPath=await copyPkImage(user.id,spec.kind,spec.url,"member "+String(remote?.id||local?.id||"")+" "+spec.key);
      if(!nextPath){failed++;continue}
      patch[spec.pathKey]=nextPath;
      patch[spec.sourceKey]="supabase";
      metadata[spec.urlMeta]=spec.url;
      metadata[spec.pathMeta]=nextPath;
      if(spec.current&&spec.current!==nextPath&&localStillManaged)cleanup.push({kind:spec.kind,path:spec.current});
      copied++;changed=true;
      continue;
    }

    if(!spec.url&&remoteChanged&&localStillManaged){
      patch[spec.pathKey]=null;
      patch[spec.sourceKey]=null;
      metadata[spec.urlMeta]=null;
      metadata[spec.pathMeta]=null;
      if(spec.current)cleanup.push({kind:spec.kind,path:spec.current});
      removed++;changed=true;
      continue;
    }

    if(remoteChanged){
      // A local image exists, but it is not proven to be the last PK-managed
      // copy. Preserve the Nihility image instead of overwriting it blindly.
      conflicts++;
      continue;
    }

    // Repair old imports where the PK URL was recorded but the image copy failed.
    if(spec.url&&spec.current&&managedPath===spec.current&&metadata[spec.urlMeta]!==spec.url){
      metadata[spec.urlMeta]=spec.url;changed=true;
    }
  }

  if(changed){
    patch.metadata=metadata;
    await admin("/rest/v1/members?id=eq."+encodeURIComponent(local.id),{
      method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify(patch)
    });
    if(Object.prototype.hasOwnProperty.call(patch,"avatar_storage_path"))local.avatar_storage_path=patch.avatar_storage_path;
    if(Object.prototype.hasOwnProperty.call(patch,"banner_storage_path"))local.banner_storage_path=patch.banner_storage_path;
    if(Object.prototype.hasOwnProperty.call(patch,"avatar_source"))local.avatar_source=patch.avatar_source;
    if(Object.prototype.hasOwnProperty.call(patch,"banner_source"))local.banner_source=patch.banner_source;
    local.metadata=metadata;
    await Promise.allSettled(cleanup.map(item=>deleteStoredMedia(user.id,item.kind,item.path)));
  }
  return{copied,removed,failed,conflicts};
}
async function syncPkGroupMedia(user:any,local:any,remote:any){
  const urls=pkGroupMediaUrls(remote);
  const metadata:any={...(local.metadata||{})};
  const patch:any={};
  const cleanup:Array<{kind:string,path:string}>=[];
  let copied=0,removed=0,failed=0,conflicts=0,changed=false;

  for(const spec of [
    {key:"icon",kind:"avatar",url:urls.icon,current:local.icon_storage_path||metadata.icon_storage_path||null,pathKey:"icon_storage_path",urlMeta:"pk_icon_url",pathMeta:"pk_icon_storage_path"},
    {key:"banner",kind:"banner",url:urls.banner,current:metadata.banner_storage_path||null,pathKey:null,urlMeta:"pk_banner_url",pathMeta:"pk_banner_storage_path"}
  ]){
    const previousUrl=metadata[spec.urlMeta]||null;
    const managedPath=metadata[spec.pathMeta]||null;
    const remoteChanged=previousUrl!==spec.url;
    const missing=Boolean(spec.url&&!spec.current);
    const localStillManaged=Boolean(managedPath&&spec.current===managedPath);

    if(spec.url&&(missing||(remoteChanged&&localStillManaged))){
      const nextPath=await copyPkImage(user.id,spec.kind,spec.url,"group "+String(remote?.id||local?.id||"")+" "+spec.key);
      if(!nextPath){failed++;continue}
      if(spec.pathKey)patch[spec.pathKey]=nextPath;
      metadata[spec.key==="icon"?"icon_storage_path":"banner_storage_path"]=nextPath;
      metadata[spec.urlMeta]=spec.url;
      metadata[spec.pathMeta]=nextPath;
      if(spec.current&&spec.current!==nextPath&&localStillManaged)cleanup.push({kind:spec.kind,path:spec.current});
      copied++;changed=true;
      continue;
    }

    if(!spec.url&&remoteChanged&&localStillManaged){
      if(spec.pathKey)patch[spec.pathKey]=null;
      metadata[spec.key==="icon"?"icon_storage_path":"banner_storage_path"]=null;
      metadata[spec.urlMeta]=null;
      metadata[spec.pathMeta]=null;
      if(spec.current)cleanup.push({kind:spec.kind,path:spec.current});
      removed++;changed=true;
      continue;
    }

    if(remoteChanged){conflicts++;continue}
  }

  if(changed){
    patch.metadata=metadata;
    await admin("/rest/v1/groups?id=eq."+encodeURIComponent(local.id),{
      method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify(patch)
    });
    if(Object.prototype.hasOwnProperty.call(patch,"icon_storage_path"))local.icon_storage_path=patch.icon_storage_path;
    local.metadata=metadata;
    await Promise.allSettled(cleanup.map(item=>deleteStoredMedia(user.id,item.kind,item.path)));
  }
  return{copied,removed,failed,conflicts};
}
async function syncPkSystemMedia(user:any,remote:any){
  const rows=await admin("/rest/v1/app_settings?user_id=eq."+encodeURIComponent(user.id)+"&select=settings&limit=1");
  const settings=rows?.[0]?.settings||{};
  const profile:any={...(settings.system_profile||{})};
  const baseline:any={...(profile.pk_media_v1||{})};
  const urls={avatar:remote?.avatar_url||null,banner:remote?.banner||remote?.banner_url||null};
  const cleanup:Array<{kind:string,path:string}>=[];
  let copied=0,removed=0,failed=0,conflicts=0,changed=false;

  for(const spec of [
    {key:"avatar",kind:"avatar",url:urls.avatar,current:profile.avatar_storage_path||null},
    {key:"banner",kind:"banner",url:urls.banner,current:profile.banner_storage_path||null}
  ]){
    const previousUrl=baseline[spec.key+"_url"]??(profile[spec.key==="avatar"?"avatar_url":"banner"]||null);
    const managedPath=baseline[spec.key+"_storage_path"]||null;
    const remoteChanged=previousUrl!==spec.url;
    const missing=Boolean(spec.url&&!spec.current);
    const localStillManaged=Boolean(managedPath&&spec.current===managedPath);

    if(spec.url&&(missing||(remoteChanged&&localStillManaged))){
      const nextPath=await copyPkImage(user.id,spec.kind,spec.url,"system "+spec.key);
      if(!nextPath){failed++;continue}
      profile[spec.key+"_storage_path"]=nextPath;
      baseline[spec.key+"_url"]=spec.url;
      baseline[spec.key+"_storage_path"]=nextPath;
      if(spec.current&&spec.current!==nextPath&&localStillManaged)cleanup.push({kind:spec.kind,path:spec.current});
      copied++;changed=true;
      continue;
    }
    if(!spec.url&&remoteChanged&&localStillManaged){
      profile[spec.key+"_storage_path"]=null;
      baseline[spec.key+"_url"]=null;
      baseline[spec.key+"_storage_path"]=null;
      if(spec.current)cleanup.push({kind:spec.kind,path:spec.current});
      removed++;changed=true;
      continue;
    }
    if(remoteChanged){conflicts++;continue}
  }

  if(changed){
    profile.avatar_url=urls.avatar;
    profile.banner=urls.banner;
    profile.pk_media_v1=baseline;
    const merged={...settings,system_profile:profile,system_name:profile.name||settings.system_name||null};
    await admin("/rest/v1/app_settings?on_conflict=user_id",{
      method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify({user_id:user.id,settings:merged})
    });
    await Promise.allSettled(cleanup.map(item=>deleteStoredMedia(user.id,item.kind,item.path)));
  }
  return{copied,removed,failed,conflicts};
}
async function syncPkMediaToNihility(user:any,token:string,state:any){
  const totals={copied:0,removed:0,failed:0,conflicts:0};
  for(const local of state.localMembers||[]){
    const remote=findPkForLocal(local,state.pkMemberByKey);if(!remote)continue;
    const result=await syncPkMemberMedia(user,local,remote);
    totals.copied+=result.copied;totals.removed+=result.removed;totals.failed+=result.failed;totals.conflicts+=result.conflicts;
  }
  for(const local of state.localGroups||[]){
    const remote=findPkForLocal(local,state.pkGroupByKey);if(!remote)continue;
    const result=await syncPkGroupMedia(user,local,remote);
    totals.copied+=result.copied;totals.removed+=result.removed;totals.failed+=result.failed;totals.conflicts+=result.conflicts;
  }
  const system=await pk(token,"/systems/@me");
  const systemResult=await syncPkSystemMedia(user,system);
  totals.copied+=systemResult.copied;totals.removed+=systemResult.removed;totals.failed+=systemResult.failed;totals.conflicts+=systemResult.conflicts;
  return totals;
}
async function deleteStoredMedia(userId:string,kind:string,path:string|null|undefined){
  if(!path)return;
  const cfg=BUCKETS[kind];
  if(!cfg)return;
  const normalized=String(path);
  if(!normalized.startsWith(userId+"/"))throw new Error("Refusing to delete media outside user namespace");
  const response=await fetch(SUPABASE_URL+"/storage/v1/object/"+encodeURIComponent(cfg.name)+"/"+normalized.split("/").map(encodeURIComponent).join("/"),{
    method:"DELETE",
    headers:{apikey:SERVICE_KEY,Authorization:"Bearer "+SERVICE_KEY}
  });
  if(!response.ok&&response.status!==404){
    console.warn("Unable to delete member media",cfg.name,response.status);
  }
}
async function actionDeleteMember(user:any,body:any){
  const memberId=String(body.memberId||"").trim();
  if(!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(memberId)){
    throw new ClientError("Invalid member",400);
  }
  const rows=await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&id=eq."+encodeURIComponent(memberId)+"&select=id,name,avatar_storage_path,banner_storage_path&limit=1");
  const member=rows?.[0];
  if(!member)throw new ClientError("Member not found",404);

  await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&id=eq."+encodeURIComponent(memberId),{
    method:"DELETE",
    headers:{Prefer:"return=minimal"}
  });

  await Promise.allSettled([
    deleteStoredMedia(user.id,"avatar",member.avatar_storage_path),
    deleteStoredMedia(user.id,"banner",member.banner_storage_path)
  ]);
  return {deleted:true,memberId};
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
    body:JSON.stringify({user_id:user.id,provider:"pluralkit",external_system_id:system.id||null,external_system_name:system.name||system.id||"PluralKit system",share_fronting_updates:false,connected_at:new Date().toISOString()})
  });
  return {connected:true,system:{id:system.id||null,name:system.name||null}};
}
async function actionStatus(user:any){
  const rows=await admin("/rest/v1/integration_secrets?user_id=eq."+encodeURIComponent(user.id)+"&provider=eq.pluralkit&select=provider&limit=1");
  return {connected:Boolean(rows?.length)};
}
async function actionDisconnect(user:any){
  await admin("/rest/v1/integration_secrets?user_id=eq."+encodeURIComponent(user.id)+"&provider=eq.pluralkit",{method:"DELETE"});
  await admin("/rest/v1/external_integrations?user_id=eq."+encodeURIComponent(user.id)+"&provider=eq.pluralkit",{method:"DELETE"});
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

const MEMBER_SYNC_FIELDS=["name","display_name","pronouns","color","description","birthday","proxy_tags","keep_proxy"];
const GROUP_SYNC_FIELDS=["name","display_name","description","color"];

function syncText(value:any){
  if(value===undefined||value===null)return null;
  const text=String(value);
  return text===""?null:text;
}
function syncColor(value:any){
  const text=String(value||"").replace(/^#/,"").toLowerCase();
  return text||null;
}
function syncProxyTags(value:any){
  if(!Array.isArray(value))return [];
  return value.map((tag:any)=>({
    prefix:tag?.prefix==null?null:String(tag.prefix),
    suffix:tag?.suffix==null?null:String(tag.suffix)
  }));
}
function canonicalPkMember(m:any){
  return {
    name:String(m?.name||m?.display_name||m?.id||""),
    display_name:syncText(m?.display_name),
    pronouns:syncText(m?.pronouns),
    color:syncColor(m?.color),
    description:syncText(m?.description),
    birthday:syncText(m?.birthday),
    proxy_tags:syncProxyTags(m?.proxy_tags),
    keep_proxy:Boolean(m?.keep_proxy)
  };
}
function canonicalLocalMember(m:any){
  return {
    name:String(m?.name||m?.display_name||m?.id||""),
    display_name:syncText(m?.display_name),
    pronouns:syncText(m?.pronouns),
    color:syncColor(m?.color),
    description:syncText(m?.description),
    birthday:syncText(m?.birthday),
    proxy_tags:syncProxyTags(m?.metadata?.proxy_tags),
    keep_proxy:Boolean(m?.metadata?.keep_proxy)
  };
}
function canonicalPkGroup(g:any){
  return {
    name:String(g?.name||g?.display_name||g?.id||""),
    display_name:syncText(g?.display_name),
    description:syncText(g?.description),
    color:syncColor(g?.color)
  };
}
function canonicalLocalGroup(g:any){
  return {
    name:String(g?.name||g?.display_name||g?.id||""),
    display_name:syncText(g?.display_name),
    description:syncText(g?.description),
    color:syncColor(g?.color)
  };
}
function syncEqual(a:any,b:any){return JSON.stringify(a)===JSON.stringify(b)}
function analyzeSyncFields(local:any,remote:any,baseline:any,fields:string[]){
  const pull:string[]=[],push:string[]=[],conflicts:string[]=[],same:string[]=[];
  for(const field of fields){
    const lv=local[field],rv=remote[field];
    if(syncEqual(lv,rv)){same.push(field);continue}
    const hasBaseline=baseline&&Object.prototype.hasOwnProperty.call(baseline,field);
    if(hasBaseline){
      const bv=baseline[field];
      if(syncEqual(lv,bv)&&!syncEqual(rv,bv)){pull.push(field);continue}
      if(syncEqual(rv,bv)&&!syncEqual(lv,bv)){push.push(field);continue}
    }
    conflicts.push(field);
  }
  return {pull,push,conflicts,same};
}
function labelSyncItem(item:any){return item?.display_name||item?.name||item?.id||"Unnamed"}
function trimSyncItems(items:any[],limit=20){return items.slice(0,limit)}
function memberPkPayload(fields:any){
  const payload:any={};
  for(const key of MEMBER_SYNC_FIELDS)if(Object.prototype.hasOwnProperty.call(fields,key))payload[key]=fields[key];
  return payload;
}
function groupPkPayload(fields:any){
  const payload:any={};
  for(const key of GROUP_SYNC_FIELDS)if(Object.prototype.hasOwnProperty.call(fields,key))payload[key]=fields[key];
  return payload;
}
function validatePkMemberPayload(payload:any){
  if(payload.name&&String(payload.name).length>100)return "Member name exceeds PluralKit's 100-character limit";
  if(payload.display_name&&String(payload.display_name).length>100)return "Member display name exceeds PluralKit's 100-character limit";
  if(payload.pronouns&&String(payload.pronouns).length>100)return "Member pronouns exceed PluralKit's 100-character limit";
  if(payload.description&&String(payload.description).length>1000)return "Member description exceeds PluralKit's 1000-character limit";
  return null;
}
function validatePkGroupPayload(payload:any){
  if(payload.name&&String(payload.name).length>100)return "Group name exceeds PluralKit's 100-character limit";
  if(payload.display_name&&String(payload.display_name).length>100)return "Group display name exceeds PluralKit's 100-character limit";
  if(payload.description&&String(payload.description).length>1000)return "Group description exceeds PluralKit's 1000-character limit";
  return null;
}
async function loadPkTwoWayState(user:any,token:string){
  const [pkMembers,pkGroups,localMembers,localGroups,links]=await Promise.all([
    pk(token,"/systems/@me/members"),
    pk(token,"/systems/@me/groups?with_members=true"),
    admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&archived_at=is.null&select=id,name,display_name,pronouns,color,description,birthday,avatar_storage_path,banner_storage_path,pk_id,metadata,updated_at"),
    admin("/rest/v1/groups?user_id=eq."+encodeURIComponent(user.id)+"&select=id,name,display_name,description,color,icon_storage_path,pk_id,metadata,updated_at"),
    admin("/rest/v1/member_groups?user_id=eq."+encodeURIComponent(user.id)+"&select=member_id,group_id")
  ]);

  const localMemberByRemote=new Map<string,any>();
  for(const m of localMembers||[]){
    if(m.pk_id)localMemberByRemote.set(String(m.pk_id),m);
    if(m.metadata?.pk_uuid)localMemberByRemote.set(String(m.metadata.pk_uuid),m);
  }
  const pkMemberByKey=new Map<string,any>();
  for(const m of pkMembers||[]){
    if(m.id)pkMemberByKey.set(String(m.id),m);
    if(m.uuid)pkMemberByKey.set(String(m.uuid),m);
  }
  const localGroupByRemote=new Map<string,any>();
  for(const g of localGroups||[]){
    if(g.pk_id)localGroupByRemote.set(String(g.pk_id),g);
    if(g.metadata?.pk_uuid)localGroupByRemote.set(String(g.metadata.pk_uuid),g);
  }
  const pkGroupByKey=new Map<string,any>();
  for(const g of pkGroups||[]){
    if(g.id)pkGroupByKey.set(String(g.id),g);
    if(g.uuid)pkGroupByKey.set(String(g.uuid),g);
  }

  return {pkMembers:pkMembers||[],pkGroups:pkGroups||[],localMembers:localMembers||[],localGroups:localGroups||[],links:links||[],localMemberByRemote,pkMemberByKey,localGroupByRemote,pkGroupByKey};
}
function findPkForLocal(local:any,map:Map<string,any>){
  return (local?.pk_id&&map.get(String(local.pk_id)))||(local?.metadata?.pk_uuid&&map.get(String(local.metadata.pk_uuid)))||null;
}
function findLocalForPk(remote:any,map:Map<string,any>){
  return (remote?.id&&map.get(String(remote.id)))||(remote?.uuid&&map.get(String(remote.uuid)))||null;
}
function remoteGroupMemberLocalIds(group:any,state:any){
  const ids:string[]=[];
  for(const ref of Array.isArray(group?.members)?group.members:[]){
    const key=typeof ref==="string"?ref:(ref?.id||ref?.uuid||"");
    const local=findLocalForPk({id:key,uuid:key},state.localMemberByRemote);
    if(local?.id)ids.push(String(local.id));
  }
  return [...new Set(ids)].sort();
}
function localGroupMemberIds(group:any,state:any){
  return [...new Set((state.links||[]).filter((x:any)=>String(x.group_id)===String(group.id)).map((x:any)=>String(x.member_id)))].sort();
}
function analyzeMembership(localIds:string[],remoteIds:string[],baseline:any){
  if(syncEqual(localIds,remoteIds))return "same";
  if(Array.isArray(baseline)){
    if(syncEqual(localIds,baseline)&&!syncEqual(remoteIds,baseline))return "pull";
    if(syncEqual(remoteIds,baseline)&&!syncEqual(localIds,baseline))return "push";
  }
  return "conflict";
}
async function buildPkSyncComparison(user:any,token:string){
  const state=await loadPkTwoWayState(user,token);
  const missingInNihilityMembers=state.pkMembers.filter((m:any)=>!findLocalForPk(m,state.localMemberByRemote));
  const missingInPkMembers=state.localMembers.filter((m:any)=>!findPkForLocal(m,state.pkMemberByKey));
  const missingInNihilityGroups=state.pkGroups.filter((g:any)=>!findLocalForPk(g,state.localGroupByRemote));
  const missingInPkGroups=state.localGroups.filter((g:any)=>!findPkForLocal(g,state.pkGroupByKey));

  const memberPull:any[]=[],memberPush:any[]=[],memberConflicts:any[]=[];
  for(const local of state.localMembers){
    const remote=findPkForLocal(local,state.pkMemberByKey);if(!remote)continue;
    const analysis=analyzeSyncFields(canonicalLocalMember(local),canonicalPkMember(remote),local.metadata?.pk_sync_v1?.fields,MEMBER_SYNC_FIELDS);
    const item={localId:local.id,pkId:remote.id,name:labelSyncItem(local),fields:[] as string[]};
    if(analysis.pull.length){memberPull.push({...item,fields:analysis.pull})}
    if(analysis.push.length){memberPush.push({...item,fields:analysis.push})}
    if(analysis.conflicts.length){memberConflicts.push({...item,fields:analysis.conflicts})}
  }

  const groupPull:any[]=[],groupPush:any[]=[],groupConflicts:any[]=[];
  const membershipPull:any[]=[],membershipPush:any[]=[],membershipConflicts:any[]=[];
  for(const local of state.localGroups){
    const remote=findPkForLocal(local,state.pkGroupByKey);if(!remote)continue;
    const analysis=analyzeSyncFields(canonicalLocalGroup(local),canonicalPkGroup(remote),local.metadata?.pk_sync_v1?.fields,GROUP_SYNC_FIELDS);
    const item={localId:local.id,pkId:remote.id,name:labelSyncItem(local),fields:[] as string[]};
    if(analysis.pull.length)groupPull.push({...item,fields:analysis.pull});
    if(analysis.push.length)groupPush.push({...item,fields:analysis.push});
    if(analysis.conflicts.length)groupConflicts.push({...item,fields:analysis.conflicts});

    const localIds=localGroupMemberIds(local,state);
    const remoteIds=remoteGroupMemberLocalIds(remote,state);
    const membership=analyzeMembership(localIds,remoteIds,local.metadata?.pk_sync_v1?.member_ids);
    if(membership==="pull")membershipPull.push(item);
    else if(membership==="push")membershipPush.push(item);
    else if(membership==="conflict")membershipConflicts.push(item);
  }

  return {
    counts:{
      pkMembers:state.pkMembers.length,
      nihilityMembers:state.localMembers.length,
      pkGroups:state.pkGroups.length,
      nihilityGroups:state.localGroups.length
    },
    members:{
      missingInNihility:{count:missingInNihilityMembers.length,items:trimSyncItems(missingInNihilityMembers.map((m:any)=>({pkId:m.id,name:labelSyncItem(m)})))},
      missingInPk:{count:missingInPkMembers.length,items:trimSyncItems(missingInPkMembers.map((m:any)=>({localId:m.id,name:labelSyncItem(m)})))},
      toNihility:{count:memberPull.length,items:trimSyncItems(memberPull)},
      toPk:{count:memberPush.length,items:trimSyncItems(memberPush)},
      conflicts:{count:memberConflicts.length,items:trimSyncItems(memberConflicts)}
    },
    groups:{
      missingInNihility:{count:missingInNihilityGroups.length,items:trimSyncItems(missingInNihilityGroups.map((g:any)=>({pkId:g.id,name:labelSyncItem(g)})))},
      missingInPk:{count:missingInPkGroups.length,items:trimSyncItems(missingInPkGroups.map((g:any)=>({localId:g.id,name:labelSyncItem(g)})))},
      toNihility:{count:groupPull.length,items:trimSyncItems(groupPull)},
      toPk:{count:groupPush.length,items:trimSyncItems(groupPush)},
      conflicts:{count:groupConflicts.length,items:trimSyncItems(groupConflicts)}
    },
    memberships:{
      toNihility:{count:membershipPull.length,items:trimSyncItems(membershipPull)},
      toPk:{count:membershipPush.length,items:trimSyncItems(membershipPush)},
      conflicts:{count:membershipConflicts.length,items:trimSyncItems(membershipConflicts)}
    },
    mediaNote:"Two-way sync covers member/group details and group memberships. Private image files are left unchanged because PluralKit requires publicly accessible image URLs."
  };
}
async function actionPkSyncCompare(user:any){
  const token=await getSecret(user.id);
  return buildPkSyncComparison(user,token);
}
async function importPkMemberForSync(user:any,pm:any){
  let avatarPath=null,bannerPath=null;
  const avatar=pm.avatar_url||null,banner=pm.banner||pm.banner_url||null;
  if(avatar){try{avatarPath=await storeImage(user.id,"avatar",avatar)}catch{}}
  if(banner){try{bannerPath=await storeImage(user.id,"banner",banner)}catch{}}
  const fields=canonicalPkMember(pm);
  const rows=await admin("/rest/v1/members",{
    method:"POST",headers:{Prefer:"return=representation"},
    body:JSON.stringify({
      user_id:user.id,...fields,
      proxy_tags:undefined,keep_proxy:undefined,
      avatar_url:null,avatar_source:avatarPath?"supabase":null,avatar_storage_path:avatarPath,
      banner_url:null,banner_source:bannerPath?"supabase":null,banner_storage_path:bannerPath,
      pk_id:pm.id,metadata:{pk_uuid:pm.uuid||null,pk_avatar_url:avatar,pk_banner_url:banner,pk_avatar_storage_path:avatarPath,pk_banner_storage_path:bannerPath,proxy_tags:fields.proxy_tags,keep_proxy:fields.keep_proxy,pk_sync_v1:{fields}},archived_at:null
    })
  });
  return rows?.[0]||null;
}
async function importPkGroupForSync(user:any,pg:any){
  let iconPath=null,bannerPath=null;
  const icon=pg.icon||pg.icon_url||null,banner=pg.banner||pg.banner_url||null;
  if(icon){try{iconPath=await storeImage(user.id,"avatar",icon)}catch{}}
  if(banner){try{bannerPath=await storeImage(user.id,"banner",banner)}catch{}}
  const fields=canonicalPkGroup(pg);
  const rows=await admin("/rest/v1/groups",{
    method:"POST",headers:{Prefer:"return=representation"},
    body:JSON.stringify({
      user_id:user.id,...fields,
      icon_url:null,icon_source:null,icon_storage_path:iconPath,pk_id:pg.id,
      metadata:{pk_uuid:pg.uuid||null,pk_icon_url:icon,pk_banner_url:banner,pk_icon_storage_path:iconPath,pk_banner_storage_path:bannerPath,icon_storage_path:iconPath,banner_storage_path:bannerPath,pk_sync_v1:{fields,origin:"pk"}}
    })
  });
  return rows?.[0]||null;
}
async function createPkMemberFromLocal(user:any,token:string,local:any){
  const fields=canonicalLocalMember(local),payload=memberPkPayload(fields);
  const blocked=validatePkMemberPayload(payload);if(blocked)return {blocked};
  const created=await pk(token,"/members",{method:"POST",body:JSON.stringify(payload)});
  const metadata={...(local.metadata||{}),pk_uuid:created?.uuid||null,pk_sync_v1:{fields:canonicalPkMember(created)}};
  await admin("/rest/v1/members?id=eq."+encodeURIComponent(local.id),{
    method:"PATCH",headers:{Prefer:"return=minimal"},
    body:JSON.stringify({pk_id:created.id,metadata})
  });
  return {created};
}
async function createPkGroupFromLocal(user:any,token:string,local:any){
  const fields=canonicalLocalGroup(local),payload=groupPkPayload(fields);
  const blocked=validatePkGroupPayload(payload);if(blocked)return {blocked};
  const created=await pk(token,"/groups",{method:"POST",body:JSON.stringify(payload)});
  const metadata={...(local.metadata||{}),pk_uuid:created?.uuid||null,pk_sync_v1:{fields:canonicalPkGroup(created),origin:"nihility"}};
  await admin("/rest/v1/groups?id=eq."+encodeURIComponent(local.id),{
    method:"PATCH",headers:{Prefer:"return=minimal"},
    body:JSON.stringify({pk_id:created.id,metadata})
  });
  return {created};
}
async function actionPkSyncApply(user:any,body:any){
  const token=await getSecret(user.id);
  const conflictPolicy=["skip","nihility","pk"].includes(String(body?.conflictPolicy))?String(body.conflictPolicy):"skip";
  let state=await loadPkTwoWayState(user,token);
  const result:any={members:{toNihility:0,toPk:0,createdInNihility:0,createdInPk:0},groups:{toNihility:0,toPk:0,createdInNihility:0,createdInPk:0},memberships:{toNihility:0,toPk:0},conflictsSkipped:0,blocked:[] as string[]};

  for(const remote of state.pkMembers){
    if(findLocalForPk(remote,state.localMemberByRemote))continue;
    await importPkMemberForSync(user,remote);result.members.createdInNihility++;
  }
  for(const local of state.localMembers){
    if(findPkForLocal(local,state.pkMemberByKey))continue;
    const made=await createPkMemberFromLocal(user,token,local);
    if(made.blocked)result.blocked.push(labelSyncItem(local)+": "+made.blocked);
    else result.members.createdInPk++;
  }

  state=await loadPkTwoWayState(user,token);
  for(const remote of state.pkGroups){
    if(findLocalForPk(remote,state.localGroupByRemote))continue;
    await importPkGroupForSync(user,remote);result.groups.createdInNihility++;
  }
  for(const local of state.localGroups){
    if(findPkForLocal(local,state.pkGroupByKey))continue;
    const made=await createPkGroupFromLocal(user,token,local);
    if(made.blocked)result.blocked.push(labelSyncItem(local)+": "+made.blocked);
    else result.groups.createdInPk++;
  }

  state=await loadPkTwoWayState(user,token);
  for(const local of state.localMembers){
    const remote=findPkForLocal(local,state.pkMemberByKey);if(!remote)continue;
    const localFields=canonicalLocalMember(local),remoteFields=canonicalPkMember(remote),baseline=local.metadata?.pk_sync_v1?.fields||{};
    const analysis=analyzeSyncFields(localFields,remoteFields,baseline,MEMBER_SYNC_FIELDS);
    const localPatch:any={},remotePatch:any={},nextBaseline:any={...baseline};
    const metadata:any={...(local.metadata||{})};
    let localChanged=false,remoteChanged=false;
    for(const field of MEMBER_SYNC_FIELDS){
      let mode="same";
      if(analysis.pull.includes(field))mode="pull";
      else if(analysis.push.includes(field))mode="push";
      else if(analysis.conflicts.includes(field))mode=conflictPolicy==="pk"?"pull":conflictPolicy==="nihility"?"push":"conflict";
      if(mode==="conflict"){result.conflictsSkipped++;continue}
      const value=mode==="pull"?remoteFields[field]:localFields[field];
      if(mode==="pull"){
        if(field==="proxy_tags"||field==="keep_proxy"){metadata[field]=value}
        else localPatch[field]=value;
        localChanged=true;result.members.toNihility++;
      }else if(mode==="push"){
        remotePatch[field]=value;remoteChanged=true;result.members.toPk++;
      }
      nextBaseline[field]=value;
    }
    if(Object.keys(remotePatch).length){
      const blocked=validatePkMemberPayload(remotePatch);
      if(blocked){
        result.blocked.push(labelSyncItem(local)+": "+blocked);
        for(const field of Object.keys(remotePatch))delete nextBaseline[field];
        remoteChanged=false;
      }else await pk(token,"/members/"+encodeURIComponent(remote.id),{method:"PATCH",body:JSON.stringify(remotePatch)});
    }
    metadata.pk_sync_v1={...(metadata.pk_sync_v1||{}),fields:nextBaseline};
    if(localChanged||remoteChanged||!syncEqual(local.metadata?.pk_sync_v1?.fields,nextBaseline)){
      localPatch.metadata=metadata;
      await admin("/rest/v1/members?id=eq."+encodeURIComponent(local.id),{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify(localPatch)});
    }
  }

  state=await loadPkTwoWayState(user,token);
  for(const local of state.localGroups){
    const remote=findPkForLocal(local,state.pkGroupByKey);if(!remote)continue;
    const localFields=canonicalLocalGroup(local),remoteFields=canonicalPkGroup(remote),baseline=local.metadata?.pk_sync_v1?.fields||{};
    const analysis=analyzeSyncFields(localFields,remoteFields,baseline,GROUP_SYNC_FIELDS);
    const localPatch:any={},remotePatch:any={},nextBaseline:any={...baseline};
    const metadata:any={...(local.metadata||{})};
    let localChanged=false,remoteChanged=false;
    for(const field of GROUP_SYNC_FIELDS){
      let mode="same";
      if(analysis.pull.includes(field))mode="pull";
      else if(analysis.push.includes(field))mode="push";
      else if(analysis.conflicts.includes(field))mode=conflictPolicy==="pk"?"pull":conflictPolicy==="nihility"?"push":"conflict";
      if(mode==="conflict"){result.conflictsSkipped++;continue}
      const value=mode==="pull"?remoteFields[field]:localFields[field];
      if(mode==="pull"){localPatch[field]=value;localChanged=true;result.groups.toNihility++}
      else if(mode==="push"){remotePatch[field]=value;remoteChanged=true;result.groups.toPk++}
      nextBaseline[field]=value;
    }
    if(Object.keys(remotePatch).length){
      const blocked=validatePkGroupPayload(remotePatch);
      if(blocked){
        result.blocked.push(labelSyncItem(local)+": "+blocked);
        for(const field of Object.keys(remotePatch))delete nextBaseline[field];
        remoteChanged=false;
      }else await pk(token,"/groups/"+encodeURIComponent(remote.id),{method:"PATCH",body:JSON.stringify(remotePatch)});
    }
    metadata.pk_sync_v1={...(metadata.pk_sync_v1||{}),fields:nextBaseline};
    if(localChanged||remoteChanged||!syncEqual(local.metadata?.pk_sync_v1?.fields,nextBaseline)){
      localPatch.metadata=metadata;
      await admin("/rest/v1/groups?id=eq."+encodeURIComponent(local.id),{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify(localPatch)});
    }
  }

  state=await loadPkTwoWayState(user,token);
  const memberByLocalId=new Map<string,any>((state.localMembers||[]).map((m:any)=>[String(m.id),m]));
  for(const local of state.localGroups){
    const remote=findPkForLocal(local,state.pkGroupByKey);if(!remote)continue;
    const localIds=localGroupMemberIds(local,state);
    const remoteIds=remoteGroupMemberLocalIds(remote,state);
    const baseline=local.metadata?.pk_sync_v1?.member_ids;
    let direction=analyzeMembership(localIds,remoteIds,baseline);
    const origin=local.metadata?.pk_sync_v1?.origin;
    if(direction==="conflict"&&!Array.isArray(baseline)&&origin==="pk")direction="pull";
    else if(direction==="conflict"&&!Array.isArray(baseline)&&origin==="nihility")direction="push";
    else if(direction==="conflict")direction=conflictPolicy==="pk"?"pull":conflictPolicy==="nihility"?"push":"conflict";
    let finalIds=localIds;
    if(direction==="pull"){
      const wanted=new Set(remoteIds);
      for(const link of (state.links||[]).filter((x:any)=>String(x.group_id)===String(local.id))){
        if(!wanted.has(String(link.member_id)))await admin("/rest/v1/member_groups?user_id=eq."+encodeURIComponent(user.id)+"&member_id=eq."+encodeURIComponent(link.member_id)+"&group_id=eq."+encodeURIComponent(local.id),{method:"DELETE",headers:{Prefer:"return=minimal"}});
      }
      const current=new Set(localIds);
      for(const memberId of remoteIds)if(!current.has(memberId))await admin("/rest/v1/member_groups",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({user_id:user.id,member_id:memberId,group_id:local.id})});
      finalIds=remoteIds;result.memberships.toNihility++;
    }else if(direction==="push"){
      const refs=localIds.map(id=>memberByLocalId.get(id)?.pk_id).filter(Boolean);
      await pk(token,"/groups/"+encodeURIComponent(remote.id)+"/members/overwrite",{method:"POST",body:JSON.stringify(refs)});
      finalIds=localIds;result.memberships.toPk++;
    }else if(direction==="conflict"){
      result.conflictsSkipped++;continue;
    }else finalIds=localIds;

    const nextSync={...(local.metadata?.pk_sync_v1||{}),member_ids:finalIds};delete nextSync.origin;
    const metadata={...(local.metadata||{}),pk_sync_v1:nextSync};
    await admin("/rest/v1/groups?id=eq."+encodeURIComponent(local.id),{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({metadata})});
  }

  result.comparison=await buildPkSyncComparison(user,token);
  try{
    await admin("/rest/v1/system_events",{
      method:"POST",
      headers:{Prefer:"return=minimal"},
      body:JSON.stringify({
        user_id:user.id,
        event_type:"integration_synced",
        occurred_at:new Date().toISOString(),
        metadata:{
          source:"pluralkit",
          members_to_nihility:result.members.toNihility,
          members_to_pk:result.members.toPk,
          members_created_in_nihility:result.members.createdInNihility,
          members_created_in_pk:result.members.createdInPk,
          groups_to_nihility:result.groups.toNihility,
          groups_to_pk:result.groups.toPk,
          groups_created_in_nihility:result.groups.createdInNihility,
          groups_created_in_pk:result.groups.createdInPk,
          memberships_to_nihility:result.memberships.toNihility,
          memberships_to_pk:result.memberships.toPk,
          conflicts_skipped:result.conflictsSkipped,
          blocked_count:result.blocked.length
        }
      })
    });
  }catch{
    console.warn("Unable to record PluralKit sync timeline summary");
  }
  return result;
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
        pk_id:m.id,metadata:{pk_uuid:m.uuid||null,pk_avatar_url:avatar,pk_banner_url:banner,pk_avatar_storage_path:avatarPath,pk_banner_storage_path:bannerPath,proxy_tags:Array.isArray(m.proxy_tags)?m.proxy_tags:[],keep_proxy:Boolean(m.keep_proxy)},archived_at:null
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
  const oldSystem=existingSettings?.system_profile||{};
  const systemAvatarUrl=pkSystem?.avatar_url||null;
  const systemBannerUrl=pkSystem?.banner||pkSystem?.banner_url||null;
  let systemAvatarPath=oldSystem.avatar_storage_path||null;
  let systemBannerPath=oldSystem.banner_storage_path||null;
  if((oldSystem.avatar_url||null)!==systemAvatarUrl){
    systemAvatarPath=null;
    if(systemAvatarUrl){try{systemAvatarPath=await storeImage(user.id,"avatar",systemAvatarUrl)}catch{}}
  }
  if((oldSystem.banner||oldSystem.banner_url||null)!==systemBannerUrl){
    systemBannerPath=null;
    if(systemBannerUrl){try{systemBannerPath=await storeImage(user.id,"banner",systemBannerUrl)}catch{}}
  }
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

  const localMembers=await admin("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&select=id,name,display_name,pronouns,color,description,birthday,avatar_storage_path,banner_storage_path,pk_id,metadata,archived_at");
  const localGroups=await admin("/rest/v1/groups?user_id=eq."+encodeURIComponent(user.id)+"&select=id,name,display_name,description,color,icon_storage_path,pk_id,metadata");
  const existingLinks=await admin("/rest/v1/member_groups?user_id=eq."+encodeURIComponent(user.id)+"&select=member_id,group_id");

  const memberMap=new Map<string,string>();
  for(const row of localMembers||[]){
    if(row.pk_id)memberMap.set(String(row.pk_id),row.id);
    if(row.metadata?.pk_uuid)memberMap.set(String(row.metadata.pk_uuid),row.id);
  }

  const localByPk=new Map<string,any>();
  for(const row of localMembers||[]){
    if(row.pk_id)localByPk.set(String(row.pk_id),row);
    if(row.metadata?.pk_uuid)localByPk.set(String(row.metadata.pk_uuid),row);
  }

  let membersUpdated=0,membersUnchanged=0,memberMediaCopied=0;
  for(const pm of pkMembers||[]){
    const local=localByPk.get(String(pm.id))||(pm.uuid?localByPk.get(String(pm.uuid)):null);
    if(!local)continue;

    const oldMetadata=local.metadata||{};
    const avatarUrl=pm.avatar_url||null;
    const bannerUrl=pm.banner||pm.banner_url||null;
    let avatarPath=local.avatar_storage_path||null;
    let bannerPath=local.banner_storage_path||null;

    if((oldMetadata.pk_avatar_url||null)!==avatarUrl){
      avatarPath=null;
      if(avatarUrl){
        try{avatarPath=await storeImage(user.id,"avatar",avatarUrl);memberMediaCopied++}catch{}
      }
    }
    if((oldMetadata.pk_banner_url||null)!==bannerUrl){
      bannerPath=null;
      if(bannerUrl){
        try{bannerPath=await storeImage(user.id,"banner",bannerUrl);memberMediaCopied++}catch{}
      }
    }

    const next={
      name:pm.name||pm.display_name||pm.id,
      display_name:pm.display_name||null,
      pronouns:pm.pronouns||null,
      color:pm.color||null,
      description:pm.description||null,
      birthday:pm.birthday||null,
      avatar_url:null,
      avatar_source:avatarPath?"supabase":null,
      avatar_storage_path:avatarPath,
      banner_url:null,
      banner_source:bannerPath?"supabase":null,
      banner_storage_path:bannerPath,
      archived_at:null,
      metadata:{
        ...oldMetadata,
        pk_uuid:pm.uuid||oldMetadata.pk_uuid||null,
        pk_avatar_url:avatarUrl,
        pk_banner_url:bannerUrl,
        proxy_tags:Array.isArray(pm.proxy_tags)?pm.proxy_tags:[],
        keep_proxy:Boolean(pm.keep_proxy)
      }
    };

    const changed=
      local.name!==next.name||
      (local.display_name||null)!==next.display_name||
      (local.pronouns||null)!==next.pronouns||
      (local.color||null)!==next.color||
      (local.description||null)!==next.description||
      (local.birthday||null)!==next.birthday||
      (local.avatar_storage_path||null)!==(next.avatar_storage_path||null)||
      (local.banner_storage_path||null)!==(next.banner_storage_path||null)||
      local.archived_at!=null||
      JSON.stringify(oldMetadata)!==JSON.stringify(next.metadata);

    if(changed){
      await admin("/rest/v1/members?id=eq."+encodeURIComponent(local.id),{
        method:"PATCH",
        headers:{Prefer:"return=minimal"},
        body:JSON.stringify(next)
      });
      local.name=next.name;local.display_name=next.display_name;local.pronouns=next.pronouns;
      local.color=next.color;local.description=next.description;local.birthday=next.birthday;
      local.avatar_storage_path=next.avatar_storage_path;local.banner_storage_path=next.banner_storage_path;
      local.metadata=next.metadata;local.archived_at=null;
      membersUpdated++;
    }else{
      membersUnchanged++;
    }
  }

  const groupByPk=new Map<string,any>();
  for(const row of localGroups||[]){
    if(row.pk_id)groupByPk.set(String(row.pk_id),row);
    if(row.metadata?.pk_uuid)groupByPk.set(String(row.metadata.pk_uuid),row);
  }

  const linkSet=new Set((existingLinks||[]).map((x:any)=>String(x.member_id)+":"+String(x.group_id)));
  let added=0,updated=0,unchanged=0,membershipsAdded=0,membershipsRemoved=0,unresolved=0,groupMediaCopied=0;

  for(const g of pkGroups||[]){
    let local=groupByPk.get(String(g.id))||(g.uuid?groupByPk.get(String(g.uuid)):null);
    const oldMetadata=local?.metadata||{};
    const iconUrl=g.icon||g.icon_url||null;
    const bannerUrl=g.banner||g.banner_url||null;
    let iconPath=oldMetadata.icon_storage_path||null;
    let bannerPath=oldMetadata.banner_storage_path||null;

    if((oldMetadata.pk_icon_url||null)!==iconUrl){
      iconPath=null;
      if(iconUrl){try{iconPath=await storeImage(user.id,"avatar",iconUrl);groupMediaCopied++}catch{}}
    }
    if((oldMetadata.pk_banner_url||null)!==bannerUrl){
      bannerPath=null;
      if(bannerUrl){try{bannerPath=await storeImage(user.id,"banner",bannerUrl);groupMediaCopied++}catch{}}
    }

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
          icon_storage_path:iconPath,
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
        ...oldMetadata,
        pk_uuid:g.uuid||oldMetadata.pk_uuid||null,
        pk_icon_url:iconUrl,
        pk_banner_url:bannerUrl,
        icon_storage_path:iconPath,
        banner_storage_path:bannerPath
      };
      const changed=
        local.name!==nextName||
        (local.display_name||null)!==nextDisplayName||
        (local.description||null)!==nextDescription||
        (local.color||null)!==nextColor||
        (local.icon_storage_path||null)!==(iconPath||null)||
        JSON.stringify(oldMetadata)!==JSON.stringify(metadata);

      if(changed){
        await admin("/rest/v1/groups?id=eq."+encodeURIComponent(local.id),{
          method:"PATCH",
          headers:{Prefer:"return=minimal"},
          body:JSON.stringify({
            name:nextName,
            display_name:nextDisplayName,
            description:nextDescription,
            color:nextColor,
            icon_url:null,
            icon_source:null,
            icon_storage_path:iconPath,
            metadata
          })
        });
        local={...local,name:nextName,display_name:nextDisplayName,description:nextDescription,color:nextColor,icon_storage_path:iconPath,metadata};
        updated++;
      }else{
        unchanged++;
      }
    }
    if(!local?.id)continue;

    const desiredMemberIds=new Set<string>();
    const refs=Array.isArray(g.members)?g.members:[];
    for(const ref of refs){
      const key=typeof ref==="string"?ref:(ref?.id||ref?.uuid||"");
      const memberId=memberMap.get(String(key));
      if(!memberId){unresolved++;continue}
      desiredMemberIds.add(String(memberId));
      const linkKey=String(memberId)+":"+String(local.id);
      if(linkSet.has(linkKey))continue;
      await admin("/rest/v1/member_groups",{
        method:"POST",headers:{Prefer:"return=minimal"},
        body:JSON.stringify({user_id:user.id,member_id:memberId,group_id:local.id})
      });
      linkSet.add(linkKey);
      membershipsAdded++;
    }

    const currentForGroup=(existingLinks||[]).filter((x:any)=>String(x.group_id)===String(local.id));
    for(const link of currentForGroup){
      if(desiredMemberIds.has(String(link.member_id)))continue;
      await admin("/rest/v1/member_groups?user_id=eq."+encodeURIComponent(user.id)+"&member_id=eq."+encodeURIComponent(link.member_id)+"&group_id=eq."+encodeURIComponent(local.id),{
        method:"DELETE",
        headers:{Prefer:"return=minimal"}
      });
      linkSet.delete(String(link.member_id)+":"+String(local.id));
      membershipsRemoved++;
    }
  }

  return {
    memberTotal:(pkMembers||[]).length,
    membersUpdated,
    membersUnchanged,
    memberMediaCopied,
    groupTotal:(pkGroups||[]).length,
    added,
    updated,
    unchanged,
    membershipsAdded,
    membershipsRemoved,
    unresolved,
    groupMediaCopied,
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
    const [existing,tombstoned]=await Promise.all([
      admin("/rest/v1/fronts?user_id=eq."+encodeURIComponent(user.id)+"&source=eq.pluralkit&external_id=in."+encodeURIComponent(filter)+"&select=external_id"),
      admin("/rest/v1/rpc/nihility_front_history_tombstones",{
        method:"POST",
        body:JSON.stringify({p_user_id:user.id,p_provider:"pluralkit",p_external_ids:switchIds})
      })
    ]);
    existingIds=new Set((existing||[]).map((f:any)=>String(f.external_id)));
    for(const id of tombstoned||[])existingIds.add(String(id));
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

function historyCorrectionPayload(body:any){
  const frontId=String(body?.frontId||"").trim();
  if(!validUuid(frontId))throw new ClientError("Invalid front history entry");
  const startedAt=String(body?.startedAt||"").trim();
  const endedAt=body?.endedAt==null||body?.endedAt===""?null:String(body.endedAt).trim();
  if(!startedAt||!Number.isFinite(Date.parse(startedAt)))throw new ClientError("Invalid front start time");
  if(endedAt!==null&&!Number.isFinite(Date.parse(endedAt)))throw new ClientError("Invalid front end time");
  const note=body?.note==null?null:String(body.note);
  if(note!==null&&note.length>10000)throw new ClientError("Front note is too long");
  const source=String(body?.source||"").trim();
  if(!source||source.length>32)throw new ClientError("Invalid front source");
  const rawLinks=Array.isArray(body?.memberLinks)?body.memberLinks:[];
  if(rawLinks.length>1000)throw new ClientError("Too many members are attached to one front");
  const memberLinks=rawLinks.map((item:any)=>{
    const memberId=String(item?.memberId||"").trim();
    const joinedAt=String(item?.joinedAt||"").trim();
    const leftAt=item?.leftAt==null||item?.leftAt===""?null:String(item.leftAt).trim();
    if(!validUuid(memberId))throw new ClientError("Invalid member in front history");
    if(!joinedAt||!Number.isFinite(Date.parse(joinedAt)))throw new ClientError("Invalid member join time");
    if(leftAt!==null&&!Number.isFinite(Date.parse(leftAt)))throw new ClientError("Invalid member leave time");
    const detail={
      note:item?.note==null?null:String(item.note),
      private_note:item?.privateNote==null?null:String(item.privateNote),
      mood:item?.mood==null?null:String(item.mood),
      context:item?.context==null?null:String(item.context),
      activity:item?.activity==null?null:String(item.activity),
      location:item?.location==null?null:String(item.location)
    };
    if(!textLength(detail.note,4000)||!textLength(detail.private_note,4000)||!textLength(detail.mood,200)||!textLength(detail.context,1000)||!textLength(detail.activity,500)||!textLength(detail.location,500)){
      throw new ClientError("One or more per-fronter detail fields exceed Nihility limits");
    }
    return {member_id:memberId,joined_at:joinedAt,left_at:leftAt,...detail};
  });
  return {frontId,startedAt,endedAt,note,source,memberLinks};
}
async function actionFrontHistoryPreview(user:any,body:any){
  const input=historyCorrectionPayload(body);
  const result=await admin("/rest/v1/rpc/preview_nihility_front_history_correction",{
    method:"POST",
    body:JSON.stringify({
      p_user_id:user.id,
      p_front_id:input.frontId,
      p_started_at:input.startedAt,
      p_ended_at:input.endedAt,
      p_note:input.note,
      p_source:input.source,
      p_member_links:input.memberLinks
    })
  });
  if(result?.error)throw new ClientError(String(result.error),400);
  return result;
}
async function actionFrontHistoryCorrect(user:any,body:any){
  const input=historyCorrectionPayload(body);
  const expectedRevision=String(body?.expectedRevision||"").trim();
  if(!/^[a-f0-9]{32}$/i.test(expectedRevision))throw new ClientError("Review the latest history entry before saving");
  const result=await admin("/rest/v1/rpc/correct_nihility_front_history",{
    method:"POST",
    body:JSON.stringify({
      p_user_id:user.id,
      p_front_id:input.frontId,
      p_expected_revision:expectedRevision,
      p_started_at:input.startedAt,
      p_ended_at:input.endedAt,
      p_note:input.note,
      p_source:input.source,
      p_member_links:input.memberLinks
    })
  });
  if(result?.error)throw new ClientError(String(result.error),result?.stale?409:400);
  return result;
}
async function actionFrontHistoryDelete(user:any,body:any){
  const frontId=String(body?.frontId||"").trim();
  const expectedRevision=String(body?.expectedRevision||"").trim();
  if(!validUuid(frontId))throw new ClientError("Invalid front history entry");
  if(!/^[a-f0-9]{32}$/i.test(expectedRevision))throw new ClientError("Review the latest history entry before deleting it");
  const result=await admin("/rest/v1/rpc/delete_nihility_front_history",{
    method:"POST",
    body:JSON.stringify({
      p_user_id:user.id,
      p_front_id:frontId,
      p_expected_revision:expectedRevision
    })
  });
  if(result?.error)throw new ClientError(String(result.error),result?.stale?409:400);
  return result;
}


const BACKUP_FORMAT="project-nihility-backup";
const BACKUP_VERSION=1;
const BACKUP_MAX_JSON_BYTES=64*1024*1024;
const BACKUP_MAX_COMPRESSED_BYTES=20*1024*1024;
const BACKUP_LIMITS={
  members:10000,
  groups:5000,
  member_groups:100000,
  fronts:200000,
  front_members:500000,
  imports:50000,
  member_field_definitions:64,
  member_field_values:640000,
  member_tags:500,
  member_tag_links:1000000,
  member_connections:10000,
  system_events:1000000,
  journal_entries:100000,
  media:40000
};

function jsonBytes(value:any){
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
function cloneJson(value:any){
  return JSON.parse(JSON.stringify(value??{}));
}
async function sha256Text(value:string){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function validUuid(value:any){
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(String(value||""));
}
function validTimestamp(value:any,nullable=false){
  if(value===null||value===undefined||value==="")return nullable;
  return Number.isFinite(Date.parse(String(value)));
}
function textLength(value:any,max:number,required=false){
  if(value===null||value===undefined)return !required;
  const v=String(value);
  return (!required||v.trim().length>0)&&v.length<=max;
}
function addBackupMedia(list:any[],key:string,kind:string,path:any){
  const value=String(path||"").trim();
  if(!value)return null;
  list.push({key,kind,source_path:value,included:false});
  return key;
}
function sanitizedGroupMetadata(value:any){
  const metadata=(value&&typeof value==="object"&&!Array.isArray(value))?cloneJson(value):{};
  delete metadata.icon_storage_path;
  delete metadata.banner_storage_path;
  return metadata;
}
function sanitizedSettings(value:any,media:any[]){
  const settings=(value&&typeof value==="object"&&!Array.isArray(value))?cloneJson(value):{};
  const system=settings.system_profile;
  if(system&&typeof system==="object"&&!Array.isArray(system)){
    const avatarPath=system.avatar_storage_path;
    const bannerPath=system.banner_storage_path;
    delete system.avatar_storage_path;
    delete system.banner_storage_path;
    system.avatar_media_key=addBackupMedia(media,"system:avatar","avatar",avatarPath);
    system.banner_media_key=addBackupMedia(media,"system:banner","banner",bannerPath);
  }
  return settings;
}
async function requireBackupOwner(userId:string){
  const rows=await admin("/rest/v1/profiles?user_id=eq."+encodeURIComponent(userId)+"&select=role&limit=1");
  if(rows?.[0]?.role!=="owner")throw new ClientError("Only the Nihility owner can manage full backups.",403);
}
async function actionBackupExport(user:any){
  await requireBackupOwner(user.id);
  const [
    members,groups,memberGroups,fronts,frontMembers,settingsRows,imports,profileRows,
    fieldDefinitions,fieldValues,tags,tagLinks,connections,systemEvents,journalVaultRows,journalEntries
  ]=await Promise.all([
    adminAll("/rest/v1/members?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=created_at.asc"),
    adminAll("/rest/v1/groups?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=created_at.asc"),
    adminAll("/rest/v1/member_groups?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=created_at.asc"),
    adminAll("/rest/v1/fronts?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=started_at.asc"),
    adminAll("/rest/v1/front_members?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=joined_at.asc"),
    admin("/rest/v1/app_settings?user_id=eq."+encodeURIComponent(user.id)+"&select=settings&limit=1"),
    adminAll("/rest/v1/imports?user_id=eq."+encodeURIComponent(user.id)+"&select=source,summary,created_at&order=created_at.asc"),
    admin("/rest/v1/profiles?user_id=eq."+encodeURIComponent(user.id)+"&select=display_name,avatar_url,avatar_storage_path,banner_url,banner_storage_path&limit=1"),
    adminAll("/rest/v1/member_field_definitions?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=position.asc,id.asc"),
    adminAll("/rest/v1/member_field_values?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=member_id.asc,field_id.asc"),
    adminAll("/rest/v1/member_tags?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=name.asc"),
    adminAll("/rest/v1/member_tag_links?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=member_id.asc,tag_id.asc"),
    adminAll("/rest/v1/member_connections?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=created_at.asc"),
    adminAll("/rest/v1/system_events?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=occurred_at.asc,id.asc"),
    admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id)+"&select=*&limit=1"),
    adminAll("/rest/v1/journal_entries?user_id=eq."+encodeURIComponent(user.id)+"&select=*&order=logical_date.asc,created_at.asc,id.asc")
  ]);

  const media:any[]=[];
  const portableMembers=(members||[]).map((m:any)=>({
    backup_id:m.id,
    name:m.name,
    display_name:m.display_name,
    pronouns:m.pronouns,
    color:m.color,
    description:m.description,
    birthday:m.birthday,
    avatar_url:m.avatar_source==="external"?m.avatar_url:null,
    avatar_source:m.avatar_source==="external"?"external":null,
    banner_url:m.banner_source==="external"?m.banner_url:null,
    banner_source:m.banner_source==="external"?"external":null,
    pk_id:m.pk_id,
    tupper_id:m.tupper_id,
    metadata:m.metadata||{},
    created_at:m.created_at,
    updated_at:m.updated_at,
    archived_at:m.archived_at,
    avatar_media_key:addBackupMedia(media,"member:"+m.id+":avatar","avatar",m.avatar_storage_path),
    banner_media_key:addBackupMedia(media,"member:"+m.id+":banner","banner",m.banner_storage_path)
  }));
  const portableGroups=(groups||[]).map((g:any)=>({
    backup_id:g.id,
    name:g.name,
    display_name:g.display_name,
    description:g.description,
    color:g.color,
    icon_url:g.icon_source==="external"?g.icon_url:null,
    icon_source:g.icon_source==="external"?"external":null,
    pk_id:g.pk_id,
    tupper_id:g.tupper_id,
    metadata:sanitizedGroupMetadata(g.metadata),
    created_at:g.created_at,
    updated_at:g.updated_at,
    icon_media_key:addBackupMedia(media,"group:"+g.id+":icon","avatar",g.icon_storage_path||g.metadata?.icon_storage_path),
    banner_media_key:addBackupMedia(media,"group:"+g.id+":banner","banner",g.metadata?.banner_storage_path)
  }));
  const portableMemberGroups=(memberGroups||[]).map((x:any)=>({
    member_backup_id:x.member_id,
    group_backup_id:x.group_id,
    created_at:x.created_at
  }));
  const portableFronts=(fronts||[]).map((f:any)=>({
    backup_id:f.id,
    started_at:f.started_at,
    ended_at:f.ended_at,
    note:f.note,
    source:f.source,
    external_id:f.external_id,
    created_at:f.created_at
  }));
  const portableFrontMembers=(frontMembers||[]).map((x:any)=>({
    front_backup_id:x.front_id,
    member_backup_id:x.member_id,
    joined_at:x.joined_at,
    left_at:x.left_at,
    note:x.note,
    private_note:x.private_note,
    mood:x.mood,
    context:x.context,
    activity:x.activity,
    location:x.location
  }));
  const portableFieldDefinitions=(fieldDefinitions||[]).map((x:any)=>({
    backup_id:x.id,key:x.key,label:x.label,description:x.description,
    field_type:x.field_type,options:x.options||[],position:x.position||0,
    created_at:x.created_at,updated_at:x.updated_at
  }));
  const portableFieldValues=(fieldValues||[]).map((x:any)=>({
    member_backup_id:x.member_id,field_backup_id:x.field_id,value:x.value,
    created_at:x.created_at,updated_at:x.updated_at
  }));
  const portableTags=(tags||[]).map((x:any)=>({
    backup_id:x.id,name:x.name,color:x.color,created_at:x.created_at,updated_at:x.updated_at
  }));
  const portableTagLinks=(tagLinks||[]).map((x:any)=>({
    member_backup_id:x.member_id,tag_backup_id:x.tag_id,created_at:x.created_at
  }));
  const portableConnections=(connections||[]).map((x:any)=>({
    source_member_backup_id:x.source_member_id,
    target_member_backup_id:x.target_member_id,
    source_label:x.source_label,
    target_label:x.target_label,
    created_at:x.created_at,
    updated_at:x.updated_at
  }));
  const portableSystemEvents=(systemEvents||[]).map((x:any)=>({
    event_type:x.event_type,
    occurred_at:x.occurred_at,
    member_backup_id:x.member_id||null,
    related_member_backup_id:x.related_member_id||null,
    group_backup_id:x.group_id||null,
    front_backup_id:x.front_id||null,
    metadata:(x.metadata&&typeof x.metadata==="object"&&!Array.isArray(x.metadata))?x.metadata:{},
    created_at:x.created_at
  }));
  const journalVault=journalVaultRows?.[0]||null;
  const portableJournalVault=journalVault?{
    format_version:journalVault.format_version,
    cipher_suite:journalVault.cipher_suite,
    kdf_name:journalVault.kdf_name,
    kdf_iterations:journalVault.kdf_iterations,
    kdf_salt:journalVault.kdf_salt,
    wrap_iv:journalVault.wrap_iv,
    wrapped_key:journalVault.wrapped_key,
    recovery_kdf_name:journalVault.recovery_kdf_name,
    recovery_salt:journalVault.recovery_salt,
    recovery_iv:journalVault.recovery_iv,
    recovery_wrapped_key:journalVault.recovery_wrapped_key,
    key_verifier:journalVault.key_verifier,
    created_at:journalVault.created_at,
    updated_at:journalVault.updated_at
  }:null;
  const portableJournalEntries=(journalEntries||[]).map((x:any)=>({
    id:x.id,
    payload_version:x.payload_version,
    iv:x.iv,
    ciphertext:x.ciphertext,
    created_at:x.created_at,
    updated_at:x.updated_at
  }));
  const profile=profileRows?.[0]||{};
  const portableProfile={
    display_name:profile.display_name||null,
    avatar_url:profile.avatar_storage_path?null:(profile.avatar_url||null),
    banner_url:profile.banner_storage_path?null:(profile.banner_url||null),
    avatar_media_key:addBackupMedia(media,"profile:avatar","profile",profile.avatar_storage_path),
    banner_media_key:addBackupMedia(media,"profile:banner","banner",profile.banner_storage_path)
  };
  const data={
    members:portableMembers,
    groups:portableGroups,
    member_groups:portableMemberGroups,
    fronts:portableFronts,
    front_members:portableFrontMembers,
    member_field_definitions:portableFieldDefinitions,
    member_field_values:portableFieldValues,
    member_tags:portableTags,
    member_tag_links:portableTagLinks,
    member_connections:portableConnections,
    system_events:portableSystemEvents,
    journal_vault:portableJournalVault,
    journal_entries:portableJournalEntries,
    settings:sanitizedSettings(settingsRows?.[0]?.settings||{},media),
    imports:(imports||[]).map((x:any)=>({source:x.source,summary:x.summary||{},created_at:x.created_at})),
    profile:portableProfile
  };
  const dataHash=await sha256Text(JSON.stringify(data));
  return {
    format:BACKUP_FORMAT,
    version:BACKUP_VERSION,
    exported_at:new Date().toISOString(),
    application:{name:"Project Nihility",version:"3.0"},
    data,
    media,
    integrity:{data_sha256:dataHash},
    excluded:[
      "account email and role",
      "passwords and authentication sessions",
      "account invitations",
      "PluralKit and other integration credentials",
      "security-event logs"
    ]
  };
}

function requireArray(data:any,key:string,limit:number){
  const value=data?.[key];
  if(!Array.isArray(value))throw new ClientError("Backup section "+key+" is invalid");
  if(value.length>limit)throw new ClientError("Backup section "+key+" exceeds Nihility limits");
  return value;
}
function optionalArray(data:any,key:string,limit:number){
  const value=data?.[key];
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value))throw new ClientError("Backup section "+key+" is invalid");
  if(value.length>limit)throw new ClientError("Backup section "+key+" exceeds Nihility limits");
  return value;
}
function validCustomValueForDefinition(def:any,value:any){
  const type=String(def?.field_type||"");
  if(type==="text")return typeof value==="string"&&value.length<=500;
  if(type==="long_text")return typeof value==="string"&&value.length<=4000;
  if(type==="number")return typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1e15;
  if(type==="boolean")return typeof value==="boolean";
  if(type==="date"){
    if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const date=new Date(value+"T00:00:00Z");
    return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
  }
  const options=Array.isArray(def?.options)?def.options:[];
  if(type==="select")return typeof value==="string"&&options.includes(value);
  if(type==="multi_select"){
    if(!Array.isArray(value)||value.length>50)return false;
    const seen=new Set<string>();
    for(const item of value){
      if(typeof item!=="string"||!options.includes(item)||seen.has(item))return false;
      seen.add(item);
    }
    return true;
  }
  return false;
}
function validateIds(rows:any[],label:string){
  const seen=new Set<string>();
  for(const row of rows){
    if(!row||typeof row!=="object"||!validUuid(row.backup_id))throw new ClientError("Backup contains an invalid "+label+" identifier");
    const id=String(row.backup_id);
    if(seen.has(id))throw new ClientError("Backup contains duplicate "+label+" identifiers");
    seen.add(id);
  }
  return seen;
}
async function validateBackup(backup:any){
  if(!backup||typeof backup!=="object"||Array.isArray(backup))throw new ClientError("Invalid Nihility backup");
  if(backup.format!==BACKUP_FORMAT||Number(backup.version)!==BACKUP_VERSION)throw new ClientError("Unsupported Nihility backup version");
  if(!backup.data||typeof backup.data!=="object"||Array.isArray(backup.data))throw new ClientError("Backup data is missing");
  if(jsonBytes(backup)>BACKUP_MAX_JSON_BYTES)throw new ClientError("Backup is too large to restore in this version",413);

  const data=backup.data;
  const members=requireArray(data,"members",BACKUP_LIMITS.members);
  const groups=requireArray(data,"groups",BACKUP_LIMITS.groups);
  const memberGroups=requireArray(data,"member_groups",BACKUP_LIMITS.member_groups);
  const fronts=requireArray(data,"fronts",BACKUP_LIMITS.fronts);
  const frontMembers=requireArray(data,"front_members",BACKUP_LIMITS.front_members);
  const imports=requireArray(data,"imports",BACKUP_LIMITS.imports);
  const fieldDefinitions=optionalArray(data,"member_field_definitions",BACKUP_LIMITS.member_field_definitions);
  const fieldValues=optionalArray(data,"member_field_values",BACKUP_LIMITS.member_field_values);
  const tags=optionalArray(data,"member_tags",BACKUP_LIMITS.member_tags);
  const tagLinks=optionalArray(data,"member_tag_links",BACKUP_LIMITS.member_tag_links);
  const connections=optionalArray(data,"member_connections",BACKUP_LIMITS.member_connections);
  const systemEvents=optionalArray(data,"system_events",BACKUP_LIMITS.system_events);
  const journalEntries=optionalArray(data,"journal_entries",BACKUP_LIMITS.journal_entries);
  const journalVault=(data.journal_vault&&typeof data.journal_vault==="object"&&!Array.isArray(data.journal_vault))?data.journal_vault:null;
  const media=Array.isArray(backup.media)?backup.media:[];
  if(media.length>BACKUP_LIMITS.media)throw new ClientError("Backup media manifest is too large");

  const memberIds=validateIds(members,"member");
  const groupIds=validateIds(groups,"group");
  const frontIds=validateIds(fronts,"front");
  const fieldIds=validateIds(fieldDefinitions,"custom field");
  const tagIds=validateIds(tags,"tag");
  const fieldById=new Map(fieldDefinitions.map((x:any)=>[String(x.backup_id),x]));

  for(const m of members){
    if(!textLength(m.name,200,true))throw new ClientError("A member name is missing or too long");
    if(!textLength(m.display_name,200)||!textLength(m.pronouns,200)||!textLength(m.description,10000))throw new ClientError("A member text field exceeds Nihility limits");
    if(m.color!=null&&m.color!==""&&!/^[0-9A-Fa-f]{6}$/.test(String(m.color)))throw new ClientError("A member color is invalid");
    if(m.birthday!=null&&m.birthday!==""&&!/^\d{4}-\d{2}-\d{2}$/.test(String(m.birthday)))throw new ClientError("A member birthday is invalid");
    if(m.archived_at&&!validTimestamp(m.archived_at))throw new ClientError("A member archive timestamp is invalid");
    if(jsonBytes(m.metadata||{})>65536)throw new ClientError("A member metadata block exceeds Nihility limits");
  }
  for(const g of groups){
    if(!textLength(g.name,200,true))throw new ClientError("A group name is missing or too long");
    if(!textLength(g.display_name,200)||!textLength(g.description,10000))throw new ClientError("A group text field exceeds Nihility limits");
    if(g.color!=null&&g.color!==""&&!/^[0-9A-Fa-f]{6}$/.test(String(g.color)))throw new ClientError("A group color is invalid");
    if(jsonBytes(g.metadata||{})>65536)throw new ClientError("A group metadata block exceeds Nihility limits");
  }

  const membershipKeys=new Set<string>();
  for(const link of memberGroups){
    const memberId=String(link?.member_backup_id||"");
    const groupId=String(link?.group_backup_id||"");
    if(!memberIds.has(memberId)||!groupIds.has(groupId))throw new ClientError("Backup contains a group membership with a missing member or group");
    const key=memberId+":"+groupId;
    if(membershipKeys.has(key))throw new ClientError("Backup contains a duplicate group membership");
    membershipKeys.add(key);
  }

  let activeFronts=0;
  const frontTimes=new Map<string,{start:number,end:number|null}>();
  for(const f of fronts){
    if(!validTimestamp(f.started_at))throw new ClientError("A front has an invalid start time");
    if(!validTimestamp(f.ended_at,true))throw new ClientError("A front has an invalid end time");
    if(!textLength(f.note,10000)||!textLength(f.source,32)||!textLength(f.external_id,128))throw new ClientError("A front field exceeds Nihility limits");
    const start=Date.parse(String(f.started_at));
    const end=f.ended_at?Date.parse(String(f.ended_at)):null;
    if(end!==null&&end<start)throw new ClientError("A front ends before it starts");
    if(end===null)activeFronts++;
    frontTimes.set(String(f.backup_id),{start,end});
  }
  if(activeFronts>1)throw new ClientError("Backup contains more than one active front");

  const frontMemberKeys=new Set<string>();
  for(const link of frontMembers){
    const frontId=String(link?.front_backup_id||"");
    const memberId=String(link?.member_backup_id||"");
    if(!frontIds.has(frontId)||!memberIds.has(memberId))throw new ClientError("Backup contains a front link with a missing member or front");
    if(!validTimestamp(link.joined_at)||!validTimestamp(link.left_at,true))throw new ClientError("A fronter timing value is invalid");
    const joined=Date.parse(String(link.joined_at));
    const left=link.left_at?Date.parse(String(link.left_at)):null;
    if(left!==null&&left<joined)throw new ClientError("A fronter leaves before joining");
    if(!textLength(link.note,4000)||!textLength(link.private_note,4000)||!textLength(link.mood,200)||!textLength(link.context,1000)||!textLength(link.activity,500)||!textLength(link.location,500)){
      throw new ClientError("A per-fronter detail field exceeds Nihility limits");
    }
    const frontTime=frontTimes.get(frontId);
    if(frontTime&&joined<frontTime.start-1000)throw new ClientError("A fronter joins before the front starts");
    if(frontTime?.end!==null&&frontTime?.end!==undefined&&joined>frontTime.end+1000)throw new ClientError("A fronter joins after the front ends");
    if(frontTime?.end!==null&&frontTime?.end!==undefined&&left!==null&&left>frontTime.end+1000)throw new ClientError("A fronter leaves after the front ends");
    const key=frontId+":"+memberId+":"+String(link.joined_at);
    if(frontMemberKeys.has(key))throw new ClientError("Backup contains a duplicate fronter timing row");
    frontMemberKeys.add(key);
  }

  for(const def of fieldDefinitions){
    if(!/^[a-z][a-z0-9_]{0,31}$/.test(String(def.key||"")))throw new ClientError("A custom field key is invalid");
    if(!textLength(def.label,80,true)||!textLength(def.description,240))throw new ClientError("A custom field label or description exceeds Nihility limits");
    if(!["text","long_text","number","boolean","date","select","multi_select"].includes(String(def.field_type||"")))throw new ClientError("A custom field type is invalid");
    const options=Array.isArray(def.options)?def.options:[];
    if(options.length>100||options.some((x:any)=>typeof x!=="string"||x.trim().length<1||x.length>100))throw new ClientError("A custom field has invalid options");
    if(new Set(options.map((x:string)=>x.toLowerCase())).size!==options.length)throw new ClientError("A custom field contains duplicate options");
    const position=Number(def.position||0);
    if(!Number.isInteger(position)||position<0||position>10000)throw new ClientError("A custom field position is invalid");
  }
  const fieldValueKeys=new Set<string>();
  for(const row of fieldValues){
    const memberId=String(row?.member_backup_id||"");
    const fieldId=String(row?.field_backup_id||"");
    if(!memberIds.has(memberId)||!fieldIds.has(fieldId))throw new ClientError("Backup contains a custom field value with a missing member or field");
    const key=memberId+":"+fieldId;
    if(fieldValueKeys.has(key))throw new ClientError("Backup contains a duplicate custom field value");
    fieldValueKeys.add(key);
    if(!validCustomValueForDefinition(fieldById.get(fieldId),row?.value))throw new ClientError("Backup contains an invalid custom field value");
  }
  const tagNames=new Set<string>();
  for(const tag of tags){
    if(!textLength(tag.name,60,true))throw new ClientError("A tag name is missing or too long");
    const lower=String(tag.name).trim().toLowerCase();
    if(tagNames.has(lower))throw new ClientError("Backup contains duplicate tag names");
    tagNames.add(lower);
    if(tag.color!=null&&tag.color!==""&&!/^[0-9A-Fa-f]{6}$/.test(String(tag.color)))throw new ClientError("A tag color is invalid");
  }
  const tagLinkKeys=new Set<string>();
  const tagCounts=new Map<string,number>();
  for(const row of tagLinks){
    const memberId=String(row?.member_backup_id||"");
    const tagId=String(row?.tag_backup_id||"");
    if(!memberIds.has(memberId)||!tagIds.has(tagId))throw new ClientError("Backup contains a tag assignment with a missing member or tag");
    const key=memberId+":"+tagId;
    if(tagLinkKeys.has(key))throw new ClientError("Backup contains a duplicate tag assignment");
    tagLinkKeys.add(key);
    tagCounts.set(memberId,(tagCounts.get(memberId)||0)+1);
    if((tagCounts.get(memberId)||0)>100)throw new ClientError("A backup member has more than 100 tags");
  }

  const connectionKeys=new Set<string>();
  const connectionCounts=new Map<string,number>();
  for(const row of connections){
    const sourceId=String(row?.source_member_backup_id||"");
    const targetId=String(row?.target_member_backup_id||"");
    if(!memberIds.has(sourceId)||!memberIds.has(targetId))throw new ClientError("Backup contains a connection with a missing member");
    if(sourceId===targetId)throw new ClientError("Backup contains a self-connection");
    if(!textLength(row?.source_label,80,true)||!textLength(row?.target_label,80,true))throw new ClientError("A relationship label is missing or too long");
    const key=[sourceId,targetId].sort().join(":");
    if(connectionKeys.has(key))throw new ClientError("Backup contains a duplicate member connection");
    connectionKeys.add(key);
    for(const memberId of [sourceId,targetId]){
      connectionCounts.set(memberId,(connectionCounts.get(memberId)||0)+1);
      if((connectionCounts.get(memberId)||0)>250)throw new ClientError("A backup member has more than 250 direct connections");
    }
  }

  const allowedTimelineTypes=new Set([
    "front_logged","member_created","member_archived","member_restored",
    "group_created","member_group_added","member_group_removed",
    "connection_added","connection_updated","connection_removed",
    "integration_imported","integration_synced","backup_restored"
  ]);
  for(const event of systemEvents){
    if(!allowedTimelineTypes.has(String(event?.event_type||"")))throw new ClientError("Backup contains an invalid system timeline event");
    if(!validTimestamp(event?.occurred_at))throw new ClientError("A system timeline timestamp is invalid");
    if(!validTimestamp(event?.created_at,true))throw new ClientError("A system timeline created timestamp is invalid");
    const memberId=event?.member_backup_id?String(event.member_backup_id):"";
    const relatedMemberId=event?.related_member_backup_id?String(event.related_member_backup_id):"";
    const groupId=event?.group_backup_id?String(event.group_backup_id):"";
    const frontId=event?.front_backup_id?String(event.front_backup_id):"";
    if(memberId&&!memberIds.has(memberId))throw new ClientError("Timeline event references a missing member");
    if(relatedMemberId&&!memberIds.has(relatedMemberId))throw new ClientError("Timeline event references a missing related member");
    if(groupId&&!groupIds.has(groupId))throw new ClientError("Timeline event references a missing group");
    if(frontId&&!frontIds.has(frontId))throw new ClientError("Timeline event references a missing front");
    const metadata=(event?.metadata&&typeof event.metadata==="object"&&!Array.isArray(event.metadata))?event.metadata:{};
    if(jsonBytes(metadata)>8192)throw new ClientError("A system timeline metadata block exceeds Nihility limits");
  }

  if(journalEntries.length&&!journalVault)throw new ClientError("Journal entries require journal vault metadata");
  if(journalVault){
    if(Number(journalVault.format_version)!==1)throw new ClientError("Unsupported journal vault version");
    if(String(journalVault.cipher_suite||"")!=="AES-256-GCM")throw new ClientError("Unsupported journal cipher suite");
    if(String(journalVault.kdf_name||"")!=="PBKDF2-HMAC-SHA-256")throw new ClientError("Unsupported journal passphrase KDF");
    if(String(journalVault.recovery_kdf_name||"")!=="HKDF-SHA-256")throw new ClientError("Unsupported journal recovery KDF");
    const iterations=Number(journalVault.kdf_iterations);
    if(!Number.isInteger(iterations)||iterations<600000||iterations>5000000)throw new ClientError("Journal KDF settings are invalid");
    journalBase64url(journalVault.kdf_salt,16,128,"journal KDF salt");
    journalBase64url(journalVault.wrap_iv,16,64,"journal wrap IV");
    journalBase64url(journalVault.wrapped_key,48,160,"wrapped journal key");
    journalBase64url(journalVault.recovery_salt,16,128,"journal recovery salt");
    journalBase64url(journalVault.recovery_iv,16,64,"journal recovery IV");
    journalBase64url(journalVault.recovery_wrapped_key,48,160,"journal recovery key");
    journalBase64url(journalVault.key_verifier,43,43,"journal key verifier");
  }
  const journalIds=new Set<string>();
  for(const entry of journalEntries){
    const id=journalUuid(entry?.id);
    if(journalIds.has(id))throw new ClientError("Backup contains duplicate journal entry identifiers");
    journalIds.add(id);
    if(Number(entry?.payload_version)!==1)throw new ClientError("Unsupported journal entry version");
    journalBase64url(entry?.iv,16,64,"journal entry IV");
    journalBase64url(entry?.ciphertext,24,350000,"journal ciphertext");
    if(!validTimestamp(entry?.created_at,true)||!validTimestamp(entry?.updated_at,true))throw new ClientError("A journal timestamp is invalid");
  }

  const settings=(data.settings&&typeof data.settings==="object"&&!Array.isArray(data.settings))?data.settings:{};
  if(jsonBytes(settings)>131072)throw new ClientError("Backup settings exceed Nihility limits");
  for(const item of imports){
    if(!["pluralkit","tupperbox","nihility"].includes(String(item?.source||"")))throw new ClientError("Backup contains an invalid import source");
    if(jsonBytes(item?.summary||{})>65536)throw new ClientError("An import summary exceeds Nihility limits");
  }

  const mediaKeys=new Set<string>();
  for(const item of media){
    const key=String(item?.key||"");
    const kind=String(item?.kind||"");
    if(!key||key.length>300||!BUCKETS[kind])throw new ClientError("Backup contains an invalid media manifest entry");
    if(mediaKeys.has(key))throw new ClientError("Backup contains duplicate media keys");
    mediaKeys.add(key);
  }

  const expected=String(backup?.integrity?.data_sha256||"").toLowerCase();
  if(expected){
    if(!/^[a-f0-9]{64}$/.test(expected))throw new ClientError("Backup integrity value is invalid");
    const actual=await sha256Text(JSON.stringify(data));
    if(actual!==expected)throw new ClientError("Backup integrity check failed. The file may be damaged or modified.");
  }

  return {
    counts:{
      members:members.length,
      groups:groups.length,
      member_groups:memberGroups.length,
      fronts:fronts.length,
      front_members:frontMembers.length,
      imports:imports.length,
      member_field_definitions:fieldDefinitions.length,
      member_field_values:fieldValues.length,
      member_tags:tags.length,
      member_tag_links:tagLinks.length,
      member_connections:connections.length,
      system_events:systemEvents.length,
      journal_entries:journalEntries.length
    },
    media:{total:media.length,included:media.filter((x:any)=>x?.included===true).length}
  };
}
async function actionBackupPreview(user:any,body:any){
  await requireBackupOwner(user.id);
  const validated=await validateBackup(body?.backup);
  const current=await admin("/rest/v1/rpc/nihility_backup_counts",{
    method:"POST",
    body:JSON.stringify({p_user_id:user.id})
  });
  if(!current)throw new ClientError("Backup preview is unavailable",403);
  return {
    backup:{
      exported_at:body.backup.exported_at||null,
      counts:validated.counts,
      media:validated.media
    },
    current,
    mode:"replace",
    warnings:[
      "Restore replaces current members, groups, front history, app settings, import history, encrypted journal vault data, and safe profile fields.",
      "Account email, role, sessions, invitations, and integration credentials are not changed.",
      validated.media.included<validated.media.total
        ?"Some private media is not included in this backup and will not be restored."
        :""
    ].filter(Boolean)
  };
}
async function collectCurrentMedia(userId:string){
  const [members,groups,profiles,settingsRows]=await Promise.all([
    adminAll("/rest/v1/members?user_id=eq."+encodeURIComponent(userId)+"&select=avatar_storage_path,banner_storage_path"),
    adminAll("/rest/v1/groups?user_id=eq."+encodeURIComponent(userId)+"&select=icon_storage_path,metadata"),
    admin("/rest/v1/profiles?user_id=eq."+encodeURIComponent(userId)+"&select=avatar_storage_path,banner_storage_path&limit=1"),
    admin("/rest/v1/app_settings?user_id=eq."+encodeURIComponent(userId)+"&select=settings&limit=1")
  ]);
  const items:any[]=[];
  const add=(kind:string,path:any)=>{if(path)items.push({kind,path:String(path)})};
  for(const m of members||[]){add("avatar",m.avatar_storage_path);add("banner",m.banner_storage_path)}
  for(const g of groups||[]){add("avatar",g.icon_storage_path||g.metadata?.icon_storage_path);add("banner",g.metadata?.banner_storage_path)}
  add("profile",profiles?.[0]?.avatar_storage_path);add("banner",profiles?.[0]?.banner_storage_path);
  add("avatar",settingsRows?.[0]?.settings?.system_profile?.avatar_storage_path);
  add("banner",settingsRows?.[0]?.settings?.system_profile?.banner_storage_path);
  const seen=new Set<string>();
  return items.filter(item=>{const key=item.kind+":"+item.path;if(seen.has(key))return false;seen.add(key);return true});
}
async function actionBackupRestore(user:any,body:any){
  await requireBackupOwner(user.id);
  if(String(body?.confirmation||"")!=="RESTORE")throw new ClientError("Type RESTORE to confirm this replacement.",400);
  const validated=await validateBackup(body?.backup);
  const mediaPaths=(body?.mediaPaths&&typeof body.mediaPaths==="object"&&!Array.isArray(body.mediaPaths))?body.mediaPaths:{};
  const manifest=new Map<string,string>();
  for(const item of (Array.isArray(body.backup?.media)?body.backup.media:[])){
    manifest.set(String(item?.key||""),String(item?.kind||""));
  }
  const keep=new Set<string>();
  for(const [key,rawPath] of Object.entries(mediaPaths)){
    const kind=manifest.get(key);
    const path=String(rawPath||"");
    if(!kind||!BUCKETS[kind])throw new ClientError("Restore contains an unknown media key");
    if(!path.startsWith(user.id+"/")||path.length>512)throw new ClientError("Restore media path is outside this account");
    keep.add(kind+":"+path);
  }

  const oldMedia=await collectCurrentMedia(user.id);
  const restored=await admin("/rest/v1/rpc/restore_nihility_backup",{
    method:"POST",
    body:JSON.stringify({p_user_id:user.id,p_backup:body.backup,p_media_paths:mediaPaths})
  });

  await Promise.allSettled(
    oldMedia
      .filter(item=>!keep.has(item.kind+":"+item.path))
      .map(item=>deleteStoredMedia(user.id,item.kind,item.path))
  );

  return {
    ...restored,
    backup_counts:validated.counts,
    media_restored:Object.keys(mediaPaths).length
  };
}

async function readLimitedStream(stream:ReadableStream<Uint8Array>|null,maxBytes:number){
  const reader=stream?.getReader();
  if(!reader)return new Uint8Array();
  const chunks:Uint8Array[]=[];let total=0;
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    if(value){
      total+=value.length;
      if(total>maxBytes){await reader.cancel();throw new ClientError("Backup request is too large",413)}
      chunks.push(value);
    }
  }
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return bytes;
}
async function readLimitedBytes(req:Request,maxBytes:number){
  const declared=Number(req.headers.get("content-length")||0);
  if(Number.isFinite(declared)&&declared>maxBytes)throw new ClientError("Backup request is too large",413);
  return readLimitedStream(req.body,maxBytes);
}
async function readBackupRequest(req:Request){
  const type=(req.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
  let bytes:Uint8Array;
  if(type==="application/gzip"||type==="application/x-gzip"){
    const compressed=await readLimitedBytes(req,BACKUP_MAX_COMPRESSED_BYTES);
    let stream:ReadableStream<Uint8Array>;
    try{
      stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
    }catch{
      throw new ClientError("Unable to decompress backup request");
    }
    bytes=await readLimitedStream(stream,BACKUP_MAX_JSON_BYTES);
  }else if(type==="application/json"){
    bytes=await readLimitedBytes(req,BACKUP_MAX_JSON_BYTES);
  }else{
    throw new ClientError("Backup request must be JSON or gzip",415);
  }
  if(!bytes.length)throw new ClientError("Backup request is empty");
  try{return JSON.parse(new TextDecoder().decode(bytes))}
  catch{throw new ClientError("Backup request contains invalid JSON")}
}


function journalBase64url(value:any,min:number,max:number,label:string){
  const text=String(value||"");
  if(text.length<min||text.length>max||!/^[A-Za-z0-9_-]+$/.test(text))throw new ClientError("Invalid "+label,400);
  return text;
}
function journalUuid(value:any,label="journal entry"){
  const text=String(value||"");
  if(!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(text))throw new ClientError("Invalid "+label,400);
  return text;
}
function journalDate(value:any){
  const text=String(value||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new ClientError("Invalid journal date",400);
  const d=new Date(text+"T00:00:00Z");
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==text)throw new ClientError("Invalid journal date",400);
  return text;
}
function journalVaultPayload(body:any){
  const v=body?.vault||{};
  const iterations=Number(v.kdf_iterations);
  if(!Number.isInteger(iterations)||iterations<600000||iterations>5000000)throw new ClientError("Invalid journal KDF settings",400);
  return{
    format_version:1,
    cipher_suite:"AES-256-GCM",
    kdf_name:"PBKDF2-HMAC-SHA-256",
    kdf_iterations:iterations,
    kdf_salt:journalBase64url(v.kdf_salt,16,128,"journal KDF salt"),
    wrap_iv:journalBase64url(v.wrap_iv,16,64,"journal wrap IV"),
    wrapped_key:journalBase64url(v.wrapped_key,48,160,"wrapped journal key"),
    recovery_kdf_name:"HKDF-SHA-256",
    recovery_salt:journalBase64url(v.recovery_salt,16,128,"journal recovery salt"),
    recovery_iv:journalBase64url(v.recovery_iv,16,64,"journal recovery IV"),
    recovery_wrapped_key:journalBase64url(v.recovery_wrapped_key,48,160,"journal recovery key"),
    key_verifier:journalBase64url(v.key_verifier,43,43,"journal key verifier")
  };
}
function constantTimeTextEqual(a:string,b:string){
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
async function requireJournalProof(userId:string,proof:any){
  const supplied=journalBase64url(proof,43,43,"journal vault proof");
  const rows=await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(userId)+"&select=key_verifier&limit=1");
  const expected=String(rows?.[0]?.key_verifier||"");
  if(!expected||!constantTimeTextEqual(supplied,expected))throw new ClientError("Journal vault must be unlocked for this action.",403);
}
async function actionJournalStatus(user:any){
  const rows=await admin(
    "/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id)+
    "&select=format_version,cipher_suite,kdf_name,kdf_iterations,kdf_salt,wrap_iv,wrapped_key,recovery_kdf_name,recovery_salt,recovery_iv,recovery_wrapped_key,created_at,updated_at&limit=1"
  );
  const vault=rows?.[0]||null;
  if(!vault)return{configured:false,vault:null};
  return{configured:true,vault};
}
async function actionJournalSetup(user:any,body:any){
  const existing=await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id&limit=1");
  if(existing?.length)throw new ClientError("Journal vault is already configured",409);
  const vault=journalVaultPayload(body);
  await admin("/rest/v1/journal_vaults",{
    method:"POST",
    headers:{Prefer:"return=minimal"},
    body:JSON.stringify({user_id:user.id,...vault})
  });
  return{configured:true};
}
async function actionJournalList(user:any,body:any){
  await requireJournalProof(user.id,body?.proof);
  const limit=Math.min(200,Math.max(1,Number(body?.limit)||100));
  const offset=Math.min(1000000,Math.max(0,Number(body?.offset)||0));
  const rows=await admin(
    "/rest/v1/journal_entries?user_id=eq."+encodeURIComponent(user.id)+
    "&select=id,payload_version,iv,ciphertext,created_at,updated_at"+
    "&order=updated_at.desc,id.desc"+
    "&limit="+limit+"&offset="+offset
  );
  return{entries:rows||[],has_more:(rows||[]).length===limit};
}
async function actionJournalSave(user:any,body:any){
  await requireJournalProof(user.id,body?.proof);
  const e=body?.entry||{};
  const id=journalUuid(e.id);
  const payloadVersion=Number(e.payload_version||1);
  if(payloadVersion!==1)throw new ClientError("Unsupported journal payload version",400);
  const iv=journalBase64url(e.iv,16,64,"journal entry IV");
  const ciphertext=journalBase64url(e.ciphertext,24,350000,"journal ciphertext");

  const vault=await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id&limit=1");
  if(!vault?.length)throw new ClientError("Journal vault is not configured",409);

  const existing=await admin("/rest/v1/journal_entries?id=eq."+encodeURIComponent(id)+"&select=id,user_id&limit=1");
  if(existing?.length&&String(existing[0].user_id)!==String(user.id))throw new ClientError("Journal entry identifier is unavailable",409);

  await admin("/rest/v1/journal_entries?on_conflict=id",{
    method:"POST",
    headers:{Prefer:"resolution=merge-duplicates,return=representation"},
    body:JSON.stringify({id,user_id:user.id,payload_version:1,iv,ciphertext})
  });
  return{saved:true,id};
}
async function actionJournalDelete(user:any,body:any){
  await requireJournalProof(user.id,body?.proof);
  const id=journalUuid(body?.entry_id);
  const existing=await admin("/rest/v1/journal_entries?user_id=eq."+encodeURIComponent(user.id)+"&id=eq."+encodeURIComponent(id)+"&select=id&limit=1");
  if(!existing?.length)throw new ClientError("Journal entry not found",404);
  await admin("/rest/v1/journal_entries?user_id=eq."+encodeURIComponent(user.id)+"&id=eq."+encodeURIComponent(id),{
    method:"DELETE",headers:{Prefer:"return=minimal"}
  });
  return{deleted:true,id};
}
async function actionJournalRewrap(user:any,body:any){
  await requireJournalProof(user.id,body?.proof);
  const v=body?.vault||{};
  const iterations=Number(v.kdf_iterations);
  if(!Number.isInteger(iterations)||iterations<600000||iterations>5000000)throw new ClientError("Invalid journal KDF settings",400);
  const patch={
    kdf_iterations:iterations,
    kdf_salt:journalBase64url(v.kdf_salt,16,128,"journal KDF salt"),
    wrap_iv:journalBase64url(v.wrap_iv,16,64,"journal wrap IV"),
    wrapped_key:journalBase64url(v.wrapped_key,48,160,"wrapped journal key")
  };
  const existing=await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id&limit=1");
  if(!existing?.length)throw new ClientError("Journal vault is not configured",404);
  await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id),{
    method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify(patch)
  });
  return{rewrapped:true};
}
async function actionJournalRekey(user:any,body:any){
  await requireJournalProof(user.id,body?.proof);
  const v=body?.vault||{};
  const iterations=Number(v.kdf_iterations);
  if(!Number.isInteger(iterations)||iterations<600000||iterations>5000000)throw new ClientError("Invalid journal KDF settings",400);
  const patch={
    kdf_iterations:iterations,
    kdf_salt:journalBase64url(v.kdf_salt,16,128,"journal KDF salt"),
    wrap_iv:journalBase64url(v.wrap_iv,16,64,"journal wrap IV"),
    wrapped_key:journalBase64url(v.wrapped_key,48,160,"wrapped journal key"),
    recovery_salt:journalBase64url(v.recovery_salt,16,128,"journal recovery salt"),
    recovery_iv:journalBase64url(v.recovery_iv,16,64,"journal recovery IV"),
    recovery_wrapped_key:journalBase64url(v.recovery_wrapped_key,48,160,"journal recovery key")
  };
  const existing=await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id&limit=1");
  if(!existing?.length)throw new ClientError("Journal vault is not configured",404);
  await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id),{
    method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify(patch)
  });
  return{rekeyed:true};
}
async function actionJournalRotateRecovery(user:any,body:any){
  await requireJournalProof(user.id,body?.proof);
  const v=body?.vault||{};
  const patch={
    recovery_salt:journalBase64url(v.recovery_salt,16,128,"journal recovery salt"),
    recovery_iv:journalBase64url(v.recovery_iv,16,64,"journal recovery IV"),
    recovery_wrapped_key:journalBase64url(v.recovery_wrapped_key,48,160,"journal recovery key")
  };
  const existing=await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id&limit=1");
  if(!existing?.length)throw new ClientError("Journal vault is not configured",404);
  await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id),{
    method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify(patch)
  });
  return{rotated:true};
}
async function actionJournalReset(user:any,body:any){
  await requireJournalProof(user.id,body?.proof);
  if(String(body?.confirmation||"")!=="ERASE JOURNAL")throw new ClientError("Type ERASE JOURNAL to confirm journal destruction.",400);
  await admin("/rest/v1/journal_vaults?user_id=eq."+encodeURIComponent(user.id),{
    method:"DELETE",headers:{Prefer:"return=minimal"}
  });
  return{reset:true};
}

const ACTION_LIMITS:Record<string,{limit:number,window:number}> = {
  pk_connect:{limit:10,window:60},
  pk_status:{limit:120,window:60},
  pk_disconnect:{limit:10,window:60},
  pk_mirror_front:{limit:60,window:60},
  pk_compare:{limit:30,window:60},
  pk_import:{limit:120,window:60},
  pk_import_groups:{limit:10,window:60},
  pk_sync_compare:{limit:30,window:60},
  pk_sync_apply:{limit:10,window:60},
  pk_get_system:{limit:60,window:60},
  pk_update_system:{limit:20,window:60},
  pk_import_fronts:{limit:120,window:60},
  import_media:{limit:30,window:60},
  upload_media:{limit:60,window:60},
  password_range:{limit:12,window:60},
  delete_member:{limit:10,window:60},
  backup_export:{limit:5,window:60},
  backup_preview:{limit:10,window:60},
  backup_restore:{limit:2,window:300},
  front_history_preview:{limit:60,window:60},
  front_history_correct:{limit:20,window:60},
  front_history_delete:{limit:10,window:60},
  journal_status:{limit:60,window:60},
  journal_setup:{limit:3,window:300},
  journal_list:{limit:60,window:60},
  journal_save:{limit:60,window:60},
  journal_delete:{limit:20,window:60},
  journal_rewrap:{limit:5,window:300},
  journal_rotate_recovery:{limit:5,window:300},
  journal_rekey:{limit:3,window:300},
  journal_reset:{limit:2,window:600},
};
const AUDITED_ACTIONS=new Set([
  "pk_connect","pk_disconnect","pk_mirror_front","pk_import","pk_import_groups","pk_sync_apply",
  "pk_update_system","pk_import_fronts","import_media","upload_media","delete_member",
  "backup_export","backup_restore","front_history_correct","front_history_delete",
  "journal_setup","journal_delete","journal_rewrap","journal_rotate_recovery","journal_rekey","journal_reset"
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

async function actionPasswordRange(body:any){
  const prefix=String(body.prefix||"").trim().toUpperCase();
  if(!/^[A-F0-9]{5}$/.test(prefix))throw new ClientError("Invalid password hash prefix");

  const response=await fetch("https://api.pwnedpasswords.com/range/"+prefix,{
    method:"GET",
    headers:{
      "Accept":"text/plain",
      "Add-Padding":"true",
      "User-Agent":"Project-Nihility/1.0 (+https://projectnihilityofficial.top)"
    },
    signal:AbortSignal.timeout(8000),
    cache:"no-store"
  });

  if(!response.ok){
    console.warn("Pwned Passwords request failed",response.status);
    throw new ClientError("Password safety service is temporarily unavailable. Please try again.",503);
  }

  const range=await response.text();
  if(range.length>100000)throw new Error("Unexpected Pwned Passwords response size");
  return {range};
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
  if(origin && !ALLOWED_ORIGINS.has(origin))return json({error:"Origin not allowed"},403,origin);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors(origin)});
  if(req.method!=="POST")return json({error:"Method not allowed"},405,origin);

  let user:any=null;
  let action="unknown";
  try{
    user=await currentUser(req);
    const profile=await admin("/rest/v1/profiles?user_id=eq."+encodeURIComponent(user.id)+"&select=user_id,role&limit=1");
    if(!profile?.length)throw new ClientError("Nihility profile required",403);

    const headerAction=String(req.headers.get("x-nihility-action")||"");
    if(headerAction==="upload_media"){
      action="upload_media";
      await consumeRateLimit(user.id,action);
      const result=await actionUploadMedia(user,req);
      await recordSecurityEvent(user.id,"edge."+action,true,{origin:origin||null});
      return json(result,200,origin);
    }

    if(headerAction==="journal_save"){
      action="journal_save";
      await consumeRateLimit(user.id,action);
      const contentType=(req.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
      if(contentType!=="application/json")throw new ClientError("JSON content type required",415);
      const body=await readJsonBody(req,512*1024);
      const result=await actionJournalSave(user,body);
      return json(result,200,origin);
    }

    if(headerAction==="backup_preview"||headerAction==="backup_restore"){
      action=headerAction;
      if(profile?.[0]?.role!=="owner")throw new ClientError("Only the Nihility owner can manage full backups.",403);
      await consumeRateLimit(user.id,action);
      const body=await readBackupRequest(req);
      const result=action==="backup_preview"
        ?await actionBackupPreview(user,body)
        :await actionBackupRestore(user,body);
      if(AUDITED_ACTIONS.has(action)){
        await recordSecurityEvent(user.id,"edge."+action,true,{origin:origin||null});
      }
      return json(result,200,origin);
    }

    const contentType=(req.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
    if(contentType!=="application/json")throw new ClientError("JSON content type required",415);
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
    else if(action==="pk_sync_compare")result=await actionPkSyncCompare(user);
    else if(action==="pk_sync_apply")result=await actionPkSyncApply(user,body);
    else if(action==="pk_get_system")result=await actionGetPkSystem(user);
    else if(action==="pk_update_system")result=await actionUpdatePkSystem(user,body);
    else if(action==="pk_import_fronts")result=await actionImportPkFronts(user,body);
    else if(action==="import_media")result=await actionImportMedia(user,body);
    else if(action==="password_range")result=await actionPasswordRange(body);
    else if(action==="delete_member")result=await actionDeleteMember(user,body);
    else if(action==="backup_export")result=await actionBackupExport(user);
    else if(action==="front_history_preview")result=await actionFrontHistoryPreview(user,body);
    else if(action==="front_history_correct")result=await actionFrontHistoryCorrect(user,body);
    else if(action==="front_history_delete")result=await actionFrontHistoryDelete(user,body);
    else if(action==="journal_status")result=await actionJournalStatus(user);
    else if(action==="journal_setup")result=await actionJournalSetup(user,body);
    else if(action==="journal_list")result=await actionJournalList(user,body);
    else if(action==="journal_save")result=await actionJournalSave(user,body);
    else if(action==="journal_delete")result=await actionJournalDelete(user,body);
    else if(action==="journal_rewrap")result=await actionJournalRewrap(user,body);
    else if(action==="journal_rotate_recovery")result=await actionJournalRotateRecovery(user,body);
    else if(action==="journal_rekey")result=await actionJournalRekey(user,body);
    else if(action==="journal_reset")result=await actionJournalReset(user,body);
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

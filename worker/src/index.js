const TYPES={"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif"};
const json=(body,status,headers={})=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json",...headers}});
function cors(env,origin){const allowed=env.ALLOWED_ORIGIN||"";return{"Access-Control-Allow-Origin":origin===allowed?origin:allowed,"Access-Control-Allow-Headers":"Authorization, Content-Type, X-File-Name","Access-Control-Allow-Methods":"PUT, DELETE, OPTIONS","Vary":"Origin"}}
async function userFor(request,env){
  const auth=request.headers.get("Authorization")||"";
  if(!auth.startsWith("Bearer "))throw new Error("Missing bearer token.");
  const r=await fetch(env.SUPABASE_URL.replace(/\/$/,"")+"/auth/v1/user",{headers:{Authorization:auth,apikey:env.SUPABASE_ANON_KEY}});
  if(!r.ok)throw new Error("Invalid Supabase session.");
  const u=await r.json();
  if(env.ALLOWED_USER_ID&&u.id!==env.ALLOWED_USER_ID)throw new Error("This upload service is restricted to another account.");
  return u;
}
export default{async fetch(request,env){
  const origin=request.headers.get("Origin")||"",headers=cors(env,origin);
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
  try{
    const user=await userFor(request,env),url=new URL(request.url);
    if(request.method==="PUT"&&url.pathname.startsWith("/media/")){
      const kind=url.pathname.split("/").filter(Boolean)[1];
      if(!["avatar","banner"].includes(kind))return json({error:"Unknown media kind."},404,headers);
      const type=request.headers.get("Content-Type")||"",ext=TYPES[type];
      if(!ext)return json({error:"Unsupported image type."},415,headers);
      const max=kind==="avatar"?2*1024*1024:5*1024*1024;
      const declared=Number(request.headers.get("Content-Length")||0);
      if(declared&&declared>max)return json({error:"File exceeds the upload limit."},413,headers);
      const body=await request.arrayBuffer();
      if(body.byteLength>max)return json({error:"File exceeds the upload limit."},413,headers);
      const key=user.id+"/"+kind+"/"+crypto.randomUUID()+"."+ext;
      await env.MEDIA.put(key,body,{httpMetadata:{contentType:type,cacheControl:"public, max-age=31536000, immutable"},customMetadata:{owner:user.id,originalName:request.headers.get("X-File-Name")||""}});
      return json({key,url:env.R2_PUBLIC_BASE_URL.replace(/\/$/,"")+"/"+key,source:"r2"},201,headers);
    }
    if(request.method==="DELETE"&&url.pathname==="/media"){
      const key=url.searchParams.get("key")||"";
      if(!key.startsWith(user.id+"/"))return json({error:"Invalid media key."},403,headers);
      await env.MEDIA.delete(key);return json({ok:true},200,headers);
    }
    return json({error:"Not found."},404,headers);
  }catch(e){return json({error:e.message||"Unauthorized."},401,headers)}
}};
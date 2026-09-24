'use strict';

(()=>{
  const enc=new TextEncoder();
  const dec=new TextDecoder();
  const MIME_EXT={
    'image/png':'png',
    'image/jpeg':'jpg',
    'image/webp':'webp',
    'image/gif':'gif'
  };
  const CRC_TABLE=(()=>{
    const table=new Uint32Array(256);
    for(let n=0;n<256;n++){
      let c=n;
      for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);
      table[n]=c>>>0;
    }
    return table;
  })();

  function clone(value){return JSON.parse(JSON.stringify(value))}
  function u16(view,offset,value){view.setUint16(offset,value,true)}
  function u32(view,offset,value){view.setUint32(offset,value>>>0,true)}
  function getU16(bytes,offset){return bytes[offset]|(bytes[offset+1]<<8)}
  function getU32(bytes,offset){return (bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16)|(bytes[offset+3]<<24))>>>0}
  function safeName(value){return String(value||'media').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,120)||'media'}

  async function crc32(blob){
    let crc=0xffffffff;
    const chunk=1024*1024;
    for(let offset=0;offset<blob.size;offset+=chunk){
      const bytes=new Uint8Array(await blob.slice(offset,Math.min(blob.size,offset+chunk)).arrayBuffer());
      for(const b of bytes)crc=CRC_TABLE[(crc^b)&0xff]^(crc>>>8);
    }
    return (crc^0xffffffff)>>>0;
  }
  async function sha256Blob(blob){
    const bytes=await blob.arrayBuffer();
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
  }

  async function zipStore(entries,onProgress=()=>{}){
    if(entries.length>65535)throw new Error('Backup contains too many ZIP entries.');
    const names=new Set();
    const parts=[];
    const central=[];
    let offset=0;
    let index=0;

    for(const entry of entries){
      const name=String(entry.name||'');
      if(!name||names.has(name))throw new Error('Backup contains an invalid or duplicate ZIP filename.');
      names.add(name);
      const blob=entry.blob instanceof Blob?entry.blob:new Blob([entry.blob]);
      if(blob.size>0xffffffff)throw new Error('A backup file is too large for this ZIP format.');
      const nameBytes=enc.encode(name);
      if(nameBytes.length>65535)throw new Error('A backup filename is too long.');
      const crc=await crc32(blob);

      const local=new Uint8Array(30);
      const lv=new DataView(local.buffer);
      u32(lv,0,0x04034b50);
      u16(lv,4,20);
      u16(lv,6,0x0800);
      u16(lv,8,0);
      u16(lv,10,0);
      u16(lv,12,0);
      u32(lv,14,crc);
      u32(lv,18,blob.size);
      u32(lv,22,blob.size);
      u16(lv,26,nameBytes.length);
      u16(lv,28,0);

      const center=new Uint8Array(46+nameBytes.length);
      const cv=new DataView(center.buffer);
      u32(cv,0,0x02014b50);
      u16(cv,4,20);
      u16(cv,6,20);
      u16(cv,8,0x0800);
      u16(cv,10,0);
      u16(cv,12,0);
      u16(cv,14,0);
      u32(cv,16,crc);
      u32(cv,20,blob.size);
      u32(cv,24,blob.size);
      u16(cv,28,nameBytes.length);
      u16(cv,30,0);
      u16(cv,32,0);
      u16(cv,34,0);
      u16(cv,36,0);
      u32(cv,38,0);
      u32(cv,42,offset);
      center.set(nameBytes,46);
      central.push(center);

      parts.push(local,nameBytes,blob);
      offset+=local.length+nameBytes.length+blob.size;
      index++;
      onProgress({phase:'packing',current:index,total:entries.length,name});
    }

    const centralOffset=offset;
    let centralSize=0;
    for(const item of central){parts.push(item);centralSize+=item.length;offset+=item.length}

    const end=new Uint8Array(22);
    const ev=new DataView(end.buffer);
    u32(ev,0,0x06054b50);
    u16(ev,4,0);u16(ev,6,0);
    u16(ev,8,entries.length);u16(ev,10,entries.length);
    u32(ev,12,centralSize);
    u32(ev,16,centralOffset);
    u16(ev,20,0);
    parts.push(end);
    return new Blob(parts,{type:'application/zip'});
  }

  async function parseStoredZip(file){
    if(file.size<22)throw new Error('This ZIP backup is incomplete.');
    const tailStart=Math.max(0,file.size-65557);
    const tail=new Uint8Array(await file.slice(tailStart).arrayBuffer());
    let eocd=-1;
    for(let i=tail.length-22;i>=0;i--){
      if(getU32(tail,i)===0x06054b50){eocd=i;break}
    }
    if(eocd<0)throw new Error('Unable to find the ZIP directory.');
    const count=getU16(tail,eocd+10);
    const centralSize=getU32(tail,eocd+12);
    const centralOffset=getU32(tail,eocd+16);
    if(centralOffset+centralSize>file.size)throw new Error('The ZIP directory is invalid.');

    const dir=new Uint8Array(await file.slice(centralOffset,centralOffset+centralSize).arrayBuffer());
    const entries=new Map();
    let pos=0;
    for(let i=0;i<count;i++){
      if(pos+46>dir.length||getU32(dir,pos)!==0x02014b50)throw new Error('The ZIP directory is damaged.');
      const flags=getU16(dir,pos+8);
      const method=getU16(dir,pos+10);
      const crc=getU32(dir,pos+16);
      const compressedSize=getU32(dir,pos+20);
      const size=getU32(dir,pos+24);
      const nameLen=getU16(dir,pos+28);
      const extraLen=getU16(dir,pos+30);
      const commentLen=getU16(dir,pos+32);
      const localOffset=getU32(dir,pos+42);
      if(method!==0)throw new Error('This ZIP uses compression Nihility does not support.');
      if(!(flags&0x0800)&&nameLen)throw new Error('This ZIP uses an unsupported filename encoding.');
      const nameStart=pos+46;
      const nameEnd=nameStart+nameLen;
      if(nameEnd+extraLen+commentLen>dir.length)throw new Error('The ZIP directory is damaged.');
      const name=dec.decode(dir.slice(nameStart,nameEnd));
      if(entries.has(name))throw new Error('The ZIP contains duplicate filenames.');

      const local=new Uint8Array(await file.slice(localOffset,localOffset+30).arrayBuffer());
      if(local.length<30||getU32(local,0)!==0x04034b50)throw new Error('A ZIP entry is damaged.');
      const localNameLen=getU16(local,26);
      const localExtraLen=getU16(local,28);
      const dataStart=localOffset+30+localNameLen+localExtraLen;
      if(dataStart+compressedSize>file.size)throw new Error('A ZIP entry extends past the end of the file.');
      const blob=file.slice(dataStart,dataStart+compressedSize);
      entries.set(name,{blob,size,crc,method});
      pos=nameEnd+extraLen+commentLen;
    }
    return entries;
  }

  function stripServerMediaPaths(backup){
    const copy=clone(backup);
    copy.media=(Array.isArray(copy.media)?copy.media:[]).map(item=>({
      key:item.key,
      kind:item.kind,
      included:false
    }));
    return copy;
  }

  async function createJsonBackup(backup){
    const portable=stripServerMediaPaths(backup);
    return new Blob([JSON.stringify(portable,null,2)],{type:'application/json'});
  }

  async function createMediaZip(backup,getMediaBlob,onProgress=()=>{}){
    const portable=clone(backup);
    const mediaEntries=[];
    const manifest=[];
    let missing=0;
    const source=Array.isArray(portable.media)?portable.media:[];
    for(let i=0;i<source.length;i++){
      const item=source[i]||{};
      onProgress({phase:'media',current:i,total:source.length,key:item.key});
      try{
        const blob=await getMediaBlob(item.kind,item.source_path);
        const mime=String(blob.type||'').toLowerCase();
        const ext=MIME_EXT[mime];
        if(!ext)throw new Error('Unsupported media type');
        const archivePath='media/'+String(i+1).padStart(5,'0')+'-'+safeName(item.key)+'.'+ext;
        manifest.push({
          key:item.key,
          kind:item.kind,
          included:true,
          archive_path:archivePath,
          mime,
          size:blob.size,
          sha256:await sha256Blob(blob)
        });
        mediaEntries.push({name:archivePath,blob});
      }catch(error){
        console.warn('Unable to include backup media',item.key,error);
        missing++;
        manifest.push({key:item.key,kind:item.kind,included:false});
      }
    }
    portable.media=manifest;
    const backupBlob=new Blob([JSON.stringify(portable,null,2)],{type:'application/json'});
    const zip=await zipStore([{name:'nihility-backup.json',blob:backupBlob},...mediaEntries],onProgress);
    return{blob:zip,missing,total:source.length};
  }

  async function readBackupFile(file){
    if(!(file instanceof Blob))throw new Error('Choose a backup file first.');
    if(file.size>1100*1024*1024)throw new Error('Backup file is too large.');
    const magic=new Uint8Array(await file.slice(0,4).arrayBuffer());
    const isZip=magic.length===4&&getU32(magic,0)===0x04034b50;
    if(isZip){
      const entries=await parseStoredZip(file);
      const backupEntry=entries.get('nihility-backup.json');
      if(!backupEntry)throw new Error('ZIP does not contain nihility-backup.json.');
      if(backupEntry.blob.size>64*1024*1024)throw new Error('Backup metadata is too large.');
      let backup;
      try{backup=JSON.parse(await backupEntry.blob.text())}
      catch{throw new Error('Backup metadata is not valid JSON.')}
      return{backup,entries,isZip:true};
    }
    if(file.size>64*1024*1024)throw new Error('JSON backup is too large.');
    let backup;
    try{backup=JSON.parse(await file.text())}
    catch{throw new Error('Backup file is not valid JSON.')}
    return{backup,entries:new Map(),isZip:false};
  }

  async function verifiedMediaBlob(parsed,item){
    if(!item?.included||!item.archive_path)throw new Error('Media is not included in this backup.');
    const entry=parsed.entries.get(item.archive_path);
    if(!entry)throw new Error('Backup media file is missing: '+item.archive_path);
    if(Number.isFinite(Number(item.size))&&Number(item.size)!==entry.blob.size)throw new Error('Backup media size check failed.');
    if(item.sha256){
      const actual=await sha256Blob(entry.blob);
      if(actual!==String(item.sha256).toLowerCase())throw new Error('Backup media integrity check failed.');
    }
    const mime=String(item.mime||'').toLowerCase();
    if(!MIME_EXT[mime])throw new Error('Backup media type is unsupported.');
    return new Blob([entry.blob],{type:mime});
  }

  function download(blob,filename){
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=filename;
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }

  window.nihilityBackup={
    createJsonBackup,
    createMediaZip,
    readBackupFile,
    verifiedMediaBlob,
    download
  };
})();

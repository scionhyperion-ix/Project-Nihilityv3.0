(()=>{
  'use strict';

  const CONFIGS=[
    {key:'member-avatar',urlId:'memberAvatarUrl',fileId:'memberAvatarFile',storageKind:'avatar',shape:'avatar',label:'profile picture',previewImage:'#memberPreviewAvatar'},
    {key:'member-banner',urlId:'memberBannerUrl',fileId:'memberBannerFile',storageKind:'banner',shape:'banner',label:'banner',previewImage:'#memberPreviewBanner'},
    {key:'profile-avatar',urlId:'profileAvatarUrl',fileId:'profileAvatarFile',storageKind:'profile',shape:'avatar',label:'profile picture',previewImage:'#profileAvatarPreview img'},
    {key:'profile-banner',urlId:'profileBannerUrl',fileId:'profileBannerFile',storageKind:'banner',shape:'banner',label:'banner',previewBackground:'#profileBannerPreview'},
    {key:'group-icon',urlId:'groupsManagerIconUrl',fileId:'groupsManagerIconFile',storageKind:'avatar',shape:'avatar',label:'group icon',previewImage:'#groupPreviewIconImage'},
    {key:'group-banner',urlId:'groupsManagerBannerUrl',fileId:'groupsManagerBannerFile',storageKind:'banner',shape:'banner',label:'group banner',previewBackground:'#groupPreviewBanner'},
    {key:'system-avatar',urlId:'systemEditAvatar',fileId:'systemEditAvatarFile',storageKind:'avatar',shape:'avatar',label:'system profile picture',previewImage:'#systemEditorAvatarPreview',preferSavedPreview:true},
    {key:'system-banner',urlId:'systemEditBanner',fileId:'systemEditBannerFile',storageKind:'banner',shape:'banner',label:'system banner',previewBackground:'#systemEditorBannerPreview',preferSavedPreview:true}
  ];

  const state={config:null,image:null,objectUrl:null,angle:0,zoom:1,offsetX:0,offsetY:0,dragging:false,pointerId:null,lastX:0,lastY:0};
  const enhanced=new WeakSet();
  const remotePreviews=new Map();
  const previewTimers=new Map();
  let dialog=null,canvas=null,ctx=null,zoomInput=null,message=null;

  function outputSize(shape){
    return shape==='banner'?{width:1500,height:500}:{width:1024,height:1024};
  }

  function ensureDialog(){
    if(dialog)return dialog;
    dialog=document.createElement('dialog');
    dialog.id='nihilityMediaEditorDialog';
    dialog.className='modal-dialog media-editor-dialog';
    dialog.innerHTML=`
      <div class="modal-card media-editor-card">
        <div class="modal-heading media-editor-heading">
          <div>
            <p class="eyebrow">Image editor</p>
            <h3 id="mediaEditorTitle">Adjust image</h3>
            <p id="mediaEditorSubtitle" class="muted">Drag to reposition, then zoom or rotate.</p>
          </div>
          <button id="closeMediaEditor" class="icon-button" type="button" aria-label="Close">×</button>
        </div>
        <div id="mediaEditorStage" class="media-editor-stage">
          <canvas id="mediaEditorCanvas" aria-label="Image crop preview"></canvas>
          <div class="media-editor-crop-outline" aria-hidden="true"></div>
        </div>
        <div class="media-editor-controls">
          <label class="media-editor-zoom">Zoom
            <input id="mediaEditorZoom" type="range" min="1" max="3" step="0.01" value="1">
          </label>
          <div class="media-editor-button-row">
            <button id="mediaEditorRotateLeft" class="secondary-button" type="button">↶ Rotate</button>
            <button id="mediaEditorRotateRight" class="secondary-button" type="button">Rotate ↷</button>
            <button id="mediaEditorReset" class="text-button" type="button">Reset</button>
          </div>
        </div>
        <p id="mediaEditorMessage" class="form-message media-editor-message"></p>
        <div class="modal-footer media-editor-footer">
          <button id="cancelMediaEditor" class="secondary-button" type="button">Cancel</button>
          <button id="applyMediaEditor" class="primary-button" type="button">Apply crop</button>
        </div>
      </div>`;
    document.body.append(dialog);

    canvas=dialog.querySelector('#mediaEditorCanvas');
    ctx=canvas.getContext('2d',{alpha:false});
    zoomInput=dialog.querySelector('#mediaEditorZoom');
    message=dialog.querySelector('#mediaEditorMessage');

    dialog.querySelector('#closeMediaEditor').onclick=closeEditor;
    dialog.querySelector('#cancelMediaEditor').onclick=closeEditor;
    dialog.querySelector('#mediaEditorRotateLeft').onclick=()=>rotate(-90);
    dialog.querySelector('#mediaEditorRotateRight').onclick=()=>rotate(90);
    dialog.querySelector('#mediaEditorReset').onclick=resetTransform;
    dialog.querySelector('#applyMediaEditor').onclick=applyCrop;

    zoomInput.addEventListener('input',()=>{
      state.zoom=Number(zoomInput.value)||1;
      clampOffsets();
      draw();
    });

    canvas.addEventListener('pointerdown',event=>{
      if(!state.image)return;
      state.dragging=true;
      state.pointerId=event.pointerId;
      state.lastX=event.clientX;
      state.lastY=event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove',event=>{
      if(!state.dragging||event.pointerId!==state.pointerId)return;
      const rect=canvas.getBoundingClientRect();
      state.offsetX+=(event.clientX-state.lastX)*(canvas.width/Math.max(1,rect.width));
      state.offsetY+=(event.clientY-state.lastY)*(canvas.height/Math.max(1,rect.height));
      state.lastX=event.clientX;
      state.lastY=event.clientY;
      clampOffsets();
      draw();
    });
    const endDrag=event=>{
      if(!state.dragging)return;
      if(event&&state.pointerId!==null&&event.pointerId!==state.pointerId)return;
      state.dragging=false;
      state.pointerId=null;
      canvas.classList.remove('is-dragging');
    };
    canvas.addEventListener('pointerup',endDrag);
    canvas.addEventListener('pointercancel',endDrag);

    let backdropDown=false;
    dialog.addEventListener('pointerdown',event=>{backdropDown=event.target===dialog});
    dialog.addEventListener('pointerup',event=>{if(backdropDown&&event.target===dialog)closeEditor();backdropDown=false});
    dialog.addEventListener('pointercancel',()=>{backdropDown=false});
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeEditor()});
    return dialog;
  }

  function cleanupSource(){
    if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
    state.objectUrl=null;
    state.image=null;
  }

  function closeEditor(){
    if(dialog?.open)dialog.close();
    cleanupSource();
    state.config=null;
  }

  function backgroundUrl(element){
    if(!element)return '';
    const value=getComputedStyle(element).backgroundImage||'';
    const match=value.match(/url\(["']?(.*?)["']?\)/i);
    return match?.[1]||'';
  }

  async function fetchImageBlob(url){
    const response=await fetch(url,{method:'GET',credentials:'omit',referrerPolicy:'no-referrer'});
    if(!response.ok)throw new Error('Could not load that image.');
    const blob=await response.blob();
    if(!blob.type.startsWith('image/'))throw new Error('The selected source is not an image.');
    return blob;
  }

  function clearRemotePreview(config){
    const previous=remotePreviews.get(config.key);
    if(previous?.objectUrl)URL.revokeObjectURL(previous.objectUrl);
    remotePreviews.delete(config.key);
    document.dispatchEvent(new CustomEvent('nihility-media-preview',{detail:{key:config.key,url:null}}));
  }

  async function importRemoteBlob(config,remote){
    let tempPath=null;
    try{
      const result=await window.nihilityApi.secure('import_media',{kind:config.storageKind,url:remote});
      tempPath=result?.path||null;
      if(!tempPath)throw new Error('The image link could not be imported.');
      return await window.nihilityApi.privateMediaBlob(config.storageKind,tempPath);
    }finally{
      if(tempPath){
        try{await window.nihilityApi.deleteMedia(config.storageKind,tempPath)}
        catch(error){console.warn('Unable to clean up temporary editor media',error)}
      }
    }
  }

  function setRemotePreview(config,sourceUrl,blob){
    clearRemotePreview(config);
    const objectUrl=URL.createObjectURL(blob);
    remotePreviews.set(config.key,{sourceUrl,blob,objectUrl});
    document.dispatchEvent(new CustomEvent('nihility-media-preview',{detail:{key:config.key,url:objectUrl}}));
    return objectUrl;
  }

  function scheduleRemotePreview(config,status){
    clearTimeout(previewTimers.get(config.key));
    const input=document.getElementById(config.urlId);
    const remote=(input?.value||'').trim();
    if(!remote){
      clearRemotePreview(config);
      status.textContent=document.getElementById(config.fileId)?.files?.[0]?'Image selected, adjust if needed':'Crop, reposition or rotate';
      return;
    }
    let parsed;
    try{parsed=new URL(remote)}catch{
      clearRemotePreview(config);
      status.textContent='Enter a valid HTTPS image link';
      return;
    }
    if(parsed.protocol!=='https:'){
      clearRemotePreview(config);
      status.textContent='Image links must use HTTPS';
      return;
    }
    status.textContent='Loading link preview...';
    const timer=setTimeout(async()=>{
      const latest=(input?.value||'').trim();
      if(latest!==remote)return;
      try{
        const blob=await importRemoteBlob(config,remote);
        if((input?.value||'').trim()!==remote)return;
        setRemotePreview(config,remote,blob);
        status.textContent='Link preview ready, adjust if needed';
      }catch(error){
        clearRemotePreview(config);
        status.textContent=error.message||'Could not preview this image link';
      }
    },550);
    previewTimers.set(config.key,timer);
  }

  async function getSourceBlob(config){
    const fileInput=document.getElementById(config.fileId);
    const urlInput=document.getElementById(config.urlId);
    const file=fileInput?.files?.[0];
    if(file)return file;

    const remote=(urlInput?.value||'').trim();
    let current='';
    if(config.previewImage){
      const img=document.querySelector(config.previewImage);
      if(img&&!img.hidden)current=img.currentSrc||img.src||'';
    }
    if(!current&&config.previewBackground)current=backgroundUrl(document.querySelector(config.previewBackground));

    if(remote){
      const cached=remotePreviews.get(config.key);
      if(cached?.sourceUrl===remote&&cached.blob)return cached.blob;
      if(config.preferSavedPreview&&urlInput?.dataset.mediaSavedValue===remote&&current){
        return await fetchImageBlob(current);
      }
      return await importRemoteBlob(config,remote);
    }

    if(current)return fetchImageBlob(current);

    throw new Error('Choose an upload or enter an image link first.');
  }

  async function decodeImage(blob){
    if(blob.size>12*1024*1024)throw new Error('This image is too large to edit in the browser.');
    const url=URL.createObjectURL(blob);
    const img=new Image();
    img.decoding='async';
    img.src=url;
    try{
      await new Promise((resolve,reject)=>{
        img.onload=resolve;
        img.onerror=()=>reject(new Error('The image could not be decoded.'));
      });
      if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>50000000){
        throw new Error('This image is too large to edit safely.');
      }
      state.objectUrl=url;
      state.image=img;
    }catch(error){
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function rotatedSize(){
    if(!state.image)return{width:1,height:1};
    const angle=((state.angle%360)+360)%360;
    return angle===90||angle===270
      ?{width:state.image.naturalHeight,height:state.image.naturalWidth}
      :{width:state.image.naturalWidth,height:state.image.naturalHeight};
  }

  function coverScale(){
    const size=rotatedSize();
    return Math.max(canvas.width/size.width,canvas.height/size.height);
  }

  function clampOffsets(){
    if(!state.image)return;
    const size=rotatedSize();
    const scale=coverScale()*state.zoom;
    const maxX=Math.max(0,(size.width*scale-canvas.width)/2);
    const maxY=Math.max(0,(size.height*scale-canvas.height)/2);
    state.offsetX=Math.max(-maxX,Math.min(maxX,state.offsetX));
    state.offsetY=Math.max(-maxY,Math.min(maxY,state.offsetY));
  }

  function draw(){
    if(!state.image)return;
    ctx.save();
    ctx.fillStyle='#0b1018';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.translate(canvas.width/2+state.offsetX,canvas.height/2+state.offsetY);
    ctx.rotate(state.angle*Math.PI/180);
    const scale=coverScale()*state.zoom;
    ctx.scale(scale,scale);
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality='high';
    ctx.drawImage(state.image,-state.image.naturalWidth/2,-state.image.naturalHeight/2);
    ctx.restore();
  }

  function resetTransform(){
    state.angle=0;
    state.zoom=1;
    state.offsetX=0;
    state.offsetY=0;
    zoomInput.value='1';
    clampOffsets();
    draw();
  }

  function rotate(delta){
    state.angle=(state.angle+delta)%360;
    state.offsetX=0;
    state.offsetY=0;
    clampOffsets();
    draw();
  }

  async function openEditor(config){
    ensureDialog();
    cleanupSource();
    state.config=config;
    const size=outputSize(config.shape);
    canvas.width=size.width;
    canvas.height=size.height;
    const stage=dialog.querySelector('#mediaEditorStage');
    stage.classList.toggle('banner-editor',config.shape==='banner');
    stage.classList.toggle('avatar-editor',config.shape!=='banner');
    dialog.querySelector('#mediaEditorTitle').textContent='Adjust '+config.label;
    dialog.querySelector('#mediaEditorSubtitle').textContent=config.shape==='banner'
      ?'Drag to reposition the wide crop, then zoom or rotate.'
      :'Drag to reposition the square crop, then zoom or rotate.';
    message.textContent='Loading image...';

    const blob=await getSourceBlob(config);
    await decodeImage(blob);
    resetTransform();
    message.textContent='Drag the image to choose the crop area.';
    dialog.showModal();
  }

  function exportBlob(){
    return new Promise((resolve,reject)=>{
      canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not create the edited image.')),'image/webp',0.92);
    });
  }

  async function applyCrop(){
    if(!state.config||!state.image)return;
    const apply=dialog.querySelector('#applyMediaEditor');
    apply.disabled=true;
    apply.textContent='Applying...';
    message.textContent='Preparing edited image...';
    try{
      const blob=await exportBlob();
      const config=state.config;
      const fileInput=document.getElementById(config.fileId);
      const urlInput=document.getElementById(config.urlId);
      if(!fileInput)throw new Error('The upload field is unavailable.');

      const file=new File([blob],config.shape==='banner'?'nihility-banner.webp':'nihility-avatar.webp',{type:'image/webp',lastModified:Date.now()});
      const transfer=new DataTransfer();
      transfer.items.add(file);
      fileInput.files=transfer.files;
      if(urlInput)urlInput.value='';
      fileInput.dataset.mediaAdjusted='true';
      fileInput.dispatchEvent(new Event('change',{bubbles:true}));

      const controls=document.querySelector('[data-media-editor-key="'+config.key+'"]');
      const status=controls?.querySelector('.media-edit-status');
      if(status)status.textContent='Adjusted image ready';
      closeEditor();
    }catch(error){
      message.textContent=error.message||'Could not apply the crop.';
    }finally{
      apply.disabled=false;
      apply.textContent='Apply crop';
    }
  }

  function enhance(config){
    const file=document.getElementById(config.fileId);
    const url=document.getElementById(config.urlId);
    if(!file||!url||enhanced.has(file))return;
    enhanced.add(file);

    const controls=document.createElement('div');
    controls.className='media-edit-actions';
    controls.dataset.mediaEditorKey=config.key;

    const button=document.createElement('button');
    button.type='button';
    button.className='secondary-button media-edit-button';
    button.textContent='Adjust image';

    const status=document.createElement('small');
    status.className='media-edit-status';
    status.textContent='Crop, reposition or rotate';
    controls.append(button,status);

    const fileLabel=file.closest('label');
    (fileLabel||file).insertAdjacentElement('afterend',controls);

    button.onclick=async()=>{
      button.disabled=true;
      const label=button.textContent;
      button.textContent='Loading...';
      try{
        await openEditor(config);
      }catch(error){
        status.textContent=error.message||'Could not open the image.';
      }finally{
        button.disabled=false;
        button.textContent=label;
      }
    };

    file.addEventListener('change',()=>{
      const selected=file.files?.[0]||null;
      const adjusted=Boolean(selected&&/^nihility-(avatar|banner)\.webp$/i.test(selected.name));
      if(adjusted)file.dataset.mediaAdjusted='true';
      else delete file.dataset.mediaAdjusted;
      if(selected)clearRemotePreview(config);
      status.textContent=selected?(adjusted?'Adjusted image ready':'Image selected, adjust if needed'):(url.value.trim()?'Link ready, adjust if needed':'Crop, reposition or rotate');
    });
    url.addEventListener('input',()=>scheduleRemotePreview(config,status));
    file.closest('form')?.addEventListener('reset',()=>{
      setTimeout(()=>{
        clearTimeout(previewTimers.get(config.key));
        clearRemotePreview(config);
        delete file.dataset.mediaAdjusted;
        status.textContent='Crop, reposition or rotate';
      },0);
    });
  }

  function enhanceAll(){CONFIGS.forEach(enhance)}
  new MutationObserver(enhanceAll).observe(document.documentElement,{childList:true,subtree:true});
  enhanceAll();
  window.nihilityMediaEditor={
    enhanceAll,
    getPreviewUrl(key){return remotePreviews.get(key)?.objectUrl||''},
    clearPreview(key){
      const config=CONFIGS.find(item=>item.key===key);
      if(config)clearRemotePreview(config);
    }
  };
})();
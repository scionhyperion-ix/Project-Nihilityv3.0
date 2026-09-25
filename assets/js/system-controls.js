'use strict';

(function installNihilitySystemControls(){
  const systemPanel=document.querySelector('.system-summary-panel');
  if(!systemPanel)return;

  function safeHttpsUrl(value){
    try{
      const url=new URL(String(value||'').trim());
      return url.protocol==='https:'?url.toString():'';
    }catch{return ''}
  }
  function systemName(system=state.systemProfile||{}){
    return system.name||system.display_name||(system.id?('System '+system.id):'System');
  }

  const systemPreviewMedia={
    avatar:{source:'',objectUrl:'',timer:null,request:0},
    banner:{source:'',objectUrl:'',timer:null,request:0}
  };

  function clearSystemPreviewMedia(slot){
    const item=systemPreviewMedia[slot];if(!item)return;
    clearTimeout(item.timer);
    item.timer=null;
    item.request++;
    if(item.objectUrl)URL.revokeObjectURL(item.objectUrl);
    item.objectUrl='';
    item.source='';
  }

  function clearAllSystemPreviewMedia(){
    clearSystemPreviewMedia('avatar');
    clearSystemPreviewMedia('banner');
    const status=document.querySelector('#systemEditorMediaPreviewStatus');
    if(status){status.textContent='';status.hidden=true}
  }

  function setSystemPreviewStatus(text,error=false){
    const status=document.querySelector('#systemEditorMediaPreviewStatus');if(!status)return;
    status.textContent=text||'';
    status.hidden=!text;
    status.classList.toggle('form-error',Boolean(error));
    status.classList.toggle('muted',!error);
  }

  async function importSystemPreviewBlob(kind,url){
    let path=null;
    try{
      const imported=await nihilityApi.secure('import_media',{kind,url});
      path=imported?.path||null;
      if(!path)throw new Error('Could not prepare the image preview.');
      return await nihilityApi.privateMediaBlob(kind,path);
    }finally{
      if(path){
        try{await nihilityApi.deleteMedia(kind,path)}
        catch(error){console.warn('Unable to clean up temporary system preview media',error)}
      }
    }
  }

  function scheduleSystemMediaPreview(slot){
    const input=document.querySelector(slot==='avatar'?'#systemEditAvatar':'#systemEditBanner');
    const item=systemPreviewMedia[slot];
    if(!input||!item)return;
    clearTimeout(item.timer);
    const raw=input.value.trim();
    const safe=safeHttpsUrl(raw);
    clearSystemPreviewMedia(slot);
    updateSystemPreview();
    if(!raw){
      setSystemPreviewStatus('');
      return;
    }
    if(!safe){
      setSystemPreviewStatus((slot==='avatar'?'Avatar':'Banner')+' must be a valid HTTPS URL.',true);
      return;
    }

    const current=state.systemProfile||{};
    const currentUrl=slot==='avatar'
      ?safeHttpsUrl(current.avatar_url||'')
      :safeHttpsUrl(current.banner||current.banner_url||'');
    const currentDisplay=slot==='avatar'?current.avatar_display_url:current.banner_display_url;
    if(safe===currentUrl&&currentDisplay){
      setSystemPreviewStatus('');
      updateSystemPreview();
      return;
    }

    setSystemPreviewStatus('Loading '+slot+' preview...');
    const request=++item.request;
    item.timer=setTimeout(async()=>{
      try{
        const blob=await importSystemPreviewBlob(slot==='avatar'?'avatar':'banner',safe);
        if(request!==item.request||safeHttpsUrl(input.value)!==safe)return;
        const objectUrl=URL.createObjectURL(blob);
        if(item.objectUrl)URL.revokeObjectURL(item.objectUrl);
        item.objectUrl=objectUrl;
        item.source=safe;
        setSystemPreviewStatus('');
        updateSystemPreview();
      }catch(error){
        if(request!==item.request)return;
        setSystemPreviewStatus(error.message||('Could not preview the '+slot+'.'),true);
        updateSystemPreview();
      }
    },500);
  }

  function ensureSystemEditButton(){
    let button=document.querySelector('#editSystemButton');
    if(!button){
      button=document.createElement('button');
      button.id='editSystemButton';
      button.type='button';
      button.className='secondary-button system-edit-button';
      button.textContent='Edit system';
      button.onclick=openSystemEditor;
      systemPanel.append(button);
    }
    button.hidden=!state.pkConnected;
    return button;
  }

  function ensureSystemEditor(){
    let dialog=document.querySelector('#systemEditorDialog');
    if(dialog)return dialog;

    dialog=document.createElement('dialog');
    dialog.id='systemEditorDialog';
    dialog.className='modal-dialog system-editor-dialog';
    dialog.innerHTML=`
      <form id="systemEditorForm" class="modal-card system-editor-card">
        <div class="modal-heading system-editor-heading">
          <div>
            <p class="eyebrow">PluralKit system</p>
            <h3>Edit system</h3>
            <p class="muted system-editor-subtitle">Update the connected system profile. Saving here updates PluralKit and refreshes Nihility's local copy.</p>
          </div>
          <button id="closeSystemEditor" class="icon-button" type="button" aria-label="Close">×</button>
        </div>

        <div class="system-editor-body">
          <aside class="system-editor-preview" aria-label="System profile preview">
            <div id="systemEditorBannerPreview" class="system-editor-preview-banner"></div>
            <div class="system-editor-preview-content">
              <div class="system-editor-avatar-wrap">
                <img id="systemEditorAvatarPreview" class="system-editor-preview-avatar" alt="" hidden>
                <div id="systemEditorAvatarFallback" class="system-editor-preview-avatar fallback-avatar">S</div>
              </div>
              <div id="systemEditorColorPreview" class="system-editor-color-preview"></div>
              <strong id="systemEditorNamePreview">System</strong>
              <span id="systemEditorPronounsPreview" class="muted"></span>
              <p id="systemEditorDescriptionPreview" class="muted">No description yet.</p>
              <p id="systemEditorMediaPreviewStatus" class="muted system-editor-preview-status" hidden></p>
            </div>
          </aside>

          <section class="system-editor-fields">
            <div class="form-grid two-col system-editor-grid">
              <label>Name<input id="systemEditName" maxlength="100"></label>
              <label>Pronouns<input id="systemEditPronouns" maxlength="100"></label>
              <label>System tag<input id="systemEditTag" maxlength="79" placeholder="Optional system tag"></label>
              <label>Color<input id="systemEditColor" maxlength="7" placeholder="#8b7cf6" pattern="#?[0-9A-Fa-f]{6}"></label>
              <label class="system-editor-wide">Avatar URL<input id="systemEditAvatar" type="url" maxlength="512" placeholder="https://..."></label>
              <label class="system-editor-wide">Banner URL<input id="systemEditBanner" type="url" maxlength="512" placeholder="https://..."></label>
            </div>
            <label class="system-editor-description">Description<textarea id="systemEditDescription" maxlength="1000" rows="6"></textarea></label>
            <p id="systemEditorError" class="form-error" role="alert" hidden></p>
          </section>
        </div>

        <div class="modal-footer system-editor-footer">
          <button id="cancelSystemEditor" class="secondary-button" type="button">Cancel</button>
          <button id="saveSystemEditor" class="primary-button" type="submit">Save system</button>
        </div>
      </form>`;

    document.body.append(dialog);
    const close=()=>dialog.close();
    dialog.querySelector('#closeSystemEditor').onclick=close;
    dialog.querySelector('#cancelSystemEditor').onclick=close;
    dialog.addEventListener('close',clearAllSystemPreviewMedia);

    let backdropDown=false;
    dialog.addEventListener('pointerdown',event=>{backdropDown=event.target===dialog});
    dialog.addEventListener('pointerup',event=>{if(backdropDown&&event.target===dialog)close();backdropDown=false});
    dialog.addEventListener('pointercancel',()=>{backdropDown=false});

    ['systemEditName','systemEditPronouns','systemEditColor','systemEditDescription']
      .forEach(id=>dialog.querySelector('#'+id).addEventListener('input',updateSystemPreview));
    dialog.querySelector('#systemEditAvatar').addEventListener('input',()=>scheduleSystemMediaPreview('avatar'));
    dialog.querySelector('#systemEditBanner').addEventListener('input',()=>scheduleSystemMediaPreview('banner'));

    dialog.querySelector('#systemEditorForm').onsubmit=saveSystemProfile;
    return dialog;
  }

  function setPreviewAvatar(value){
    const img=document.querySelector('#systemEditorAvatarPreview');
    const fallback=document.querySelector('#systemEditorAvatarFallback');
    if(!img||!fallback)return;
    if(!value){
      img.hidden=true;img.removeAttribute('src');fallback.hidden=false;return;
    }
    img.hidden=false;fallback.hidden=true;img.referrerPolicy='no-referrer';img.src=value;
    img.onerror=()=>{img.hidden=true;fallback.hidden=false};
  }

  function updateSystemPreview(){
    const current=state.systemProfile||{};
    const name=document.querySelector('#systemEditName')?.value.trim()||systemName(current);
    const pronouns=document.querySelector('#systemEditPronouns')?.value.trim()||'';
    const description=document.querySelector('#systemEditDescription')?.value.trim()||'';
    const color=String(document.querySelector('#systemEditColor')?.value||'').trim().replace(/^#/,'');
    const avatarInput=safeHttpsUrl(document.querySelector('#systemEditAvatar')?.value||'');
    const bannerInput=safeHttpsUrl(document.querySelector('#systemEditBanner')?.value||'');
    const savedAvatarUrl=safeHttpsUrl(current.avatar_url||'');
    const savedBannerUrl=safeHttpsUrl(current.banner||current.banner_url||'');

    const avatar=systemPreviewMedia.avatar.source===avatarInput&&systemPreviewMedia.avatar.objectUrl
      ?systemPreviewMedia.avatar.objectUrl
      :(avatarInput&&avatarInput===savedAvatarUrl?current.avatar_display_url||'':'');
    const banner=systemPreviewMedia.banner.source===bannerInput&&systemPreviewMedia.banner.objectUrl
      ?systemPreviewMedia.banner.objectUrl
      :(bannerInput&&bannerInput===savedBannerUrl?current.banner_display_url||'':'');

    document.querySelector('#systemEditorNamePreview').textContent=name;
    document.querySelector('#systemEditorPronounsPreview').textContent=pronouns;
    document.querySelector('#systemEditorDescriptionPreview').textContent=description||'No description yet.';
    document.querySelector('#systemEditorAvatarFallback').textContent=initial(name);
    document.querySelector('#systemEditorColorPreview').style.background=/^[0-9a-f]{6}$/i.test(color)?('#'+color):'var(--accent)';

    const bannerPreview=document.querySelector('#systemEditorBannerPreview');
    bannerPreview.style.backgroundImage=banner
      ? 'linear-gradient(rgba(10,11,20,.12),rgba(10,11,20,.28)), url("'+banner.replaceAll('"','%22')+'")'
      : '';
    bannerPreview.classList.toggle('has-image',Boolean(banner));
    setPreviewAvatar(avatar);
  }

  function openSystemEditor(){
    if(!state.pkConnected){toast('PluralKit is not connected','','error');return}
    const dialog=ensureSystemEditor();
    const system=state.systemProfile||{};
    document.querySelector('#systemEditName').value=system.name||'';
    document.querySelector('#systemEditPronouns').value=system.pronouns||'';
    document.querySelector('#systemEditTag').value=system.tag||'';
    document.querySelector('#systemEditColor').value=system.color?('#'+String(system.color).replace(/^#/,'')):'';
    document.querySelector('#systemEditAvatar').value=system.avatar_url||'';
    document.querySelector('#systemEditBanner').value=system.banner||system.banner_url||'';
    document.querySelector('#systemEditDescription').value=system.description||'';
    document.querySelector('#systemEditorError').hidden=true;
    clearAllSystemPreviewMedia();
    updateSystemPreview();
    dialog.showModal();
    if(document.querySelector('#systemEditAvatar').value.trim()&&!system.avatar_display_url)scheduleSystemMediaPreview('avatar');
    if(document.querySelector('#systemEditBanner').value.trim()&&!system.banner_display_url)scheduleSystemMediaPreview('banner');
  }

  function collectDraft(){
    const color=document.querySelector('#systemEditColor').value.trim().replace(/^#/,'');
    return {
      name:document.querySelector('#systemEditName').value.trim()||null,
      pronouns:document.querySelector('#systemEditPronouns').value.trim()||null,
      tag:document.querySelector('#systemEditTag').value.trim()||null,
      color:color||null,
      avatar_url:document.querySelector('#systemEditAvatar').value.trim()||null,
      banner:document.querySelector('#systemEditBanner').value.trim()||null,
      description:document.querySelector('#systemEditDescription').value.trim()||null
    };
  }

  async function saveSystemProfile(event){
    event.preventDefault();
    const dialog=document.querySelector('#systemEditorDialog');
    const error=document.querySelector('#systemEditorError');
    const button=document.querySelector('#saveSystemEditor');
    const system=collectDraft();
    if(system.color&&!/^[0-9a-f]{6}$/i.test(system.color)){error.textContent='Color must be a 6-character hex color.';error.hidden=false;return}
    if(system.avatar_url&&!safeHttpsUrl(system.avatar_url)){error.textContent='Avatar must be a valid HTTPS URL.';error.hidden=false;return}
    if(system.banner&&!safeHttpsUrl(system.banner)){error.textContent='Banner must be a valid HTTPS URL.';error.hidden=false;return}

    error.hidden=true;button.disabled=true;button.textContent='Saving...';
    try{
      const result=await nihilityApi.secure('pk_update_system',{system});
      if(window.nihilitySystemLiveCache){
        window.nihilitySystemLiveCache.value={system:result.system||system};
        window.nihilitySystemLiveCache.at=Date.now();
      }
      state.systemProfile={...(state.systemProfile||{}),...(result.system||system)};
      state.systemProfile.avatar_display_url=null;
      state.systemProfile.banner_display_url=null;
      if(result.system?.avatar_storage_path){
        try{state.systemProfile.avatar_display_url=await nihilityApi.privateMediaUrl('avatar',result.system.avatar_storage_path)}catch{}
      }
      if(result.system?.banner_storage_path){
        try{state.systemProfile.banner_display_url=await nihilityApi.privateMediaUrl('banner',result.system.banner_storage_path)}catch{}
      }
      if(state.integration){
        state.integration.external_system_name=state.systemProfile.name||state.integration.external_system_name;
        state.integration.external_system_id=state.systemProfile.id||state.integration.external_system_id;
      }
      renderAll();
      dialog.close();
      toast('System updated','PluralKit and Nihility are now in sync.');
    }catch(saveError){
      error.textContent=saveError.message||'Could not update the system.';
      error.hidden=false;
    }finally{
      button.disabled=false;button.textContent='Save system';
    }
  }

  const previousRenderAll=renderAll;
  renderAll=function renderAllWithSystemControls(){
    if(window.nihilitySilentRefresh)return;
    previousRenderAll();
    ensureSystemEditButton();
  };

  ensureSystemEditButton();
  ensureSystemEditor();
})();

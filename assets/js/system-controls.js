'use strict';

(function installNihilitySystemControls(){
  const systemPanel=document.querySelector('.system-summary-panel');
  if(!systemPanel)return;

  const localPreviewUrls={avatar:'',banner:''};

  function safeHttpsUrl(value){
    try{
      const url=new URL(String(value||'').trim());
      return url.protocol==='https:'?url.toString():'';
    }catch{return ''}
  }
  function systemName(system=state.systemProfile||{}){
    return system.name||system.display_name||(system.id?('System '+system.id):'System');
  }
  function mediaKey(kind){return kind==='avatar'?'system-avatar':'system-banner'}
  function mediaFile(kind){return document.querySelector(kind==='avatar'?'#systemEditAvatarFile':'#systemEditBannerFile')}
  function mediaUrlInput(kind){return document.querySelector(kind==='avatar'?'#systemEditAvatar':'#systemEditBanner')}

  function clearLocalPreview(kind){
    if(localPreviewUrls[kind])URL.revokeObjectURL(localPreviewUrls[kind]);
    localPreviewUrls[kind]='';
  }
  function clearSystemEditorMedia(){
    clearLocalPreview('avatar');
    clearLocalPreview('banner');
    window.nihilityMediaEditor?.clearPreview?.('system-avatar');
    window.nihilityMediaEditor?.clearPreview?.('system-banner');
  }
  function setLocalFilePreview(kind){
    clearLocalPreview(kind);
    const input=mediaFile(kind);
    const file=input?.files?.[0]||null;
    if(file)localPreviewUrls[kind]=URL.createObjectURL(file);
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
            </div>
          </aside>

          <section class="system-editor-fields">
            <div class="form-grid two-col system-editor-grid">
              <label>Name<input id="systemEditName" maxlength="100"></label>
              <label>Pronouns<input id="systemEditPronouns" maxlength="100"></label>
              <label>System tag<input id="systemEditTag" maxlength="79" placeholder="Optional system tag"></label>
              <label>Color<input id="systemEditColor" maxlength="7" placeholder="#8b7cf6" pattern="#?[0-9A-Fa-f]{6}"></label>
            </div>

            <div class="system-editor-media-grid">
              <section class="system-editor-media-card">
                <div>
                  <strong>System avatar</strong>
                  <small>Square images work best. Uploads and edited images are published only so PluralKit can reach them.</small>
                </div>
                <label>Avatar URL<input id="systemEditAvatar" type="url" maxlength="512" placeholder="https://..."></label>
                <label class="file-drop-field">Upload avatar<input id="systemEditAvatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
              </section>
              <section class="system-editor-media-card">
                <div>
                  <strong>System banner</strong>
                  <small>Use a wide image. You can crop, reposition, zoom, or rotate before saving.</small>
                </div>
                <label>Banner URL<input id="systemEditBanner" type="url" maxlength="512" placeholder="https://..."></label>
                <label class="file-drop-field">Upload banner<input id="systemEditBannerFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
              </section>
            </div>

            <label class="system-editor-description">Description<textarea id="systemEditDescription" maxlength="1000" rows="6"></textarea></label>
            <p class="muted system-editor-public-media-note">Images uploaded or edited here become public only at a randomized PluralKit media URL. Nihility's normal member, group, and account images remain private.</p>
            <p id="systemEditorError" class="form-error" role="alert" hidden></p>
          </section>
        </div>

        <div class="modal-footer system-editor-footer">
          <button id="cancelSystemEditor" class="secondary-button" type="button">Cancel</button>
          <button id="saveSystemEditor" class="primary-button" type="submit">Save system</button>
        </div>
      </form>`;

    document.body.append(dialog);
    window.nihilityMediaEditor?.enhanceAll?.();

    const close=()=>dialog.close();
    dialog.querySelector('#closeSystemEditor').onclick=close;
    dialog.querySelector('#cancelSystemEditor').onclick=close;
    dialog.addEventListener('close',clearSystemEditorMedia);

    let backdropDown=false;
    dialog.addEventListener('pointerdown',event=>{backdropDown=event.target===dialog});
    dialog.addEventListener('pointerup',event=>{if(backdropDown&&event.target===dialog)close();backdropDown=false});
    dialog.addEventListener('pointercancel',()=>{backdropDown=false});

    ['systemEditName','systemEditPronouns','systemEditColor','systemEditDescription']
      .forEach(id=>dialog.querySelector('#'+id).addEventListener('input',updateSystemPreview));

    ['avatar','banner'].forEach(kind=>{
      const file=mediaFile(kind);
      const url=mediaUrlInput(kind);
      file.addEventListener('change',()=>{
        if(file.files?.[0]){
          if(url.value)url.value='';
          window.nihilityMediaEditor?.clearPreview?.(mediaKey(kind));
        }
        setLocalFilePreview(kind);
        updateSystemPreview();
      });
      url.addEventListener('input',()=>{
        if(url.value.trim()&&file.files?.length){
          file.value='';
          clearLocalPreview(kind);
        }
        updateSystemPreview();
      });
    });

    dialog.querySelector('#systemEditorForm').onsubmit=saveSystemProfile;
    return dialog;
  }

  function setPreviewAvatar(value){
    const img=document.querySelector('#systemEditorAvatarPreview');
    const fallback=document.querySelector('#systemEditorAvatarFallback');
    if(!img||!fallback)return;
    if(!value){
      img.hidden=true;
      img.removeAttribute('src');
      fallback.hidden=false;
      return;
    }
    img.hidden=false;
    fallback.hidden=true;
    img.referrerPolicy='no-referrer';
    img.src=value;
    img.onerror=()=>{img.hidden=true;fallback.hidden=false};
  }

  function resolvedPreview(kind){
    if(localPreviewUrls[kind])return localPreviewUrls[kind];

    const secureLink=window.nihilityMediaEditor?.getPreviewUrl?.(mediaKey(kind))||'';
    if(secureLink)return secureLink;

    const current=state.systemProfile||{};
    const input=safeHttpsUrl(mediaUrlInput(kind)?.value||'');
    const saved=kind==='avatar'
      ?safeHttpsUrl(current.avatar_url||'')
      :safeHttpsUrl(current.banner||current.banner_url||'');
    if(input&&input===saved){
      return kind==='avatar'?(current.avatar_display_url||''):(current.banner_display_url||'');
    }
    return '';
  }

  function updateSystemPreview(){
    const current=state.systemProfile||{};
    const name=document.querySelector('#systemEditName')?.value.trim()||systemName(current);
    const pronouns=document.querySelector('#systemEditPronouns')?.value.trim()||'';
    const description=document.querySelector('#systemEditDescription')?.value.trim()||'';
    const color=String(document.querySelector('#systemEditColor')?.value||'').trim().replace(/^#/,'');
    const avatar=resolvedPreview('avatar');
    const banner=resolvedPreview('banner');

    document.querySelector('#systemEditorNamePreview').textContent=name;
    document.querySelector('#systemEditorPronounsPreview').textContent=pronouns;
    document.querySelector('#systemEditorDescriptionPreview').textContent=description||'No description yet.';
    document.querySelector('#systemEditorAvatarFallback').textContent=initial(name);
    document.querySelector('#systemEditorColorPreview').style.background=/^[0-9a-f]{6}$/i.test(color)?('#'+color):'var(--accent)';

    const bannerPreview=document.querySelector('#systemEditorBannerPreview');
    bannerPreview.style.backgroundImage=banner
      ?'linear-gradient(rgba(10,11,20,.12),rgba(10,11,20,.28)), url("'+banner.replaceAll('"','%22')+'")'
      :'';
    bannerPreview.classList.toggle('has-image',Boolean(banner));
    setPreviewAvatar(avatar);
  }

  function openSystemEditor(){
    if(!state.pkConnected){toast('PluralKit is not connected','','error');return}
    const dialog=ensureSystemEditor();
    const system=state.systemProfile||{};

    clearSystemEditorMedia();
    document.querySelector('#systemEditName').value=system.name||'';
    document.querySelector('#systemEditPronouns').value=system.pronouns||'';
    document.querySelector('#systemEditTag').value=system.tag||'';
    document.querySelector('#systemEditColor').value=system.color?('#'+String(system.color).replace(/^#/,'')):'';
    document.querySelector('#systemEditAvatar').value=system.avatar_url||'';
    document.querySelector('#systemEditBanner').value=system.banner||system.banner_url||'';
    document.querySelector('#systemEditAvatarFile').value='';
    document.querySelector('#systemEditBannerFile').value='';
    document.querySelector('#systemEditDescription').value=system.description||'';
    document.querySelector('#systemEditorError').hidden=true;
    updateSystemPreview();
    dialog.showModal();

    if(document.querySelector('#systemEditAvatar').value.trim()&&!system.avatar_display_url){
      document.querySelector('#systemEditAvatar').dispatchEvent(new Event('input',{bubbles:true}));
    }
    if(document.querySelector('#systemEditBanner').value.trim()&&!system.banner_display_url){
      document.querySelector('#systemEditBanner').dispatchEvent(new Event('input',{bubbles:true}));
    }
  }

  function collectDraft(){
    const color=document.querySelector('#systemEditColor').value.trim().replace(/^#/,'');
    return{
      name:document.querySelector('#systemEditName').value.trim()||null,
      pronouns:document.querySelector('#systemEditPronouns').value.trim()||null,
      tag:document.querySelector('#systemEditTag').value.trim()||null,
      color:color||null,
      avatar_url:document.querySelector('#systemEditAvatar').value.trim()||null,
      banner:document.querySelector('#systemEditBanner').value.trim()||null,
      description:document.querySelector('#systemEditDescription').value.trim()||null
    };
  }

  async function safeDeleteCandidate(kind,path){
    if(!path)return;
    try{await nihilityApi.deleteMedia(kind,path)}
    catch(error){console.warn('Unable to clean up staged system media',kind,error)}
  }

  async function saveSystemProfile(event){
    event.preventDefault();
    const dialog=document.querySelector('#systemEditorDialog');
    const error=document.querySelector('#systemEditorError');
    const button=document.querySelector('#saveSystemEditor');
    const system=collectDraft();
    const avatarFile=document.querySelector('#systemEditAvatarFile').files?.[0]||null;
    const bannerFile=document.querySelector('#systemEditBannerFile').files?.[0]||null;

    if(system.color&&!/^[0-9a-f]{6}$/i.test(system.color)){error.textContent='Color must be a 6-character hex color.';error.hidden=false;return}
    if(system.avatar_url&&!safeHttpsUrl(system.avatar_url)){error.textContent='Avatar must be a valid HTTPS URL.';error.hidden=false;return}
    if(system.banner&&!safeHttpsUrl(system.banner)){error.textContent='Banner must be a valid HTTPS URL.';error.hidden=false;return}

    let avatarUpload=null,bannerUpload=null;
    error.hidden=true;
    button.disabled=true;
    button.textContent='Saving...';

    try{
      if(avatarFile)avatarUpload=await nihilityApi.uploadPkSystemMedia('avatar',avatarFile);
      if(bannerFile)bannerUpload=await nihilityApi.uploadPkSystemMedia('banner',bannerFile);

      const result=await nihilityApi.secure('pk_update_system',{
        system,
        managed_media:{
          avatar_path:avatarUpload?.path||null,
          banner_path:bannerUpload?.path||null
        }
      });

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

      avatarUpload=null;
      bannerUpload=null;
      renderAll();
      dialog.close();
      toast('System updated','PluralKit and Nihility are now in sync.');
    }catch(saveError){
      await Promise.allSettled([
        safeDeleteCandidate('avatar',avatarUpload?.path),
        safeDeleteCandidate('banner',bannerUpload?.path)
      ]);
      error.textContent=saveError.message||'Could not update the system.';
      error.hidden=false;
    }finally{
      button.disabled=false;
      button.textContent='Save system';
    }
  }

  document.addEventListener('nihility-media-preview',event=>{
    const key=event.detail?.key||'';
    if((key==='system-avatar'||key==='system-banner')&&document.querySelector('#systemEditorDialog')?.open){
      updateSystemPreview();
    }
  });

  const previousRenderAll=renderAll;
  renderAll=function renderAllWithSystemControls(){
    if(window.nihilitySilentRefresh)return;
    previousRenderAll();
    ensureSystemEditButton();
  };

  ensureSystemEditButton();
  ensureSystemEditor();
})();

'use strict';

(function installRainbowPkFeatureParity(){
  const MEMBER_SORT_KEY='nihility_member_sort';
  const MEMBER_VIEW_KEY='nihility_member_view';
  const MEMBER_GROUP_KEY='nihility_member_group';
  const HISTORY_VIEW_KEY='nihility_history_view';
  const HISTORY_SORT_KEY='nihility_history_sort';
  const HISTORY_RANGE_KEY='nihility_history_range';
  const collator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true});

  state.groups=Array.isArray(state.groups)?state.groups:[];
  state.memberGroups=Array.isArray(state.memberGroups)?state.memberGroups:[];
  state.systemProfile=state.systemProfile||null;
  state.historyHasMore=false;
  state.historyDateFilter='';
  state.historyCalendarMonth=new Date(new Date().getFullYear(),new Date().getMonth(),1);

  function memberName(m){return m?.name||m?.display_name||'Unknown member'}
  function groupName(g){return g?.display_name||g?.name||'Unnamed group'}
  function memberGroupIds(id){return state.memberGroups.filter(x=>x.member_id===id).map(x=>x.group_id)}
  function groupMemberIds(id){return state.memberGroups.filter(x=>x.group_id===id).map(x=>x.member_id)}
  function groupsForMember(id){const ids=new Set(memberGroupIds(id));return state.groups.filter(g=>ids.has(g.id))}
  function byName(a,b){return collator.compare(memberName(a),memberName(b))}
  function sortedMembers(list){
    const mode=document.querySelector('#memberSort')?.value||localStorage.getItem(MEMBER_SORT_KEY)||'az';
    const out=[...list];
    if(mode==='za')return out.sort((a,b)=>byName(b,a));
    if(mode==='newest'||mode==='oldest')return out.sort((a,b)=>{
      const at=new Date(a.created_at||0).getTime(),bt=new Date(b.created_at||0).getTime();
      const d=mode==='newest'?bt-at:at-bt;return d||byName(a,b);
    });
    return out.sort(byName);
  }
  function makeSelect(id,labelText,options){
    const label=document.createElement('label');label.className='feature-select';label.htmlFor=id;
    const span=document.createElement('span');span.textContent=labelText;
    const select=document.createElement('select');select.id=id;
    options.forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;select.append(o)});
    label.append(span,select);return{label,select};
  }

  const coreLoadData=loadData;
  window.nihilitySystemLiveCache=window.nihilitySystemLiveCache||{value:null,at:0};

  function applySystemMedia(system){
    if(!system)return;
    system.avatar_display_url=null;
    system.banner_display_url=null;
  }
  async function hydrateSystemPrivateMedia(system){
    if(!system)return;
    if(system.avatar_storage_path){
      try{system.avatar_display_url=await nihilityApi.privateMediaUrl('avatar',system.avatar_storage_path)}
      catch(error){console.warn('Unable to load system avatar',error)}
    }
    if(system.banner_storage_path){
      try{system.banner_display_url=await nihilityApi.privateMediaUrl('banner',system.banner_storage_path)}
      catch(error){console.warn('Unable to load system banner',error)}
    }
  }

  loadData=async function loadDataWithRainbowFeatures(){
    const systemCache=window.nihilitySystemLiveCache;
    const groupPromise=nihilityApi.rest('groups',{query:'select=*&order=name.asc'});
    const linkPromise=nihilityApi.rest('member_groups',{query:'select=*&order=created_at.asc'});
    const settingsPromise=nihilityApi.rest('app_settings',{query:'select=settings&user_id=eq.'+encodeURIComponent(state.user.id)+'&limit=1'});

    const shouldRefreshSystem=!systemCache.value||(Date.now()-systemCache.at)>=30000;
    const liveSystemPromise=shouldRefreshSystem
      ?nihilityApi.secure('pk_get_system')
        .then(result=>{systemCache.value=result;systemCache.at=Date.now();return result})
        .catch(error=>{console.warn('Unable to refresh PK system profile',error);return systemCache.value})
      :Promise.resolve(systemCache.value);

    await coreLoadData();
    const [groups,links,settingsRows]=await Promise.all([groupPromise,linkPromise,settingsPromise]);

    state.groups=groups||[];
    state.memberGroups=links||[];
    state.groups.forEach(g=>{g.icon_display_url=null;g.banner_display_url=null});
    void Promise.all(state.groups.map(async g=>{
      const iconPath=g.metadata?.icon_storage_path||g.icon_storage_path||null;
      const bannerPath=g.metadata?.banner_storage_path||null;
      if(iconPath){
        try{g.icon_display_url=await nihilityApi.privateMediaUrl('avatar',iconPath)}
        catch(error){console.warn('Unable to load group icon',g.id,error)}
      }
      if(bannerPath){
        try{g.banner_display_url=await nihilityApi.privateMediaUrl('banner',bannerPath)}
        catch(error){console.warn('Unable to load group banner',g.id,error)}
      }
    })).then(()=>{if(state.route==='groups')renderGroups()});

    const storedSystem=settingsRows?.[0]?.settings?.system_profile||null;
    state.systemProfile=storedSystem?{...storedSystem}:null;
    applySystemMedia(state.systemProfile);
    void hydrateSystemPrivateMedia(state.systemProfile).then(()=>renderHome());

    state.historyHasMore=state.fronts.length>=100;
    refreshFeatureControls();
    renderAll();

    void liveSystemPromise.then(async liveSystem=>{
      if(!liveSystem?.system||!state.pkConnected)return;
      const paths={
        avatar_storage_path:state.systemProfile?.avatar_storage_path||null,
        banner_storage_path:state.systemProfile?.banner_storage_path||null
      };
      state.systemProfile={...(state.systemProfile||{}),...liveSystem.system,...paths};
      applySystemMedia(state.systemProfile);
      await hydrateSystemPrivateMedia(state.systemProfile);
      renderHome();
      applyImportedSystemIdentity();
    });
  };

  function installMemberToolbar(){
    const toolbar=document.querySelector('#membersRoute .toolbar-row');
    const create=document.querySelector('#createMemberButton');
    if(!toolbar||!create)return;

    if(!document.querySelector('#memberSort')){
      const sort=makeSelect('memberSort','Sort',[
        ['az','A to Z'],['za','Z to A'],['newest','Recently added'],['oldest','Oldest first']
      ]);
      sort.select.value=localStorage.getItem(MEMBER_SORT_KEY)||'az';
      sort.select.onchange=()=>{localStorage.setItem(MEMBER_SORT_KEY,sort.select.value);renderMembers()};
      toolbar.insertBefore(sort.label,create);
    }
    if(!document.querySelector('#memberGroupFilter')){
      const group=makeSelect('memberGroupFilter','Group',[['all','All groups']]);
      group.select.value=localStorage.getItem(MEMBER_GROUP_KEY)||'all';
      group.select.onchange=()=>{localStorage.setItem(MEMBER_GROUP_KEY,group.select.value);renderMembers()};
      toolbar.insertBefore(group.label,create);
    }
    if(!document.querySelector('#memberViewSelect')){
      const view=makeSelect('memberViewSelect','View',[
        ['cards','Card'],['compact','Compact'],['list','List'],['tiles','Card tiles']
      ]);
      view.select.value=localStorage.getItem(MEMBER_VIEW_KEY)||'cards';
      view.select.onchange=()=>{localStorage.setItem(MEMBER_VIEW_KEY,view.select.value);renderMembers()};
      toolbar.insertBefore(view.label,create);
    }
    if(!document.querySelector('#createGroupButton')){
      const b=document.createElement('button');b.id='createGroupButton';b.className='secondary-button';b.type='button';b.textContent='New group';
      b.onclick=()=>openGroupManager();toolbar.insertBefore(b,create);
    }
    refreshGroupOptions();
  }
  function refreshGroupOptions(){
    const s=document.querySelector('#memberGroupFilter');if(!s)return;
    const current=s.value||localStorage.getItem(MEMBER_GROUP_KEY)||'all';
    s.replaceChildren();
    [['all','All groups'],...state.groups.map(g=>[g.id,groupName(g)]).sort((a,b)=>collator.compare(a[1],b[1]))].forEach(([v,t])=>{
      const o=document.createElement('option');o.value=v;o.textContent=t;s.append(o);
    });
    s.value=[...s.options].some(o=>o.value===current)?current:'all';
  }

  function makeStandardMemberCard(m){
    const card=document.createElement('button');card.type='button';card.className='member-card';
    const top=document.createElement('div');top.className='member-card-top';top.append(avatarEl(m));
    const copy=document.createElement('div');copy.className='member-card-name';
    const h=document.createElement('h3');h.textContent=memberName(m);copy.append(h);
    if(m.display_name&&m.display_name!==m.name){const p=document.createElement('p');p.textContent=m.display_name;copy.append(p)}
    if(m.pronouns){const p=document.createElement('p');p.textContent=m.pronouns;copy.append(p)}
    top.append(copy);card.append(top);
    if(m.description){const d=document.createElement('p');d.className='member-card-desc';d.textContent=m.description;card.append(d)}
    const gs=groupsForMember(m.id);
    if(gs.length){const wrap=document.createElement('div');wrap.className='member-card-groups';gs.slice(0,4).forEach(g=>{const s=document.createElement('span');s.textContent=groupName(g);wrap.append(s)});card.append(wrap)}
    const bar=document.createElement('span');bar.className='member-color-bar';bar.style.background=m.color?'#'+m.color:'var(--accent)';card.append(bar);
    card.onclick=()=>openMember(m);return card;
  }
  function makeTileMemberCard(m){
    const card=document.createElement('button');card.type='button';card.className='member-card member-card-tile';
    const header=document.createElement('div');header.className='member-tile-header';
    const marker=document.createElement('span');marker.className='member-tile-marker';marker.textContent='●';
    const title=document.createElement('strong');title.className='member-tile-title';title.textContent=memberName(m);header.append(marker,title);
    const media=document.createElement('div');media.className='member-tile-media';media.append(avatarEl(m,'member-tile-avatar'));
    const details=document.createElement('div');details.className='member-tile-details';
    const primary=document.createElement('strong');primary.className='member-tile-primary';primary.textContent=m.display_name||m.name;details.append(primary);
    const pron=document.createElement('span');pron.className='member-tile-pronouns';pron.textContent=m.pronouns||'No pronouns';details.append(pron);
    const desc=document.createElement('p');desc.className='member-tile-description';desc.textContent=m.description||'No description';details.append(desc);
    card.append(header,media,details);
    const bar=document.createElement('span');bar.className='member-color-bar';bar.style.background=m.color?'#'+m.color:'var(--accent)';card.append(bar);
    card.onclick=()=>openMember(m);return card;
  }

  renderMembers=function renderMembersWithRainbowFeatures(){
    installMemberToolbar();
    const q=(document.querySelector('#memberSearch')?.value||'').trim().toLowerCase();
    const group=document.querySelector('#memberGroupFilter')?.value||'all';
    const view=document.querySelector('#memberViewSelect')?.value||localStorage.getItem(MEMBER_VIEW_KEY)||'cards';
    const list=sortedMembers(activeMembers().filter(m=>{
      if(group!=='all'&&!memberGroupIds(m.id).includes(group))return false;
      if(!q)return true;
      return [m.name,m.display_name,m.pronouns,m.description,m.birthday].filter(Boolean).some(v=>String(v).toLowerCase().includes(q));
    }));
    const grid=document.querySelector('#memberGrid');grid.dataset.memberView=view;grid.replaceChildren();
    document.querySelector('#membersEmpty').hidden=list.length>0;
    list.forEach(m=>grid.append(view==='tiles'?makeTileMemberCard(m):makeStandardMemberCard(m)));
  };

  function installMemberFields(){
    const form=document.querySelector('#memberForm');
    const grid=form?.querySelector('.form-grid.two-col');
    if(!form||!grid)return;
    if(!document.querySelector('#memberBirthday')){
      const l=document.createElement('label');l.textContent='Birthday';
      const i=document.createElement('input');i.id='memberBirthday';i.type='date';l.append(i);grid.append(l);
    }
    if(!document.querySelector('#memberGroupPicker')){
      const section=document.createElement('div');section.className='member-groups-field';
      section.innerHTML='<div class="feature-field-heading"><strong>Groups</strong><small>Choose which Nihility groups this member belongs to.</small></div><div id="memberGroupPicker" class="member-group-picker"></div>';
      grid.append(section);
    }
    if(!document.querySelector('#memberProxySection')){
      const section=document.createElement('section');section.id='memberProxySection';section.className='member-proxy-section';
      section.innerHTML='<div class="feature-field-heading"><strong>Proxy tags</strong><small>Stored with the Nihility member copy.</small></div><div id="proxyTagsList" class="proxy-tags-list"></div><div class="proxy-actions"><button id="addProxyTagButton" class="secondary-button" type="button">Add proxy tag</button><label class="proxy-keep-row"><input id="memberKeepProxy" type="checkbox"><span>Keep proxy tags in proxied messages</span></label></div>';
      document.querySelector('#memberDescription')?.closest('label')?.insertAdjacentElement('afterend',section);
      document.querySelector('#addProxyTagButton').onclick=()=>addProxyRow();
    }
    installMemberPreviewListeners();
  }
  function addProxyRow(tag={}){
    const list=document.querySelector('#proxyTagsList');if(!list)return;
    const row=document.createElement('div');row.className='proxy-tag-row';
    const pre=document.createElement('input');pre.className='proxy-prefix';pre.placeholder='Prefix, for example [';pre.value=tag.prefix||'';
    const suf=document.createElement('input');suf.className='proxy-suffix';suf.placeholder='Suffix, for example ]';suf.value=tag.suffix||'';
    const remove=document.createElement('button');remove.type='button';remove.className='icon-button proxy-remove';remove.textContent='×';
    remove.onclick=()=>{row.remove();if(!list.children.length)addProxyRow()};row.append(pre,suf,remove);list.append(row);
  }
  function collectProxyTags(){
    return [...document.querySelectorAll('#proxyTagsList .proxy-tag-row')].map(row=>({
      prefix:row.querySelector('.proxy-prefix')?.value||null,
      suffix:row.querySelector('.proxy-suffix')?.value||null
    })).filter(x=>x.prefix||x.suffix);
  }
  function buildMemberGroupPicker(member=null){
    const box=document.querySelector('#memberGroupPicker');if(!box)return;box.replaceChildren();
    const selected=new Set(member?memberGroupIds(member.id):[]);
    if(!state.groups.length){const p=document.createElement('p');p.className='muted group-picker-empty';p.textContent='No groups yet.';box.append(p);return}
    [...state.groups].sort((a,b)=>collator.compare(groupName(a),groupName(b))).forEach(g=>{
      const l=document.createElement('label');l.className='group-check';
      const i=document.createElement('input');i.type='checkbox';i.value=g.id;i.checked=selected.has(g.id);
      const s=document.createElement('span');s.textContent=groupName(g);l.append(i,s);box.append(l);
    });
  }
  function selectedMemberGroups(){return [...document.querySelectorAll('#memberGroupPicker input:checked')].map(i=>i.value)}
  async function saveMemberGroups(memberId){
    await nihilityApi.rest('member_groups',{method:'DELETE',query:'member_id=eq.'+encodeURIComponent(memberId),prefer:'return=minimal'});
    const groups=selectedMemberGroups();
    for(const groupId of groups){
      await nihilityApi.rest('member_groups',{method:'POST',body:{user_id:state.user.id,member_id:memberId,group_id:groupId},prefer:'return=minimal'});
    }
  }

  let memberPreviewObjectUrls=[];
  function clearMemberPreviewObjectUrls(){memberPreviewObjectUrls.forEach(url=>URL.revokeObjectURL(url));memberPreviewObjectUrls=[]}
  function previewFileUrl(input){
    const file=input?.files?.[0];if(!file)return '';
    const url=URL.createObjectURL(file);memberPreviewObjectUrls.push(url);return url;
  }
  function currentEditingMember(){
    const id=document.querySelector('#memberId')?.value;
    return id?state.members.find(m=>m.id===id)||null:null;
  }
  function setMemberPreviewImage(img,fallback,url,fallbackText){
    if(!img||!fallback)return;
    if(url){
      img.hidden=false;img.src=url;fallback.hidden=true;
      img.onerror=()=>{img.hidden=true;fallback.hidden=false};
    }else{
      img.hidden=true;img.removeAttribute('src');fallback.hidden=false;fallback.textContent=fallbackText;
    }
  }
  function updateMemberPreview(){
    const current=currentEditingMember();
    const name=document.querySelector('#memberName')?.value.trim()||'Member name';
    const display=document.querySelector('#memberDisplayName')?.value.trim();
    const pronouns=document.querySelector('#memberPronouns')?.value.trim();
    const birthday=document.querySelector('#memberBirthday')?.value||'';
    const description=document.querySelector('#memberDescription')?.value.trim();
    const color=hex(document.querySelector('#memberColor')?.value)||'#8B7CF6';

    document.querySelector('#memberPreviewName').textContent=display||name;
    document.querySelector('#memberPreviewSubname').textContent=display&&display!==name?name:'Nihility member';
    document.querySelector('#memberPreviewPronouns').textContent=pronouns||'';
    document.querySelector('#memberPreviewBirthday').textContent=birthday?('Birthday: '+birthday):'';
    document.querySelector('#memberPreviewDescription').textContent=description||'No description yet.';
    document.querySelector('#memberPreviewColor').style.background=color;
    document.querySelector('#memberPreviewAvatarFallback').textContent=initial(display||name);

    const avatarFile=previewFileUrl(document.querySelector('#memberAvatarFile'));
    const bannerFile=previewFileUrl(document.querySelector('#memberBannerFile'));
    const avatarUrl=avatarFile||current?.avatar_url||'';
    const bannerUrl=bannerFile||current?.banner_url||'';
    setMemberPreviewImage(document.querySelector('#memberPreviewAvatar'),document.querySelector('#memberPreviewAvatarFallback'),avatarUrl,initial(display||name));
    const banner=document.querySelector('#memberPreviewBanner'),bannerFallback=document.querySelector('#memberPreviewBannerFallback');
    if(bannerUrl){banner.hidden=false;banner.src=bannerUrl;bannerFallback.hidden=true;banner.onerror=()=>{banner.hidden=true;bannerFallback.hidden=false}}
    else{banner.hidden=true;banner.removeAttribute('src');bannerFallback.hidden=false}
  }
  function installMemberPreviewListeners(){
    const form=document.querySelector('#memberForm');if(!form||form.dataset.previewBound==='true')return;
    form.dataset.previewBound='true';
    ['memberName','memberDisplayName','memberPronouns','memberBirthday','memberDescription','memberColor','memberAvatarUrl','memberBannerUrl']
      .forEach(id=>document.querySelector('#'+id)?.addEventListener('input',()=>{clearMemberPreviewObjectUrls();updateMemberPreview()}));
    document.querySelector('#memberColorPicker')?.addEventListener('input',event=>{
      document.querySelector('#memberColor').value=event.target.value;updateMemberPreview();
    });
    ['memberAvatarFile','memberBannerFile'].forEach(id=>document.querySelector('#'+id)?.addEventListener('change',()=>{clearMemberPreviewObjectUrls();updateMemberPreview()}));
    document.querySelector('#memberDialog')?.addEventListener('close',clearMemberPreviewObjectUrls);
  }

  const coreOpenMember=openMember;
  openMember=function openMemberWithRainbowFields(m=null){
    installMemberFields();coreOpenMember(m);
    document.querySelector('#memberBirthday').value=m?.birthday||'';
    buildMemberGroupPicker(m);
    const list=document.querySelector('#proxyTagsList');list.replaceChildren();
    const tags=Array.isArray(m?.metadata?.proxy_tags)&&m.metadata.proxy_tags.length?m.metadata.proxy_tags:[{}];tags.forEach(addProxyRow);
    document.querySelector('#memberKeepProxy').checked=Boolean(m?.metadata?.keep_proxy);
    clearMemberPreviewObjectUrls();
    updateMemberPreview();
    if(m&&window.nihilityHydrateMemberMedia){
      void window.nihilityHydrateMemberMedia(m,{banner:true}).then(()=>{
        if(document.querySelector('#memberDialog')?.open&&document.querySelector('#memberId')?.value===m.id)updateMemberPreview();
      });
    }
  };

  saveMember=async function saveMemberWithRainbowFeatures(e){
    e.preventDefault();const err=document.querySelector('#memberError');err.hidden=true;let au=null,bu=null;
    try{
      const id=document.querySelector('#memberId').value,old=id?state.members.find(m=>m.id===id):null;
      au=await maybeUpload('avatar',document.querySelector('#memberAvatarFile'));bu=await maybeUpload('banner',document.querySelector('#memberBannerFile'));
      const ae=document.querySelector('#memberAvatarUrl').value.trim(),be=document.querySelector('#memberBannerUrl').value.trim(),c=hex(document.querySelector('#memberColor').value);
      const importedAvatarPath=!au&&ae?await importExternalMedia('avatar',ae):null;
      const importedBannerPath=!bu&&be?await importExternalMedia('banner',be):null;
      const newAvatarPath=au?.path||importedAvatarPath||old?.avatar_storage_path||null;
      const newBannerPath=bu?.path||importedBannerPath||old?.banner_storage_path||null;
      const metadata={...(old?.metadata||{}),proxy_tags:collectProxyTags(),keep_proxy:Boolean(document.querySelector('#memberKeepProxy')?.checked)};
      const body={user_id:state.user.id,name:document.querySelector('#memberName').value.trim(),display_name:document.querySelector('#memberDisplayName').value.trim()||null,pronouns:document.querySelector('#memberPronouns').value.trim()||null,color:c?c.slice(1).toLowerCase():null,description:document.querySelector('#memberDescription').value.trim()||null,birthday:document.querySelector('#memberBirthday').value||null,avatar_url:null,avatar_source:newAvatarPath?'supabase':null,avatar_storage_path:newAvatarPath,banner_url:null,banner_source:newBannerPath?'supabase':null,banner_storage_path:newBannerPath,pk_id:old?.pk_id||null,tupper_id:old?.tupper_id||null,metadata,archived_at:null};
      if(!body.name)throw new Error('Name is required.');
      let memberId=id;
      if(id)await nihilityApi.rest('members',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body,prefer:'return=minimal'});
      else{const rows=await nihilityApi.rest('members',{method:'POST',body,prefer:'return=representation'});memberId=rows?.[0]?.id}
      if(memberId)await saveMemberGroups(memberId);
      if(old?.avatar_storage_path&&old.avatar_storage_path!==body.avatar_storage_path)await safeDelete('avatar',old.avatar_storage_path);
      if(old?.banner_storage_path&&old.banner_storage_path!==body.banner_storage_path)await safeDelete('banner',old.banner_storage_path);
      document.querySelector('#memberDialog').close();toast(id?'Member updated':'Member created');await loadData();
    }catch(error){if(au?.path)await safeDelete('avatar',au.path);if(bu?.path)await safeDelete('banner',bu.path);err.textContent=error.message;err.hidden=false}
  };
  document.querySelector('#memberForm').onsubmit=saveMember;

  function installGroupsRoute(){
    if(!document.querySelector('#groupsRoute')){
      const route=document.createElement('section');route.id='groupsRoute';route.className='route-view';route.hidden=true;
      route.innerHTML='<div class="groups-toolbar"><label class="search-field groups-search"><span>⌕</span><input id="groupSearch" type="search" placeholder="Search groups"></label><button id="newGroupRouteButton" class="primary-button" type="button">New group</button></div><div id="groupGrid" class="group-card-grid"></div><div id="groupsEmpty" class="empty-state" hidden><h3>No groups found</h3><p>Create a group or try another search.</p></div>';
      document.querySelector('#historyRoute')?.insertAdjacentElement('beforebegin',route);
      route.querySelector('#groupSearch').oninput=renderGroups;route.querySelector('#newGroupRouteButton').onclick=()=>openGroupManager();
    }
    if(!document.querySelector('.nav-list [data-route="groups"]')){
      const b=document.createElement('button');b.className='nav-item';b.dataset.route='groups';b.type='button';b.innerHTML='<span>▦</span>Groups';
      document.querySelector('.nav-list [data-route="history"]')?.insertAdjacentElement('beforebegin',b);b.onclick=()=>setRoute('groups');
    }
    if(!document.querySelector('.mobile-nav [data-route="groups"]')){
      const b=document.createElement('button');b.className='mobile-nav-item';b.dataset.route='groups';b.type='button';b.innerHTML='<span>▦</span>Groups';
      document.querySelector('.mobile-nav [data-route="history"]')?.insertAdjacentElement('beforebegin',b);b.onclick=()=>setRoute('groups');
    }
  }
  function ensureGroupDialog(){
    let dialog=document.querySelector('#groupsManagerDialog');if(dialog)return dialog;
    dialog=document.createElement('dialog');dialog.id='groupsManagerDialog';dialog.className='modal-dialog groups-manager-dialog';
    dialog.innerHTML=`
      <form id="groupsManagerForm" class="modal-card groups-manager-card">
        <div class="modal-heading groups-manager-heading">
          <div>
            <p class="eyebrow">Nihility group</p>
            <h3 id="groupsManagerTitle">Create group</h3>
            <p class="muted groups-manager-subtitle">Edit the group profile, preview the banner, and choose members in one place.</p>
          </div>
          <button class="icon-button groups-manager-close" type="button" aria-label="Close">×</button>
        </div>
        <input id="groupsManagerRef" type="hidden">
        <div class="groups-manager-layout">
          <aside class="group-live-preview">
            <div class="group-preview-card">
              <div id="groupPreviewBanner" class="group-preview-banner"></div>
              <div class="group-preview-content">
                <img id="groupPreviewIconImage" class="group-preview-icon" alt="" hidden>
                <div id="groupPreviewIconFallback" class="group-preview-icon fallback-avatar">G</div>
                <div class="group-preview-copy">
                  <strong id="groupPreviewName">Group name</strong>
                  <span id="groupPreviewMemberCount">0 members</span>
                  <div id="groupPreviewMembers" class="group-preview-members"></div>
                </div>
              </div>
              <span id="groupPreviewColor" class="group-preview-color"></span>
            </div>
            <p class="group-preview-help">The group list will use this banner-style card, including member avatars and the group color bar.</p>

            <section class="groups-members-editor groups-members-under-preview">
              <div class="groups-section-heading">
                <strong>Members</strong>
                <small id="groupsSelectedCount">0 selected</small>
              </div>
              <label class="dialog-search groups-member-search">Find members
                <input id="groupsMemberSearch" type="search" placeholder="Search members" autocomplete="off">
              </label>
              <div id="groupsMemberPicker" class="front-member-picker groups-member-picker"></div>
            </section>
          </aside>

          <section class="groups-profile-fields">
            <div class="groups-section-heading"><strong>Group profile</strong><small>Name, appearance and notes</small></div>
            <div class="form-grid two-col groups-profile-grid">
              <label>Name<input id="groupsManagerName" maxlength="100" required></label>
              <label>Display name<input id="groupsManagerDisplayName" maxlength="100"></label>
              <label>Color<input id="groupsManagerColor" maxlength="7" placeholder="#8b7cf6"></label>
            </div>
            <label class="groups-description-field">Description<textarea id="groupsManagerDescription" maxlength="1000" rows="4"></textarea></label>
            <div class="groups-media-grid">
              <label>Icon URL<input id="groupsManagerIconUrl" type="url" placeholder="https://..."></label>
              <label>Banner URL<input id="groupsManagerBannerUrl" type="url" placeholder="https://..."></label>
              <label>Upload icon<input id="groupsManagerIconFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
              <label>Upload banner<input id="groupsManagerBannerFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
            </div>
          </section>

        </div>
        <p id="groupsManagerError" class="form-error" hidden></p>
        <div class="modal-footer modal-footer-split groups-manager-footer">
          <button id="deleteGroupButton" class="text-button danger-text" type="button">Delete group</button>
          <div><button class="secondary-button groups-manager-close" type="button">Cancel</button><button class="primary-button" type="submit">Save group</button></div>
        </div>
      </form>`;
    document.body.append(dialog);
    dialog.querySelectorAll('.groups-manager-close').forEach(b=>b.onclick=()=>dialog.close());
    dialog.querySelector('#groupsManagerForm').onsubmit=saveGroup;
    dialog.querySelector('#deleteGroupButton').onclick=deleteGroup;
    dialog.querySelector('#groupsMemberSearch').oninput=renderGroupMemberPicker;
    ['groupsManagerName','groupsManagerDisplayName','groupsManagerColor','groupsManagerDescription','groupsManagerIconUrl','groupsManagerBannerUrl']
      .forEach(id=>dialog.querySelector('#'+id)?.addEventListener('input',updateGroupPreview));
    ['groupsManagerIconFile','groupsManagerBannerFile'].forEach(id=>dialog.querySelector('#'+id)?.addEventListener('change',updateGroupPreview));
    return dialog;
  }
  let workingGroupMembers=new Set();
  let groupPreviewObjectUrls=[];
  function clearGroupPreviewObjectUrls(){groupPreviewObjectUrls.forEach(url=>URL.revokeObjectURL(url));groupPreviewObjectUrls=[]}
  function groupPreviewFileUrl(input){
    const file=input?.files?.[0];if(!file)return '';
    const url=URL.createObjectURL(file);groupPreviewObjectUrls.push(url);return url;
  }
  function currentEditingGroup(){
    const id=document.querySelector('#groupsManagerRef')?.value;
    return id?state.groups.find(g=>g.id===id)||null:null;
  }
  function selectedGroupMembers(){
    return [...workingGroupMembers].map(id=>state.members.find(m=>m.id===id)).filter(Boolean);
  }
  function updateGroupPreview(){
    const group=currentEditingGroup();
    const name=document.querySelector('#groupsManagerDisplayName')?.value.trim()||document.querySelector('#groupsManagerName')?.value.trim()||'Group name';
    const color=hex(document.querySelector('#groupsManagerColor')?.value)||'#8B7CF6';
    const members=selectedGroupMembers();
    const count=members.length;
    const nameEl=document.querySelector('#groupPreviewName');if(nameEl)nameEl.textContent=name;
    const countEl=document.querySelector('#groupPreviewMemberCount');if(countEl)countEl.textContent=count+' member'+(count===1?'':'s');
    const colorEl=document.querySelector('#groupPreviewColor');if(colorEl)colorEl.style.background=color;

    const previews=document.querySelector('#groupPreviewMembers');
    if(previews){
      previews.replaceChildren();
      members.slice(0,4).forEach(m=>previews.append(avatarEl(m,'group-member-mini')));
      if(count>4){const more=document.createElement('span');more.className='group-member-more';more.textContent='+'+(count-4);previews.append(more)}
    }

    clearGroupPreviewObjectUrls();
    const iconUrl=groupPreviewFileUrl(document.querySelector('#groupsManagerIconFile'))||group?.icon_display_url||'';
    const bannerUrl=groupPreviewFileUrl(document.querySelector('#groupsManagerBannerFile'))||group?.banner_display_url||'';

    const iconImg=document.querySelector('#groupPreviewIconImage'),iconFallback=document.querySelector('#groupPreviewIconFallback');
    if(iconImg&&iconFallback){
      if(iconUrl){iconImg.hidden=false;iconImg.src=iconUrl;iconFallback.hidden=true;iconImg.onerror=()=>{iconImg.hidden=true;iconFallback.hidden=false}}
      else{iconImg.hidden=true;iconImg.removeAttribute('src');iconFallback.hidden=false;iconFallback.textContent=initial(name)}
    }
    const banner=document.querySelector('#groupPreviewBanner');
    if(banner)banner.style.backgroundImage=bannerUrl?'url("'+bannerUrl.replaceAll('"','%22')+'")':'';
  }
  function renderGroupMemberPicker(){
    const box=document.querySelector('#groupsMemberPicker');if(!box)return;
    box.querySelectorAll('input[type="checkbox"]').forEach(input=>{
      input.checked?workingGroupMembers.add(input.value):workingGroupMembers.delete(input.value);
    });
    box.replaceChildren();
    const q=(document.querySelector('#groupsMemberSearch')?.value||'').trim().toLowerCase();
    sortedMembers(activeMembers().filter(m=>!q||[m.name,m.display_name,m.pronouns].filter(Boolean).some(v=>String(v).toLowerCase().includes(q)))).forEach(m=>{
      const row=document.createElement('label');row.className='picker-row';row.append(avatarEl(m,'picker-avatar'));
      const copy=document.createElement('span');copy.className='picker-copy';
      const strong=document.createElement('strong');strong.textContent=memberName(m);
      const small=document.createElement('small');small.textContent=m.pronouns||m.name;
      copy.append(strong,small);
      const input=document.createElement('input');input.type='checkbox';input.value=m.id;input.checked=workingGroupMembers.has(m.id);
      input.onchange=()=>{input.checked?workingGroupMembers.add(m.id):workingGroupMembers.delete(m.id);updateGroupSelectedCount();updateGroupPreview()};
      row.append(copy,input);box.append(row);
    });
    updateGroupSelectedCount();
  }
  function updateGroupSelectedCount(){
    const count=workingGroupMembers.size;
    const el=document.querySelector('#groupsSelectedCount');if(el)el.textContent=count+' selected';
  }
  function openGroupManager(group=null){
    const dialog=ensureGroupDialog();workingGroupMembers=new Set(group?groupMemberIds(group.id):[]);
    document.querySelector('#groupsManagerTitle').textContent=group?'Edit group':'Create group';
    document.querySelector('#groupsManagerRef').value=group?.id||'';
    document.querySelector('#groupsManagerName').value=group?.name||'';
    document.querySelector('#groupsManagerDisplayName').value=group?.display_name||'';
    document.querySelector('#groupsManagerColor').value=group?.color?'#'+group.color:'';
    document.querySelector('#groupsManagerDescription').value=group?.description||'';
    document.querySelector('#groupsManagerIconUrl').value=group?.metadata?.icon_storage_path?'':(group?.metadata?.pk_icon_url||'');
    document.querySelector('#groupsManagerBannerUrl').value=group?.metadata?.banner_storage_path?'':(group?.metadata?.pk_banner_url||'');
    document.querySelector('#groupsManagerIconFile').value='';
    document.querySelector('#groupsManagerBannerFile').value='';
    document.querySelector('#groupsMemberSearch').value='';
    document.querySelector('#deleteGroupButton').hidden=!group;
    document.querySelector('#groupsManagerError').hidden=true;
    clearGroupPreviewObjectUrls();
    renderGroupMemberPicker();updateGroupPreview();dialog.showModal();
  }
  async function saveGroup(e){
    e.preventDefault();const err=document.querySelector('#groupsManagerError');err.hidden=true;let iconUpload=null,bannerUpload=null;
    try{
      const id=document.querySelector('#groupsManagerRef').value;
      const old=id?state.groups.find(g=>g.id===id):null;
      const color=hex(document.querySelector('#groupsManagerColor').value);
      iconUpload=await maybeUpload('avatar',document.querySelector('#groupsManagerIconFile'));
      bannerUpload=await maybeUpload('banner',document.querySelector('#groupsManagerBannerFile'));
      const iconExternal=document.querySelector('#groupsManagerIconUrl').value.trim();
      const bannerExternal=document.querySelector('#groupsManagerBannerUrl').value.trim();
      const importedIconPath=!iconUpload&&iconExternal?await importExternalMedia('avatar',iconExternal):null;
      const importedBannerPath=!bannerUpload&&bannerExternal?await importExternalMedia('banner',bannerExternal):null;
      const oldIconPath=old?.metadata?.icon_storage_path||null;
      const oldBannerPath=old?.metadata?.banner_storage_path||null;
      const iconPath=iconUpload?.path||importedIconPath||oldIconPath;
      const bannerPath=bannerUpload?.path||importedBannerPath||oldBannerPath;
      const metadata={...(old?.metadata||{}),icon_storage_path:iconPath||null,banner_storage_path:bannerPath||null};

      const body={
        user_id:state.user.id,
        name:document.querySelector('#groupsManagerName').value.trim(),
        display_name:document.querySelector('#groupsManagerDisplayName').value.trim()||null,
        description:document.querySelector('#groupsManagerDescription').value.trim()||null,
        color:color?color.slice(1).toLowerCase():null,
        icon_url:null,
        icon_source:null,
        pk_id:old?.pk_id||null,
        tupper_id:old?.tupper_id||null,
        metadata
      };
      if(!body.name)throw new Error('Name is required.');

      let groupId=id;
      if(id)await nihilityApi.rest('groups',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body,prefer:'return=minimal'});
      else{const rows=await nihilityApi.rest('groups',{method:'POST',body,prefer:'return=representation'});groupId=rows?.[0]?.id}

      if(groupId){
        await nihilityApi.rest('member_groups',{method:'DELETE',query:'group_id=eq.'+encodeURIComponent(groupId),prefer:'return=minimal'});
        for(const memberId of workingGroupMembers){
          await nihilityApi.rest('member_groups',{method:'POST',body:{user_id:state.user.id,member_id:memberId,group_id:groupId},prefer:'return=minimal'});
        }
      }
      if(oldIconPath&&oldIconPath!==iconPath)await safeDelete('avatar',oldIconPath);
      if(oldBannerPath&&oldBannerPath!==bannerPath)await safeDelete('banner',oldBannerPath);

      clearGroupPreviewObjectUrls();
      document.querySelector('#groupsManagerDialog').close();
      toast(id?'Group updated':'Group created');
      await loadData();
    }catch(error){
      if(iconUpload?.path)await safeDelete('avatar',iconUpload.path);
      if(bannerUpload?.path)await safeDelete('banner',bannerUpload.path);
      err.textContent=error.message;err.hidden=false
    }
  }
  async function deleteGroup(){
    const id=document.querySelector('#groupsManagerRef').value;if(!id||!confirm('Delete this Nihility group? Members will not be deleted.'))return;
    const group=state.groups.find(g=>g.id===id);
    await nihilityApi.rest('groups',{method:'DELETE',query:'id=eq.'+encodeURIComponent(id),prefer:'return=minimal'});
    await safeDelete('avatar',group?.metadata?.icon_storage_path);
    await safeDelete('banner',group?.metadata?.banner_storage_path);
    clearGroupPreviewObjectUrls();
    document.querySelector('#groupsManagerDialog').close();toast('Group deleted');await loadData();
  }
  function renderGroups(){
    const grid=document.querySelector('#groupGrid'),empty=document.querySelector('#groupsEmpty');if(!grid||!empty)return;
    const q=(document.querySelector('#groupSearch')?.value||'').trim().toLowerCase();
    const groups=[...state.groups].filter(g=>!q||[g.name,g.display_name,g.description].filter(Boolean).some(v=>String(v).toLowerCase().includes(q))).sort((a,b)=>collator.compare(groupName(a),groupName(b)));
    grid.replaceChildren();empty.hidden=groups.length>0;
    groups.forEach(g=>{
      const card=document.createElement('button');card.type='button';card.className='group-card';
      if(g.banner_display_url){
        const banner=document.createElement('div');banner.className='group-card-banner';banner.style.backgroundImage='url("'+g.banner_display_url.replaceAll('"','%22')+'")';card.append(banner);card.classList.add('has-group-banner');
      }

      const content=document.createElement('div');content.className='group-card-content';
      let icon;
      if(g.icon_display_url){
        icon=document.createElement('img');icon.className='group-card-icon';icon.src=g.icon_display_url;icon.alt='';icon.loading='lazy';
        icon.onerror=()=>{const fallback=document.createElement('div');fallback.className='group-card-icon fallback-avatar';fallback.textContent=initial(groupName(g));icon.replaceWith(fallback)};
      }else{
        icon=document.createElement('div');icon.className='group-card-icon fallback-avatar';icon.textContent=initial(groupName(g));
      }

      const copy=document.createElement('div');copy.className='group-card-copy';
      const title=document.createElement('h3');title.textContent=groupName(g);
      const count=groupMemberIds(g.id).length;
      const meta=document.createElement('small');meta.textContent=count+' member'+(count===1?'':'s');
      copy.append(title,meta);

      const previews=document.createElement('div');previews.className='group-member-preview';
      const members=groupMemberIds(g.id).map(id=>state.members.find(m=>m.id===id)).filter(Boolean);
      members.slice(0,4).forEach(m=>previews.append(avatarEl(m,'group-member-mini')));
      if(members.length>4){const more=document.createElement('span');more.className='group-member-more';more.textContent='+'+(members.length-4);previews.append(more)}

      content.append(icon,copy,previews);card.append(content);
      const bar=document.createElement('span');bar.className='group-color-bar';bar.style.background=g.color?'#'+g.color:'var(--accent)';card.append(bar);
      card.onclick=()=>openGroupManager(g);grid.append(card);
    });
  }

  const coreSetRoute=setRoute;
  setRoute=function setRouteWithGroups(route){
    if(route!=='groups')return coreSetRoute(route);
    state.route='groups';document.querySelector('#pageEyebrow').textContent='System organization';document.querySelector('#pageTitle').textContent='Groups';
    document.querySelectorAll('.route-view').forEach(v=>v.hidden=v.id!=='groupsRoute');
    document.querySelectorAll('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route==='groups'));
    document.querySelector('#openFrontManager').hidden=true;history.replaceState(null,'',location.pathname+'#groups');renderGroups();
  };

  function installHistoryTools(){
    const panel=document.querySelector('#historyRoute .section-panel'),list=document.querySelector('#historyList');if(!panel||!list||document.querySelector('#historyTools'))return;
    const tools=document.createElement('div');tools.id='historyTools';tools.className='history-tools';
    const views=document.createElement('div');views.className='view-switch history-view-switch';
    [['log','Log'],['calendar','Calendar'],['members','By member']].forEach(([v,t])=>{const b=document.createElement('button');b.type='button';b.dataset.historyViewChoice=v;b.textContent=t;b.onclick=()=>{localStorage.setItem(HISTORY_VIEW_KEY,v);state.historyDateFilter='';renderHistory()};views.append(b)});
    const search=document.createElement('label');search.className='history-search';search.innerHTML='<span>Search</span><input id="historySearch" type="search" placeholder="Member name">';search.querySelector('input').oninput=renderHistory;
    const member=makeSelect('historyMemberFilter','Member',[['all','All members']]);member.select.onchange=renderHistory;
    const range=makeSelect('historyRangeFilter','Range',[['all','All loaded'],['today','Today'],['7','Last 7 days'],['30','Last 30 days']]);range.select.value=localStorage.getItem(HISTORY_RANGE_KEY)||'all';range.select.onchange=()=>{localStorage.setItem(HISTORY_RANGE_KEY,range.select.value);renderHistory()};
    const sort=makeSelect('historySort','Sort',[['newest','Newest first'],['oldest','Oldest first']]);sort.select.value=localStorage.getItem(HISTORY_SORT_KEY)||'newest';sort.select.onchange=()=>{localStorage.setItem(HISTORY_SORT_KEY,sort.select.value);renderHistory()};
    const chip=document.createElement('button');chip.id='historyDateFilterChip';chip.className='history-date-filter-chip';chip.type='button';chip.hidden=true;chip.onclick=()=>{state.historyDateFilter='';renderHistory()};
    const meta=document.createElement('div');meta.className='history-tools-meta';meta.innerHTML='<span id="historyResultCount"></span><button id="loadOlderFronts" class="text-button" type="button">Load older</button>';meta.querySelector('button').onclick=loadOlderFronts;
    tools.append(views,search,member.label,range.label,sort.label,chip,meta);list.insertAdjacentElement('beforebegin',tools);
    const cal=document.createElement('div');cal.id='historyCalendarView';cal.className='history-calendar-view';cal.hidden=true;list.insertAdjacentElement('beforebegin',cal);
    const mv=document.createElement('div');mv.id='historyMembersView';mv.className='history-members-view';mv.hidden=true;list.insertAdjacentElement('beforebegin',mv);
    refreshHistoryMembers();
  }
  function refreshHistoryMembers(){
    const s=document.querySelector('#historyMemberFilter');if(!s)return;const current=s.value||'all';s.replaceChildren();
    [['all','All members'],...sortedMembers(activeMembers()).map(m=>[m.id,memberName(m)])].forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;s.append(o)});
    s.value=[...s.options].some(o=>o.value===current)?current:'all';
  }
  function frontDateKey(f){const d=new Date(f.started_at);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
  function filteredFronts(ignoreDate=false){
    const member=document.querySelector('#historyMemberFilter')?.value||'all',range=document.querySelector('#historyRangeFilter')?.value||'all',search=(document.querySelector('#historySearch')?.value||'').trim().toLowerCase(),now=Date.now();
    let rows=state.fronts.filter(f=>{
      const ms=frontMembers(f.id);
      if(member!=='all'&&!ms.some(m=>m.id===member))return false;
      if(search&&!ms.some(m=>[m.name,m.display_name,m.pronouns].filter(Boolean).some(v=>String(v).toLowerCase().includes(search))))return false;
      if(range==='today'){const d=new Date(f.started_at),t=new Date();if(d.toDateString()!==t.toDateString())return false}
      else if(range!=='all'){const days=Number(range);if(now-new Date(f.started_at).getTime()>days*86400000)return false}
      if(!ignoreDate&&state.historyDateFilter&&frontDateKey(f)!==state.historyDateFilter)return false;return true;
    });
    const sort=document.querySelector('#historySort')?.value||'newest';rows.sort((a,b)=>sort==='oldest'?new Date(a.started_at)-new Date(b.started_at):new Date(b.started_at)-new Date(a.started_at));return rows;
  }
  renderHistory=function renderHistoryWithRainbowFeatures(){
    installHistoryTools();refreshHistoryMembers();
    const view=localStorage.getItem(HISTORY_VIEW_KEY)||'log',rows=filteredFronts();
    const list=document.querySelector('#historyList'),cal=document.querySelector('#historyCalendarView'),mv=document.querySelector('#historyMembersView');
    list.hidden=view!=='log';if(cal)cal.hidden=view!=='calendar';if(mv)mv.hidden=view!=='members';
    document.querySelectorAll('[data-history-view-choice]').forEach(b=>b.classList.toggle('active',b.dataset.historyViewChoice===view));
    const count=document.querySelector('#historyResultCount');if(count)count.textContent=rows.length+' front'+(rows.length===1?'':'s')+' shown';
    const older=document.querySelector('#loadOlderFronts');if(older)older.hidden=!state.historyHasMore;
    const chip=document.querySelector('#historyDateFilterChip');if(chip){chip.hidden=!state.historyDateFilter;chip.textContent=state.historyDateFilter?state.historyDateFilter+' ×':''}
    if(view==='calendar')return renderHistoryCalendar();
    if(view==='members')return renderHistoryByMember();
    list.replaceChildren();if(!rows.length){const p=document.createElement('p');p.className='muted history-empty';p.textContent='No fronts match these filters.';list.append(p);return}
    rows.forEach(f=>{const row=document.createElement('div');row.className='history-row';const date=document.createElement('div');date.className='history-date';date.textContent=fmt(f.started_at);const wrap=document.createElement('div');wrap.className='history-members';const ms=frontMembers(f.id);if(!ms.length){const pill=document.createElement('span');pill.className='mini-member-pill';pill.textContent='Switch out';wrap.append(pill)}else ms.sort(byName).forEach(m=>{const pill=document.createElement('span');pill.className='mini-member-pill';const dot=document.createElement('span');dot.className='mini-dot';if(m.color)dot.style.background='#'+m.color;const text=document.createElement('span');text.textContent=memberName(m);pill.append(dot,text);wrap.append(pill)});row.append(date,wrap);list.append(row)});
  };
  function renderHistoryCalendar(){
    const root=document.querySelector('#historyCalendarView');root.replaceChildren();const month=state.historyCalendarMonth,y=month.getFullYear(),mi=month.getMonth();
    const head=document.createElement('div');head.className='calendar-heading';const prev=document.createElement('button');prev.className='secondary-button';prev.textContent='‹';const title=document.createElement('strong');title.textContent=new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'}).format(month);const next=document.createElement('button');next.className='secondary-button';next.textContent='›';prev.onclick=()=>{state.historyCalendarMonth=new Date(y,mi-1,1);renderHistoryCalendar()};next.onclick=()=>{state.historyCalendarMonth=new Date(y,mi+1,1);renderHistoryCalendar()};head.append(prev,title,next);
    const grid=document.createElement('div');grid.className='calendar-grid';['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>{const s=document.createElement('span');s.className='calendar-weekday';s.textContent=d;grid.append(s)});
    const map=new Map();filteredFronts(true).forEach(f=>{const d=new Date(f.started_at);if(d.getFullYear()!==y||d.getMonth()!==mi)return;const k=frontDateKey(f);map.set(k,(map.get(k)||0)+1)});
    for(let i=0;i<new Date(y,mi,1).getDay();i++){const s=document.createElement('span');s.className='calendar-day blank';grid.append(s)}
    const total=new Date(y,mi+1,0).getDate();for(let d=1;d<=total;d++){const k=y+'-'+String(mi+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'),n=map.get(k)||0,b=document.createElement('button');b.className='calendar-day'+(n?' has-switches':'');b.disabled=!n;const strong=document.createElement('strong');strong.textContent=d;const s=document.createElement('span');s.textContent=n||'';b.append(strong,s);if(n)b.onclick=()=>{state.historyDateFilter=k;localStorage.setItem(HISTORY_VIEW_KEY,'log');renderHistory()};grid.append(b)}
    root.append(head,grid);
  }
  function renderHistoryByMember(){
    const root=document.querySelector('#historyMembersView');root.replaceChildren();const counts=new Map(),last=new Map();
    filteredFronts(true).forEach(f=>frontMembers(f.id).forEach(m=>{counts.set(m.id,(counts.get(m.id)||0)+1);const t=new Date(f.started_at).getTime();if(!last.has(m.id)||t>last.get(m.id))last.set(m.id,t)}));
    sortedMembers(activeMembers().filter(m=>counts.has(m.id))).forEach(m=>{const b=document.createElement('button');b.className='history-member-card';b.append(avatarEl(m,'history-member-avatar'));const c=document.createElement('span');c.className='history-member-copy';const st=document.createElement('strong');st.textContent=memberName(m);const sm=document.createElement('small');sm.textContent=counts.get(m.id)+' fronts';c.append(st,sm);const l=document.createElement('span');l.className='history-member-last';l.textContent=last.has(m.id)?relative(new Date(last.get(m.id)).toISOString()):'';b.append(c,l);b.onclick=()=>{document.querySelector('#historyMemberFilter').value=m.id;localStorage.setItem(HISTORY_VIEW_KEY,'log');renderHistory()};root.append(b)});
  }
  async function loadOlderFronts(){
    const b=document.querySelector('#loadOlderFronts');if(!b||!state.fronts.length)return;b.disabled=true;b.textContent='Loading...';
    try{
      const oldest=[...state.fronts].sort((a,b)=>new Date(a.started_at)-new Date(b.started_at))[0];
      const rows=await nihilityApi.rest('fronts',{query:'select=*&started_at=lt.'+encodeURIComponent(oldest.started_at)+'&order=started_at.desc&limit=100'});
      const map=new Map(state.fronts.map(f=>[f.id,f]));(rows||[]).forEach(f=>map.set(f.id,f));state.fronts=[...map.values()].sort((a,b)=>new Date(b.started_at)-new Date(a.started_at));state.historyHasMore=(rows||[]).length===100;renderHistory();toast('Older history loaded',(rows||[]).length+' older fronts added.');
    }catch(error){toast('Could not load older history',error.message,'error')}finally{b.disabled=false;b.textContent='Load older'}
  }

  function renderTopFronter(){
    let section=document.querySelector('#topFronterSection');const panel=document.querySelector('.system-summary-panel');if(!panel)return;
    if(!section){section=document.createElement('div');section.id='topFronterSection';section.className='top-fronter-section';panel.append(section)}
    section.replaceChildren();const p=document.createElement('p');p.className='eyebrow top-fronter-eyebrow';p.textContent='Top fronter';section.append(p);
    const counts=new Map();state.frontMembers.forEach(x=>counts.set(x.member_id,(counts.get(x.member_id)||0)+1));const top=[...activeMembers()].sort((a,b)=>(counts.get(b.id)||0)-(counts.get(a.id)||0)||byName(a,b))[0];
    if(!top||!(counts.get(top.id)||0)){const e=document.createElement('p');e.className='top-fronter-empty';e.textContent='No recent front data yet.';section.append(e);return}
    const row=document.createElement('div');row.className='top-fronter-row';row.append(avatarEl(top,'top-fronter-avatar'));const c=document.createElement('div');c.className='top-fronter-copy';const s=document.createElement('strong');s.textContent=memberName(top);const sm=document.createElement('span');sm.textContent=(counts.get(top.id)||0)+' recent fronts';c.append(s,sm);row.append(c);section.append(row);
  }

  function installMultiCofronter(){
    const picker=document.querySelector('#frontMemberPicker'),dialog=document.querySelector('#frontDialog');if(!picker||!dialog||document.querySelector('#cofronterMultiHelper'))return;
    const helper=document.createElement('div');helper.id='cofronterMultiHelper';helper.className='cofronter-multi-helper';helper.hidden=true;helper.innerHTML='<span>Select multiple members to add together.</span><strong id="cofronterSelectedCount">0 selected</strong>';picker.insertAdjacentElement('beforebegin',helper);
    const update=()=>{const add=document.querySelector('input[name="frontMode"]:checked')?.value==='add';helper.hidden=!add;const current=new Set((activeFront()?frontMembers(activeFront().id):[]).map(m=>m.id));picker.querySelectorAll('.picker-row').forEach(r=>{const i=r.querySelector('input');if(!i)return;const already=add&&current.has(i.value);i.disabled=already;r.classList.toggle('already-fronting',already)});const n=picker.querySelectorAll('input:checked:not(:disabled)').length;document.querySelector('#cofronterSelectedCount').textContent=n+' selected'};
    picker.addEventListener('change',update);document.querySelectorAll('input[name="frontMode"]').forEach(i=>i.addEventListener('change',()=>requestAnimationFrame(update)));new MutationObserver(()=>{if(dialog.open)requestAnimationFrame(update)}).observe(picker,{childList:true});
  }

  function applyImportedSystemIdentity(){
    const s=state.systemProfile;
    if(!s)return;
    const name=s.name||s.display_name;
    if(!name)return;
    const homeName=document.querySelector('#homeProfileName');
    if(homeName)homeName.textContent=name;
  }

  const coreRenderAll=renderAll;
  renderAll=function renderAllWithFeatureParity(){coreRenderAll();renderGroups();renderTopFronter();refreshFeatureControls();applyImportedSystemIdentity()};

  function refreshFeatureControls(){
    installMemberToolbar();installMemberFields();installGroupsRoute();installHistoryTools();installMultiCofronter();refreshGroupOptions();refreshHistoryMembers();
  }

  const coreImportPk=importPk;
  async function importPkWithGroups(){
    await coreImportPk();
    const msg=document.querySelector('#pkMessage');
    try{
      msg.textContent='Comparing PluralKit groups and memberships...';
      const r=await nihilityApi.secure('pk_import_groups');
      const systemPart=r.systemName?(' System name imported as "'+r.systemName+'".'):'';
      msg.textContent='Import complete. '+(r.added||0)+' new groups, '+(r.updated||0)+' changed groups updated, '+(r.unchanged||0)+' unchanged groups skipped, '+(r.membershipsAdded||0)+' missing memberships linked.'+systemPart+' Nihility keeps the local copies.';
      await loadData();
    }catch(error){msg.textContent='Member/front import completed, but group import failed: '+error.message}
  }
  document.querySelector('#importPkButton').onclick=importPkWithGroups;

  function installBackdropClose(dialog){
    if(!dialog||dialog.dataset.backdropClose==='true')return;
    dialog.dataset.backdropClose='true';
    let startedOnBackdrop=false;
    dialog.addEventListener('pointerdown',event=>{startedOnBackdrop=event.target===dialog});
    dialog.addEventListener('pointerup',event=>{
      if(startedOnBackdrop&&event.target===dialog&&dialog.open)dialog.close();
      startedOnBackdrop=false;
    });
    dialog.addEventListener('pointercancel',()=>{startedOnBackdrop=false});
  }
  installBackdropClose(document.querySelector('#memberDialog'));
  const originalEnsureGroupDialog=ensureGroupDialog;
  ensureGroupDialog=function ensureGroupDialogWithBackdrop(){
    const dialog=originalEnsureGroupDialog();
    installBackdropClose(dialog);
    return dialog;
  };

  refreshFeatureControls();
})();
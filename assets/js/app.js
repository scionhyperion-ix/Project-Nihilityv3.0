'use strict';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={user:null,profile:null,members:[],fronts:[],frontMembers:[],integration:null,pkConnected:false,pkImported:false,route:'home'};
let frontMutationVersion=0;
let pendingPkSyncComparison=null;
let pendingBackupRestore=null;

const THEME_KEY='nihility_appearance_theme';
const THEMES=[
  {id:'twilight',name:'Twilight',description:'Violet and lavender'},
  {id:'rainbow',name:'Rainbow',description:'Prismatic dark color'},
  {id:'ocean',name:'Ocean',description:'Blue and cyan'},
  {id:'rose',name:'Rose',description:'Berry and pink'},
  {id:'forest',name:'Forest',description:'Emerald and mint'},
  {id:'amber',name:'Amber',description:'Gold and warm orange'},
  {id:'cherry',name:'Cherry',description:'Ruby and soft red'},
  {id:'sunset',name:'Sunset',description:'Coral and peach'},
  {id:'lagoon',name:'Lagoon',description:'Teal and aqua'},
  {id:'cocoa',name:'Cocoa',description:'Chocolate and cream'}
];
function applyTheme(mode){
  const selected=THEMES.some(t=>t.id===mode)?mode:'twilight';
  localStorage.setItem(THEME_KEY,selected);
  document.documentElement.dataset.theme=selected;
  document.querySelectorAll('[data-theme-choice]').forEach(b=>{const on=b.dataset.themeChoice===selected;b.classList.toggle('selected',on);b.setAttribute('aria-checked',String(on))});
}
function renderThemeOptions(){
  const box=$('#themeOptions');if(!box)return;box.replaceChildren();
  THEMES.forEach(theme=>{const b=document.createElement('button');b.type='button';b.className='theme-option';b.dataset.themeChoice=theme.id;b.setAttribute('role','radio');
    const sw=document.createElement('span');sw.className='theme-swatch theme-swatch-'+theme.id;
    const cp=document.createElement('span');cp.className='theme-option-copy';const st=document.createElement('strong');st.textContent=theme.name;const sm=document.createElement('small');sm.textContent=theme.description;cp.append(st,sm);
    const ck=document.createElement('span');ck.className='theme-check';ck.textContent='✓';b.append(sw,cp,ck);b.onclick=()=>{applyTheme(theme.id);toast('Appearance updated',theme.name+' theme is now active.')};box.append(b)});
  applyTheme(localStorage.getItem(THEME_KEY)||'twilight');
}
function initTheme(){applyTheme(localStorage.getItem(THEME_KEY)||'twilight')}

function toast(title,detail='',type=''){
  const n=document.createElement('div');n.className='toast '+type;
  const strong=document.createElement('strong');strong.textContent=title;n.append(strong);
  if(detail){const small=document.createElement('small');small.textContent=detail;n.append(small)}
  $('#toastRegion').append(n);setTimeout(()=>n.remove(),3600);
}
function hex(v){const c=String(v||'').trim().replace(/^#/,'');return /^[0-9a-f]{6}$/i.test(c)?'#'+c.toUpperCase():''}
function label(m){return m?.display_name||m?.name||'Member'}
function initial(v){return String(v||'N').trim().charAt(0).toUpperCase()||'N'}
function fmt(ts){return ts?new Date(ts).toLocaleString():'Unknown'}
function relative(ts){if(!ts)return'';const d=Date.now()-new Date(ts).getTime(),mins=Math.floor(d/60000);if(mins<1)return'now';if(mins<60)return mins+'m ago';const hrs=Math.floor(mins/60);if(hrs<24)return hrs+'h ago';return Math.floor(hrs/24)+'d ago'}
function duration(ts){if(!ts)return'--';const sec=Math.max(0,Math.floor((Date.now()-new Date(ts).getTime())/1000)),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);return h?(h+'h '+m+'m'):(m+'m')}
let memberMediaObserver=null;
function ensureMemberMediaObserver(){
  if(memberMediaObserver||!('IntersectionObserver' in window))return memberMediaObserver;
  memberMediaObserver=new IntersectionObserver(entries=>{
    entries.forEach(entry=>{
      if(!entry.isIntersecting)return;
      const el=entry.target;memberMediaObserver.unobserve(el);
      const member=state.members.find(m=>m.id===el.dataset.memberMediaId);
      if(!member)return;
      void hydrateMemberMedia(member).then(()=>{
        if(!member.avatar_url||!el.isConnected)return;
        const img=document.createElement('img');
        img.className=el.className.replace(/\s*fallback-avatar\b/,'');
        img.src=member.avatar_url;img.alt='';
        el.replaceWith(img);
      });
    });
  },{rootMargin:'320px 0px'});
  return memberMediaObserver;
}
function avatarEl(item,cls='member-card-avatar'){
  if(item?.avatar_url){const img=document.createElement('img');img.className=cls;img.src=item.avatar_url;img.alt='';return img}
  const d=document.createElement('div');d.className=cls+' fallback-avatar';d.textContent=initial(label(item));
  if(item?.id&&item?.avatar_storage_path){
    d.dataset.memberMediaId=item.id;
    requestAnimationFrame(()=>{if(d.isConnected)ensureMemberMediaObserver()?.observe(d)});
  }
  return d
}

function setView(name){$('#loadingView').hidden=name!=='loading';$('#setupView').hidden=name!=='setup';$('#loginView').hidden=name!=='login';$('#resetView').hidden=name!=='reset';$('#deniedView').hidden=name!=='denied';$('#appView').hidden=name!=='app'}
function setRoute(route){
  state.route=route;
  const meta={home:['Overview','Home'],members:['System directory','Members'],history:['Front tracking','Front history'],settings:['Connection and privacy','Settings'],profile:['Account','Profile']};
  const pair=meta[route]||meta.home;$('#pageEyebrow').textContent=pair[0];$('#pageTitle').textContent=pair[1];
  $$('.route-view').forEach(v=>v.hidden=v.id!==route+'Route');$$('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route===route));
  $('#openFrontManager').hidden=route==='settings'||route==='profile';
  history.replaceState(null,'',route==='home'?location.pathname:(location.pathname+'#'+route));
  if(route==='profile')renderProfile();
}
function activeFront(){return state.fronts.find(f=>!f.ended_at)||null}
function activeMembers(){return state.members.filter(m=>!m.archived_at)}
function frontMembers(frontId){return state.frontMembers.filter(x=>x.front_id===frontId).map(x=>state.members.find(m=>m.id===x.member_id)).filter(Boolean)}
function frontMemberLink(frontId,memberId){
  return state.frontMembers
    .filter(x=>x.front_id===frontId&&x.member_id===memberId)
    .sort((a,b)=>new Date(b.joined_at||0)-new Date(a.joined_at||0))[0]||null;
}
function continuousFrontStart(front,memberId){
  if(!front)return null;
  const ordered=[...state.fronts].sort((a,b)=>new Date(b.started_at)-new Date(a.started_at));
  const index=ordered.findIndex(f=>f.id===front.id);
  if(index<0)return frontMemberLink(front.id,memberId)?.joined_at||front.started_at;

  let start=frontMemberLink(front.id,memberId)?.joined_at||front.started_at;
  let segmentStart=new Date(front.started_at).getTime();

  for(let i=index+1;i<ordered.length;i++){
    const previous=ordered[i];
    if(!previous?.ended_at)break;
    const previousEnd=new Date(previous.ended_at).getTime();
    if(!Number.isFinite(previousEnd)||Math.abs(previousEnd-segmentStart)>5000)break;

    const previousLink=frontMemberLink(previous.id,memberId);
    if(!previousLink)break;

    const previousStart=previousLink.joined_at||previous.started_at;
    if(previousStart&&new Date(previousStart)<new Date(start))start=previousStart;
    segmentStart=new Date(previous.started_at).getTime();
  }
  return start;
}
function frontTimerTextFromMs(ms){
  const seconds=Math.max(0,Math.floor(ms/1000));
  if(seconds<60)return seconds+'s';
  const hours=Math.floor(seconds/3600);
  const minutes=Math.floor((seconds%3600)/60);
  return hours?(hours+'h '+minutes+'m'):(minutes+'m');
}
function frontSinceText(ts){
  if(!ts)return'';
  const date=new Date(ts);
  const today=new Date();
  const sameDay=date.getFullYear()===today.getFullYear()&&date.getMonth()===today.getMonth()&&date.getDate()===today.getDate();
  const options=sameDay
    ?{hour:'numeric',minute:'2-digit'}
    :{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'};
  return 'since '+new Intl.DateTimeFormat(undefined,options).format(date);
}
function updateFrontTimers(){
  const now=Date.now();
  const starts=[];
  document.querySelectorAll('[data-front-timer-start]').forEach(el=>{
    const start=Number(el.dataset.frontTimerStart);
    if(!Number.isFinite(start))return;
    starts.push(start);
    el.textContent=frontTimerTextFromMs(now-start);
  });
  const average=$('#frontDuration');
  if(!average)return;
  if(!starts.length){average.textContent='--';average.title='Average current fronting time';return}
  const avgStart=starts.reduce((sum,value)=>sum+value,0)/starts.length;
  average.textContent='Avg '+frontTimerTextFromMs(now-avgStart);
  average.title='Average current fronting time across '+starts.length+' fronter'+(starts.length===1?'':'s');
}

async function bootstrapProfile(){
  const rows=await nihilityApi.rest('profiles',{query:'select=*&user_id=eq.'+state.user.id+'&limit=1'});
  state.profile=rows?.[0]||null;
  return Boolean(state.profile);
}
async function hydrateMemberMedia(member,{banner=false}={}){
  if(!member)return member;
  const jobs=[];
  if(member.avatar_storage_path&&!member.avatar_url){
    jobs.push(nihilityApi.privateMediaUrl('avatar',member.avatar_storage_path)
      .then(url=>{member.avatar_url=url})
      .catch(error=>{console.warn('Unable to load member avatar',member.id,error)}));
  }
  if(banner&&member.banner_storage_path&&!member.banner_url){
    jobs.push(nihilityApi.privateMediaUrl('banner',member.banner_storage_path)
      .then(url=>{member.banner_url=url})
      .catch(error=>{console.warn('Unable to load member banner',member.id,error)}));
  }
  if(jobs.length)await Promise.all(jobs);
  return member;
}
window.nihilityHydrateMemberMedia=hydrateMemberMedia;

async function hydrateHomeMedia(){
  const ids=new Set();
  const front=activeFront();
  if(front)frontMembers(front.id).forEach(m=>ids.add(m.id));

  const counts=new Map();
  state.frontMembers.forEach(link=>counts.set(link.member_id,(counts.get(link.member_id)||0)+1));
  [...counts.entries()]
    .sort((a,b)=>b[1]-a[1])
    .slice(0,8)
    .forEach(([memberId])=>ids.add(memberId));

  const priority=[...ids].map(id=>state.members.find(m=>m.id===id)).filter(Boolean);
  const jobs=priority.map(member=>hydrateMemberMedia(member));
  if(state.profile?.avatar_storage_path){
    jobs.push(nihilityApi.privateMediaUrl('profile',state.profile.avatar_storage_path)
      .then(url=>{state.profile.avatar_url=url})
      .catch(error=>{console.warn('Unable to load profile avatar',error)}));
  }
  if(state.profile?.banner_storage_path){
    jobs.push(nihilityApi.privateMediaUrl('banner',state.profile.banner_storage_path)
      .then(url=>{state.profile.banner_url=url})
      .catch(error=>{console.warn('Unable to load profile banner',error)}));
  }
  await Promise.all(jobs);
}

async function loadData(){
  const frontVersion=frontMutationVersion;
  const data=await Promise.all([
    nihilityApi.rest('members',{query:'select=*&order=name.asc'}),
    nihilityApi.rest('fronts',{query:'select=*&order=started_at.desc&limit=100'}),
    nihilityApi.rest('front_members',{query:'select=*&order=joined_at.desc'}),
    nihilityApi.rest('external_integrations',{query:'provider=eq.pluralkit&select=*'}),
    nihilityApi.rest('imports',{query:'source=eq.pluralkit&select=id&limit=1'})
  ]);
  state.members=data[0]||[];
  if(frontVersion===frontMutationVersion){
    state.fronts=data[1]||[];
    state.frontMembers=data[2]||[];
  }
  state.integration=data[3]?.[0]||null;
  state.pkConnected=Boolean(state.integration);
  state.pkImported=Boolean(data[4]?.length);
  await hydrateHomeMedia();
}
function renderAll(){renderHeader();renderHome();renderMembers();renderHistory();renderSettings();renderProfile()}
function renderHeader(){
  const name=state.profile?.display_name||state.user?.email||'Account';
  $('#sidebarName').textContent=name;$('#sidebarRole').textContent=state.profile?.role||'member';
  ['#sidebarAvatar','#profileAvatarPreview'].forEach(sel=>{
    const box=$(sel);box.replaceChildren();
    if(state.profile?.avatar_storage_path&&state.profile?.avatar_url){const img=document.createElement('img');img.src=state.profile.avatar_url;img.alt='';box.append(img)}
    else box.textContent=initial(name);
  });
}
function renderHome(){
  const front=activeFront(),members=front?frontMembers(front.id):[];
  const transferButton=$('#transferFrontToPkButton');
  if(transferButton){
    transferButton.hidden=!state.pkConnected;
    transferButton.disabled=Boolean(front&&members.some(m=>!m.pk_id));
    transferButton.title=transferButton.disabled?'Every current fronter must be linked to PluralKit before transfer.':'Send the current Nihility front state to PluralKit now.';
  }
  $('#currentFrontMembers').replaceChildren();
  const rainbowSubtitle=$('#rainbowFrontSubtitle');if(rainbowSubtitle)rainbowSubtitle.textContent=!members.length?'No one is currently fronting':members.length===1?(label(members[0])+' is currently fronting'):(members.length+' members are currently fronting');
  if(!front||!members.length){
    $('#currentFrontHeading').textContent='Nobody is fronting';$('#frontDuration').textContent='--';
    const p=document.createElement('p');p.className='muted';p.textContent='Start a front from Quick front or Manage front.';$('#currentFrontMembers').append(p);
  }else{
    $('#currentFrontHeading').textContent=members.length===1?label(members[0]):(members.length+' co-fronters');
    members.forEach(m=>{
      const row=document.createElement('div');row.className='front-person timed-front-person front-person-interactive';
      row.setAttribute('role','button');
      row.tabIndex=0;
      row.setAttribute('aria-label','Open '+label(m)+' profile');
      row.title='View or edit '+label(m);
      row.onclick=()=>openMember(m);
      row.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openMember(m)}};
      row.append(avatarEl(m,'timeline-avatar'));
      const copy=document.createElement('div');copy.className='front-person-copy';
      const name=document.createElement('strong');name.textContent=label(m);
      const pronouns=document.createElement('small');pronouns.textContent=m.pronouns||m.name;

      const start=continuousFrontStart(front,m.id);
      const timing=document.createElement('div');timing.className='front-member-timing';
      const timer=document.createElement('span');timer.className='front-member-timer';
      if(start)timer.dataset.frontTimerStart=String(new Date(start).getTime());
      timer.textContent=start?frontTimerTextFromMs(Date.now()-new Date(start).getTime()):'--';
      const since=document.createElement('span');since.className='front-member-since';since.textContent=frontSinceText(start);
      timing.append(timer,since);

      copy.append(name,pronouns,timing);
      row.append(copy);
      $('#currentFrontMembers').append(row);
    });
    updateFrontTimers();
  }
  const system=state.systemProfile||{};
  const systemName=system.name||system.display_name||state.integration?.external_system_name||'Nihility system';
  const systemId=system.id||state.integration?.external_system_id||'...';
  $('#homeProfileName').textContent=systemName;
  $('#homeIntegrationState').textContent=system.pronouns||((state.integration&&state.pkConnected)?'PluralKit system':'Independent system');
  $('#homeMemberCount').textContent=String(activeMembers().length);
  $('#homeFrontCount').textContent=String(state.fronts.length);
  $('#homeShareState').textContent=systemId;

  const systemAvatar=$('#homeProfileAvatar');
  systemAvatar.replaceChildren();
  systemAvatar.className='system-avatar large';
  if(system.avatar_display_url){
    const img=document.createElement('img');img.src=system.avatar_display_url;img.alt='';
    img.onerror=()=>{systemAvatar.replaceChildren();systemAvatar.className='system-avatar large fallback-avatar';systemAvatar.textContent=initial(systemName)};
    systemAvatar.append(img);
  }else{
    systemAvatar.classList.add('fallback-avatar');systemAvatar.textContent=initial(systemName);
  }
  const systemBanner=document.querySelector('.system-summary-panel .system-banner');
  if(systemBanner){
    const bannerUrl=system.banner_display_url||'';
    systemBanner.style.backgroundImage=bannerUrl?'url("'+bannerUrl.replaceAll('"','%22')+'")':'';
  }

  const counts=new Map();state.frontMembers.forEach(x=>counts.set(x.member_id,(counts.get(x.member_id)||0)+1));
  const frequent=[...activeMembers()].sort((a,b)=>(counts.get(b.id)||0)-(counts.get(a.id)||0)).slice(0,8);
  $('#frequentMembers').replaceChildren();
  frequent.forEach(m=>{const b=document.createElement('button');b.className='member-chip';b.type='button';b.append(avatarEl(m,'timeline-avatar'));const c=document.createElement('div');c.className='member-chip-copy';const s=document.createElement('strong');s.textContent=label(m);const sm=document.createElement('small');sm.textContent=(counts.get(m.id)||0)+' fronts';c.append(s,sm);b.append(c);b.onclick=()=>quickFront(m);$('#frequentMembers').append(b)});

  $('#recentFronts').replaceChildren();
  state.fronts.slice(0,6).forEach(f=>{const ms=frontMembers(f.id),row=document.createElement('div');row.className='timeline-row';row.append(ms[0]?avatarEl(ms[0],'timeline-avatar'):avatarEl({name:'Out'},'timeline-avatar'));const c=document.createElement('div');c.className='timeline-copy';const s=document.createElement('strong');s.textContent=ms.length?ms.map(label).join(', '):'Switch out';const sm=document.createElement('small');sm.textContent=fmt(f.started_at);c.append(s,sm);const t=document.createElement('span');t.className='timeline-time';t.textContent=relative(f.started_at);row.append(c,t);$('#recentFronts').append(row)});
}
function renderMembers(){
  const q=$('#memberSearch').value.trim().toLowerCase();
  const status=$('#memberStatusFilter')?.value||'active';
  const source=status==='archived'?state.members.filter(m=>m.archived_at):status==='all'?state.members:activeMembers();
  const list=source.filter(m=>[m.name,m.display_name,m.pronouns].filter(Boolean).some(v=>v.toLowerCase().includes(q)));
  $('#memberGrid').replaceChildren();$('#membersEmpty').hidden=list.length>0;
  list.forEach(m=>{const card=document.createElement('button');card.className='member-card';const top=document.createElement('div');top.className='member-card-top';top.append(avatarEl(m));const copy=document.createElement('div');copy.className='member-card-name';const h=document.createElement('h3');h.textContent=label(m);const p=document.createElement('p');p.textContent=m.pronouns||m.name;copy.append(h,p);top.append(copy);card.append(top);if(m.description){const d=document.createElement('p');d.className='member-card-desc';d.textContent=m.description;card.append(d)}const bar=document.createElement('span');bar.className='member-color-bar';bar.style.background=m.color?'#'+m.color:'var(--accent)';card.append(bar);card.onclick=()=>openMember(m);$('#memberGrid').append(card)});
}
function renderHistory(){
  $('#historyList').replaceChildren();
  if(!state.fronts.length){const p=document.createElement('p');p.className='muted';p.textContent='No front history yet.';$('#historyList').append(p);return}
  state.fronts.forEach(f=>{const row=document.createElement('div');row.className='history-row';const date=document.createElement('div');date.className='history-date';date.textContent=fmt(f.started_at);const members=document.createElement('div');members.className='history-members';const ms=frontMembers(f.id);if(!ms.length){const pill=document.createElement('span');pill.className='mini-member-pill';pill.textContent='Switch out';members.append(pill)}else ms.forEach(m=>{const pill=document.createElement('span');pill.className='mini-member-pill';pill.textContent=label(m);members.append(pill)});row.append(date,members);$('#historyList').append(row)});
}
function renderSettings(){
  renderThemeOptions();const connected=Boolean(state.integration&&state.pkConnected);$('#pkDisconnected').hidden=connected;$('#pkConnected').hidden=!connected;
  const importButton=$('#importPkButton');if(importButton)importButton.textContent=state.pkImported?'Sync PK':'Import system';
  if(state.integration){$('#pkSystemName').textContent=state.integration.external_system_name||'PluralKit system';$('#pkSystemId').textContent=state.integration.external_system_id||'...'}
}
function renderProfile(){
  if(!state.profile)return;
  $('#profileHeading').textContent=state.profile.display_name||state.user.email;
  $('#profileEmail').textContent=state.user.email||'';
  $('#profileDisplayName').value=state.profile.display_name||'';
  $('#profileAvatarUrl').value=state.profile.avatar_storage_path?'':(state.profile.avatar_url||'');
  $('#profileBannerUrl').value=state.profile.banner_storage_path?'':(state.profile.banner_url||'');
  $('#profileRole').textContent=state.profile.role==='owner'?'Owner':'Member';
  $('#invitePanel').hidden=state.profile.role!=='owner';
  const banner=$('#profileBannerPreview');
  if(banner){
    const url=state.profile.banner_storage_path?state.profile.banner_url||'':'';
    banner.style.backgroundImage=url?'linear-gradient(rgba(10,11,20,.08),rgba(10,11,20,.18)), url("'+url.replaceAll('"','%22')+'")':'';
    banner.classList.toggle('has-profile-banner',Boolean(url));
  }
  renderHeader();
}

function resetMemberForm(){$('#memberForm').reset();$('#memberId').value='';$('#memberColorPicker').value='#8b7cf6';$('#memberError').hidden=true;$('#deleteMemberButton').hidden=true;$('#restoreMemberButton').hidden=true;$('#permanentDeleteMemberButton').hidden=true}
function openMember(m=null){
  resetMemberForm();$('#memberDialogTitle').textContent=m?'Edit member':'New member';
  if(m){$('#memberId').value=m.id;$('#memberName').value=m.name||'';$('#memberDisplayName').value=m.display_name||'';$('#memberPronouns').value=m.pronouns||'';$('#memberDescription').value=m.description||'';$('#memberAvatarUrl').value=m.avatar_source==='external'?(m.avatar_url||''):'';$('#memberBannerUrl').value=m.banner_source==='external'?(m.banner_url||''):'';const c=hex(m.color);$('#memberColor').value=c;if(c)$('#memberColorPicker').value=c;$('#memberDialogTitle').textContent=m.archived_at?'Archived member':'Edit member';$('#deleteMemberButton').hidden=Boolean(m.archived_at);$('#restoreMemberButton').hidden=!m.archived_at;$('#permanentDeleteMemberButton').hidden=false}
  $('#memberDialog').showModal();
}
async function maybeUpload(kind,input){
  const file=input.files?.[0];if(!file)return null;const max=kind==='banner'?5*1024*1024:2*1024*1024;
  if(file.size>max)throw new Error((kind==='banner'?'Banner':'Image')+' exceeds the upload limit.');
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw new Error('Unsupported image format.');
  return nihilityApi.upload(kind,file);
}
async function safeDelete(kind,path){if(!path)return;try{await nihilityApi.deleteMedia(kind,path)}catch(error){console.warn(error)}}
async function importExternalMedia(kind,url){if(!url)return null;const result=await nihilityApi.secure('import_media',{kind,url});return result?.path||null}

async function saveMember(e){
  e.preventDefault();const err=$('#memberError');err.hidden=true;let au=null,bu=null;
  try{
    const id=$('#memberId').value,old=id?state.members.find(m=>m.id===id):null;
    au=await maybeUpload('avatar',$('#memberAvatarFile'));bu=await maybeUpload('banner',$('#memberBannerFile'));
    const ae=$('#memberAvatarUrl').value.trim(),be=$('#memberBannerUrl').value.trim(),c=hex($('#memberColor').value);
    const importedAvatarPath=!au&&ae?await importExternalMedia('avatar',ae):null;
    const importedBannerPath=!bu&&be?await importExternalMedia('banner',be):null;
    const newAvatarPath=au?.path||importedAvatarPath||old?.avatar_storage_path||null;
    const newBannerPath=bu?.path||importedBannerPath||old?.banner_storage_path||null;
    const body={user_id:state.user.id,name:$('#memberName').value.trim(),display_name:$('#memberDisplayName').value.trim()||null,pronouns:$('#memberPronouns').value.trim()||null,color:c?c.slice(1).toLowerCase():null,description:$('#memberDescription').value.trim()||null,avatar_url:null,avatar_source:newAvatarPath?'supabase':null,avatar_storage_path:newAvatarPath,banner_url:null,banner_source:newBannerPath?'supabase':null,banner_storage_path:newBannerPath,pk_id:old?.pk_id||null,tupper_id:old?.tupper_id||null,archived_at:old?.archived_at||null};
    if(!body.name)throw new Error('Name is required.');
    if(id)await nihilityApi.rest('members',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body,prefer:'return=minimal'});else await nihilityApi.rest('members',{method:'POST',body,prefer:'return=minimal'});
    if(old?.avatar_storage_path&&old.avatar_storage_path!==body.avatar_storage_path)await safeDelete('avatar',old.avatar_storage_path);if(old?.banner_storage_path&&old.banner_storage_path!==body.banner_storage_path)await safeDelete('banner',old.banner_storage_path);
    $('#memberDialog').close();toast(id?'Member updated':'Member created');await loadData();
  }catch(error){if(au?.path)await safeDelete('avatar',au.path);if(bu?.path)await safeDelete('banner',bu.path);err.textContent=error.message;err.hidden=false}
}
async function deleteMember(){
  const id=$('#memberId').value;
  if(!id||!confirm('Archive this Nihility member? Their historical front records will be kept.'))return;
  await nihilityApi.rest('members',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body:{archived_at:new Date().toISOString()},prefer:'return=minimal'});
  $('#memberDialog').close();
  toast('Member archived','You can find them under Members, then Status, Archived.');
  await loadData();
}
async function restoreMember(){
  const id=$('#memberId').value;
  if(!id)return;
  await nihilityApi.rest('members',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body:{archived_at:null},prefer:'return=minimal'});
  $('#memberDialog').close();
  toast('Member restored','They are active again.');
  await loadData();
}
async function permanentlyDeleteMember(){
  const id=$('#memberId').value;
  const member=state.members.find(m=>m.id===id);
  if(!id||!member)return;
  const name=label(member);
  if(!confirm('Permanently delete '+name+'? This cannot be undone and removes their group memberships and links from front history. Archive instead if you want to preserve history.'))return;
  if(!confirm('Delete '+name+' forever?'))return;
  await nihilityApi.secure('delete_member',{memberId:id});
  $('#memberDialog').close();
  toast('Member permanently deleted',name+' was removed from Nihility.');
  await loadData();
}

function buildFrontPicker(selected=[]){
  const q=$('#frontMemberSearch').value.trim().toLowerCase(),set=new Set(selected);$('#frontMemberPicker').replaceChildren();
  activeMembers().filter(m=>[m.name,m.display_name].filter(Boolean).some(v=>v.toLowerCase().includes(q))).forEach(m=>{const row=document.createElement('label');row.className='picker-row';row.append(avatarEl(m,'picker-avatar'));const c=document.createElement('span');c.className='picker-copy';const s=document.createElement('strong');s.textContent=label(m);const sm=document.createElement('small');sm.textContent=m.pk_id?'PK linked':'Nihility only';c.append(s,sm);const input=document.createElement('input');input.type='checkbox';input.value=m.id;input.checked=set.has(m.id);row.append(c,input);$('#frontMemberPicker').append(row)});
}
function openFront(mode='replace',pre=[]){$('input[name="frontMode"][value="'+mode+'"]').checked=true;$('#frontMemberSearch').value='';$('#frontError').hidden=true;$('#customFrontTimeEnabled').checked=false;$('#customFrontTimeRow').hidden=true;buildFrontPicker(pre);$('#frontDialog').showModal()}
async function mirrorFrontToPk(memberIds,timestamp){
  if(!state.pkConnected)return{shared:false,reason:'PluralKit is not connected.'};
  const chosen=memberIds.map(id=>state.members.find(m=>m.id===id)).filter(Boolean);
  if(chosen.length!==memberIds.length||chosen.some(m=>!m.pk_id))return{shared:false,reason:'Every current fronter must be linked to PluralKit before transfer.'};
  return nihilityApi.secure('pk_mirror_front',{memberIds,timestamp});
}
async function transferCurrentFrontToPk(){
  const button=$('#transferFrontToPkButton');
  if(!state.pkConnected)return toast('PluralKit not connected','Connect PluralKit in Settings first.','error');
  const front=activeFront();
  const memberIds=front?frontMembers(front.id).map(m=>m.id):[];
  if(front&&memberIds.length&&memberIds.some(id=>!state.members.find(m=>m.id===id)?.pk_id)){
    return toast('Cannot transfer front','One or more current fronters are not linked to PluralKit.','error');
  }
  if(button){button.disabled=true;button.textContent='Transferring...'}
  try{
    const result=await mirrorFrontToPk(memberIds,new Date().toISOString());
    if(result?.reason)throw new Error(result.reason);
    toast('Transferred to PluralKit',memberIds.length?('Sent '+memberIds.length+' current fronter'+(memberIds.length===1?'':'s')+'.'):'Sent a switch-out state.');
  }catch(error){
    toast('PluralKit transfer failed',error.message,'error');
  }finally{
    if(button){button.disabled=false;button.textContent='Transfer to PK'}
  }
}
function applyCommittedFront(frontId,memberIds,startedAt){
  const previousActive=state.fronts.filter(f=>!f.ended_at);
  previousActive.forEach(f=>{f.ended_at=startedAt});
  const previousIds=new Set(previousActive.map(f=>f.id));
  state.frontMembers.forEach(link=>{
    if(previousIds.has(link.front_id)&&!link.left_at)link.left_at=startedAt;
  });

  const front={
    id:frontId,
    user_id:state.user?.id||null,
    started_at:startedAt,
    ended_at:null,
    note:null,
    source:'nihility',
    external_id:null,
    created_at:startedAt
  };
  state.fronts=[front,...state.fronts.filter(f=>f.id!==frontId)]
    .sort((a,b)=>new Date(b.started_at)-new Date(a.started_at))
    .slice(0,100);

  const links=memberIds.map(memberId=>({
    user_id:state.user?.id||null,
    front_id:frontId,
    member_id:memberId,
    joined_at:startedAt,
    left_at:null
  }));
  state.frontMembers=[...links,...state.frontMembers];

  renderHome();
  renderHistory();
}
async function refreshFrontState(version=frontMutationVersion){
  try{
    const [fronts,frontMembers]=await Promise.all([
      nihilityApi.rest('fronts',{query:'select=*&order=started_at.desc&limit=100'}),
      nihilityApi.rest('front_members',{query:'select=*&order=joined_at.desc'})
    ]);
    if(version!==frontMutationVersion)return;
    state.fronts=fronts||[];
    state.frontMembers=frontMembers||[];
    renderHome();
    renderHistory();
  }catch(error){
    console.warn('Unable to refresh front state',error);
  }
}
async function logFront(memberIds,timestamp){
  const startedAt=timestamp||new Date().toISOString();
  const version=++frontMutationVersion;
  const result=await nihilityApi.rpc('log_front',{p_member_ids:memberIds,p_started_at:startedAt,p_note:null});
  const frontId=typeof result==='string'?result:String(result?.id||'');
  if(frontId)applyCommittedFront(frontId,memberIds,startedAt);
  else void refreshFrontState(version);

  // Nihility is authoritative. PluralKit is only updated when the user
  // explicitly transfers the current front from the Home card.
  void refreshFrontState(version);
}
async function saveFront(e){
  e.preventDefault();const err=$('#frontError');err.hidden=true;
  try{
    const selected=$$('#frontMemberPicker input:checked').map(i=>i.value);if(!selected.length)throw new Error('Select at least one member.');
    const mode=$('input[name="frontMode"]:checked')?.value||'replace';let ids=selected;
    if(mode==='add'){const current=activeFront();ids=[...new Set([...(current?frontMembers(current.id).map(m=>m.id):[]),...selected])]}
    let ts=null;if($('#customFrontTimeEnabled').checked){const raw=$('#customFrontTime').value;if(!raw)throw new Error('Enter a valid start time.');ts=new Date(raw).toISOString()}
    await logFront(ids,ts);$('#frontDialog').close();toast('Front updated','Saved to Nihility.');
  }catch(error){err.textContent=error.message;err.hidden=false}
}
async function quickFront(m){if(!confirm('Start a new front with '+label(m)+' fronting?'))return;await logFront([m.id],null);toast('Front updated',label(m)+' is now fronting.')}
async function switchOut(){if(!confirm('Switch out with nobody fronting?'))return;await logFront([],null);toast('Switched out')}

async function connectPk(){
  const message=$('#pkMessage');message.textContent='Connecting securely...';
  try{
    const token=$('#pkTokenInput').value.trim();if(!token)throw new Error('Enter a PluralKit token.');
    await nihilityApi.secure('pk_connect',{token});
    $('#pkTokenInput').value='';
    message.textContent='Connected securely. The PK token is encrypted server-side and is not stored in this browser.';
    await loadData();
  }catch(error){message.textContent=error.message}
}
async function disconnectPk(){
  const message=$('#pkMessage');message.textContent='Disconnecting...';
  try{
    await nihilityApi.secure('pk_disconnect');
    state.pkConnected=false;
    if(state.integration)state.integration.share_fronting_updates=false;
    $('#pkTokenInput').value='';
    message.textContent='PluralKit disconnected and its stored credential was deleted.';
    renderSettings();renderHome();
  }catch(error){message.textContent=error.message}
}
function pkSyncItemNames(bucket){
  const items=Array.isArray(bucket?.items)?bucket.items:[];
  if(!items.length)return'None';
  const names=items.map(item=>item.name||item.pkId||item.localId||'Unknown');
  const suffix=(bucket.count||0)>items.length?' +'+((bucket.count||0)-items.length)+' more':'';
  return names.join(', ')+suffix;
}
function addPkSyncPreviewSection(container,title,rows){
  const section=document.createElement('section');section.className='pk-sync-preview-section';
  const heading=document.createElement('h4');heading.textContent=title;section.append(heading);
  rows.forEach(([labelText,bucket])=>{
    const row=document.createElement('div');row.className='pk-sync-preview-row';
    const copy=document.createElement('div');
    const strong=document.createElement('strong');strong.textContent=labelText;
    const small=document.createElement('small');small.textContent=pkSyncItemNames(bucket);
    copy.append(strong,small);
    const count=document.createElement('span');count.className='soft-pill';count.textContent=String(bucket?.count||0);
    row.append(copy,count);section.append(row);
  });
  container.append(section);
}
function renderPkSyncPreview(comparison){
  const box=$('#pkSyncPreview');box.replaceChildren();
  addPkSyncPreviewSection(box,'Members',[
    ['PluralKit has, Nihility lacks',comparison.members.missingInNihility],
    ['Nihility has, PluralKit lacks',comparison.members.missingInPk],
    ['Changes coming from PluralKit',comparison.members.toNihility],
    ['Changes going to PluralKit',comparison.members.toPk],
    ['Conflicts needing a choice',comparison.members.conflicts]
  ]);
  addPkSyncPreviewSection(box,'Groups',[
    ['PluralKit has, Nihility lacks',comparison.groups.missingInNihility],
    ['Nihility has, PluralKit lacks',comparison.groups.missingInPk],
    ['Changes coming from PluralKit',comparison.groups.toNihility],
    ['Changes going to PluralKit',comparison.groups.toPk],
    ['Conflicts needing a choice',comparison.groups.conflicts]
  ]);
  addPkSyncPreviewSection(box,'Group memberships',[
    ['Changes coming from PluralKit',comparison.memberships.toNihility],
    ['Changes going to PluralKit',comparison.memberships.toPk],
    ['Conflicts needing a choice',comparison.memberships.conflicts]
  ]);
  $('#pkSyncMediaNote').textContent=comparison.mediaNote||'';
}
async function openPkSyncPreview(){
  const message=$('#pkMessage'),button=$('#importPkButton');
  if(button){button.disabled=true;button.textContent='Checking...'}
  message.textContent='Checking both Nihility and PluralKit before syncing...';
  try{
    const comparison=await nihilityApi.secure('pk_sync_compare');
    pendingPkSyncComparison=comparison;
    renderPkSyncPreview(comparison);
    $('#pkSyncDialog').showModal();
    message.textContent='Review what differs on each side before applying the sync.';
  }catch(error){message.textContent=error.message}
  finally{if(button){button.disabled=false;button.textContent='Sync PK'}}
}
async function applyPkSync(){
  if(!pendingPkSyncComparison)return;
  const button=$('#applyPkSyncButton'),message=$('#pkSyncMessage');
  const policy=$('input[name="pkSyncConflictPolicy"]:checked')?.value||'skip';
  if(button){button.disabled=true;button.textContent='Syncing...'}
  message.textContent='Rechecking both sides and applying safe changes...';
  try{
    const result=await nihilityApi.secure('pk_sync_apply',{conflictPolicy:policy});
    const remaining=(result.comparison?.members?.conflicts?.count||0)+(result.comparison?.groups?.conflicts?.count||0)+(result.comparison?.memberships?.conflicts?.count||0);
    await nihilityApi.rest('imports',{method:'POST',body:{user_id:state.user.id,source:'pluralkit',summary:{
      two_way_sync:true,
      members_created_in_nihility:result.members?.createdInNihility||0,
      members_created_in_pk:result.members?.createdInPk||0,
      member_fields_to_nihility:result.members?.toNihility||0,
      member_fields_to_pk:result.members?.toPk||0,
      groups_created_in_nihility:result.groups?.createdInNihility||0,
      groups_created_in_pk:result.groups?.createdInPk||0,
      group_fields_to_nihility:result.groups?.toNihility||0,
      group_fields_to_pk:result.groups?.toPk||0,
      memberships_to_nihility:result.memberships?.toNihility||0,
      memberships_to_pk:result.memberships?.toPk||0,
      conflicts_skipped:result.conflictsSkipped||0,
      blocked:Array.isArray(result.blocked)?result.blocked.length:0
    }},prefer:'return=minimal'});
    pendingPkSyncComparison=null;
    $('#pkSyncDialog').close();
    await loadData();
    const blocked=Array.isArray(result.blocked)?result.blocked.length:0;
    $('#pkMessage').textContent='Sync complete.'+(remaining?' '+remaining+' conflict'+(remaining===1?'':'s')+' remain unresolved.':'')+(blocked?' '+blocked+' change'+(blocked===1?' was':'s were')+' blocked by PluralKit limits.':'');
    toast('PK sync complete',remaining?'Some conflicts were left for review.':'Both sides were reconciled.');
  }catch(error){message.textContent=error.message}
  finally{if(button){button.disabled=false;button.textContent='Apply sync'}}
}
async function importPk(){
  const message=$('#pkMessage'),button=$('#importPkButton'),wasImported=state.pkImported;
  if(wasImported)return openPkSyncPreview();
  if(button){button.disabled=true;button.textContent='Importing...'}
  message.textContent='Comparing PluralKit with Nihility...';
  try{
    const comparison=await nihilityApi.secure('pk_compare');
    const missing=Array.isArray(comparison.missingMemberIds)?comparison.missingMemberIds:[];
    let added=0,skipped=0,mediaCopied=0;

    if(missing.length){
      for(let offset=0;offset<missing.length;offset+=10){
        const batch=missing.slice(offset,offset+10);
        const result=await nihilityApi.secure('pk_import',{memberIds:batch});
        added+=result.added||0;skipped+=result.skipped||0;mediaCopied+=result.mediaCopied||0;
        message.textContent=(wasImported?'Syncing':'Importing')+' new members... '+Math.min(offset+batch.length,missing.length)+' / '+missing.length;
      }
    }

    message.textContent='Syncing member and group changes...';
    const directory=await nihilityApi.secure('pk_import_groups');

    let frontAdded=0,frontSkipped=0,unresolvedFronts=0,batches=0;
    if(!wasImported){
      let before=null;
      do{
        message.textContent='Importing front history... '+frontAdded+' new';
        const result=await nihilityApi.secure('pk_import_fronts',{before,limit:100});
        frontAdded+=result.added||0;frontSkipped+=result.skipped||0;unresolvedFronts+=result.unresolved||0;
        before=result.nextBefore||null;batches++;
        if(!result.processed||batches>=100)break;
      }while(before);
    }

    await nihilityApi.rest('imports',{method:'POST',body:{user_id:state.user.id,source:'pluralkit',summary:{
      members_total:comparison.memberTotal||0,
      members_missing:missing.length,
      members_added:added,
      members_updated:directory.membersUpdated||0,
      members_unchanged:directory.membersUnchanged||0,
      member_media_copied:(mediaCopied||0)+(directory.memberMediaCopied||0),
      groups_total:directory.groupTotal||0,
      groups_added:directory.added||0,
      groups_updated:directory.updated||0,
      groups_unchanged:directory.unchanged||0,
      group_memberships_added:directory.membershipsAdded||0,
      group_memberships_removed:directory.membershipsRemoved||0,
      groups_unresolved:directory.unresolved||0,
      fronts_added:frontAdded,
      fronts_skipped:frontSkipped,
      front_members_unresolved:unresolvedFronts
    }},prefer:'return=minimal'});

    state.pkImported=true;
    const parts=[
      added+' member'+(added===1?'':'s')+' added',
      (directory.membersUpdated||0)+' member'+((directory.membersUpdated||0)===1?'':'s')+' updated',
      (directory.added||0)+' group'+((directory.added||0)===1?'':'s')+' added',
      (directory.updated||0)+' group'+((directory.updated||0)===1?'':'s')+' updated',
      (directory.membershipsAdded||0)+' membership'+((directory.membershipsAdded||0)===1?'':'s')+' added',
      (directory.membershipsRemoved||0)+' membership'+((directory.membershipsRemoved||0)===1?'':'s')+' removed'
    ];
    if(!wasImported)parts.push(frontAdded+' front-history entr'+(frontAdded===1?'y':'ies')+' added');
    message.textContent=(wasImported?'Sync complete: ':'Import complete: ')+parts.join(', ')+'.';
    await loadData();
  }catch(error){message.textContent=error.message}
  finally{if(button){button.disabled=false;button.textContent=state.pkImported?'Sync PK':'Import system'}}
}

async function saveProfile(e){
  e.preventDefault();const msg=$('#profileMessage');msg.textContent='Saving...';let avatarUpload=null,bannerUpload=null;
  try{
    const old=state.profile;
    const avatarExternal=$('#profileAvatarUrl').value.trim();
    const bannerExternal=$('#profileBannerUrl').value.trim();
    avatarUpload=await maybeUpload('profile',$('#profileAvatarFile'));
    bannerUpload=await maybeUpload('banner',$('#profileBannerFile'));
    const importedAvatarPath=!avatarUpload&&avatarExternal?await importExternalMedia('profile',avatarExternal):null;
    const importedBannerPath=!bannerUpload&&bannerExternal?await importExternalMedia('banner',bannerExternal):null;
    const body={
      display_name:$('#profileDisplayName').value.trim()||null,
      avatar_url:null,
      avatar_storage_path:avatarUpload?.path||importedAvatarPath||old.avatar_storage_path||null,
      banner_url:null,
      banner_storage_path:bannerUpload?.path||importedBannerPath||old.banner_storage_path||null
    };
    await nihilityApi.rest('profiles',{method:'PATCH',query:'user_id=eq.'+state.user.id,body,prefer:'return=minimal'});
    if(old.avatar_storage_path&&old.avatar_storage_path!==body.avatar_storage_path)await safeDelete('profile',old.avatar_storage_path);
    if(old.banner_storage_path&&old.banner_storage_path!==body.banner_storage_path)await safeDelete('banner',old.banner_storage_path);
    state.profile={...state.profile,...body};
    if(state.profile.avatar_storage_path){
      try{state.profile.avatar_url=await nihilityApi.privateMediaUrl('profile',state.profile.avatar_storage_path)}
      catch(error){console.warn('Unable to reload profile avatar',error)}
    }
    if(state.profile.banner_storage_path){
      try{state.profile.banner_url=await nihilityApi.privateMediaUrl('banner',state.profile.banner_storage_path)}
      catch(error){console.warn('Unable to reload profile banner',error)}
    }
    $('#profileAvatarFile').value='';$('#profileBannerFile').value='';
    msg.textContent='Profile saved.';renderProfile();
  }catch(error){
    if(avatarUpload?.path)await safeDelete('profile',avatarUpload.path);
    if(bannerUpload?.path)await safeDelete('banner',bannerUpload.path);
    msg.textContent=error.message
  }
}
async function invite(e){
  e.preventDefault();
  const msg=$('#inviteMessage');
  const email=$('#inviteEmail').value.trim().toLowerCase();
  msg.textContent='Creating invite...';
  try{
    await nihilityApi.rest('account_invites',{method:'DELETE',query:'email=eq.'+encodeURIComponent(email),prefer:'return=minimal'});
    await nihilityApi.rest('account_invites',{method:'POST',body:{email,invited_by:state.user.id},prefer:'return=minimal'});
    msg.textContent='Invite created. They can now sign in with that email.';
    $('#inviteForm').reset();
  }catch(error){msg.textContent=error.message}
}

async function boot(){
  initTheme();
  localStorage.removeItem('nihility_pk_token');sessionStorage.removeItem('nihility_pk_token_session');
  if(!nihilityApi.configured()){setView('setup');return}
  try{
    await nihilityApi.readSessionFromUrl();
  }catch(error){
    nihilityApi.saveSession(null);
    setView('login');
    const message=$('#loginMessage');
    if(message)message.textContent=error.message||'Unable to verify this sign-in link.';
    return;
  }
  state.user=await nihilityApi.user();if(!state.user){setView('login');return}
  if(new URLSearchParams(location.search).get('reset')==='1'){setView('reset');return}
  if(!await bootstrapProfile()){setView('denied');return}
  setView('loading');
  await loadData();
  setRoute('home');
  setView('app');
}

$('#loginForm').onsubmit=async e=>{e.preventDefault();const m=$('#loginMessage'),email=$('#emailInput').value.trim(),password=$('#passwordInput').value;if(!password){m.textContent='Enter your password, or use the magic-link button.';return}m.textContent='Signing in...';try{await nihilityApi.signInWithPassword(email,password);location.reload()}catch(error){m.textContent=error.message}};
$('#magicLinkButton').onclick=async()=>{const m=$('#loginMessage'),email=$('#emailInput').value.trim();if(!email){m.textContent='Enter your email first.';return}m.textContent='Sending...';try{await nihilityApi.sendMagicLink(email);m.textContent='Check your email, then open the sign-in link in this browser.'}catch(error){m.textContent=error.message}};
$('#forgotPasswordButton').onclick=async()=>{const m=$('#loginMessage'),email=$('#emailInput').value.trim();if(!email){m.textContent='Enter your email first.';return}m.textContent='Sending password reset...';try{await nihilityApi.sendPasswordReset(email);m.textContent='Check your email, then open the reset link in this browser.'}catch(error){m.textContent=error.message}};
function backupFilename(exportedAt){
  const date=exportedAt?new Date(exportedAt):new Date();
  const stamp=Number.isFinite(date.getTime())?date.toISOString().replace(/[:.]/g,'-'):'backup';
  return 'project-nihility-backup-'+stamp+'.json';
}
async function exportBackup(){
  const button=$('#exportBackupButton'),message=$('#backupMessage');
  button.disabled=true;message.textContent='Preparing encrypted-account data export...';
  try{
    const result=await nihilityApi.secure('backup_export');
    const backup=result?.backup;
    if(!backup)throw new Error('Backup export returned no data.');
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;link.download=backupFilename(backup.exported_at);
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    message.textContent='Backup downloaded. Authentication, invites, integration secrets, security logs, and media file bytes are intentionally excluded.';
  }catch(error){message.textContent=error.message}
  finally{button.disabled=false}
}
function clearBackupPreview(){
  pendingBackupRestore=null;
  const box=$('#backupPreview');
  if(box)box.hidden=true;
  const restore=$('#restoreBackupButton');
  if(restore)restore.disabled=true;
  const phrase=$('#restoreConfirmPhrase');
  if(phrase)phrase.value='';
}
function backupSummaryText(summary){
  return [
    (summary.members||0)+' members',
    (summary.archived_members||0)+' archived',
    (summary.groups||0)+' groups',
    (summary.fronts||0)+' fronts',
    (summary.front_members||0)+' front-member links'
  ].join(' • ');
}
async function previewBackup(){
  const input=$('#restoreBackupFile'),file=input.files?.[0],message=$('#backupMessage');
  clearBackupPreview();
  if(!file){message.textContent='Choose a Nihility backup JSON file first.';return}
  if(file.size>25*1024*1024){message.textContent='Backup files are limited to 25 MB in this version.';return}
  const button=$('#previewBackupButton');button.disabled=true;message.textContent='Validating backup securely...';
  try{
    const preview=await nihilityApi.secureFile('backup_restore_preview',file);
    pendingBackupRestore={file,hash:preview.hash,summary:preview.summary,exportedAt:preview.exported_at};
    $('#backupPreviewSummary').textContent=backupSummaryText(preview.summary||{});
    $('#backupPreviewDate').textContent=preview.exported_at?'Exported '+fmt(preview.exported_at):'Export date unavailable';
    $('#backupPreviewMedia').textContent=preview.media_note||'Private media bytes are not embedded in this backup.';
    $('#backupPreview').hidden=false;
    $('#restoreBackupButton').disabled=false;
    message.textContent='Backup passed validation. Review the restore mode before applying it.';
  }catch(error){message.textContent=error.message}
  finally{button.disabled=false}
}
async function applyBackupRestore(){
  const message=$('#backupMessage');
  if(!pendingBackupRestore){message.textContent='Preview the backup first.';return}
  const mode=$('#backupRestoreMode').value;
  if(mode==='replace'){
    if($('#restoreConfirmPhrase').value.trim()!=='RESTORE'){
      message.textContent='Type RESTORE exactly before replacing current data.';return;
    }
    if(!confirm('Replace your current Nihility members, groups, front history, import history, and app settings with this backup? Authentication and integration credentials are not changed.'))return;
  }else if(!confirm('Merge missing records from this backup into Nihility? Existing records with the same IDs will be kept.'))return;

  const button=$('#restoreBackupButton');button.disabled=true;message.textContent='Restoring backup in a database transaction...';
  try{
    const result=await nihilityApi.secureFile('backup_restore_apply',pendingBackupRestore.file,{mode,previewHash:pendingBackupRestore.hash});
    await loadData();renderAll();
    const counts=result?.result||{};
    message.textContent='Restore complete. '+[
      (counts.members_inserted||0)+' members',
      (counts.groups_inserted||0)+' groups',
      (counts.fronts_inserted||0)+' fronts'
    ].join(', ')+'.';
    $('#restoreBackupFile').value='';clearBackupPreview();
    toast('Backup restored',mode==='replace'?'Current Nihility data was replaced safely.':'Missing backup records were merged.');
  }catch(error){message.textContent=error.message;button.disabled=false}
}

async function verifyNewPassword(password,message){
  if(password.length<12){message.textContent='Use at least 12 characters for your password.';return false}
  if(!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/\d/.test(password)||!/[^A-Za-z0-9]/.test(password)){
    message.textContent='Use lowercase and uppercase letters, a number, and a symbol.';
    return false;
  }
  message.textContent='Checking password safety...';
  const exposure=await nihilityApi.checkPwnedPassword(password);
  if(exposure.pwned){
    message.textContent='Choose a different password. This password appears in known breach data.';
    return false;
  }
  return true;
}
$('#resetPasswordForm').onsubmit=async e=>{e.preventDefault();const m=$('#resetPasswordMessage'),password=$('#resetPasswordInput').value;try{if(!await verifyNewPassword(password,m))return;m.textContent='Saving...';await nihilityApi.setPassword(password);m.textContent='Password saved. Redirecting...';history.replaceState(null,'',location.pathname);setTimeout(()=>location.reload(),600)}catch(error){m.textContent=error.message}};
$('#passwordForm').onsubmit=async e=>{e.preventDefault();const m=$('#passwordMessage'),password=$('#newPasswordInput').value;try{if(!await verifyNewPassword(password,m))return;m.textContent='Saving...';await nihilityApi.setPassword(password);$('#newPasswordInput').value='';m.textContent='Password saved. You can use it the next time you sign in.'}catch(error){m.textContent=error.message}};
async function signOut(){
  const button=$('#signOutButton');
  if(button)button.disabled=true;
  try{await nihilityApi.signOut('local')}
  catch(error){console.warn('Server sign-out failed; local session will still be cleared.',error)}
  finally{nihilityApi.saveSession(null);location.reload()}
}
$('#signOutButton').onclick=signOut;$('#deniedSignOut').onclick=signOut;$('#sidebarProfileButton').onclick=()=>setRoute('profile');
$$('[data-route]').forEach(b=>b.onclick=()=>setRoute(b.dataset.route));$$('[data-route-link]').forEach(b=>b.onclick=()=>setRoute(b.dataset.routeLink));
$('#openFrontManager').onclick=()=>openFront('replace');$('#chooseAnyMemberButton').onclick=()=>openFront('replace');$('#newFrontButton').onclick=()=>openFront('replace');$('#addCoFronterButton').onclick=()=>openFront('add');$('#transferFrontToPkButton').onclick=transferCurrentFrontToPk;$('#switchOutButton').onclick=switchOut;
$('#createMemberButton').onclick=()=>openMember();$('#memberSearch').oninput=()=>renderMembers();$('#memberForm').onsubmit=saveMember;$('#deleteMemberButton').onclick=deleteMember;$('#restoreMemberButton').onclick=restoreMember;$('#permanentDeleteMemberButton').onclick=permanentlyDeleteMember;$('#closeMemberDialog').onclick=$('#cancelMemberButton').onclick=()=>$('#memberDialog').close();$('#memberColorPicker').oninput=e=>$('#memberColor').value=e.target.value.toUpperCase();$('#memberColor').oninput=e=>{const c=hex(e.target.value);if(c)$('#memberColorPicker').value=c};
$('#frontForm').onsubmit=saveFront;$('#closeFrontDialog').onclick=$('#cancelFrontButton').onclick=()=>$('#frontDialog').close();$('#frontMemberSearch').oninput=()=>buildFrontPicker($$('#frontMemberPicker input:checked').map(i=>i.value));$('#customFrontTimeEnabled').onchange=e=>$('#customFrontTimeRow').hidden=!e.target.checked;
$('#connectPkButton').onclick=connectPk;$('#disconnectPkButton').onclick=disconnectPk;$('#importPkButton').onclick=importPk;
$('#exportBackupButton').onclick=exportBackup;$('#previewBackupButton').onclick=previewBackup;$('#restoreBackupButton').onclick=applyBackupRestore;$('#restoreBackupFile').onchange=()=>{clearBackupPreview();$('#backupMessage').textContent='Backup selected. Preview it before restoring.'};$('#backupRestoreMode').onchange=()=>{$('#restoreConfirmWrap').hidden=$('#backupRestoreMode').value!=='replace'};
$('#closePkSyncDialog').onclick=$('#cancelPkSyncButton').onclick=()=>$('#pkSyncDialog').close();$('#applyPkSyncButton').onclick=applyPkSync;
document.querySelectorAll('input[name="themeMode"]').forEach(i=>i.onchange=()=>applyTheme(i.value));
$('#profileForm').onsubmit=saveProfile;
$('#profileBannerUrl').addEventListener('input',()=>{
  // External URLs are copied server-side on save. Do not fetch them directly
  // in the browser, which would disclose the user's IP to the image host.
});$('#inviteForm').onsubmit=invite;
const AUTO_REFRESH_MS=15000;
let autoRefreshBusy=false;
let lastAutoRefreshAt=0;

async function autoRefreshData({force=false}={}){
  if(autoRefreshBusy||!state.user||document.hidden||!navigator.onLine)return;
  if($('#appView')?.hidden)return;
  if(document.querySelector('dialog[open]'))return;
  if(state.route==='settings'||state.route==='profile')return;
  const now=Date.now();
  if(!force&&now-lastAutoRefreshAt<AUTO_REFRESH_MS-500)return;
  autoRefreshBusy=true;
  try{
    await loadData();
    lastAutoRefreshAt=Date.now();
  }catch(error){
    console.warn('Automatic refresh failed',error);
  }finally{
    autoRefreshBusy=false;
  }
}

setInterval(()=>{void autoRefreshData()},AUTO_REFRESH_MS);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void autoRefreshData({force:true})});
window.addEventListener('focus',()=>{if(Date.now()-lastAutoRefreshAt>5000)void autoRefreshData({force:true})});
window.addEventListener('online',()=>void autoRefreshData({force:true}));

setInterval(updateFrontTimers,15000);
boot().then(()=>{lastAutoRefreshAt=Date.now()}).catch(error=>{console.error(error);toast('Unable to start Nihility',error.message,'error')});

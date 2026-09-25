'use strict';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={user:null,profile:null,members:[],fronts:[],frontMembers:[],integration:null,pkConnected:false,pkImported:false,route:'home'};
let frontMutationVersion=0;
let pendingPkSyncComparison=null;
let pendingBackupRestore=null;
let pendingFrontDetails=new Map();
let pendingFrontSelected=new Set();

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
window.nihilityCoreDataReady=false;
function renderHomePending(){
  renderHeader();
  $('#currentFrontHeading').textContent='Loading front...';
  $('#frontDuration').textContent='...';
  $('#currentFrontMembers').replaceChildren();
  const frontWait=document.createElement('p');frontWait.className='muted';frontWait.textContent='Loading current front data...';$('#currentFrontMembers').append(frontWait);
  $('#currentFrontNote').hidden=true;
  $('#addCoFronterButton').disabled=true;
  $('#chooseAnyMemberButton').disabled=true;
  $('#transferFrontToPkButton').hidden=true;
  $('#homeProfileName').textContent=state.profile?.display_name||'Nihility';
  $('#homeIntegrationState').textContent='Loading system data...';
  $('#homeMemberCount').textContent='...';
  $('#homeFrontCount').textContent='...';
  $('#homeShareState').textContent='...';
  $('#frequentMembers').replaceChildren();
  const memberWait=document.createElement('p');memberWait.className='muted';memberWait.textContent='Loading members...';$('#frequentMembers').append(memberWait);
  $('#recentFronts').replaceChildren();
  const historyWait=document.createElement('p');historyWait.className='muted';historyWait.textContent='Loading recent activity...';$('#recentFronts').append(historyWait);
}
function setRoute(route){
  state.route=route;
  const meta={home:['Overview','Home'],members:['System directory','Members'],history:['Front tracking','Front history'],settings:['Connection and privacy','Settings'],profile:['Account','Profile']};
  const pair=meta[route]||meta.home;$('#pageEyebrow').textContent=pair[0];$('#pageTitle').textContent=pair[1];
  $('.route-view').forEach(v=>v.hidden=v.id!==route+'Route');$('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route===route));
  history.replaceState(null,'',route==='home'?location.pathname:(location.pathname+'#'+route));

  // Render only the route the user is actually opening. Building every hidden
  // route at startup is expensive for large systems and should not block Home.
  if(route==='home'){window.nihilityCoreDataReady?(renderHeader(),renderHome()):renderHomePending()}
  else if(route==='members')renderMembers();
  else if(route==='history')renderHistory();
  else if(route==='settings')renderSettings();
  else if(route==='profile')renderProfile();
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
  const initial=Boolean(window.nihilityInitialHydration);

  const core=await Promise.all([
    nihilityApi.rest('members',{query:'select=*&order=name.asc',timeoutMs:12000}),
    nihilityApi.rest('fronts',{query:'select=*&order=started_at.desc&limit=100',timeoutMs:12000}),
    nihilityApi.rest('front_members',{query:'select=*&order=joined_at.desc',timeoutMs:12000})
  ]);

  state.members=core[0]||[];
  if(frontVersion===frontMutationVersion){
    state.fronts=core[1]||[];
    state.frontMembers=core[2]||[];
  }

  // Home no longer waits on integration/import metadata.
  window.nihilityCoreDataReady=true;
  document.dispatchEvent(new CustomEvent('nihility-core-data-ready'));

  const integrationPromise=Promise.all([
    nihilityApi.rest('external_integrations',{query:'provider=eq.pluralkit&select=*',timeoutMs:12000}),
    nihilityApi.rest('imports',{query:'source=eq.pluralkit&select=id&limit=1',timeoutMs:12000})
  ]);

  const applyIntegration=async()=>{
    const data=await integrationPromise;
    state.integration=data[0]?.[0]||null;
    state.pkConnected=Boolean(state.integration);
    state.pkImported=Boolean(data[1]?.length);
    if(initial&&!$('#appView')?.hidden){
      renderHome();
      renderSettings();
    }
  };

  const mediaPromise=hydrateHomeMedia();

  if(initial){
    void applyIntegration().catch(error=>console.warn('Integration metadata is still loading',error));
    void mediaPromise.then(()=>{
      if(window.nihilityInitialHydration||$('#appView')?.hidden)return;
      renderHeader();
      renderHome();
    });
  }else{
    await Promise.all([applyIntegration(),mediaPromise]);
  }
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
function noteHelpEl(note,ariaLabel='Show note'){
  const wrap=document.createElement('span');wrap.className='note-help';
  const button=document.createElement('button');button.type='button';button.className='note-help-button';button.textContent='?';
  button.setAttribute('aria-label',ariaLabel);button.setAttribute('aria-expanded','false');
  const tooltip=document.createElement('span');tooltip.className='note-help-tooltip';tooltip.setAttribute('role','tooltip');tooltip.textContent=note;
  button.onclick=event=>{
    event.stopPropagation();
    const open=!wrap.classList.contains('note-help-open');
    wrap.classList.toggle('note-help-open',open);
    button.setAttribute('aria-expanded',String(open));
  };
  button.onkeydown=event=>event.stopPropagation();
  button.onblur=()=>{
    wrap.classList.remove('note-help-open');
    button.setAttribute('aria-expanded','false');
  };
  wrap.append(button,tooltip);
  return wrap;
}
function renderHome(){
  $('#addCoFronterButton').disabled=false;
  $('#chooseAnyMemberButton').disabled=false;
  const front=activeFront(),members=front?frontMembers(front.id):[];
  const currentNote=$('#currentFrontNote');
  if(currentNote){
    currentNote.replaceChildren();
    currentNote.hidden=!front?.note;
    if(front?.note)currentNote.append(noteHelpEl(front.note,'Show front note'));
  }
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
    const p=document.createElement('p');p.className='muted';p.textContent='Start a front from Quick front or choose a member.';$('#currentFrontMembers').append(p);
  }else{
    $('#currentFrontHeading').textContent=members.length===1?label(members[0]):(members.length+' co-fronters');
    members.forEach(m=>{
      const row=document.createElement('div');row.className='front-person timed-front-person front-person-interactive';
      row.setAttribute('role','button');
      row.tabIndex=0;
      row.setAttribute('aria-label','Open actions for '+label(m));
      row.title='Front actions for '+label(m);
      row.onclick=()=>openFronterActions(m,front);
      row.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openFronterActions(m,front)}};
      row.append(avatarEl(m,'timeline-avatar'));
      const copy=document.createElement('div');copy.className='front-person-copy';
      const nameLine=document.createElement('div');nameLine.className='front-person-name-line';
      const name=document.createElement('strong');name.textContent=label(m);nameLine.append(name);
      const memberNote=frontMemberLink(front.id,m.id)?.note||'';
      if(memberNote)nameLine.append(noteHelpEl(memberNote,'Show note for '+label(m)));
      const pronouns=document.createElement('small');pronouns.textContent=m.pronouns||m.name;

      const start=continuousFrontStart(front,m.id);
      const timing=document.createElement('div');timing.className='front-member-timing';
      const timer=document.createElement('span');timer.className='front-member-timer';
      if(start)timer.dataset.frontTimerStart=String(new Date(start).getTime());
      timer.textContent=start?frontTimerTextFromMs(Date.now()-new Date(start).getTime()):'--';
      const since=document.createElement('span');since.className='front-member-since';since.textContent=frontSinceText(start);
      timing.append(timer,since);

      copy.append(nameLine,pronouns,timing);
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
  const backupPanel=$('#backupPanel');if(backupPanel)backupPanel.hidden=state.profile?.role!=='owner';
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


function backupFilename(extension){
  const now=new Date();
  const stamp=[
    now.getFullYear(),
    String(now.getMonth()+1).padStart(2,'0'),
    String(now.getDate()).padStart(2,'0')
  ].join('-')+'_'+[
    String(now.getHours()).padStart(2,'0'),
    String(now.getMinutes()).padStart(2,'0')
  ].join('-');
  return 'project-nihility-backup_'+stamp+'.'+extension;
}
function formatBytes(value){
  const bytes=Math.max(0,Number(value)||0);
  if(bytes<1024)return bytes+' B';
  if(bytes<1024*1024)return (bytes/1024).toFixed(bytes<10240?1:0)+' KB';
  if(bytes<1024*1024*1024)return (bytes/(1024*1024)).toFixed(bytes<10*1024*1024?1:0)+' MB';
  return (bytes/(1024*1024*1024)).toFixed(2)+' GB';
}
function setBackupExportBusy(busy){
  const json=$('#exportBackupJsonButton'),media=$('#exportBackupMediaButton'),preview=$('#previewRestoreButton');
  if(json)json.disabled=busy;
  if(media)media.disabled=busy;
  if(preview)preview.disabled=busy||!$('#backupFileInput')?.files?.[0];
}
async function exportBackup(includeMedia=false){
  if(state.profile?.role!=='owner')return;
  const message=$('#backupMessage');
  setBackupExportBusy(true);
  message.textContent='Preparing secure backup...';
  try{
    const backup=await nihilityApi.secure('backup_export');
    if(includeMedia){
      const result=await nihilityBackup.createMediaZip(
        backup,
        (kind,path)=>nihilityApi.privateMediaBlob(kind,path),
        progress=>{
          if(progress.phase==='media')message.textContent='Collecting private media... '+Math.min(progress.current+1,progress.total)+' / '+progress.total;
          else if(progress.phase==='packing')message.textContent='Packing backup... '+progress.current+' / '+progress.total;
        }
      );
      nihilityBackup.download(result.blob,backupFilename('zip'));
      message.textContent='ZIP backup created with '+(result.total-result.missing)+' of '+result.total+' private media file'+(result.total===1?'':'s')+'.'+(result.missing?' '+result.missing+' media file'+(result.missing===1?' was':'s were')+' unavailable and marked as omitted.':'');
      toast('Backup created','System data and private media were exported.');
    }else{
      const blob=await nihilityBackup.createJsonBackup(backup);
      nihilityBackup.download(blob,backupFilename('json'));
      message.textContent='JSON backup created. Private media files are not included in this format.';
      toast('Backup created','Portable system data was exported.');
    }
  }catch(error){
    message.textContent=error.message;
  }finally{
    setBackupExportBusy(false);
  }
}
function backupCountLabel(key){
  return ({
    members:'Members',
    groups:'Groups',
    member_groups:'Group memberships',
    fronts:'Front records',
    front_members:'Fronter timing rows',
    imports:'Import records',
    member_field_definitions:'Custom field definitions',
    member_field_values:'Custom field values',
    member_tags:'Member tags',
    member_tag_links:'Tag assignments',
    member_connections:'Member connections',
    system_events:'System timeline events',
    journal_entries:'Encrypted journal entries'
  })[key]||key;
}
function addBackupPreviewRow(container,labelText,currentValue,backupValue){
  const row=document.createElement('div');row.className='backup-preview-row';
  const label=document.createElement('span');label.textContent=labelText;
  const current=document.createElement('span');current.className='backup-preview-current';current.textContent=String(currentValue??0);
  const arrow=document.createElement('span');arrow.className='backup-preview-arrow';arrow.textContent='→';
  const next=document.createElement('strong');next.textContent=String(backupValue??0);
  row.append(label,current,arrow,next);container.append(row);
}
function renderBackupRestorePreview(result,parsed){
  const box=$('#backupRestorePreview');box.replaceChildren();
  const meta=document.createElement('div');meta.className='backup-preview-meta';
  const title=document.createElement('strong');title.textContent='Backup contents';
  const date=document.createElement('span');
  const raw=result?.backup?.exported_at;
  date.textContent=raw&&Number.isFinite(Date.parse(raw))?'Created '+new Date(raw).toLocaleString():'Creation time unavailable';
  meta.append(title,date);box.append(meta);

  const heading=document.createElement('div');heading.className='backup-preview-columns';
  const blank=document.createElement('span');blank.textContent='Data';
  const current=document.createElement('span');current.textContent='Current';
  const next=document.createElement('span');next.textContent='Backup';
  heading.append(blank,current,next);box.append(heading);

  const counts=result?.backup?.counts||{};
  const existing=result?.current||{};
  ['members','groups','member_groups','fronts','front_members','imports','member_field_definitions','member_field_values','member_tags','member_tag_links','member_connections','system_events','journal_entries'].forEach(key=>{
    addBackupPreviewRow(box,backupCountLabel(key),existing[key]||0,counts[key]||0);
  });

  const media=document.createElement('div');media.className='backup-media-summary';
  const mediaStrong=document.createElement('strong');mediaStrong.textContent='Private media';
  const mediaText=document.createElement('span');
  const total=result?.backup?.media?.total||0;
  const included=result?.backup?.media?.included||0;
  mediaText.textContent=parsed?.isZip
    ?included+' of '+total+' media file'+(total===1?'':'s')+' included'
    :'Not included in JSON backup';
  media.append(mediaStrong,mediaText);box.append(media);

  const warnings=(result?.warnings||[]).filter(Boolean);
  if(warnings.length){
    const list=document.createElement('ul');list.className='backup-preview-warnings';
    warnings.forEach(value=>{const item=document.createElement('li');item.textContent=value;list.append(item)});
    box.append(list);
  }
}
async function previewBackupRestore(){
  const file=$('#backupFileInput')?.files?.[0];
  const message=$('#backupMessage');
  if(!file){message.textContent='Choose a backup file first.';return}
  const button=$('#previewRestoreButton');
  button.disabled=true;message.textContent='Reading and validating backup...';
  try{
    const parsed=await nihilityBackup.readBackupFile(file);
    const preview=await nihilityApi.secureBackup('backup_preview',parsed.backup);
    pendingBackupRestore={parsed,preview,file};
    renderBackupRestorePreview(preview,parsed);
    $('#backupRestoreConfirmInput').value='';
    $('#applyBackupRestoreButton').disabled=true;
    $('#backupRestoreMessage').textContent='';
    $('#backupRestoreDialog').showModal();
    message.textContent='Backup validated. Review the replacement preview before restoring.';
  }catch(error){
    pendingBackupRestore=null;
    message.textContent=error.message;
  }finally{
    button.disabled=!file;
  }
}
function closeBackupRestoreDialog(){
  $('#backupRestoreDialog').close();
  $('#backupRestoreConfirmInput').value='';
  $('#applyBackupRestoreButton').disabled=true;
  $('#backupRestoreMessage').textContent='';
}
async function applyBackupRestore(){
  if(!pendingBackupRestore)return;
  const confirmInput=$('#backupRestoreConfirmInput');
  const button=$('#applyBackupRestoreButton');
  const message=$('#backupRestoreMessage');
  if(confirmInput.value!=='RESTORE'){message.textContent='Type RESTORE exactly to continue.';return}

  button.disabled=true;confirmInput.disabled=true;
  const parsed=pendingBackupRestore.parsed;
  const backup=parsed.backup;
  const mediaPaths={};
  const uploaded=[];
  let restoreRequestStarted=false;

  try{
    const media=(Array.isArray(backup.media)?backup.media:[]).filter(item=>item?.included===true);
    for(let i=0;i<media.length;i++){
      const item=media[i];
      message.textContent='Verifying and restoring private media... '+(i+1)+' / '+media.length;
      const blob=await nihilityBackup.verifiedMediaBlob(parsed,item);
      const result=await nihilityApi.upload(item.kind,blob);
      mediaPaths[item.key]=result.path;
      uploaded.push({kind:item.kind,path:result.path});
    }

    message.textContent='Replacing Nihility data in one database transaction...';
    restoreRequestStarted=true;
    const result=await nihilityApi.secureBackup('backup_restore',backup,{confirmation:'RESTORE',mediaPaths});

    pendingBackupRestore=null;
    closeBackupRestoreDialog();
    $('#backupFileInput').value='';
    $('#backupFileSummary').textContent='Choose a Nihility JSON or ZIP backup to inspect it.';
    $('#previewRestoreButton').disabled=true;
    $('#backupMessage').textContent='Restore complete: '+(result.members||0)+' members, '+(result.groups||0)+' groups, and '+(result.fronts||0)+' front records restored.';
    await bootstrapProfile();
    window.nihilitySystemLiveCache={value:null,at:0};
    await loadData();
    setRoute('home');
    toast('Backup restored','Your portable Nihility data has been replaced from the backup.');
  }catch(error){
    message.textContent=error.message;
    if(!restoreRequestStarted&&uploaded.length){
      await Promise.allSettled(uploaded.map(item=>nihilityApi.deleteMedia(item.kind,item.path)));
    }
  }finally{
    confirmInput.disabled=false;
    button.disabled=confirmInput.value!=='RESTORE'||!pendingBackupRestore;
  }
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

function emptyFrontDetail(){
  return{note:'',private_note:'',mood:'',context:'',activity:'',location:''};
}
function detailFromFrontLink(link){
  return{
    note:link?.note||'',
    private_note:link?.private_note||'',
    mood:link?.mood||'',
    context:link?.context||'',
    activity:link?.activity||'',
    location:link?.location||''
  };
}
function currentFrontMemberIdSet(){
  const current=activeFront();
  return new Set(current?frontMembers(current.id).map(m=>m.id):[]);
}
function selectedFrontMemberIds(){
  const selected=[...pendingFrontSelected];
  if(($('input[name="frontMode"]:checked')?.value||'replace')!=='add')return selected;
  const currentIds=currentFrontMemberIdSet();
  return selected.filter(id=>!currentIds.has(id));
}
function effectiveFrontDetailMemberIds(){
  const selected=[...pendingFrontSelected];
  const mode=$('input[name="frontMode"]:checked')?.value||'replace';
  if(mode!=='add')return selected;
  return [...new Set([...currentFrontMemberIdSet(),...selected])];
}
function syncFrontModeDetails(){
  const mode=$('input[name="frontMode"]:checked')?.value||'replace';
  const overallNoteField=$('#frontOverallNoteField');
  if(overallNoteField)overallNoteField.hidden=mode==='add';
  if(mode==='add'){
    const current=activeFront();
    if(current){
      state.frontMembers.filter(x=>x.front_id===current.id).forEach(link=>{
        if(!pendingFrontDetails.has(link.member_id))pendingFrontDetails.set(link.member_id,detailFromFrontLink(link));
      });
      if(!$('#frontOverallNote').value.trim()&&current.note)$('#frontOverallNote').value=current.note;
    }
  }
  renderFrontSelectionSummary();
  renderFrontSelectedDetails();
}
function renderFrontSelectionSummary(){
  const box=$('#frontSelectionSummary');if(!box)return;
  const ids=selectedFrontMemberIds();
  box.replaceChildren();
  box.hidden=!ids.length;
  if(!ids.length)return;

  const heading=document.createElement('div');heading.className='front-selection-heading';
  const title=document.createElement('strong');title.textContent=ids.length+' selected';
  const hint=document.createElement('small');hint.textContent='Selections stay selected while you search.';
  heading.append(title,hint);box.append(heading);

  ids.forEach(id=>{
    const member=state.members.find(m=>m.id===id);if(!member)return;
    if(!pendingFrontDetails.has(id))pendingFrontDetails.set(id,emptyFrontDetail());
    const values=pendingFrontDetails.get(id);

    const item=document.createElement('div');item.className='front-selection-item';
    const who=document.createElement('div');who.className='front-selection-member';
    who.append(avatarEl(member,'picker-avatar'));
    const copy=document.createElement('span');
    const strong=document.createElement('strong');strong.textContent=label(member);
    const small=document.createElement('small');small.textContent=member.pronouns||member.name||'';
    copy.append(strong,small);who.append(copy);

    const noteButton=document.createElement('button');noteButton.type='button';noteButton.className='front-selection-note-button';
    noteButton.textContent=values.note?'Note ✓':'Note';
    noteButton.setAttribute('aria-expanded','false');
    noteButton.setAttribute('aria-label','Add a note for '+label(member));

    const remove=document.createElement('button');remove.type='button';remove.className='front-selection-remove icon-button';
    remove.textContent='×';remove.setAttribute('aria-label','Remove '+label(member));

    const editor=document.createElement('div');editor.className='front-selection-note-editor';editor.hidden=true;
    const noteLabel=document.createElement('label');noteLabel.textContent='Note for '+label(member);
    const textarea=document.createElement('textarea');textarea.rows=2;textarea.maxLength=4000;
    textarea.value=values.note||'';textarea.placeholder='Optional note for this fronter';
    textarea.addEventListener('input',()=>{
      values.note=textarea.value;
      noteButton.textContent=textarea.value.trim()?'Note ✓':'Note';
    });
    noteLabel.append(textarea);editor.append(noteLabel);

    noteButton.onclick=()=>{
      editor.hidden=!editor.hidden;
      noteButton.setAttribute('aria-expanded',String(!editor.hidden));
      item.classList.toggle('note-open',!editor.hidden);
      if(!editor.hidden)requestAnimationFrame(()=>textarea.focus());
    };
    remove.onclick=()=>{
      pendingFrontSelected.delete(id);
      if(!currentFrontMemberIdSet().has(id))pendingFrontDetails.delete(id);
      buildFrontPicker();
      renderFrontSelectionSummary();
      renderFrontSelectedDetails();
    };

    item.append(who,noteButton,remove,editor);box.append(item);
  });
}
function renderFrontSelectedDetails(){
  const box=$('#frontSelectedDetails');if(!box)return;
  box.replaceChildren();
  const ids=effectiveFrontDetailMemberIds();
  if(!ids.length){
    const empty=document.createElement('p');empty.className='muted front-details-empty';empty.textContent='Select a fronter to add optional details.';box.append(empty);return;
  }
  ids.forEach(id=>{
    const member=state.members.find(m=>m.id===id);if(!member)return;
    if(!pendingFrontDetails.has(id))pendingFrontDetails.set(id,emptyFrontDetail());
    const values=pendingFrontDetails.get(id);
    const card=document.createElement('details');card.className='front-detail-card';
    const summary=document.createElement('summary');
    summary.append(avatarEl(member,'picker-avatar'));
    const copy=document.createElement('span');const strong=document.createElement('strong');strong.textContent=label(member);
    const small=document.createElement('small');small.textContent='Mood, activity, context and private details';
    copy.append(strong,small);summary.append(copy);card.append(summary);
    const fields=document.createElement('div');fields.className='front-detail-fields';
    const addField=(title,key,max,textarea=false,placeholder='')=>{
      const lab=document.createElement('label');lab.textContent=title;
      const input=document.createElement(textarea?'textarea':'input');
      if(textarea)input.rows=2;else input.type='text';
      input.maxLength=max;input.value=values[key]||'';input.placeholder=placeholder;
      input.addEventListener('input',()=>{values[key]=input.value});
      lab.append(input);fields.append(lab);
    };
    addField('Mood','mood',200,false,'Optional mood');
    addField('Activity','activity',500,false,'What are they doing?');
    addField('Context','context',1000,true,'Reason, situation, or context');
    addField('Location','location',500,false,'Optional location');
    addField('Private note','private_note',4000,true,'Shown only inside detail editors');
    const hint=document.createElement('p');hint.className='muted front-detail-private-hint';hint.textContent='The fronter note is edited beside the selected member above. Private note and location stay out of compact Home and History views and are never sent to PluralKit. They are still part of your Nihility account data and backups.';
    fields.append(hint);card.append(fields);box.append(card);
  });
}
function buildFrontPicker(selected=[]){
  selected.forEach(id=>pendingFrontSelected.add(id));
  const q=$('#frontMemberSearch').value.trim().toLowerCase(),set=pendingFrontSelected;$('#frontMemberPicker').replaceChildren();
  activeMembers().filter(m=>[m.name,m.display_name].filter(Boolean).some(v=>v.toLowerCase().includes(q))).forEach(m=>{
    const row=document.createElement('label');row.className='picker-row';row.append(avatarEl(m,'picker-avatar'));
    const copy=document.createElement('span');copy.className='picker-copy';const strong=document.createElement('strong');strong.textContent=label(m);
    const small=document.createElement('small');small.textContent=m.pk_id?'PK linked':'Nihility only';copy.append(strong,small);
    const input=document.createElement('input');input.type='checkbox';input.value=m.id;input.checked=set.has(m.id);
    input.onchange=()=>{
      if(input.checked){
        pendingFrontSelected.add(m.id);
        if(!pendingFrontDetails.has(m.id))pendingFrontDetails.set(m.id,emptyFrontDetail());
      }else{
        pendingFrontSelected.delete(m.id);
        if(!currentFrontMemberIdSet().has(m.id))pendingFrontDetails.delete(m.id);
      }
      renderFrontSelectionSummary();
      renderFrontSelectedDetails();
    };
    row.append(copy,input);$('#frontMemberPicker').append(row);
  });
}
function openFront(mode='replace',pre=[]){
  $('input[name="frontMode"][value="'+mode+'"]').checked=true;
  $('#frontMemberSearch').value='';$('#frontError').hidden=true;$('#customFrontTimeEnabled').checked=false;$('#customFrontTimeRow').hidden=true;
  pendingFrontDetails=new Map();
  pendingFrontSelected=new Set(pre);
  const current=activeFront();
  if(mode==='add'&&current){
    state.frontMembers.filter(x=>x.front_id===current.id).forEach(link=>pendingFrontDetails.set(link.member_id,detailFromFrontLink(link)));
    $('#frontOverallNote').value=current.note||'';
  }else{
    $('#frontOverallNote').value='';
  }
  pre.forEach(id=>{if(!pendingFrontDetails.has(id))pendingFrontDetails.set(id,emptyFrontDetail())});
  $('#frontDetailsSection').open=false;
  buildFrontPicker(pre);
  syncFrontModeDetails();
  $('#frontDialog').showModal();
}
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
function applyCommittedFront(frontId,memberDetails,startedAt,note=null){
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
    note:note||null,
    source:'nihility',
    external_id:null,
    created_at:startedAt
  };
  state.fronts=[front,...state.fronts.filter(f=>f.id!==frontId)]
    .sort((a,b)=>new Date(b.started_at)-new Date(a.started_at))
    .slice(0,100);

  const links=memberDetails.map(item=>({
    user_id:state.user?.id||null,
    front_id:frontId,
    member_id:item.member_id,
    joined_at:startedAt,
    left_at:null,
    note:item.note||null,
    private_note:item.private_note||null,
    mood:item.mood||null,
    context:item.context||null,
    activity:item.activity||null,
    location:item.location||null
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
async function logFront(memberDetails,timestamp,note=null){
  const startedAt=timestamp||new Date().toISOString();
  const version=++frontMutationVersion;
  const result=await nihilityApi.rpc('log_front_detailed',{p_member_details:memberDetails,p_started_at:startedAt,p_note:note||null});
  const frontId=typeof result==='string'?result:String(result?.id||'');
  if(frontId)applyCommittedFront(frontId,memberDetails,startedAt,note);
  else void refreshFrontState(version);

  // Nihility is authoritative. Notes and per-fronter details are never sent
  // to PluralKit by the automatic/local front flow.
  void refreshFrontState(version);
}
async function saveFront(e){
  e.preventDefault();const err=$('#frontError');err.hidden=true;
  try{
    const selected=[...pendingFrontSelected];
    const mode=$('input[name="frontMode"]:checked')?.value||'replace';
    if(mode!=='add'&&!selected.length)throw new Error('Select at least one member.');
    let ids=selected;
    if(mode==='add'){
      const current=activeFront();
      const currentIds=new Set(current?frontMembers(current.id).map(m=>m.id):[]);
      const newlyAdded=selected.filter(id=>!currentIds.has(id));
      if(!newlyAdded.length)throw new Error('Select at least one member who is not already fronting.');
      ids=[...new Set([...currentIds,...selected])];
    }
    if(!ids.length)throw new Error('Select at least one member.');
    const details=ids.map(memberId=>{
      const value=pendingFrontDetails.get(memberId)||emptyFrontDetail();
      return{
        member_id:memberId,
        note:value.note.trim()||null,
        private_note:value.private_note.trim()||null,
        mood:value.mood.trim()||null,
        context:value.context.trim()||null,
        activity:value.activity.trim()||null,
        location:value.location.trim()||null
      };
    });
    let ts=null;if($('#customFrontTimeEnabled').checked){const raw=$('#customFrontTime').value;if(!raw)throw new Error('Enter a valid start time.');ts=new Date(raw).toISOString()}
    const note=$('#frontOverallNote').value.trim()||null;
    await logFront(details,ts,note);$('#frontDialog').close();toast('Front updated','Saved to Nihility.');
  }catch(error){err.textContent=error.message;err.hidden=false}
}
function ensureFronterActionDialog(){
  let dialog=$('#fronterActionDialog');
  if(dialog)return dialog;
  dialog=document.createElement('dialog');
  dialog.id='fronterActionDialog';
  dialog.className='modal-dialog fronter-action-dialog';
  dialog.setAttribute('aria-labelledby','fronterActionName');
  dialog.innerHTML=`
    <div class="modal-card fronter-action-card">
      <div class="modal-heading fronter-action-heading">
        <div class="fronter-action-identity">
          <div id="fronterActionAvatar" class="fronter-action-avatar"></div>
          <div>
            <p class="eyebrow">Current fronter</p>
            <h3 id="fronterActionName">Member</h3>
            <p id="fronterActionMeta" class="muted"></p>
          </div>
        </div>
        <button id="closeFronterActionDialog" class="icon-button" type="button" aria-label="Close">×</button>
      </div>
      <div class="fronter-action-list">
        <button id="fronterActionEditMember" class="fronter-action-item" type="button">
          <strong>Edit alter</strong>
          <small>Open this member's profile and details.</small>
        </button>
        <button id="fronterActionEditFront" class="fronter-action-item" type="button">
          <strong>Edit notes, details & time</strong>
          <small>Change this front's timing, notes, and per-fronter details.</small>
        </button>
        <button id="fronterActionSwitchOut" class="fronter-action-item danger-text" type="button">
          <strong>Switch out</strong>
          <small>Remove only this member from the current front.</small>
        </button>
      </div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('#closeFronterActionDialog').onclick=()=>dialog.close();
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});
  return dialog;
}
function openFronterActions(member,front){
  if(!member||!front)return;
  const dialog=ensureFronterActionDialog();
  const avatar=dialog.querySelector('#fronterActionAvatar');
  avatar.replaceChildren(avatarEl(member,'timeline-avatar'));
  dialog.querySelector('#fronterActionName').textContent=label(member);
  dialog.querySelector('#fronterActionMeta').textContent=member.pronouns||member.name||'';
  dialog.querySelector('#fronterActionEditMember').onclick=()=>{
    dialog.close();
    openMember(member);
  };
  dialog.querySelector('#fronterActionEditFront').onclick=()=>{
    dialog.close();
    if(window.nihilityOpenFrontHistoryEditor)window.nihilityOpenFrontHistoryEditor(front.id);
    else toast('Front editor unavailable','Reload the page and try again.','error');
  };
  dialog.querySelector('#fronterActionSwitchOut').onclick=async()=>{
    dialog.close();
    await switchOutMember(member);
  };
  dialog.showModal();
}
function currentFrontMemberDetails(front,member){
  const link=frontMemberLink(front.id,member.id)||{};
  return{
    member_id:member.id,
    note:link.note||null,
    private_note:link.private_note||null,
    mood:link.mood||null,
    context:link.context||null,
    activity:link.activity||null,
    location:link.location||null
  };
}
async function switchOutMember(member){
  const front=activeFront();
  if(!front)return toast('No active front','There is no active front to update.','error');
  const members=frontMembers(front.id);
  if(!members.some(item=>item.id===member.id))return toast('Front already changed',label(member)+' is no longer in the current front.','error');
  if(!confirm('Switch '+label(member)+' out?'))return;
  const remaining=members.filter(item=>item.id!==member.id);
  const details=remaining.map(item=>currentFrontMemberDetails(front,item));
  await logFront(details,null,remaining.length?(front.note||null):null);
  toast('Switched out',label(member)+' is no longer fronting.');
}
async function quickFront(m){if(!confirm('Start a new front with '+label(m)+' fronting?'))return;await logFront([{member_id:m.id}],null,null);toast('Front updated',label(m)+' is now fronting.')}

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
    const mediaConflicts=result.media?.conflicts||0;
    const remaining=(result.comparison?.members?.conflicts?.count||0)+(result.comparison?.groups?.conflicts?.count||0)+(result.comparison?.memberships?.conflicts?.count||0)+mediaConflicts;
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
      media_to_nihility:result.media?.copied||0,
      media_removed:result.media?.removed||0,
      media_failed:result.media?.failed||0,
      media_conflicts:result.media?.conflicts||0,
      conflicts_skipped:result.conflictsSkipped||0,
      blocked:Array.isArray(result.blocked)?result.blocked.length:0
    }},prefer:'return=minimal'});
    pendingPkSyncComparison=null;
    $('#pkSyncDialog').close();
    await loadData();
    const blocked=Array.isArray(result.blocked)?result.blocked.length:0;
    const mediaCopied=result.media?.copied||0,mediaFailed=result.media?.failed||0;
    $('#pkMessage').textContent='Sync complete.'+(mediaCopied?' '+mediaCopied+' PK image'+(mediaCopied===1?' was':'s were')+' copied into private storage.':'')+(remaining?' '+remaining+' conflict'+(remaining===1?'':'s')+' remain unresolved.':'')+(mediaFailed?' '+mediaFailed+' PK image'+(mediaFailed===1?' could':'s could')+' not be copied and will be retried next sync.':'')+(blocked?' '+blocked+' change'+(blocked===1?' was':'s were')+' blocked by PluralKit limits.':'');
    toast('PK sync complete',mediaFailed?'Some PK media could not be copied and will retry later.':remaining?'Some conflicts were left for review.':'Both sides were reconciled.');
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
  window.nihilityInitialHydration=true;
  window.nihilityCoreDataReady=false;

  let coreResolved=false;
  let resolveCore;
  const coreReady=new Promise(resolve=>{resolveCore=()=>{coreResolved=true;resolve()}});
  const onCoreReady=()=>{
    resolveCore();
    if(!$('#appView')?.hidden&&state.route==='home')setRoute('home');
  };
  document.addEventListener('nihility-core-data-ready',onCoreReady,{once:true});

  const fullLoadPromise=Promise.resolve().then(()=>loadData());

  // Never let the full-screen loader monopolize the UI. If Supabase is slow,
  // reveal the app shell and show a local loading state while data continues.
  await Promise.race([
    coreReady,
    new Promise(resolve=>setTimeout(resolve,1800))
  ]);

  setView('app');
  setRoute('home');

  void fullLoadPromise.then(()=>{
    window.nihilityInitialHydration=false;
    lastFullAutoRefreshAt=Date.now();
    if($('#appView')?.hidden)return;

    if(window.nihilityCoreDataReady)setRoute(state.route||'home');

    // Refresh only lightweight controls when the browser has spare time.
    // Hidden member/history/group cards are rendered lazily when opened.
    const finish=()=>{
      if($('#appView')?.hidden)return;
      window.nihilityRefreshFeatureControls?.();
      if(state.route==='timeline')window.nihilitySystemTimeline?.render?.();
      document.dispatchEvent(new CustomEvent('nihility-initial-hydration-complete'));
    };
    if('requestIdleCallback' in window)requestIdleCallback(finish,{timeout:1800});
    else setTimeout(finish,120);
  }).catch(error=>{
    window.nihilityInitialHydration=false;
    console.warn('Background startup hydration did not finish',error);
    if(!$('#appView')?.hidden){
      toast(
        window.nihilityCoreDataReady?'Some background data is still loading':'Nihility data is taking longer than expected',
        window.nihilityCoreDataReady?'The core app is ready. Secondary data will retry automatically.':'The app shell is available while the data service recovers.',
        'error'
      );
    }
  }).finally(()=>{
    if(!coreResolved)document.removeEventListener('nihility-core-data-ready',onCoreReady);
  });
}

$('#loginForm').onsubmit=async e=>{e.preventDefault();const m=$('#loginMessage'),email=$('#emailInput').value.trim(),password=$('#passwordInput').value;if(!password){m.textContent='Enter your password, or use the magic-link button.';return}m.textContent='Signing in...';try{await nihilityApi.signInWithPassword(email,password);location.reload()}catch(error){m.textContent=error.message}};
$('#magicLinkButton').onclick=async()=>{const m=$('#loginMessage'),email=$('#emailInput').value.trim();if(!email){m.textContent='Enter your email first.';return}m.textContent='Sending...';try{await nihilityApi.sendMagicLink(email);m.textContent='Check your email, then open the sign-in link in this browser.'}catch(error){m.textContent=error.message}};
$('#forgotPasswordButton').onclick=async()=>{const m=$('#loginMessage'),email=$('#emailInput').value.trim();if(!email){m.textContent='Enter your email first.';return}m.textContent='Sending password reset...';try{await nihilityApi.sendPasswordReset(email);m.textContent='Check your email, then open the reset link in this browser.'}catch(error){m.textContent=error.message}};
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
$('[data-route]').forEach(b=>b.onclick=()=>setRoute(b.dataset.route));$('[data-route-link]').forEach(b=>b.onclick=()=>setRoute(b.dataset.routeLink));

const mobileNavMoreButton=$('#mobileNavMoreButton');
const mobileNavMoreMenu=$('#mobileNavMoreMenu');
function closeMobileNavMore(){
  if(!mobileNavMoreButton||!mobileNavMoreMenu)return;
  mobileNavMoreMenu.hidden=true;
  mobileNavMoreButton.setAttribute('aria-expanded','false');
}
if(mobileNavMoreButton&&mobileNavMoreMenu){
  mobileNavMoreButton.onclick=event=>{
    event.stopPropagation();
    const opening=mobileNavMoreMenu.hidden;
    mobileNavMoreMenu.hidden=!opening;
    mobileNavMoreButton.setAttribute('aria-expanded',String(opening));
    if(opening)requestAnimationFrame(()=>mobileNavMoreMenu.querySelector('[role="menuitem"]')?.focus());
  };
  mobileNavMoreMenu.addEventListener('click',event=>{
    if(event.target.closest('[data-route]'))closeMobileNavMore();
  });
  mobileNavMoreMenu.addEventListener('keydown',event=>{
    const items=[...mobileNavMoreMenu.querySelectorAll('[role="menuitem"]')];
    const index=items.indexOf(document.activeElement);
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      const next=event.key==='ArrowDown'
        ?(index+1+items.length)%items.length
        :(index-1+items.length)%items.length;
      items[next]?.focus();
    }else if(event.key==='Escape'){
      event.preventDefault();
      closeMobileNavMore();
      mobileNavMoreButton.focus();
    }
  });
  document.addEventListener('click',event=>{
    if(!mobileNavMoreMenu.hidden&&!event.target.closest('.mobile-nav-more'))closeMobileNavMore();
  });
}
$('#chooseAnyMemberButton').onclick=()=>openFront('replace');$('#newFrontButton').onclick=()=>openFront('replace');$('#addCoFronterButton').onclick=()=>openFront('add');$('#transferFrontToPkButton').onclick=transferCurrentFrontToPk;
$('#createMemberButton').onclick=()=>openMember();$('#memberSearch').oninput=()=>renderMembers();$('#memberForm').onsubmit=saveMember;$('#deleteMemberButton').onclick=deleteMember;$('#restoreMemberButton').onclick=restoreMember;$('#permanentDeleteMemberButton').onclick=permanentlyDeleteMember;$('#closeMemberDialog').onclick=$('#cancelMemberButton').onclick=()=>$('#memberDialog').close();$('#memberColorPicker').oninput=e=>$('#memberColor').value=e.target.value.toUpperCase();$('#memberColor').oninput=e=>{const c=hex(e.target.value);if(c)$('#memberColorPicker').value=c};
$('#frontForm').onsubmit=saveFront;$('#closeFrontDialog').onclick=$('#cancelFrontButton').onclick=()=>$('#frontDialog').close();$('#frontMemberSearch').oninput=()=>buildFrontPicker();document.querySelectorAll('input[name="frontMode"]').forEach(i=>i.addEventListener('change',syncFrontModeDetails));$('#customFrontTimeEnabled').onchange=e=>$('#customFrontTimeRow').hidden=!e.target.checked;
$('#connectPkButton').onclick=connectPk;$('#disconnectPkButton').onclick=disconnectPk;$('#importPkButton').onclick=importPk;
$('#closePkSyncDialog').onclick=$('#cancelPkSyncButton').onclick=()=>$('#pkSyncDialog').close();$('#applyPkSyncButton').onclick=applyPkSync;
document.querySelectorAll('input[name="themeMode"]').forEach(i=>i.onchange=()=>applyTheme(i.value));
$('#profileForm').onsubmit=saveProfile;
$('#exportBackupJsonButton').onclick=()=>exportBackup(false);
$('#exportBackupMediaButton').onclick=()=>exportBackup(true);
$('#backupFileInput').onchange=event=>{
  pendingBackupRestore=null;
  const file=event.target.files?.[0]||null;
  $('#backupFileSummary').textContent=file?(file.name+' · '+formatBytes(file.size)):'Choose a Nihility JSON or ZIP backup to inspect it.';
  $('#previewRestoreButton').disabled=!file;
  $('#backupMessage').textContent='';
};
$('#previewRestoreButton').onclick=previewBackupRestore;
$('#closeBackupRestoreDialog').onclick=$('#cancelBackupRestoreButton').onclick=closeBackupRestoreDialog;
$('#backupRestoreConfirmInput').oninput=event=>{
  $('#applyBackupRestoreButton').disabled=event.target.value!=='RESTORE'||!pendingBackupRestore;
};
$('#applyBackupRestoreButton').onclick=applyBackupRestore;
$('#profileBannerUrl').addEventListener('input',()=>{
  // External URLs are previewed only through the secure media importer.
});
document.addEventListener('nihility-media-preview',event=>{
  const key=event.detail?.key||'';
  const url=event.detail?.url||'';
  if(key==='profile-avatar'){
    const box=$('#profileAvatarPreview');
    if(box){
      box.replaceChildren();
      if(url){
        const img=document.createElement('img');img.src=url;img.alt='';box.append(img);
      }else{
        const name=state.profile?.display_name||state.user?.email||'Account';
        if(state.profile?.avatar_storage_path&&state.profile?.avatar_url){
          const img=document.createElement('img');img.src=state.profile.avatar_url;img.alt='';box.append(img);
        }else box.textContent=initial(name);
      }
    }
  }
  if(key==='profile-banner'){
    const banner=$('#profileBannerPreview');
    if(banner){
      const shown=url||(state.profile?.banner_storage_path?state.profile?.banner_url||'':'');
      banner.style.backgroundImage=shown?'linear-gradient(rgba(10,11,20,.08),rgba(10,11,20,.18)), url("'+shown.replaceAll('"','%22')+'")':'';
      banner.classList.toggle('has-profile-banner',Boolean(shown));
    }
  }
});
$('#inviteForm').onsubmit=invite;
const AUTO_REFRESH_MS=15000;
const FULL_AUTO_REFRESH_MS=90000;
let autoRefreshBusy=false;
let lastAutoRefreshAt=0;
let lastFullAutoRefreshAt=0;

function autoRefreshFingerprint(){
  const rows=(list,keys)=>(list||[]).map(row=>keys.map(key=>row?.[key]??null));
  const system=state.systemProfile
    ?Object.fromEntries(Object.entries(state.systemProfile).filter(([key])=>!['avatar_display_url','banner_display_url'].includes(key)))
    :null;
  return JSON.stringify({
    members:rows(state.members,['id','updated_at','name','display_name','pronouns','color','description','birthday','archived_at','avatar_storage_path','banner_storage_path','metadata']),
    fronts:rows(state.fronts,['id','updated_at','started_at','ended_at','note','source']),
    frontMembers:rows(state.frontMembers,['id','updated_at','front_id','member_id','joined_at','left_at','note','private_note','mood','context','activity','location']),
    groups:rows(state.groups,['id','updated_at','name','display_name','color','description','icon_storage_path','metadata']),
    memberGroups:rows(state.memberGroups,['id','member_id','group_id','created_at']),
    fieldDefinitions:rows(state.memberFieldDefinitions,['id','updated_at','key','label','field_type','position','description','options']),
    fieldValues:rows(state.memberFieldValues,['id','updated_at','member_id','field_id','value']),
    tags:rows(state.memberTags,['id','updated_at','name','color']),
    tagLinks:rows(state.memberTagLinks,['id','member_id','tag_id','created_at']),
    connections:rows(state.memberConnections,['id','updated_at','source_member_id','target_member_id','source_label','target_label']),
    timeline:rows(state.timelineEvents,['id','updated_at','event_type','occurred_at','member_id','related_member_id','group_id','front_id','metadata']),
    integration:state.integration?[state.integration.id,state.integration.updated_at,state.integration.external_system_id,state.integration.external_system_name]:null,
    pkConnected:Boolean(state.pkConnected),
    pkImported:Boolean(state.pkImported),
    system
  });
}
function liveFrontFingerprint(){
  const rows=(list,keys)=>(list||[]).map(row=>keys.map(key=>row?.[key]??null));
  return JSON.stringify({
    fronts:rows(state.fronts,['id','updated_at','started_at','ended_at','note','source']),
    frontMembers:rows(state.frontMembers,['id','updated_at','front_id','member_id','joined_at','left_at','note','private_note','mood','context','activity','location'])
  });
}
async function refreshLiveFrontData(){
  const frontVersion=frontMutationVersion;
  const [fronts,links]=await Promise.all([
    nihilityApi.rest('fronts',{query:'select=*&order=started_at.desc&limit=100',timeoutMs:12000}),
    nihilityApi.rest('front_members',{query:'select=*&order=joined_at.desc',timeoutMs:12000})
  ]);
  if(frontVersion===frontMutationVersion){
    state.fronts=fronts||[];
    state.frontMembers=links||[];
  }
}

async function autoRefreshData({force=false,full=false}={}){
  if(autoRefreshBusy||!state.user||document.hidden||!navigator.onLine)return;
  if($('#appView')?.hidden)return;
  if(document.querySelector('dialog[open]'))return;
  if(state.route==='settings'||state.route==='profile'||state.route==='journal')return;
  const now=Date.now();
  if(!force&&now-lastAutoRefreshAt<AUTO_REFRESH_MS-500)return;

  const routeNeedsDirectory=['members','groups','timeline'].includes(state.route);
  const fullDue=now-lastFullAutoRefreshAt>=(routeNeedsDirectory?45000:FULL_AUTO_REFRESH_MS);
  const doFull=Boolean(full||fullDue);
  const before=doFull?autoRefreshFingerprint():liveFrontFingerprint();

  autoRefreshBusy=true;
  let refreshed=false;
  if(doFull)window.nihilitySilentRefresh=true;
  try{
    if(doFull){
      await loadData();
      lastFullAutoRefreshAt=Date.now();
    }else{
      await refreshLiveFrontData();
    }
    refreshed=true;
    lastAutoRefreshAt=Date.now();
  }catch(error){
    console.warn('Automatic refresh failed',error);
  }finally{
    if(doFull)window.nihilitySilentRefresh=false;
    autoRefreshBusy=false;
  }

  const after=doFull?autoRefreshFingerprint():liveFrontFingerprint();
  if(refreshed&&before!==after){
    requestAnimationFrame(()=>{
      if(document.hidden||document.querySelector('dialog[open]'))return;
      setRoute(state.route||'home');
      document.dispatchEvent(new CustomEvent('nihility-silent-refresh-applied'));
    });
  }
}

setInterval(()=>{void autoRefreshData()},AUTO_REFRESH_MS);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void autoRefreshData({force:true})});
window.addEventListener('focus',()=>{if(Date.now()-lastAutoRefreshAt>5000)void autoRefreshData({force:true})});
window.addEventListener('online',()=>void autoRefreshData({force:true,full:true}));

setInterval(updateFrontTimers,15000);
boot().then(()=>{lastAutoRefreshAt=Date.now()}).catch(error=>{console.error(error);setView('app');setRoute('home');toast('Unable to start Nihility',error.message,'error')});

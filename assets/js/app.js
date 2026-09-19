'use strict';

const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={user:null,profile:null,members:[],fronts:[],frontMembers:[],integration:null,pkConnected:false,route:'home'};

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
function avatarEl(item,cls='member-card-avatar'){if(item?.avatar_url){const img=document.createElement('img');img.className=cls;img.src=item.avatar_url;img.alt='';return img}const d=document.createElement('div');d.className=cls+' fallback-avatar';d.textContent=initial(label(item));return d}

function setView(name){$('#setupView').hidden=name!=='setup';$('#loginView').hidden=name!=='login';$('#deniedView').hidden=name!=='denied';$('#appView').hidden=name!=='app'}
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

async function bootstrapProfile(){
  const rows=await nihilityApi.rest('profiles',{query:'select=*&user_id=eq.'+state.user.id+'&limit=1'});
  state.profile=rows?.[0]||null;
  return Boolean(state.profile);
}
async function loadData(){
  const data=await Promise.all([
    nihilityApi.rest('members',{query:'select=*&order=name.asc'}),
    nihilityApi.rest('fronts',{query:'select=*&order=started_at.desc&limit=100'}),
    nihilityApi.rest('front_members',{query:'select=*&order=joined_at.desc'}),
    nihilityApi.rest('external_integrations',{query:'provider=eq.pluralkit&select=*'}),
    nihilityApi.secure('pk_status').catch(()=>({connected:false}))
  ]);
  state.members=data[0]||[];state.fronts=data[1]||[];state.frontMembers=data[2]||[];state.integration=data[3]?.[0]||null;state.pkConnected=Boolean(data[4]?.connected);
  await Promise.all(state.members.map(async m=>{
    if(m.avatar_storage_path)m.avatar_url=await nihilityApi.privateMediaUrl('avatar',m.avatar_storage_path);
    if(m.banner_storage_path)m.banner_url=await nihilityApi.privateMediaUrl('banner',m.banner_storage_path);
  }));
  if(state.profile?.avatar_storage_path)state.profile.avatar_url=await nihilityApi.privateMediaUrl('profile',state.profile.avatar_storage_path);
  renderAll();
}
function renderAll(){renderHeader();renderHome();renderMembers();renderHistory();renderSettings();renderProfile()}
function renderHeader(){
  const name=state.profile?.display_name||state.user?.email||'Account';
  $('#sidebarName').textContent=name;$('#sidebarRole').textContent=state.profile?.role||'member';
  ['#sidebarAvatar','#homeProfileAvatar','#profileAvatarPreview'].forEach(sel=>{
    const box=$(sel);box.replaceChildren();
    if(state.profile?.avatar_url){const img=document.createElement('img');img.src=state.profile.avatar_url;img.alt='';box.append(img)}
    else box.textContent=initial(name);
  });
}
function renderHome(){
  const front=activeFront(),members=front?frontMembers(front.id):[];
  $('#currentFrontMembers').replaceChildren();
  if(!front||!members.length){
    $('#currentFrontHeading').textContent='Nobody is fronting';$('#frontDuration').textContent='--';
    const p=document.createElement('p');p.className='muted';p.textContent='Start a front from Quick front or Manage front.';$('#currentFrontMembers').append(p);
  }else{
    $('#currentFrontHeading').textContent=members.length===1?label(members[0]):(members.length+' co-fronters');$('#frontDuration').textContent=duration(front.started_at);
    members.forEach(m=>{const row=document.createElement('div');row.className='front-person';row.append(avatarEl(m,'timeline-avatar'));const copy=document.createElement('div');copy.className='front-person-copy';const s=document.createElement('strong');s.textContent=label(m);const sm=document.createElement('small');sm.textContent=m.pronouns||m.name;copy.append(s,sm);row.append(copy);$('#currentFrontMembers').append(row)});
  }
  $('#homeProfileName').textContent=state.profile?.display_name||state.user?.email||'Account';
  $('#homeIntegrationState').textContent=(state.integration&&state.pkConnected)?'PluralKit connected':'Independent storage';
  $('#homeMemberCount').textContent=String(activeMembers().length);$('#homeFrontCount').textContent=String(state.fronts.length);$('#homeShareState').textContent=(state.integration?.share_fronting_updates&&state.pkConnected)?'On':'Off';

  const counts=new Map();state.frontMembers.forEach(x=>counts.set(x.member_id,(counts.get(x.member_id)||0)+1));
  const frequent=[...activeMembers()].sort((a,b)=>(counts.get(b.id)||0)-(counts.get(a.id)||0)).slice(0,8);
  $('#frequentMembers').replaceChildren();
  frequent.forEach(m=>{const b=document.createElement('button');b.className='member-chip';b.append(avatarEl(m,'timeline-avatar'));const c=document.createElement('div');c.className='member-chip-copy';const s=document.createElement('strong');s.textContent=label(m);const sm=document.createElement('small');sm.textContent=(counts.get(m.id)||0)+' fronts';c.append(s,sm);b.append(c);b.onclick=()=>quickFront(m);$('#frequentMembers').append(b)});

  $('#recentFronts').replaceChildren();
  state.fronts.slice(0,6).forEach(f=>{const ms=frontMembers(f.id),row=document.createElement('div');row.className='timeline-row';row.append(ms[0]?avatarEl(ms[0],'timeline-avatar'):avatarEl({name:'Out'},'timeline-avatar'));const c=document.createElement('div');c.className='timeline-copy';const s=document.createElement('strong');s.textContent=ms.length?ms.map(label).join(', '):'Switch out';const sm=document.createElement('small');sm.textContent=fmt(f.started_at);c.append(s,sm);const t=document.createElement('span');t.className='timeline-time';t.textContent=relative(f.started_at);row.append(c,t);$('#recentFronts').append(row)});
}
function renderMembers(){
  const q=$('#memberSearch').value.trim().toLowerCase();
  const list=activeMembers().filter(m=>[m.name,m.display_name,m.pronouns].filter(Boolean).some(v=>v.toLowerCase().includes(q)));
  $('#memberGrid').replaceChildren();$('#membersEmpty').hidden=list.length>0;
  list.forEach(m=>{const card=document.createElement('button');card.className='member-card';const top=document.createElement('div');top.className='member-card-top';top.append(avatarEl(m));const copy=document.createElement('div');copy.className='member-card-name';const h=document.createElement('h3');h.textContent=label(m);const p=document.createElement('p');p.textContent=m.pronouns||m.name;copy.append(h,p);top.append(copy);card.append(top);if(m.description){const d=document.createElement('p');d.className='member-card-desc';d.textContent=m.description;card.append(d)}const bar=document.createElement('span');bar.className='member-color-bar';bar.style.background=m.color?'#'+m.color:'var(--accent)';card.append(bar);card.onclick=()=>openMember(m);$('#memberGrid').append(card)});
}
function renderHistory(){
  $('#historyList').replaceChildren();
  if(!state.fronts.length){const p=document.createElement('p');p.className='muted';p.textContent='No front history yet.';$('#historyList').append(p);return}
  state.fronts.forEach(f=>{const row=document.createElement('div');row.className='history-row';const date=document.createElement('div');date.className='history-date';date.textContent=fmt(f.started_at);const members=document.createElement('div');members.className='history-members';const ms=frontMembers(f.id);if(!ms.length){const pill=document.createElement('span');pill.className='mini-member-pill';pill.textContent='Switch out';members.append(pill)}else ms.forEach(m=>{const pill=document.createElement('span');pill.className='mini-member-pill';pill.textContent=label(m);members.append(pill)});row.append(date,members);$('#historyList').append(row)});
}
function renderSettings(){
  const connected=Boolean(state.integration&&state.pkConnected);$('#pkDisconnected').hidden=connected;$('#pkConnected').hidden=!connected;
  if(state.integration){$('#pkSystemName').textContent=state.integration.external_system_name||'PluralKit system';$('#pkSystemId').textContent=state.integration.external_system_id||'...';$('#shareFrontingToggle').checked=state.integration.share_fronting_updates!==false}
}
function renderProfile(){
  if(!state.profile)return;
  $('#profileHeading').textContent=state.profile.display_name||state.user.email;$('#profileEmail').textContent=state.user.email||'';$('#profileDisplayName').value=state.profile.display_name||'';$('#profileAvatarUrl').value=state.profile.avatar_storage_path?'':(state.profile.avatar_url||'');$('#profileRole').textContent=state.profile.role==='owner'?'Owner':'Member';$('#invitePanel').hidden=state.profile.role!=='owner';renderHeader();
}

function resetMemberForm(){$('#memberForm').reset();$('#memberId').value='';$('#memberColorPicker').value='#8b7cf6';$('#memberError').hidden=true;$('#deleteMemberButton').hidden=true}
function openMember(m=null){
  resetMemberForm();$('#memberDialogTitle').textContent=m?'Edit member':'New member';
  if(m){$('#memberId').value=m.id;$('#memberName').value=m.name||'';$('#memberDisplayName').value=m.display_name||'';$('#memberPronouns').value=m.pronouns||'';$('#memberDescription').value=m.description||'';$('#memberAvatarUrl').value=m.avatar_source==='external'?(m.avatar_url||''):'';$('#memberBannerUrl').value=m.banner_source==='external'?(m.banner_url||''):'';const c=hex(m.color);$('#memberColor').value=c;if(c)$('#memberColorPicker').value=c;$('#deleteMemberButton').hidden=false}
  $('#memberDialog').showModal();
}
async function maybeUpload(kind,input){
  const file=input.files?.[0];if(!file)return null;const max=kind==='banner'?5*1024*1024:2*1024*1024;
  if(file.size>max)throw new Error((kind==='banner'?'Banner':'Image')+' exceeds the upload limit.');
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw new Error('Unsupported image format.');
  return nihilityApi.upload(kind,file);
}
async function safeDelete(kind,path){if(!path)return;try{await nihilityApi.deleteMedia(kind,path)}catch(error){console.warn(error)}}

async function saveMember(e){
  e.preventDefault();const err=$('#memberError');err.hidden=true;let au=null,bu=null;
  try{
    const id=$('#memberId').value,old=id?state.members.find(m=>m.id===id):null;
    au=await maybeUpload('avatar',$('#memberAvatarFile'));bu=await maybeUpload('banner',$('#memberBannerFile'));
    const ae=$('#memberAvatarUrl').value.trim(),be=$('#memberBannerUrl').value.trim(),c=hex($('#memberColor').value);
    const body={user_id:state.user.id,name:$('#memberName').value.trim(),display_name:$('#memberDisplayName').value.trim()||null,pronouns:$('#memberPronouns').value.trim()||null,color:c?c.slice(1).toLowerCase():null,description:$('#memberDescription').value.trim()||null,avatar_url:ae||(au?null:old?.avatar_url||null),avatar_source:au?'supabase':(ae?'external':old?.avatar_source||null),avatar_storage_path:au?.path||(ae?null:old?.avatar_storage_path||null),banner_url:be||(bu?null:old?.banner_url||null),banner_source:bu?'supabase':(be?'external':old?.banner_source||null),banner_storage_path:bu?.path||(be?null:old?.banner_storage_path||null),pk_id:old?.pk_id||null,tupper_id:old?.tupper_id||null,archived_at:null};
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
  toast('Member archived','Historical front records were preserved.');
  await loadData();
}

function buildFrontPicker(selected=[]){
  const q=$('#frontMemberSearch').value.trim().toLowerCase(),set=new Set(selected);$('#frontMemberPicker').replaceChildren();
  activeMembers().filter(m=>[m.name,m.display_name].filter(Boolean).some(v=>v.toLowerCase().includes(q))).forEach(m=>{const row=document.createElement('label');row.className='picker-row';row.append(avatarEl(m,'picker-avatar'));const c=document.createElement('span');c.className='picker-copy';const s=document.createElement('strong');s.textContent=label(m);const sm=document.createElement('small');sm.textContent=m.pk_id?'PK linked':'Nihility only';c.append(s,sm);const input=document.createElement('input');input.type='checkbox';input.value=m.id;input.checked=set.has(m.id);row.append(c,input);$('#frontMemberPicker').append(row)});
}
function openFront(mode='replace',pre=[]){$('input[name="frontMode"][value="'+mode+'"]').checked=true;$('#frontMemberSearch').value='';$('#frontError').hidden=true;$('#customFrontTimeEnabled').checked=false;$('#customFrontTimeRow').hidden=true;buildFrontPicker(pre);$('#frontDialog').showModal()}
async function mirrorFrontToPk(memberIds,timestamp){
  if(!state.integration?.share_fronting_updates||!state.pkConnected)return{shared:false};
  const chosen=memberIds.map(id=>state.members.find(m=>m.id===id)).filter(Boolean);
  if(chosen.some(m=>!m.pk_id))return{shared:false,reason:'Some selected members are not linked to PluralKit.'};
  return nihilityApi.secure('pk_mirror_front',{memberIds,timestamp});
}
async function logFront(memberIds,timestamp){
  await nihilityApi.rpc('log_front',{p_member_ids:memberIds,p_started_at:timestamp||new Date().toISOString(),p_note:null});
  try{const shared=await mirrorFrontToPk(memberIds,timestamp);if(shared.reason)toast('Front saved locally',shared.reason)}catch(error){toast('Front saved locally','PluralKit sharing failed: '+error.message,'error')}
  await loadData();
}
async function saveFront(e){
  e.preventDefault();const err=$('#frontError');err.hidden=true;
  try{
    const selected=$$('#frontMemberPicker input:checked').map(i=>i.value);if(!selected.length)throw new Error('Select at least one member.');
    const mode=$('input[name="frontMode"]:checked')?.value||'replace';let ids=selected;
    if(mode==='add'){const current=activeFront();ids=[...new Set([...(current?frontMembers(current.id).map(m=>m.id):[]),...selected])]}
    let ts=null;if($('#customFrontTimeEnabled').checked){const raw=$('#customFrontTime').value;if(!raw)throw new Error('Enter a valid start time.');ts=new Date(raw).toISOString()}
    await logFront(ids,ts);$('#frontDialog').close();toast('Front updated',state.integration?.share_fronting_updates?'Nihility saved first. External sharing was attempted.':'Saved only to Nihility.');
  }catch(error){err.textContent=error.message;err.hidden=false}
}
async function quickFront(m){if(confirm('Start a new front with '+label(m)+'?')){await logFront([m.id],null);toast('Front updated')}}
async function switchOut(){if(!confirm('Switch out with nobody fronting?'))return;await logFront([],null);toast('Switched out')}

async function connectPk(){
  const message=$('#pkMessage');message.textContent='Connecting...';
  try{
    const token=$('#pkTokenInput').value.trim();if(!token)throw new Error('Enter a PluralKit token.');
    nihilityApi.savePkToken(token,$('#rememberPkToken').checked);
    const system=await nihilityApi.pk('/systems/@me');
    const body={user_id:state.user.id,provider:'pluralkit',external_system_id:system.id||null,external_system_name:system.name||system.id||'PluralKit system',share_fronting_updates:true,connected_at:new Date().toISOString()};
    await nihilityApi.rest('external_integrations',{method:'POST',query:'on_conflict=user_id,provider',body,prefer:'resolution=merge-duplicates,return=minimal'});
    message.textContent='Connected. Front sharing is on by default.';await loadData();
  }catch(error){nihilityApi.clearPkToken();message.textContent=error.message}
}
async function disconnectPk(){
  nihilityApi.clearPkToken();
  $('#pkTokenInput').value='';
  if(state.integration){
    await nihilityApi.rest('external_integrations',{method:'PATCH',query:'provider=eq.pluralkit',body:{share_fronting_updates:false},prefer:'return=minimal'});
    state.integration.share_fronting_updates=false;
  }
  $('#pkMessage').textContent='PluralKit disconnected on this device.';
  renderSettings();
  renderHome();
}
async function toggleShare(){if(!state.integration)return;const value=$('#shareFrontingToggle').checked;await nihilityApi.rest('external_integrations',{method:'PATCH',query:'provider=eq.pluralkit',body:{share_fronting_updates:value},prefer:'return=minimal'});state.integration.share_fronting_updates=value;renderHome();toast('Front sharing '+(value?'enabled':'disabled'))}
async function importPk(){
  const message=$('#pkMessage');message.textContent='Importing members...';
  try{
    const members=await nihilityApi.pk('/systems/@me/members');
    const existingPk=new Set(state.members.map(m=>m.pk_id).filter(Boolean));
    const rows=(members||[]).filter(m=>!existingPk.has(m.id)).map(m=>({user_id:state.user.id,name:m.name||m.display_name||m.id,display_name:m.display_name||null,pronouns:m.pronouns||null,color:m.color||null,description:m.description||null,birthday:m.birthday||null,avatar_url:m.avatar_url||null,avatar_source:m.avatar_url?'external':null,banner_url:m.banner||null,banner_source:m.banner?'external':null,pk_id:m.id,metadata:{pk_uuid:m.uuid||null},archived_at:null}));
    if(rows.length)await nihilityApi.rest('members',{method:'POST',body:rows,prefer:'return=minimal'});
    await nihilityApi.rest('imports',{method:'POST',body:{user_id:state.user.id,source:'pluralkit',summary:{members_added:rows.length,members_skipped:(members||[]).length-rows.length}},prefer:'return=minimal'});
    message.textContent='Imported '+rows.length+' new members. Existing Nihility copies were left unchanged.';await loadData();
  }catch(error){message.textContent=error.message}
}

async function saveProfile(e){
  e.preventDefault();const msg=$('#profileMessage');msg.textContent='Saving...';let upload=null;
  try{
    const old=state.profile,external=$('#profileAvatarUrl').value.trim();upload=await maybeUpload('profile',$('#profileAvatarFile'));
    const body={display_name:$('#profileDisplayName').value.trim()||null,avatar_url:external||(upload?null:old.avatar_url||null),avatar_storage_path:upload?.path||(external?null:old.avatar_storage_path||null)};
    await nihilityApi.rest('profiles',{method:'PATCH',query:'user_id=eq.'+state.user.id,body,prefer:'return=minimal'});
    if(old.avatar_storage_path&&old.avatar_storage_path!==body.avatar_storage_path)await safeDelete('profile',old.avatar_storage_path);
    state.profile={...state.profile,...body};if(state.profile.avatar_storage_path)state.profile.avatar_url=await nihilityApi.privateMediaUrl('profile',state.profile.avatar_storage_path);msg.textContent='Profile saved.';renderProfile();
  }catch(error){if(upload?.path)await safeDelete('profile',upload.path);msg.textContent=error.message}
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
  if(!nihilityApi.configured()){setView('setup');return}
  nihilityApi.readSessionFromUrl();state.user=await nihilityApi.user();if(!state.user){setView('login');return}
  if(!await bootstrapProfile()){setView('denied');return}
  setView('app');await loadData();const requested=(location.hash||'#home').slice(1);setRoute(['home','members','history','settings','profile'].includes(requested)?requested:'home');
}

$('#loginForm').onsubmit=async e=>{e.preventDefault();const m=$('#loginMessage');m.textContent='Sending...';try{await nihilityApi.sendMagicLink($('#emailInput').value.trim());m.textContent='Check your email for the sign-in link.'}catch(error){m.textContent=error.message}};
function signOut(){nihilityApi.saveSession(null);location.reload()}
$('#signOutButton').onclick=signOut;$('#deniedSignOut').onclick=signOut;$('#sidebarProfileButton').onclick=()=>setRoute('profile');
$$('[data-route]').forEach(b=>b.onclick=()=>setRoute(b.dataset.route));$$('[data-route-link]').forEach(b=>b.onclick=()=>setRoute(b.dataset.routeLink));
$('#refreshButton').onclick=loadData;$('#openFrontManager').onclick=()=>openFront('replace');$('#chooseAnyMemberButton').onclick=()=>openFront('replace');$('#newFrontButton').onclick=()=>openFront('replace');$('#addCoFronterButton').onclick=()=>openFront('add');$('#switchOutButton').onclick=switchOut;
$('#createMemberButton').onclick=()=>openMember();$('#memberSearch').oninput=renderMembers;$('#memberForm').onsubmit=saveMember;$('#deleteMemberButton').onclick=deleteMember;$('#closeMemberDialog').onclick=$('#cancelMemberButton').onclick=()=>$('#memberDialog').close();$('#memberColorPicker').oninput=e=>$('#memberColor').value=e.target.value.toUpperCase();$('#memberColor').oninput=e=>{const c=hex(e.target.value);if(c)$('#memberColorPicker').value=c};
$('#frontForm').onsubmit=saveFront;$('#closeFrontDialog').onclick=$('#cancelFrontButton').onclick=()=>$('#frontDialog').close();$('#frontMemberSearch').oninput=()=>buildFrontPicker($$('#frontMemberPicker input:checked').map(i=>i.value));$('#customFrontTimeEnabled').onchange=e=>$('#customFrontTimeRow').hidden=!e.target.checked;
$('#connectPkButton').onclick=connectPk;$('#disconnectPkButton').onclick=disconnectPk;$('#shareFrontingToggle').onchange=toggleShare;$('#importPkButton').onclick=importPk;
$('#profileForm').onsubmit=saveProfile;$('#inviteForm').onsubmit=invite;
setInterval(()=>{const f=activeFront();if(f)$('#frontDuration').textContent=duration(f.started_at)},60000);
boot().catch(error=>{console.error(error);toast('Unable to start Nihility',error.message,'error')});

'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const state={user:null,members:[]};
function toast(message){const n=document.createElement('div');n.className='toast';n.textContent=message;$('#toastRegion').append(n);setTimeout(()=>n.remove(),3200)}
function hex(v){const c=String(v||'').trim().replace(/^#/,'');return /^[0-9a-f]{6}$/i.test(c)?'#'+c.toUpperCase():''}
function view(v){$('#setupView').hidden=v!=='setup';$('#loginView').hidden=v!=='login';$('#appView').hidden=v!=='app'}
function route(r){$$('.route-view').forEach(v=>v.hidden=v.id!==r+'Route');$$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.route===r));$('#pageTitle').textContent=r==='members'?'Members':'Settings';$('#newMemberButton').hidden=r!=='members'}
async function load(){state.members=await nihilityApi.rest('members',{query:'select=*&order=name.asc'});render()}
function render(){
  const q=$('#memberSearch').value.trim().toLowerCase();
  const list=state.members.filter(m=>[m.name,m.display_name,m.pronouns].filter(Boolean).some(v=>v.toLowerCase().includes(q)));
  $('#memberGrid').replaceChildren();$('#memberCount').textContent=state.members.length+' '+(state.members.length===1?'member':'members');$('#memberEmpty').hidden=list.length>0;
  for(const m of list){
    const card=document.createElement('article');card.className='member-card';card.style.setProperty('--member-color',m.color?'#'+m.color:'var(--accent)');
    if(m.avatar_url){const img=document.createElement('img');img.className='member-avatar';img.alt='';img.src=m.avatar_url;card.append(img)}
    const h=document.createElement('h3');h.textContent=m.display_name||m.name;const p=document.createElement('p');p.textContent=m.pronouns||m.name;card.append(h,p);card.onclick=()=>openMember(m);$('#memberGrid').append(card);
  }
}
function resetForm(){$('#memberForm').reset();$('#memberId').value='';$('#memberColorPicker').value='#8b7cf6';$('#memberError').hidden=true;$('#deleteMemberButton').hidden=true}
function openMember(m=null){
  resetForm();$('#memberDialogTitle').textContent=m?'Edit member':'New member';
  if(m){$('#memberId').value=m.id;$('#memberName').value=m.name||'';$('#memberDisplayName').value=m.display_name||'';$('#memberPronouns').value=m.pronouns||'';$('#memberDescription').value=m.description||'';$('#memberAvatarUrl').value=m.avatar_url||'';$('#memberBannerUrl').value=m.banner_url||'';const c=hex(m.color);$('#memberColor').value=c;if(c)$('#memberColorPicker').value=c;$('#deleteMemberButton').hidden=false}
  $('#memberDialog').showModal();
}
async function maybeUpload(kind,input){
  const file=input.files?.[0];if(!file)return null;
  const max=kind==='avatar'?2*1024*1024:5*1024*1024;
  if(file.size>max)throw new Error((kind==='avatar'?'Avatar':'Banner')+' exceeds the upload limit.');
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))throw new Error('Unsupported image format.');
  return (await nihilityApi.upload(kind,file)).url;
}
async function saveMember(e){
  e.preventDefault();const err=$('#memberError');err.hidden=true;
  try{
    const au=await maybeUpload('avatar',$('#memberAvatarFile'));const bu=await maybeUpload('banner',$('#memberBannerFile'));const c=hex($('#memberColor').value);
    const body={user_id:state.user.id,name:$('#memberName').value.trim(),display_name:$('#memberDisplayName').value.trim()||null,pronouns:$('#memberPronouns').value.trim()||null,color:c?c.slice(1).toLowerCase():null,description:$('#memberDescription').value.trim()||null,avatar_url:au||$('#memberAvatarUrl').value.trim()||null,avatar_source:au?'r2':($('#memberAvatarUrl').value.trim()?'external':null),banner_url:bu||$('#memberBannerUrl').value.trim()||null,banner_source:bu?'r2':($('#memberBannerUrl').value.trim()?'external':null)};
    if(!body.name)throw new Error('Name is required.');
    const id=$('#memberId').value;
    if(id)await nihilityApi.rest('members',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body,prefer:'return=minimal'});
    else await nihilityApi.rest('members',{method:'POST',body,prefer:'return=minimal'});
    $('#memberDialog').close();toast(id?'Member updated.':'Member created.');await load();
  }catch(e){err.textContent=e.message;err.hidden=false}
}
async function removeMember(){
  const id=$('#memberId').value;if(!id||!confirm('Delete this member from Nihility?'))return;
  await nihilityApi.rest('members',{method:'DELETE',query:'id=eq.'+encodeURIComponent(id),prefer:'return=minimal'});$('#memberDialog').close();toast('Member deleted.');await load();
}
async function boot(){
  if(!nihilityApi.configured()){view('setup');return}
  nihilityApi.readSessionFromUrl();state.user=await nihilityApi.user();
  if(!state.user){view('login');return}
  $('#settingsEmail').textContent=state.user.email||'Signed in';view('app');route('members');await load();
}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const m=$('#loginMessage');m.textContent='Sending...';try{await nihilityApi.sendMagicLink($('#emailInput').value.trim());m.textContent='Check your email for the sign-in link.'}catch(e){m.textContent=e.message}});
$('#signOutButton').onclick=()=>{nihilityApi.saveSession(null);location.reload()};
$$('.nav-item').forEach(b=>b.onclick=()=>route(b.dataset.route));$('#newMemberButton').onclick=()=>openMember();$('#memberSearch').oninput=render;$('#memberForm').onsubmit=saveMember;$('#deleteMemberButton').onclick=removeMember;$('#closeMemberDialog').onclick=$('#cancelMemberButton').onclick=()=>$('#memberDialog').close();
$('#memberColorPicker').oninput=e=>$('#memberColor').value=e.target.value.toUpperCase();$('#memberColor').oninput=e=>{const c=hex(e.target.value);if(c)$('#memberColorPicker').value=c};
boot().catch(e=>{console.error(e);toast(e.message||'Unable to start Nihility.')});
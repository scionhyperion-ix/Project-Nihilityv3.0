'use strict';

(()=>{
  const te=new TextEncoder(),td=new TextDecoder();
  const PASS_ITERATIONS=650000;
  const LOCK_KEY='nihility_journal_lock_minutes';
  const PAGE_SIZE=200;
  let vaultStatus=null;
  let vaultKey=null;
  let encryptedRows=[];
  let decryptedEntries=[];
  let hasMore=false;
  let loaded=0;
  let lockTimer=null;
  let editingId=null;

  const qs=s=>document.querySelector(s);
  const b64u=bytes=>{
    let bin='';for(const b of bytes)bin+=String.fromCharCode(b);
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  };
  const unb64u=text=>{
    const normalized=String(text||'').replace(/-/g,'+').replace(/_/g,'/');
    const padded=normalized+'='.repeat((4-normalized.length%4)%4);
    const bin=atob(padded),out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
    return out;
  };
  const randomBytes=n=>{const x=new Uint8Array(n);crypto.getRandomValues(x);return x};
  const aad=(id,version=1)=>te.encode('nihility-journal-entry:v'+version+':'+state.user.id+':'+id);
  const wrapAad=()=>te.encode('nihility-journal-wrap:v1:'+state.user.id);
  const recoveryAad=()=>te.encode('nihility-journal-recovery:v1:'+state.user.id);
  const today=()=>new Date().toISOString().slice(0,10);

  async function importAes(raw){return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt'])}
  async function derivePassphraseKey(passphrase,salt,iterations){
    const material=await crypto.subtle.importKey('raw',te.encode(passphrase),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey(
      {name:'PBKDF2',salt,iterations,hash:'SHA-256'},
      material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']
    );
  }
  async function deriveRecoveryKey(secret,salt){
    const material=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);
    return crypto.subtle.deriveKey(
      {name:'HKDF',hash:'SHA-256',salt,info:te.encode('nihility-journal-recovery-kdf:v1:'+state.user.id)},
      material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']
    );
  }
  async function wrapRawKey(raw,key,iv,aadBytes){
    const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aadBytes},key,raw);
    return new Uint8Array(ct);
  }
  async function unwrapRawKey(cipher,key,iv,aadBytes){
    const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aadBytes},key,cipher);
    return new Uint8Array(raw);
  }
  async function encryptEntry(id,payload){
    const iv=randomBytes(12);
    const raw=te.encode(JSON.stringify(payload));
    if(raw.length>120000)throw new Error('Journal entry is too large.');
    const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id,1)},vaultKey,raw);
    return{payload_version:1,iv:b64u(iv),ciphertext:b64u(new Uint8Array(ct))};
  }
  async function decryptRow(row){
    const raw=await crypto.subtle.decrypt(
      {name:'AES-GCM',iv:unb64u(row.iv),additionalData:aad(row.id,Number(row.payload_version||1))},
      vaultKey,unb64u(row.ciphertext)
    );
    const payload=JSON.parse(td.decode(raw));
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid encrypted journal payload.');
    return{
      id:row.id,
      title:String(payload.title||''),
      body:String(payload.body||''),
      date:/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date||''))?String(payload.date):today(),
      member_ids:Array.isArray(payload.member_ids)?payload.member_ids.map(String).filter(Boolean).slice(0,100):[],
      created_at:row.created_at,
      updated_at:row.updated_at
    };
  }

  function lockMinutes(){
    const n=Number(localStorage.getItem(LOCK_KEY)||15);
    return [5,15,30,60].includes(n)?n:15;
  }
  function armLock(){
    clearTimeout(lockTimer);
    if(!vaultKey)return;
    lockTimer=setTimeout(()=>lockVault('Journal locked after inactivity.'),lockMinutes()*60000);
  }
  function touchVault(){if(vaultKey)armLock()}
  function clearPlaintext(){
    decryptedEntries=[];
    editingId=null;
    const body=qs('#journalBody');if(body)body.value='';
    const title=qs('#journalTitle');if(title)title.value='';
  }
  function lockVault(message='Journal locked.'){
    vaultKey=null;
    encryptedRows=[];
    loaded=0;hasMore=false;
    clearTimeout(lockTimer);lockTimer=null;
    clearPlaintext();
    renderJournal();
    if(message)toast('Journal locked',message);
  }

  async function refreshStatus(){
    vaultStatus=await nihilityApi.secure('journal_status');
    return vaultStatus;
  }
  async function checkNewPassphrase(passphrase){
    if(passphrase.length<16)throw new Error('Use at least 16 characters for the journal passphrase.');
    if(passphrase.length>256)throw new Error('Journal passphrase is too long.');
    const pwned=await nihilityApi.checkPwnedPassword(passphrase);
    if(pwned?.pwned)throw new Error('That passphrase appears in a known breach. Choose a different journal passphrase.');
  }
  function formatRecovery(secret){
    const raw=b64u(secret);
    return 'NJR1-'+raw.match(/.{1,5}/g).join('-');
  }
  function parseRecovery(value){
    const raw=String(value||'').trim().replace(/^NJR1-/i,'').replace(/[^A-Za-z0-9_-]/g,'');
    const bytes=unb64u(raw);
    if(bytes.length!==32)throw new Error('Recovery key is invalid.');
    return bytes;
  }
  async function buildVault(passphrase,dekRaw,recoverySecret=randomBytes(32)){
    const salt=randomBytes(16),iv=randomBytes(12);
    const passKey=await derivePassphraseKey(passphrase,salt,PASS_ITERATIONS);
    const wrapped=await wrapRawKey(dekRaw,passKey,iv,wrapAad());

    const recoverySalt=randomBytes(16),recoveryIv=randomBytes(12);
    const recoveryKey=await deriveRecoveryKey(recoverySecret,recoverySalt);
    const recoveryWrapped=await wrapRawKey(dekRaw,recoveryKey,recoveryIv,recoveryAad());

    return{
      vault:{
        kdf_iterations:PASS_ITERATIONS,
        kdf_salt:b64u(salt),
        wrap_iv:b64u(iv),
        wrapped_key:b64u(wrapped),
        recovery_salt:b64u(recoverySalt),
        recovery_iv:b64u(recoveryIv),
        recovery_wrapped_key:b64u(recoveryWrapped)
      },
      recoverySecret
    };
  }
  async function unlockWithPassphrase(passphrase){
    if(!vaultStatus?.configured)throw new Error('Journal vault is not configured.');
    const v=vaultStatus.vault;
    try{
      const key=await derivePassphraseKey(passphrase,unb64u(v.kdf_salt),Number(v.kdf_iterations));
      const raw=await unwrapRawKey(unb64u(v.wrapped_key),key,unb64u(v.wrap_iv),wrapAad());
      vaultKey=await importAes(raw);
    }catch{
      throw new Error('Unable to unlock journal. Check the passphrase.');
    }
    await loadFirstPage();
    armLock();
  }
  async function unlockWithRecovery(recoveryText){
    if(!vaultStatus?.configured)throw new Error('Journal vault is not configured.');
    const v=vaultStatus.vault;
    try{
      const secret=parseRecovery(recoveryText);
      const key=await deriveRecoveryKey(secret,unb64u(v.recovery_salt));
      const raw=await unwrapRawKey(unb64u(v.recovery_wrapped_key),key,unb64u(v.recovery_iv),recoveryAad());
      return raw;
    }catch{
      throw new Error('Recovery key is invalid or no longer active.');
    }
  }

  async function fetchPage(offset){
    return nihilityApi.secure('journal_list',{limit:PAGE_SIZE,offset});
  }
  async function decryptRows(rows){
    const output=[];
    for(const row of rows||[]){
      try{output.push(await decryptRow(row))}
      catch{output.push({id:row.id,title:'Unable to decrypt',body:'',date:'',member_ids:[],created_at:row.created_at,updated_at:row.updated_at,broken:true})}
    }
    return output;
  }
  async function loadFirstPage(){
    const result=await fetchPage(0);
    encryptedRows=result.entries||[];
    decryptedEntries=await decryptRows(encryptedRows);
    loaded=encryptedRows.length;hasMore=Boolean(result.has_more);
    sortEntries();renderJournal();
  }
  async function loadOlder(){
    touchVault();
    const result=await fetchPage(loaded);
    const rows=result.entries||[];
    encryptedRows.push(...rows);
    decryptedEntries.push(...await decryptRows(rows));
    loaded+=rows.length;hasMore=Boolean(result.has_more);
    sortEntries();renderJournal();
  }
  function sortEntries(){
    decryptedEntries.sort((a,b)=>{
      const byDate=String(b.date||'').localeCompare(String(a.date||''));
      if(byDate)return byDate;
      return new Date(b.updated_at||0)-new Date(a.updated_at||0);
    });
  }
  function memberName(id){
    const m=state.members.find(x=>x.id===id);return m?label(m):'Unavailable member';
  }

  function ensureRoute(){
    if(!qs('#journalRoute')){
      const route=document.createElement('section');route.id='journalRoute';route.className='route-view';route.hidden=true;
      route.innerHTML='<article class="panel section-panel journal-panel"><div class="panel-heading split-heading"><div><p class="eyebrow">Encrypted vault</p><h3>Journal</h3></div><div id="journalHeaderActions" class="button-row"></div></div><p class="muted journal-security-summary">Journal titles, bodies, logical dates, and linked members are encrypted in your browser before they leave this device. Nihility cannot recover them without your journal passphrase or recovery key.</p><div id="journalContent"></div></article>';
      qs('#settingsRoute')?.insertAdjacentElement('beforebegin',route);
    }
    if(!qs('.nav-list [data-route="journal"]')){
      const b=document.createElement('button');b.className='nav-item';b.dataset.route='journal';b.type='button';b.innerHTML='<span>✎</span>Journal';
      qs('.nav-list [data-route="settings"]')?.insertAdjacentElement('beforebegin',b);b.onclick=()=>setRoute('journal');
    }
    if(!qs('.mobile-nav [data-route="journal"]')){
      const b=document.createElement('button');b.className='mobile-nav-item';b.dataset.route='journal';b.type='button';b.innerHTML='<span>✎</span>Journal';
      qs('.mobile-nav [data-route="settings"]')?.insertAdjacentElement('beforebegin',b);b.onclick=()=>setRoute('journal');
    }
    ensureDialogs();
  }

  function ensureDialogs(){
    if(!qs('#journalEntryDialog')){
      const d=document.createElement('dialog');d.id='journalEntryDialog';d.className='modal-dialog journal-entry-dialog';
      d.innerHTML='<form id="journalEntryForm" class="modal-card"><div class="modal-heading"><div><p class="eyebrow">Encrypted journal entry</p><h3 id="journalEntryDialogTitle">New entry</h3><p class="muted">The title, date, body, and linked members are encrypted together before upload.</p></div><button class="icon-button journal-entry-close" type="button" aria-label="Close">×</button></div><label>Date<input id="journalDate" type="date" required></label><label>Title<input id="journalTitle" maxlength="200" autocomplete="off" placeholder="Optional title"></label><label>Entry<textarea id="journalBody" maxlength="50000" rows="14" required placeholder="Write privately..."></textarea></label><div class="journal-member-section"><div class="editor-section-heading"><span>Linked members</span><small>Optional, encrypted inside the journal entry.</small></div><label>Find members<input id="journalMemberSearch" type="search" placeholder="Search members" autocomplete="off"></label><div id="journalMemberPicker" class="journal-member-picker"></div></div><p id="journalEntryError" class="form-error" hidden></p><div class="modal-footer modal-footer-split"><button id="journalDeleteEntryButton" class="secondary-button danger-button" type="button" hidden>Delete entry</button><div><button class="secondary-button journal-entry-close" type="button">Cancel</button><button class="primary-button" type="submit">Encrypt and save</button></div></div></form>';
      document.body.append(d);
      d.querySelectorAll('.journal-entry-close').forEach(b=>b.onclick=()=>{d.close();clearEditor()});
      d.querySelector('#journalEntryForm').onsubmit=saveEntry;
      d.querySelector('#journalMemberSearch').oninput=renderMemberPicker;
      d.querySelector('#journalDeleteEntryButton').onclick=deleteEntry;
    }
    if(!qs('#journalRecoveryDialog')){
      const d=document.createElement('dialog');d.id='journalRecoveryDialog';d.className='modal-dialog';
      d.innerHTML='<div class="modal-card"><div class="modal-heading"><div><p class="eyebrow">Journal recovery key</p><h3>Save this recovery key</h3><p class="muted">This is shown once. Store it somewhere separate from Nihility. Anyone with this key plus access to your encrypted journal backup can decrypt the vault key.</p></div></div><div id="journalRecoveryValue" class="journal-recovery-value"></div><div class="button-row"><button id="copyJournalRecovery" class="secondary-button" type="button">Copy recovery key</button></div><label class="check-row"><input id="journalRecoverySaved" type="checkbox"><span><strong>I saved this recovery key</strong><small>Nihility does not keep a plaintext copy.</small></span></label><div class="modal-footer"><button id="closeJournalRecovery" class="primary-button" type="button" disabled>Done</button></div></div>';
      document.body.append(d);
      d.querySelector('#copyJournalRecovery').onclick=async()=>{await navigator.clipboard.writeText(d.querySelector('#journalRecoveryValue').textContent);toast('Recovery key copied')};
      d.querySelector('#journalRecoverySaved').onchange=e=>{d.querySelector('#closeJournalRecovery').disabled=!e.target.checked};
      d.querySelector('#closeJournalRecovery').onclick=()=>d.close();
    }
    if(!qs('#journalSecurityDialog')){
      const d=document.createElement('dialog');d.id='journalSecurityDialog';d.className='modal-dialog';
      d.innerHTML='<div class="modal-card"><div class="modal-heading"><div><p class="eyebrow">Journal security</p><h3>Vault controls</h3></div><button class="icon-button journal-security-close" type="button">×</button></div><label>Auto-lock<select id="journalLockMinutes"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option></select></label><div class="journal-security-block"><strong>Change passphrase</strong><form id="journalChangePassphraseForm" class="stack"><label>New passphrase<input id="journalNewPassphrase" type="password" autocomplete="new-password" minlength="16" required></label><label>Confirm passphrase<input id="journalNewPassphraseConfirm" type="password" autocomplete="new-password" minlength="16" required></label><button class="secondary-button" type="submit">Change passphrase</button></form></div><div class="journal-security-block"><strong>Recovery key</strong><p class="muted">Rotating the recovery key immediately invalidates the previous one.</p><button id="rotateJournalRecovery" class="secondary-button" type="button">Generate new recovery key</button></div><div class="journal-security-block journal-danger-zone"><strong>Destroy journal vault</strong><p class="muted">Deletes every encrypted journal entry and both wrapped vault keys. This cannot be undone without a backup.</p><label>Type ERASE JOURNAL<input id="journalResetConfirm" autocomplete="off"></label><button id="resetJournalVault" class="secondary-button danger-button" type="button">Erase journal vault</button></div><p id="journalSecurityError" class="form-error" hidden></p><div class="modal-footer"><button class="secondary-button journal-security-close" type="button">Close</button></div></div>';
      document.body.append(d);
      d.querySelectorAll('.journal-security-close').forEach(b=>b.onclick=()=>d.close());
      d.querySelector('#journalLockMinutes').onchange=e=>{localStorage.setItem(LOCK_KEY,e.target.value);armLock()};
      d.querySelector('#journalChangePassphraseForm').onsubmit=changePassphrase;
      d.querySelector('#rotateJournalRecovery').onclick=rotateRecovery;
      d.querySelector('#resetJournalVault').onclick=resetVault;
    }
    if(!qs('#journalRecoverDialog')){
      const d=document.createElement('dialog');d.id='journalRecoverDialog';d.className='modal-dialog';
      d.innerHTML='<form id="journalRecoverForm" class="modal-card"><div class="modal-heading"><div><p class="eyebrow">Journal recovery</p><h3>Recover vault access</h3><p class="muted">The recovery key decrypts the vault key locally. A new passphrase and a new recovery key will be created immediately.</p></div><button class="icon-button journal-recover-close" type="button">×</button></div><label>Recovery key<input id="journalRecoveryInput" autocomplete="off" required></label><label>New passphrase<input id="journalRecoveryPassphrase" type="password" autocomplete="new-password" minlength="16" required></label><label>Confirm new passphrase<input id="journalRecoveryPassphraseConfirm" type="password" autocomplete="new-password" minlength="16" required></label><p id="journalRecoverError" class="form-error" hidden></p><div class="modal-footer"><button class="secondary-button journal-recover-close" type="button">Cancel</button><button class="primary-button" type="submit">Recover and rotate keys</button></div></form>';
      document.body.append(d);
      d.querySelectorAll('.journal-recover-close').forEach(b=>b.onclick=()=>d.close());
      d.querySelector('#journalRecoverForm').onsubmit=recoverVault;
    }
  }

  function showRecovery(secret){
    const d=qs('#journalRecoveryDialog');
    qs('#journalRecoveryValue').textContent=formatRecovery(secret);
    qs('#journalRecoverySaved').checked=false;qs('#closeJournalRecovery').disabled=true;
    d.showModal();
  }

  function renderLocked(){
    const box=qs('#journalContent'),actions=qs('#journalHeaderActions');actions.replaceChildren();box.replaceChildren();
    if(!vaultStatus?.configured){
      const card=document.createElement('div');card.className='journal-locked-card';
      card.innerHTML='<h4>Create encrypted journal vault</h4><p class="muted">Choose a separate journal passphrase. Nihility will generate a random 256-bit vault key and a one-time recovery key. The passphrase itself is never sent to Supabase.</p><form id="journalSetupForm" class="stack"><label>Journal passphrase<input id="journalSetupPassphrase" type="password" autocomplete="new-password" minlength="16" maxlength="256" required></label><label>Confirm passphrase<input id="journalSetupConfirm" type="password" autocomplete="new-password" minlength="16" maxlength="256" required></label><button class="primary-button" type="submit">Create encrypted vault</button><p id="journalSetupError" class="form-error" hidden></p></form>';
      box.append(card);card.querySelector('#journalSetupForm').onsubmit=setupVault;return;
    }
    const card=document.createElement('div');card.className='journal-locked-card';
    card.innerHTML='<h4>Journal vault locked</h4><p class="muted">Enter the journal passphrase. It is used only on this device to unwrap the encryption key.</p><form id="journalUnlockForm" class="stack"><label>Journal passphrase<input id="journalUnlockPassphrase" type="password" autocomplete="current-password" required></label><button class="primary-button" type="submit">Unlock journal</button><p id="journalUnlockError" class="form-error" hidden></p></form><button id="openJournalRecovery" class="text-button" type="button">Use recovery key</button>';
    box.append(card);
    card.querySelector('#journalUnlockForm').onsubmit=unlockForm;
    card.querySelector('#openJournalRecovery').onclick=()=>qs('#journalRecoverDialog').showModal();
  }

  function renderUnlocked(){
    const box=qs('#journalContent'),actions=qs('#journalHeaderActions');actions.replaceChildren();box.replaceChildren();
    const add=document.createElement('button');add.className='primary-button';add.type='button';add.textContent='New entry';add.onclick=()=>openEditor();
    const security=document.createElement('button');security.className='secondary-button';security.type='button';security.textContent='Vault security';security.onclick=()=>openSecurity();
    const lock=document.createElement('button');lock.className='secondary-button';lock.type='button';lock.textContent='Lock';lock.onclick=()=>lockVault();
    actions.append(add,security,lock);

    const tools=document.createElement('div');tools.className='journal-toolbar';
    tools.innerHTML='<label class="search-field"><span>⌕</span><input id="journalSearch" type="search" placeholder="Search decrypted entries on this device" autocomplete="off"></label>';
    tools.querySelector('input').oninput=renderEntryList;box.append(tools);
    const list=document.createElement('div');list.id='journalEntryList';list.className='journal-entry-list';box.append(list);
    const load=document.createElement('div');load.className='journal-load-row';load.innerHTML='<button id="journalLoadOlder" class="secondary-button" type="button">Load older encrypted entries</button>';box.append(load);
    load.querySelector('button').onclick=loadOlder;
    renderEntryList();
  }

  function renderEntryList(){
    if(!vaultKey)return;
    touchVault();
    const list=qs('#journalEntryList');if(!list)return;
    const q=(qs('#journalSearch')?.value||'').trim().toLowerCase();
    list.replaceChildren();
    const rows=decryptedEntries.filter(e=>!q||[e.title,e.body,...e.member_ids.map(memberName)].join(' ').toLowerCase().includes(q));
    qs('#journalLoadOlder').hidden=!hasMore;
    if(!rows.length){
      const empty=document.createElement('div');empty.className='empty-state';empty.innerHTML='<h3>No journal entries found</h3><p>Your encrypted journal is ready.</p>';list.append(empty);return;
    }
    let last='';
    rows.forEach(e=>{
      const heading=e.date||'Unknown date';
      if(heading!==last){
        const h=document.createElement('div');h.className='journal-date-heading';h.textContent=heading;list.append(h);last=heading;
      }
      const card=document.createElement('button');card.type='button';card.className='journal-entry-card';
      const title=document.createElement('strong');title.textContent=e.title||'Untitled entry';
      const preview=document.createElement('span');preview.textContent=e.broken?'This entry could not be decrypted.':(e.body.replace(/\s+/g,' ').trim().slice(0,180)||'Empty entry');
      const meta=document.createElement('small');meta.textContent=e.member_ids.length?e.member_ids.slice(0,5).map(memberName).join(', '):'Private journal entry';
      card.append(title,preview,meta);if(!e.broken)card.onclick=()=>openEditor(e);list.append(card);
    });
  }

  function renderJournal(){
    ensureRoute();
    if(!vaultStatus){qs('#journalContent').innerHTML='<p class="muted">Loading journal vault...</p>';return}
    if(!vaultKey)renderLocked();else renderUnlocked();
  }

  async function setupVault(event){
    event.preventDefault();const err=qs('#journalSetupError');err.hidden=true;
    try{
      const pass=qs('#journalSetupPassphrase').value,confirm=qs('#journalSetupConfirm').value;
      if(pass!==confirm)throw new Error('Passphrases do not match.');
      await checkNewPassphrase(pass);
      const dekRaw=randomBytes(32),built=await buildVault(pass,dekRaw);
      await nihilityApi.secure('journal_setup',{vault:built.vault});
      vaultKey=await importAes(dekRaw);
      await refreshStatus();await loadFirstPage();armLock();showRecovery(built.recoverySecret);toast('Encrypted journal created');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }
  async function unlockForm(event){
    event.preventDefault();const err=qs('#journalUnlockError');err.hidden=true;
    try{await unlockWithPassphrase(qs('#journalUnlockPassphrase').value);qs('#journalUnlockPassphrase').value='';toast('Journal unlocked')}
    catch(error){err.textContent=error.message;err.hidden=false}
  }

  function clearEditor(){
    editingId=null;
    qs('#journalEntryError').hidden=true;
    qs('#journalBody').value='';qs('#journalTitle').value='';qs('#journalMemberSearch').value='';
  }
  function openEditor(entry=null){
    touchVault();editingId=entry?.id||null;
    qs('#journalEntryDialogTitle').textContent=entry?'Edit entry':'New entry';
    qs('#journalDate').value=entry?.date||today();
    qs('#journalTitle').value=entry?.title||'';
    qs('#journalBody').value=entry?.body||'';
    qs('#journalDeleteEntryButton').hidden=!entry;
    renderMemberPicker(entry?.member_ids||[]);
    qs('#journalEntryDialog').showModal();
  }
  function selectedJournalMemberIds(){return[...document.querySelectorAll('#journalMemberPicker input:checked')].map(x=>x.value)}
  function renderMemberPicker(selected=null){
    const box=qs('#journalMemberPicker');if(!box)return;
    const selectedSet=selected?new Set(selected):new Set(selectedJournalMemberIds());
    const q=(qs('#journalMemberSearch')?.value||'').trim().toLowerCase();box.replaceChildren();
    [...state.members].filter(m=>!q||[m.name,m.display_name,m.pronouns].filter(Boolean).some(v=>String(v).toLowerCase().includes(q)))
      .sort((a,b)=>label(a).localeCompare(label(b),undefined,{numeric:true,sensitivity:'base'})).slice(0,200).forEach(m=>{
        const l=document.createElement('label');l.className='journal-member-option';
        const c=document.createElement('input');c.type='checkbox';c.value=m.id;c.checked=selectedSet.has(m.id);
        const span=document.createElement('span');span.textContent=label(m)+(m.archived_at?' (archived)':'');l.append(c,span);box.append(l);
      });
  }
  async function saveEntry(event){
    event.preventDefault();touchVault();const err=qs('#journalEntryError');err.hidden=true;
    try{
      const date=qs('#journalDate').value,title=qs('#journalTitle').value.trim(),body=qs('#journalBody').value;
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Choose a valid journal date.');
      if(!body.trim())throw new Error('Journal entry body is required.');
      const member_ids=selectedJournalMemberIds();if(member_ids.length>100)throw new Error('Link at most 100 members to one journal entry.');
      const id=editingId||crypto.randomUUID();
      const encrypted=await encryptEntry(id,{title,body,date,member_ids});
      await nihilityApi.secure('journal_save',{entry:{id,...encrypted}});
      qs('#journalEntryDialog').close();clearEditor();await loadFirstPage();toast('Journal entry encrypted and saved');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }
  async function deleteEntry(){
    if(!editingId)return;
    if(!confirm('Delete this encrypted journal entry permanently?'))return;
    touchVault();
    try{
      await nihilityApi.secure('journal_delete',{entry_id:editingId});
      qs('#journalEntryDialog').close();clearEditor();await loadFirstPage();toast('Journal entry deleted');
    }catch(error){const err=qs('#journalEntryError');err.textContent=error.message;err.hidden=false}
  }

  function openSecurity(){
    touchVault();qs('#journalLockMinutes').value=String(lockMinutes());qs('#journalSecurityError').hidden=true;qs('#journalResetConfirm').value='';qs('#journalSecurityDialog').showModal();
  }
  async function changePassphrase(event){
    event.preventDefault();touchVault();const err=qs('#journalSecurityError');err.hidden=true;
    try{
      const pass=qs('#journalNewPassphrase').value,confirm=qs('#journalNewPassphraseConfirm').value;
      if(pass!==confirm)throw new Error('Passphrases do not match.');
      await checkNewPassphrase(pass);
      const raw=await crypto.subtle.exportKey('raw',vaultKey).catch(()=>null);
      if(!raw)throw new Error('Unable to rotate journal passphrase in this session.');
      const salt=randomBytes(16),iv=randomBytes(12),key=await derivePassphraseKey(pass,salt,PASS_ITERATIONS);
      const wrapped=await wrapRawKey(new Uint8Array(raw),key,iv,wrapAad());
      await nihilityApi.secure('journal_rewrap',{vault:{kdf_iterations:PASS_ITERATIONS,kdf_salt:b64u(salt),wrap_iv:b64u(iv),wrapped_key:b64u(wrapped)}});
      qs('#journalNewPassphrase').value='';qs('#journalNewPassphraseConfirm').value='';await refreshStatus();toast('Journal passphrase changed');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }
  async function exportVaultRaw(){
    if(!vaultKey)throw new Error('Journal is locked.');
    const raw=await crypto.subtle.exportKey('raw',vaultKey);
    return new Uint8Array(raw);
  }
  async function rotateRecovery(){
    touchVault();const err=qs('#journalSecurityError');err.hidden=true;
    try{
      const raw=await exportVaultRaw(),secret=randomBytes(32),salt=randomBytes(16),iv=randomBytes(12);
      const key=await deriveRecoveryKey(secret,salt),wrapped=await wrapRawKey(raw,key,iv,recoveryAad());
      await nihilityApi.secure('journal_rotate_recovery',{vault:{recovery_salt:b64u(salt),recovery_iv:b64u(iv),recovery_wrapped_key:b64u(wrapped)}});
      await refreshStatus();showRecovery(secret);toast('Journal recovery key rotated');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }
  async function resetVault(){
    const err=qs('#journalSecurityError');err.hidden=true;
    try{
      if(qs('#journalResetConfirm').value!=='ERASE JOURNAL')throw new Error('Type ERASE JOURNAL exactly.');
      await nihilityApi.secure('journal_reset',{confirmation:'ERASE JOURNAL'});
      qs('#journalSecurityDialog').close();vaultKey=null;clearPlaintext();await refreshStatus();renderJournal();toast('Journal vault erased');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }
  async function recoverVault(event){
    event.preventDefault();const err=qs('#journalRecoverError');err.hidden=true;
    try{
      const pass=qs('#journalRecoveryPassphrase').value,confirm=qs('#journalRecoveryPassphraseConfirm').value;
      if(pass!==confirm)throw new Error('Passphrases do not match.');
      await checkNewPassphrase(pass);
      const raw=await unlockWithRecovery(qs('#journalRecoveryInput').value);
      const built=await buildVault(pass,raw);
      await nihilityApi.secure('journal_rewrap',{vault:{kdf_iterations:built.vault.kdf_iterations,kdf_salt:built.vault.kdf_salt,wrap_iv:built.vault.wrap_iv,wrapped_key:built.vault.wrapped_key}});
      await nihilityApi.secure('journal_rotate_recovery',{vault:{recovery_salt:built.vault.recovery_salt,recovery_iv:built.vault.recovery_iv,recovery_wrapped_key:built.vault.recovery_wrapped_key}});
      vaultKey=await importAes(raw);await refreshStatus();await loadFirstPage();armLock();
      qs('#journalRecoverDialog').close();qs('#journalRecoveryInput').value='';qs('#journalRecoveryPassphrase').value='';qs('#journalRecoveryPassphraseConfirm').value='';
      showRecovery(built.recoverySecret);toast('Journal vault recovered and keys rotated');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }

  // Import journal keys as extractable only while held in memory so passphrase and
  // recovery rotation can rewrap the same random vault key without re-encrypting entries.
  const originalImportAes=importAes;
  importAes=async raw=>crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},true,['encrypt','decrypt']);

  const coreSetRoute=setRoute;
  setRoute=function(route){
    if(route!=='journal')return coreSetRoute(route);
    ensureRoute();
    state.route='journal';
    qs('#pageEyebrow').textContent='Encrypted vault';
    qs('#pageTitle').textContent='Journal';
    document.querySelectorAll('.route-view').forEach(v=>v.hidden=v.id!=='journalRoute');
    document.querySelectorAll('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route==='journal'));
    qs('#openFrontManager').hidden=true;history.replaceState(null,'',location.pathname+'#journal');
    renderJournal();
  };

  async function initialize(){
    ensureRoute();
    try{await refreshStatus()}catch(error){vaultStatus={configured:false,error:error.message}}
    renderJournal();
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&vaultKey)lockVault('Journal locked when the tab was hidden.')});
  window.addEventListener('beforeunload',()=>{vaultKey=null;clearPlaintext()});
  document.addEventListener('pointerdown',()=>{if(state.route==='journal')touchVault()},{passive:true});
  document.addEventListener('keydown',()=>{if(state.route==='journal')touchVault()});
  initialize();
})();

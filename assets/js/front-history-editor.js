'use strict';

(()=>{
  let editorState=null;

  const memberLabel=m=>m?.display_name||m?.name||'Unknown member';
  const byMemberName=(a,b)=>memberLabel(a).localeCompare(memberLabel(b),undefined,{sensitivity:'base',numeric:true});

  function toLocalInput(value){
    if(!value)return '';
    const date=new Date(value);
    if(!Number.isFinite(date.getTime()))return '';
    const pad=n=>String(n).padStart(2,'0');
    return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes());
  }
  function toIso(value){
    if(!value)return null;
    const date=new Date(value);
    if(!Number.isFinite(date.getTime()))throw new Error('Enter a valid date and time.');
    return date.toISOString();
  }
  function fmtTime(value){
    if(!value)return 'Ongoing';
    const date=new Date(value);
    return Number.isFinite(date.getTime())?date.toLocaleString():'Invalid time';
  }
  function fmtDuration(start,end){
    if(!start)return '';
    const a=new Date(start).getTime();
    const b=end?new Date(end).getTime():Date.now();
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '';
    const total=Math.floor((b-a)/60000);
    const days=Math.floor(total/1440);
    const hours=Math.floor((total%1440)/60);
    const mins=total%60;
    const parts=[];
    if(days)parts.push(days+'d');
    if(hours)parts.push(hours+'h');
    if(mins||!parts.length)parts.push(mins+'m');
    return parts.join(' ');
  }

  function ensureDialog(){
    let dialog=document.querySelector('#frontHistoryEditorDialog');
    if(dialog)return dialog;
    dialog=document.createElement('dialog');
    dialog.id='frontHistoryEditorDialog';
    dialog.className='modal-dialog history-editor-dialog';
    dialog.innerHTML=\`
      <div class="modal-card history-editor-card">
        <div class="modal-heading history-editor-heading">
          <div>
            <p class="eyebrow">Front history correction</p>
            <h3 id="historyEditorTitle">Edit history entry</h3>
            <p id="historyEditorSubtitle" class="muted">Review timing and members carefully before saving.</p>
          </div>
          <button id="closeHistoryEditorButton" class="icon-button" type="button" aria-label="Close">×</button>
        </div>

        <div class="history-editor-body">
          <section class="history-editor-fields">
            <div class="history-editor-grid">
              <label>Start time
                <input id="historyEditorStart" type="datetime-local" required>
              </label>
              <label>End time
                <input id="historyEditorEnd" type="datetime-local">
              </label>
            </div>

            <label class="check-row history-editor-ongoing">
              <input id="historyEditorOngoing" type="checkbox">
              <span><strong>Ongoing front</strong><small>Leave the end time open. Only one ongoing front can exist.</small></span>
            </label>

            <label>Record origin
              <select id="historyEditorSource"></select>
            </label>
            <p id="historyEditorSourceHelp" class="muted history-editor-help"></p>

            <label>Front note
              <textarea id="historyEditorNote" maxlength="10000" rows="4" placeholder="Optional note"></textarea>
            </label>

            <div class="history-editor-section-heading">
              <div><strong>Members</strong><small id="historyEditorSelectedCount">0 selected</small></div>
              <button id="historyEditorAlignTimes" class="text-button" type="button">Align member times to front</button>
            </div>
            <label class="search-field history-editor-search"><span>⌕</span><input id="historyEditorMemberSearch" type="search" placeholder="Search members"></label>
            <div id="historyEditorMemberPicker" class="history-editor-member-picker"></div>

            <div class="history-editor-section-heading history-editor-timing-heading">
              <div><strong>Selected member timing</strong><small>Each member can have an individual join and leave time.</small></div>
            </div>
            <div id="historyEditorMemberTimes" class="history-editor-member-times"></div>
          </section>

          <aside class="history-editor-review-column">
            <div class="history-editor-current-card">
              <p class="eyebrow">Current record</p>
              <dl id="historyEditorCurrentSummary" class="detail-list"></dl>
            </div>

            <div id="historyEditorReviewPanel" class="history-editor-review-panel" hidden>
              <p class="eyebrow">Validated changes</p>
              <div id="historyEditorReviewSummary"></div>
            </div>

            <div class="security-note history-editor-safety">
              <strong>Server validated</strong>
              <p>Review uses the same ownership, timestamp, overlap, and member checks as the final save. Editing after review invalidates it.</p>
            </div>

            <div id="historyEditorDeletePanel" class="history-editor-delete-panel" hidden>
              <strong>Delete this history entry?</strong>
              <p class="muted">This removes the front and its member timing rows. Imported PluralKit entries are tombstoned so a later import does not recreate them.</p>
              <label>Type DELETE
                <input id="historyEditorDeleteConfirm" autocomplete="off" spellcheck="false" placeholder="DELETE">
              </label>
              <div class="button-row">
                <button id="historyEditorCancelDelete" class="secondary-button" type="button">Cancel</button>
                <button id="historyEditorConfirmDelete" class="secondary-button danger-button" type="button" disabled>Delete entry</button>
              </div>
            </div>
          </aside>
        </div>

        <p id="historyEditorMessage" class="form-message history-editor-message"></p>
        <div class="modal-footer modal-footer-split history-editor-footer">
          <button id="historyEditorDeleteButton" class="text-button danger-text" type="button">Delete entry</button>
          <div>
            <button id="historyEditorCancelButton" class="secondary-button" type="button">Cancel</button>
            <button id="historyEditorReviewButton" class="secondary-button" type="button">Review changes</button>
            <button id="historyEditorApplyButton" class="primary-button" type="button" disabled>Apply correction</button>
          </div>
        </div>
      </div>\`;
    document.body.append(dialog);

    dialog.querySelector('#closeHistoryEditorButton').onclick=
      dialog.querySelector('#historyEditorCancelButton').onclick=()=>dialog.close();
    dialog.querySelector('#historyEditorMemberSearch').oninput=renderMemberPicker;
    dialog.querySelector('#historyEditorAlignTimes').onclick=alignMemberTimes;
    dialog.querySelector('#historyEditorReviewButton').onclick=reviewChanges;
    dialog.querySelector('#historyEditorApplyButton').onclick=applyCorrection;
    dialog.querySelector('#historyEditorDeleteButton').onclick=showDeletePanel;
    dialog.querySelector('#historyEditorCancelDelete').onclick=hideDeletePanel;
    dialog.querySelector('#historyEditorDeleteConfirm').oninput=event=>{
      dialog.querySelector('#historyEditorConfirmDelete').disabled=event.target.value!=='DELETE';
    };
    dialog.querySelector('#historyEditorConfirmDelete').onclick=deleteEntry;

    ['historyEditorStart','historyEditorEnd','historyEditorSource','historyEditorNote']
      .forEach(id=>dialog.querySelector('#'+id).addEventListener('input',invalidateReview));
    dialog.querySelector('#historyEditorOngoing').onchange=event=>{
      const end=dialog.querySelector('#historyEditorEnd');
      end.disabled=event.target.checked;
      if(event.target.checked){
        end.value='';
        for(const item of editorState?.links?.values()||[])item.leftAt=null;
      }else if(!end.value&&editorState?.front?.ended_at){
        end.value=toLocalInput(editorState.front.ended_at);
      }
      renderMemberTimes();
      invalidateReview();
    };

    let backdropDown=false;
    dialog.addEventListener('pointerdown',event=>{backdropDown=event.target===dialog});
    dialog.addEventListener('pointerup',event=>{
      if(backdropDown&&event.target===dialog)dialog.close();
      backdropDown=false;
    });
    dialog.addEventListener('pointercancel',()=>{backdropDown=false});
    dialog.addEventListener('close',()=>{editorState=null});
    return dialog;
  }

  function currentFrontPayload(){
    const dialog=ensureDialog();
    const startedAt=toIso(dialog.querySelector('#historyEditorStart').value);
    const ongoing=dialog.querySelector('#historyEditorOngoing').checked;
    const endValue=dialog.querySelector('#historyEditorEnd').value;
    if(!ongoing&&!endValue)throw new Error('Enter an end time, or mark the front as ongoing.');
    const endedAt=ongoing?null:toIso(endValue);
    const source=dialog.querySelector('#historyEditorSource').value;
    const note=dialog.querySelector('#historyEditorNote').value;
    const memberLinks=[...(editorState?.links?.entries()||[])].map(([memberId,item])=>({
      memberId,
      joinedAt:toIso(item.joinedAt),
      leftAt:ongoing?null:(item.leftAt?toIso(item.leftAt):null)
    }));
    return{frontId:editorState.front.id,startedAt,endedAt,source,note,memberLinks};
  }

  function invalidateReview(){
    if(!editorState)return;
    editorState.review=null;
    const dialog=ensureDialog();
    dialog.querySelector('#historyEditorReviewPanel').hidden=true;
    dialog.querySelector('#historyEditorApplyButton').disabled=true;
    dialog.querySelector('#historyEditorMessage').textContent='';
    hideDeletePanel();
    updateSourceHelp();
  }

  function updateSourceHelp(){
    if(!editorState)return;
    const dialog=ensureDialog();
    const selected=dialog.querySelector('#historyEditorSource').value;
    const current=editorState.front.source||'nihility';
    const help=dialog.querySelector('#historyEditorSourceHelp');
    if(current==='pluralkit'&&selected==='nihility'){
      help.textContent='This will detach the record from its PluralKit switch ID. The original PK switch will be tombstoned locally so importing history does not recreate it.';
    }else if(current==='pluralkit'){
      help.textContent='This entry remains linked to its original PluralKit switch ID. Nihility corrections do not write back to PluralKit.';
    }else if(current!=='nihility'&&selected==='nihility'){
      help.textContent='This will detach the record from its imported origin and make it a Nihility-local history entry.';
    }else{
      help.textContent='This is a Nihility-local history entry.';
    }
  }

  function renderCurrentSummary(){
    const box=ensureDialog().querySelector('#historyEditorCurrentSummary');
    box.replaceChildren();
    const f=editorState.front;
    const rows=[
      ['Start',fmtTime(f.started_at)],
      ['End',f.ended_at?fmtTime(f.ended_at):'Ongoing'],
      ['Duration',fmtDuration(f.started_at,f.ended_at)],
      ['Origin',f.source||'nihility'],
      ['Members',String(editorState.originalLinks.length)],
      ['Overlap status',(editorState.preview?.validation?.existing_overlap_count||0)+' existing']
    ];
    rows.forEach(([term,value])=>{
      const wrap=document.createElement('div');
      const dt=document.createElement('dt');dt.textContent=term;
      const dd=document.createElement('dd');dd.textContent=value;
      wrap.append(dt,dd);box.append(wrap);
    });
  }

  function renderMemberPicker(){
    if(!editorState)return;
    const dialog=ensureDialog();
    const box=dialog.querySelector('#historyEditorMemberPicker');
    const q=dialog.querySelector('#historyEditorMemberSearch').value.trim().toLowerCase();
    const members=[...state.members]
      .filter(m=>!q||[m.name,m.display_name,m.pronouns].filter(Boolean).some(v=>String(v).toLowerCase().includes(q)))
      .sort(byMemberName);
    box.replaceChildren();
    if(!members.length){
      const p=document.createElement('p');p.className='muted';p.textContent='No members match this search.';box.append(p);return;
    }
    members.forEach(m=>{
      const row=document.createElement('label');row.className='picker-row history-editor-picker-row';
      row.append(avatarEl(m,'picker-avatar'));
      const copy=document.createElement('span');copy.className='picker-copy';
      const strong=document.createElement('strong');strong.textContent=memberLabel(m);
      const small=document.createElement('small');
      small.textContent=(m.archived_at?'Archived · ':'')+(m.pronouns||m.name||'');
      copy.append(strong,small);
      const input=document.createElement('input');input.type='checkbox';input.value=m.id;input.checked=editorState.links.has(m.id);
      input.onchange=()=>{
        if(input.checked){
          const start=dialog.querySelector('#historyEditorStart').value;
          const end=dialog.querySelector('#historyEditorOngoing').checked?'':dialog.querySelector('#historyEditorEnd').value;
          editorState.links.set(m.id,{joinedAt:start,leftAt:end||null});
        }else{
          editorState.links.delete(m.id);
        }
        renderMemberTimes();
        updateSelectedCount();
        invalidateReview();
      };
      row.append(copy,input);box.append(row);
    });
    updateSelectedCount();
  }

  function updateSelectedCount(){
    const count=editorState?.links?.size||0;
    ensureDialog().querySelector('#historyEditorSelectedCount').textContent=count+' selected';
  }

  function renderMemberTimes(){
    if(!editorState)return;
    const dialog=ensureDialog();
    const box=dialog.querySelector('#historyEditorMemberTimes');
    const ongoing=dialog.querySelector('#historyEditorOngoing').checked;
    box.replaceChildren();
    const selected=[...editorState.links.entries()]
      .map(([id,times])=>({member:state.members.find(m=>m.id===id),id,times}))
      .filter(x=>x.member)
      .sort((a,b)=>byMemberName(a.member,b.member));
    if(!selected.length){
      const p=document.createElement('p');p.className='muted history-editor-empty';p.textContent='No members selected. This entry will represent a switch-out.';box.append(p);return;
    }
    selected.forEach(({member,id,times})=>{
      const row=document.createElement('div');row.className='history-member-time-row';
      const who=document.createElement('div');who.className='history-member-time-who';who.append(avatarEl(member,'timeline-avatar'));
      const copy=document.createElement('span');
      const strong=document.createElement('strong');strong.textContent=memberLabel(member);
      const small=document.createElement('small');small.textContent=member.archived_at?'Archived member':(member.pronouns||member.name||'');
      copy.append(strong,small);who.append(copy);

      const joinLabel=document.createElement('label');joinLabel.textContent='Joined';
      const join=document.createElement('input');join.type='datetime-local';join.value=times.joinedAt||'';join.required=true;
      join.oninput=()=>{times.joinedAt=join.value;invalidateReview()};
      joinLabel.append(join);

      const leaveLabel=document.createElement('label');leaveLabel.textContent='Left';
      const leave=document.createElement('input');leave.type='datetime-local';leave.value=times.leftAt||'';leave.disabled=ongoing;
      leave.oninput=()=>{times.leftAt=leave.value||null;invalidateReview()};
      leaveLabel.append(leave);

      const remove=document.createElement('button');remove.type='button';remove.className='icon-button';
      remove.setAttribute('aria-label','Remove '+memberLabel(member));remove.textContent='×';
      remove.onclick=()=>{
        editorState.links.delete(id);
        renderMemberTimes();renderMemberPicker();invalidateReview();
      };
      row.append(who,joinLabel,leaveLabel,remove);box.append(row);
    });
    updateSelectedCount();
  }

  function alignMemberTimes(){
    if(!editorState)return;
    const dialog=ensureDialog();
    const start=dialog.querySelector('#historyEditorStart').value;
    const end=dialog.querySelector('#historyEditorOngoing').checked?'':dialog.querySelector('#historyEditorEnd').value;
    if(!start)return;
    for(const item of editorState.links.values()){
      item.joinedAt=start;
      item.leftAt=end||null;
    }
    renderMemberTimes();invalidateReview();
  }

  function sameInstant(a,b){
    if(!a&&!b)return true;
    if(!a||!b)return false;
    return new Date(a).getTime()===new Date(b).getTime();
  }
  function renderReview(snapshot,payload){
    const dialog=ensureDialog();
    const panel=dialog.querySelector('#historyEditorReviewPanel');
    const box=dialog.querySelector('#historyEditorReviewSummary');
    box.replaceChildren();
    const before=snapshot.front||{};
    const addDiff=(label,beforeText,afterText)=>{
      const row=document.createElement('div');row.className='history-review-diff';
      const strong=document.createElement('strong');strong.textContent=label;
      const span=document.createElement('span');span.textContent=beforeText+' → '+afterText;
      row.append(strong,span);box.append(row);
    };
    let changed=false;
    if(!sameInstant(before.started_at,payload.startedAt)){addDiff('Start',fmtTime(before.started_at),fmtTime(payload.startedAt));changed=true}
    if(!sameInstant(before.ended_at,payload.endedAt)){addDiff('End',before.ended_at?fmtTime(before.ended_at):'Ongoing',payload.endedAt?fmtTime(payload.endedAt):'Ongoing');changed=true}
    if((before.source||'')!==payload.source){addDiff('Origin',before.source||'Unknown',payload.source);changed=true}
    if((before.note||'')!==(payload.note||'')){addDiff('Note',before.note||'No note',payload.note||'No note');changed=true}

    const beforeMembers=new Map((snapshot.links||[]).map(x=>[String(x.member_id),x]));
    const afterMembers=new Map(payload.memberLinks.map(x=>[String(x.memberId),x]));
    const added=[...afterMembers.keys()].filter(id=>!beforeMembers.has(id));
    const removed=[...beforeMembers.keys()].filter(id=>!afterMembers.has(id));
    const timingChanged=[...afterMembers.keys()].filter(id=>{
      const a=afterMembers.get(id),b=beforeMembers.get(id);
      return b&&(!sameInstant(a.joinedAt,b.joined_at)||!sameInstant(a.leftAt,b.left_at));
    });
    const addMemberSummary=(label,ids)=>{
      if(!ids.length)return;
      changed=true;
      const row=document.createElement('div');row.className='history-review-diff';
      const strong=document.createElement('strong');strong.textContent=label;
      const span=document.createElement('span');span.textContent=ids.map(id=>memberLabel(state.members.find(m=>m.id===id))).join(', ');
      row.append(strong,span);box.append(row);
    };
    addMemberSummary('Members added',added);
    addMemberSummary('Members removed',removed);
    addMemberSummary('Timing changed',timingChanged);

    if(!changed){
      const p=document.createElement('p');p.className='muted';p.textContent='No changes detected.';box.append(p);
    }

    const validation=document.createElement('div');validation.className='history-review-validation';
    const existing=Number(snapshot.validation?.existing_overlap_count||0);
    const proposed=Number(snapshot.validation?.proposed_overlap_count||0);
    validation.textContent=proposed
      ?'Validated: '+proposed+' existing overlap'+(proposed===1?' is':'s are')+' preserved without widening.'
      :'Validated: this correction creates no front overlap.';
    if(existing&&!proposed)validation.textContent+=' Existing overlap was reduced or removed.';
    box.append(validation);
    panel.hidden=false;
    return changed;
  }

  async function reviewChanges(){
    if(!editorState)return;
    const dialog=ensureDialog();
    const button=dialog.querySelector('#historyEditorReviewButton');
    const apply=dialog.querySelector('#historyEditorApplyButton');
    const message=dialog.querySelector('#historyEditorMessage');
    button.disabled=true;apply.disabled=true;message.textContent='Validating correction...';
    try{
      const payload=currentFrontPayload();
      const preview=await nihilityApi.secure('front_history_preview',payload);
      const changed=renderReview(preview,payload);
      editorState.review={payload,revision:preview.revision,preview};
      apply.disabled=!changed;
      message.textContent=changed?'Review validated. No changes have been saved yet.':'Nothing changed, so there is nothing to apply.';
    }catch(error){
      editorState.review=null;
      dialog.querySelector('#historyEditorReviewPanel').hidden=true;
      message.textContent=error.message;
    }finally{
      button.disabled=false;
    }
  }

  async function refreshAfterMutation(previousCount){
    await loadData();
    const wanted=Math.max(100,previousCount||0);
    while(state.fronts.length<wanted&&state.historyHasMore&&state.fronts.length){
      const oldest=[...state.fronts].sort((a,b)=>new Date(a.started_at)-new Date(b.started_at))[0];
      const rows=await nihilityApi.rest('fronts',{query:'select=*&started_at=lt.'+encodeURIComponent(oldest.started_at)+'&order=started_at.desc&limit=100'});
      const map=new Map(state.fronts.map(f=>[f.id,f]));
      (rows||[]).forEach(f=>map.set(f.id,f));
      state.fronts=[...map.values()].sort((a,b)=>new Date(b.started_at)-new Date(a.started_at));
      state.historyHasMore=(rows||[]).length===100;
      if(!(rows||[]).length)break;
    }
    renderHistory();renderHome();
  }

  async function applyCorrection(){
    if(!editorState?.review)return;
    const dialog=ensureDialog();
    const apply=dialog.querySelector('#historyEditorApplyButton');
    const reviewButton=dialog.querySelector('#historyEditorReviewButton');
    const message=dialog.querySelector('#historyEditorMessage');
    apply.disabled=true;reviewButton.disabled=true;
    message.textContent='Applying validated correction...';
    const previousCount=state.fronts.length;
    try{
      const payload={...editorState.review.payload,expectedRevision:editorState.review.revision};
      await nihilityApi.secure('front_history_correct',payload);
      dialog.close();
      await refreshAfterMutation(previousCount);
      toast('Front history corrected','The validated changes were saved.');
    }catch(error){
      message.textContent=error.message;
      editorState.review=null;
      dialog.querySelector('#historyEditorReviewPanel').hidden=true;
    }finally{
      reviewButton.disabled=false;
      apply.disabled=!editorState?.review;
    }
  }

  function showDeletePanel(){
    if(!editorState)return;
    const dialog=ensureDialog();
    dialog.querySelector('#historyEditorDeletePanel').hidden=false;
    dialog.querySelector('#historyEditorDeleteConfirm').value='';
    dialog.querySelector('#historyEditorConfirmDelete').disabled=true;
    dialog.querySelector('#historyEditorDeleteConfirm').focus();
  }
  function hideDeletePanel(){
    const dialog=document.querySelector('#frontHistoryEditorDialog');
    if(!dialog)return;
    dialog.querySelector('#historyEditorDeletePanel').hidden=true;
    dialog.querySelector('#historyEditorDeleteConfirm').value='';
    dialog.querySelector('#historyEditorConfirmDelete').disabled=true;
  }

  async function deleteEntry(){
    if(!editorState)return;
    const dialog=ensureDialog();
    const confirm=dialog.querySelector('#historyEditorDeleteConfirm');
    const button=dialog.querySelector('#historyEditorConfirmDelete');
    const message=dialog.querySelector('#historyEditorMessage');
    if(confirm.value!=='DELETE')return;
    button.disabled=true;message.textContent='Deleting history entry...';
    const previousCount=state.fronts.length;
    try{
      await nihilityApi.secure('front_history_delete',{
        frontId:editorState.front.id,
        expectedRevision:editorState.baseRevision
      });
      dialog.close();
      await refreshAfterMutation(Math.max(0,previousCount-1));
      toast('History entry deleted','The front record was removed.');
    }catch(error){
      message.textContent=error.message;
      button.disabled=false;
    }
  }

  async function openEditor(frontId){
    const front=state.fronts.find(f=>f.id===frontId);
    if(!front)return;
    const dialog=ensureDialog();
    const links=state.frontMembers.filter(x=>x.front_id===frontId);
    editorState={
      front:{...front},
      originalLinks:links.map(x=>({...x})),
      links:new Map(links.map(x=>[x.member_id,{joinedAt:toLocalInput(x.joined_at),leftAt:toLocalInput(x.left_at)}])),
      baseRevision:null,
      preview:null,
      review:null
    };

    dialog.querySelector('#historyEditorTitle').textContent='Edit '+fmtTime(front.started_at);
    dialog.querySelector('#historyEditorSubtitle').textContent='Correct timing, members, origin, or notes. Changes are validated before they can be applied.';
    dialog.querySelector('#historyEditorStart').value=toLocalInput(front.started_at);
    dialog.querySelector('#historyEditorEnd').value=toLocalInput(front.ended_at);
    dialog.querySelector('#historyEditorOngoing').checked=!front.ended_at;
    dialog.querySelector('#historyEditorEnd').disabled=!front.ended_at;
    dialog.querySelector('#historyEditorNote').value=front.note||'';
    dialog.querySelector('#historyEditorMemberSearch').value='';
    dialog.querySelector('#historyEditorMessage').textContent='Loading current revision...';
    dialog.querySelector('#historyEditorReviewPanel').hidden=true;
    dialog.querySelector('#historyEditorApplyButton').disabled=true;
    dialog.querySelector('#historyEditorReviewButton').disabled=false;
    dialog.querySelector('#historyEditorDeleteButton').disabled=true;
    hideDeletePanel();

    const source=dialog.querySelector('#historyEditorSource');source.replaceChildren();
    const currentSource=front.source||'nihility';
    const addOption=(value,label)=>{const option=document.createElement('option');option.value=value;option.textContent=label;source.append(option)};
    addOption(currentSource,currentSource==='nihility'?'Nihility (local)':currentSource==='pluralkit'?'PluralKit import (linked)':currentSource+' import');
    if(currentSource!=='nihility')addOption('nihility','Nihility (detach from import)');
    source.value=currentSource;
    updateSourceHelp();

    renderMemberPicker();renderMemberTimes();
    dialog.showModal();

    try{
      const preview=await nihilityApi.secure('front_history_preview',currentFrontPayload());
      if(!editorState||editorState.front.id!==frontId)return;
      editorState.baseRevision=preview.revision;
      editorState.preview=preview;
      renderCurrentSummary();
      dialog.querySelector('#historyEditorDeleteButton').disabled=false;
      dialog.querySelector('#historyEditorMessage').textContent='Ready. Review changes before applying them.';
    }catch(error){
      if(!editorState||editorState.front.id!==frontId)return;
      dialog.querySelector('#historyEditorMessage').textContent=error.message;
      dialog.querySelector('#historyEditorReviewButton').disabled=true;
    }
  }

  window.nihilityOpenFrontHistoryEditor=openEditor;
})();

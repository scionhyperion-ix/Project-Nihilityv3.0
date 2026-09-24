'use strict';

(()=>{
  state.memberFieldDefinitions=[];
  state.memberFieldValues=[];
  state.memberTags=[];
  state.memberTagLinks=[];

  const keyify=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,32);
  const fieldName=def=>def?.label||def?.key||'Field';

  async function restAll(table,base){
    const out=[];let offset=0;
    while(true){
      const rows=await nihilityApi.rest(table,{query:(base?base+'&':'')+'limit=1000&offset='+offset});
      out.push(...(rows||[]));
      if(!rows||rows.length<1000)break;
      offset+=1000;
      if(offset>1000000)throw new Error('Custom member data exceeds the safe loading limit.');
    }
    return out;
  }

  const coreLoadData=loadData;
  loadData=async function(){
    const customPromise=Promise.all([
      restAll('member_field_definitions','select=*&order=position.asc,id.asc'),
      restAll('member_field_values','select=*&order=member_id.asc,field_id.asc'),
      restAll('member_tags','select=*&order=name.asc'),
      restAll('member_tag_links','select=*&order=member_id.asc,tag_id.asc')
    ]);
    await coreLoadData();
    const [defs,values,tags,links]=await customPromise;
    state.memberFieldDefinitions=defs;
    state.memberFieldValues=values;
    state.memberTags=tags;
    state.memberTagLinks=links;
    renderAll();
  };

  function valuesFor(memberId){return state.memberFieldValues.filter(x=>x.member_id===memberId)}
  function tagsFor(memberId){
    const ids=new Set(state.memberTagLinks.filter(x=>x.member_id===memberId).map(x=>x.tag_id));
    return state.memberTags.filter(x=>ids.has(x.id));
  }
  function valueFor(memberId,fieldId){return state.memberFieldValues.find(x=>x.member_id===memberId&&x.field_id===fieldId)?.value}
  function groupsFor(memberId){
    const ids=new Set((state.memberGroups||[]).filter(x=>x.member_id===memberId).map(x=>x.group_id));
    return (state.groups||[]).filter(g=>ids.has(g.id));
  }
  function searchable(value){
    if(value===null||value===undefined)return '';
    if(Array.isArray(value))return value.map(searchable).join(' ');
    if(typeof value==='boolean')return value?'yes true':'no false';
    return String(value);
  }
  function has(value,needle){return searchable(value).toLowerCase().includes(needle)}
  function tokenize(query){
    const result=[],re=/([a-z][a-z0-9_-]*):(?:"([^"]*)"|([^\s]+))|"([^"]+)"|([^\s]+)/gi;let m;
    while((m=re.exec(query))!==null){
      result.push(m[1]?{key:m[1].toLowerCase(),value:String(m[2]??m[3]??'').toLowerCase()}:{key:null,value:String(m[4]??m[5]??'').toLowerCase()});
    }
    return result;
  }
  function definitionFor(key){
    const normalized=keyify(key);
    return state.memberFieldDefinitions.find(d=>d.key===normalized||keyify(d.label)===normalized)||null;
  }
  function matchesMember(member,query){
    const terms=tokenize(query);
    if(!terms.length)return true;
    const tags=tagsFor(member.id),values=valuesFor(member.id),groups=groupsFor(member.id);
    const base=[member.name,member.display_name,member.pronouns,member.description,member.birthday];
    return terms.every(term=>{
      if(!term.value)return true;
      if(!term.key){
        if(base.some(v=>has(v,term.value)))return true;
        if(tags.some(t=>has(t.name,term.value)))return true;
        if(groups.some(g=>has(g.name,term.value)||has(g.display_name,term.value)))return true;
        return values.some(row=>{
          const def=state.memberFieldDefinitions.find(d=>d.id===row.field_id);
          return has(row.value,term.value)||has(def?.label,term.value)||has(def?.key,term.value);
        });
      }
      if(term.key==='tag'||term.key==='tags')return tags.some(t=>has(t.name,term.value));
      if(term.key==='group')return groups.some(g=>has(g.name,term.value)||has(g.display_name,term.value));
      if(term.key==='name')return has(member.name,term.value)||has(member.display_name,term.value);
      if(term.key==='pronouns')return has(member.pronouns,term.value);
      if(term.key==='birthday')return has(member.birthday,term.value);
      const def=definitionFor(term.key);if(!def)return false;
      const row=values.find(v=>v.field_id===def.id);return Boolean(row&&has(row.value,term.value));
    });
  }

  function decorateCard(card,member){
    const tags=tagsFor(member.id);if(!tags.length)return;
    const wrap=document.createElement('div');wrap.className='member-custom-tag-row';
    tags.slice(0,5).forEach(tag=>{
      const chip=document.createElement('span');chip.className='member-custom-tag-chip';chip.textContent=tag.name;
      if(tag.color)chip.style.setProperty('--tag-color','#'+tag.color);
      wrap.append(chip);
    });
    if(tags.length>5){const more=document.createElement('span');more.className='member-custom-tag-more';more.textContent='+'+(tags.length-5);wrap.append(more)}
    card.append(wrap);
  }

  function ensureMemberSection(){
    if(document.querySelector('#memberCustomDataSection'))return;
    const stage=document.querySelector('#memberFieldsStage');if(!stage)return;
    const section=document.createElement('section');section.id='memberCustomDataSection';section.className='member-custom-data-section';
    const heading=document.createElement('div');heading.className='editor-section-heading';
    const title=document.createElement('span');title.textContent='Custom fields and tags';
    const small=document.createElement('small');small.textContent='Optional structured details used by Nihility search and filters.';
    heading.append(title,small);
    const tags=document.createElement('div');tags.id='memberCustomTags';tags.className='member-custom-tags-editor';
    const fields=document.createElement('div');fields.id='memberCustomFields';fields.className='member-custom-fields-editor';
    section.append(heading,tags,fields);stage.append(section);
  }

  function makeFieldControl(def,value){
    let input;
    if(def.field_type==='long_text'){
      input=document.createElement('textarea');input.rows=3;input.maxLength=4000;input.value=typeof value==='string'?value:'';
    }else if(def.field_type==='boolean'){
      input=document.createElement('select');
      [['','Not set'],['true','Yes'],['false','No']].forEach(pair=>{const o=document.createElement('option');o.value=pair[0];o.textContent=pair[1];input.append(o)});
      input.value=value===true?'true':value===false?'false':'';
    }else if(def.field_type==='select'){
      input=document.createElement('select');const blank=document.createElement('option');blank.value='';blank.textContent='Not set';input.append(blank);
      (def.options||[]).forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;input.append(o)});
      input.value=typeof value==='string'?value:'';
    }else if(def.field_type==='multi_select'){
      input=document.createElement('div');input.className='member-custom-multiselect';
      const chosen=new Set(Array.isArray(value)?value:[]);
      (def.options||[]).forEach(v=>{const l=document.createElement('label');const c=document.createElement('input');c.type='checkbox';c.value=v;c.checked=chosen.has(v);const t=document.createElement('span');t.textContent=v;l.append(c,t);input.append(l)});
    }else{
      input=document.createElement('input');input.type=def.field_type==='number'?'number':def.field_type==='date'?'date':'text';
      if(def.field_type==='text')input.maxLength=500;
      if(def.field_type==='number'){input.step='any';input.min='-1000000000000000';input.max='1000000000000000'}
      input.value=value===null||value===undefined?'':String(value);
    }
    input.dataset.customFieldId=def.id;input.dataset.customFieldType=def.field_type;return input;
  }

  function renderMemberEditor(member=null){
    ensureMemberSection();
    const tagBox=document.querySelector('#memberCustomTags'),fieldBox=document.querySelector('#memberCustomFields');if(!tagBox||!fieldBox)return;
    tagBox.replaceChildren();fieldBox.replaceChildren();

    const tagHead=document.createElement('div');tagHead.className='member-custom-subheading';
    const tagStrong=document.createElement('strong');tagStrong.textContent='Tags';
    const tagSmall=document.createElement('small');tagSmall.textContent=state.memberTags.length?'Choose up to 100 tags.':'No tags have been defined yet.';
    tagHead.append(tagStrong,tagSmall);tagBox.append(tagHead);
    if(state.memberTags.length){
      const picker=document.createElement('div');picker.className='member-custom-tag-picker';
      const selected=new Set(member?tagsFor(member.id).map(t=>t.id):[]);
      state.memberTags.forEach(tag=>{
        const l=document.createElement('label');l.className='member-custom-tag-option';
        const c=document.createElement('input');c.type='checkbox';c.value=tag.id;c.checked=selected.has(tag.id);
        const span=document.createElement('span');span.textContent=tag.name;if(tag.color)span.style.setProperty('--tag-color','#'+tag.color);
        l.append(c,span);picker.append(l);
      });tagBox.append(picker);
    }

    const fieldHead=document.createElement('div');fieldHead.className='member-custom-subheading';
    const fieldStrong=document.createElement('strong');fieldStrong.textContent='Custom fields';
    const fieldSmall=document.createElement('small');fieldSmall.textContent=state.memberFieldDefinitions.length?'All values are optional.':'No custom fields have been defined yet.';
    fieldHead.append(fieldStrong,fieldSmall);fieldBox.append(fieldHead);
    [...state.memberFieldDefinitions].sort((a,b)=>(a.position-b.position)||fieldName(a).localeCompare(fieldName(b))).forEach(def=>{
      const label=document.createElement('label');label.className='member-custom-field';
      const title=document.createElement('span');title.className='member-custom-field-label';title.textContent=def.label;
      if(def.description){const help=document.createElement('small');help.textContent=def.description;title.append(help)}
      label.append(title,makeFieldControl(def,member?valueFor(member.id,def.id):null));fieldBox.append(label);
    });
  }

  function collectValues(){
    const rows=[];
    state.memberFieldDefinitions.forEach(def=>{
      const root=document.querySelector('[data-custom-field-id="'+CSS.escape(def.id)+'"]');if(!root)return;
      let value;
      if(def.field_type==='multi_select'){
        value=[...root.querySelectorAll('input:checked')].map(x=>x.value);if(!value.length)return;
      }else if(def.field_type==='boolean'){
        if(root.value==='')return;value=root.value==='true';
      }else if(def.field_type==='number'){
        if(root.value==='')return;value=Number(root.value);if(!Number.isFinite(value)||Math.abs(value)>1e15)throw new Error(def.label+' must be a valid number.');
      }else{
        value=String(root.value||'').trim();if(!value)return;
      }
      rows.push({field_id:def.id,value});
    });
    return rows;
  }
  async function saveMemberCustomData(memberId){
    const tagIds=[...document.querySelectorAll('#memberCustomTags input:checked')].map(x=>x.value);
    if(tagIds.length>100)throw new Error('A member can have at most 100 tags.');
    await nihilityApi.rpc('replace_member_custom_data',{p_member_id:memberId,p_values:collectValues(),p_tag_ids:tagIds});
  }

  const coreOpenMember=openMember;
  openMember=function(member=null){coreOpenMember(member);renderMemberEditor(member)};

  function ensureSettingsPanel(){
    let panel=document.querySelector('#memberMetadataSettingsPanel');if(panel)return panel;
    const grid=document.querySelector('#settingsRoute .settings-grid');if(!grid)return null;
    panel=document.createElement('article');panel.id='memberMetadataSettingsPanel';panel.className='panel section-panel member-metadata-settings settings-card settings-card-wide';
    panel.innerHTML='<div class="member-metadata-header"><div class="member-metadata-title"><p class="eyebrow">Member metadata</p><h3>Custom fields and tags</h3><p class="muted">Add structured details to member profiles, then find them quickly from Members.</p></div><div class="member-metadata-counts" aria-label="Metadata totals"><span id="customFieldCount" class="soft-pill metadata-count-pill">0 fields</span><span id="memberTagCount" class="soft-pill metadata-count-pill">0 tags</span></div></div><div class="member-metadata-search-help"><span>Search examples</span><code>source:RE</code><code>tag:frequent</code><code>doctor</code></div><div class="member-metadata-settings-grid"><section class="member-metadata-section"><div class="member-metadata-section-heading"><div><strong>Custom fields</strong><small>Structured profile details such as source, role, age, species, or subsystem.</small></div><button id="newCustomFieldButton" class="secondary-button compact-metadata-button" type="button">+ New field</button></div><div id="customFieldDefinitionList" class="member-metadata-list"></div></section><section class="member-metadata-section"><div class="member-metadata-section-heading"><div><strong>Tags</strong><small>Reusable labels for fast filtering and lightweight member categories.</small></div><button id="newMemberTagButton" class="secondary-button compact-metadata-button" type="button">+ New tag</button></div><div id="memberTagDefinitionList" class="member-metadata-list member-tag-definition-grid"></div></section></div>';
    const backup=document.querySelector('#backupPanel');if(backup)backup.insertAdjacentElement('beforebegin',panel);else grid.append(panel);
    panel.querySelector('#newCustomFieldButton').onclick=()=>openFieldDialog();
    panel.querySelector('#newMemberTagButton').onclick=()=>openTagDialog();
    return panel;
  }

  function renderSettingsPanel(){
    const panel=ensureSettingsPanel();if(!panel)return;
    panel.hidden=state.profile?.role!=='owner';if(panel.hidden)return;
    const fieldCount=panel.querySelector('#customFieldCount'),tagCount=panel.querySelector('#memberTagCount');
    if(fieldCount)fieldCount.textContent=state.memberFieldDefinitions.length+' field'+(state.memberFieldDefinitions.length===1?'':'s');
    if(tagCount)tagCount.textContent=state.memberTags.length+' tag'+(state.memberTags.length===1?'':'s');

    const defs=panel.querySelector('#customFieldDefinitionList');defs.replaceChildren();
    state.memberFieldDefinitions.forEach(def=>{
      const row=document.createElement('div');row.className='member-metadata-row member-field-definition-row';
      const copy=document.createElement('div');copy.className='member-metadata-row-copy';
      const top=document.createElement('div');top.className='member-metadata-row-title';
      const strong=document.createElement('strong');strong.textContent=def.label;
      const key=document.createElement('code');key.className='member-field-key';key.textContent=def.key;
      top.append(strong,key);
      const small=document.createElement('small');small.textContent=def.description||'No description';
      const type=document.createElement('span');type.className='member-field-type';type.textContent=def.field_type.replace('_',' ');
      copy.append(top,small,type);
      const actions=document.createElement('div');actions.className='member-metadata-row-actions';
      const edit=document.createElement('button');edit.type='button';edit.className='text-button';edit.textContent='Edit';edit.onclick=()=>openFieldDialog(def);
      const del=document.createElement('button');del.type='button';del.className='text-button danger-text';del.textContent='Delete';del.onclick=()=>deleteField(def);
      actions.append(edit,del);row.append(copy,actions);defs.append(row);
    });
    if(!state.memberFieldDefinitions.length){
      const empty=document.createElement('div');empty.className='member-metadata-empty';
      const icon=document.createElement('span');icon.className='member-metadata-empty-icon';icon.textContent='Aa';
      const copy=document.createElement('div');const strong=document.createElement('strong');strong.textContent='No custom fields yet';
      const p=document.createElement('p');p.textContent='Create fields like Source, Role, Species, Age, or Subsystem. Each field gets a searchable key.';
      copy.append(strong,p);empty.append(icon,copy);defs.append(empty);
    }

    const tags=panel.querySelector('#memberTagDefinitionList');tags.replaceChildren();
    state.memberTags.forEach(tag=>{
      const row=document.createElement('div');row.className='member-tag-definition-card';
      if(tag.color)row.style.setProperty('--tag-color','#'+tag.color);
      const copy=document.createElement('div');copy.className='member-tag-definition-copy';
      const swatch=document.createElement('span');swatch.className='member-tag-definition-swatch';
      const strong=document.createElement('strong');strong.textContent=tag.name;
      copy.append(swatch,strong);
      const actions=document.createElement('div');actions.className='member-metadata-row-actions';
      const edit=document.createElement('button');edit.type='button';edit.className='text-button';edit.textContent='Edit';edit.onclick=()=>openTagDialog(tag);
      const del=document.createElement('button');del.type='button';del.className='text-button danger-text';del.textContent='Delete';del.onclick=()=>deleteTag(tag);
      actions.append(edit,del);row.append(copy,actions);tags.append(row);
    });
    if(!state.memberTags.length){
      const empty=document.createElement('div');empty.className='member-metadata-empty';
      const icon=document.createElement('span');icon.className='member-metadata-empty-icon tag-empty-icon';icon.textContent='#';
      const copy=document.createElement('div');const strong=document.createElement('strong');strong.textContent='No tags yet';
      const p=document.createElement('p');p.textContent='Add reusable labels such as frequent, doctor, caretaker, or source-specific categories.';
      copy.append(strong,p);empty.append(icon,copy);tags.append(empty);
    }
  }

  function ensureFieldDialog(){
    let d=document.querySelector('#memberFieldDefinitionDialog');if(d)return d;
    d=document.createElement('dialog');d.id='memberFieldDefinitionDialog';d.className='modal-dialog';
    d.innerHTML='<form id="memberFieldDefinitionForm" class="modal-card"><div class="modal-heading"><div><p class="eyebrow">Member custom field</p><h3 id="memberFieldDialogTitle">New custom field</h3></div><button class="icon-button field-dialog-close" type="button" aria-label="Close">×</button></div><input id="memberFieldDefinitionId" type="hidden"><div class="form-grid two-col"><label>Label<input id="memberFieldLabel" maxlength="80" required placeholder="Source"></label><label>Search key<input id="memberFieldKey" maxlength="32" required pattern="[a-z][a-z0-9_]{0,31}" placeholder="source"></label><label>Type<select id="memberFieldType"><option value="text">Text</option><option value="long_text">Long text</option><option value="number">Number</option><option value="boolean">Yes / No</option><option value="date">Date</option><option value="select">Select</option><option value="multi_select">Multi-select</option></select></label><label>Position<input id="memberFieldPosition" type="number" min="0" max="10000" value="0"></label></div><label>Description<input id="memberFieldDescription" maxlength="240" placeholder="Optional helper text"></label><label id="memberFieldOptionsRow" hidden>Options<textarea id="memberFieldOptions" rows="6" placeholder="One option per line"></textarea><small>Changing options is blocked if existing values would become invalid.</small></label><p id="memberFieldDialogError" class="form-error" hidden></p><div class="modal-footer"><button class="secondary-button field-dialog-close" type="button">Cancel</button><button class="primary-button" type="submit">Save field</button></div></form>';
    document.body.append(d);
    d.querySelectorAll('.field-dialog-close').forEach(b=>b.onclick=()=>d.close());
    d.querySelector('#memberFieldType').onchange=()=>{d.querySelector('#memberFieldOptionsRow').hidden=!['select','multi_select'].includes(d.querySelector('#memberFieldType').value)};
    d.querySelector('#memberFieldLabel').oninput=()=>{const key=d.querySelector('#memberFieldKey');if(!key.dataset.touched)key.value=keyify(d.querySelector('#memberFieldLabel').value)};
    d.querySelector('#memberFieldKey').oninput=e=>{e.target.dataset.touched='true';e.target.value=keyify(e.target.value)};
    d.querySelector('#memberFieldDefinitionForm').onsubmit=saveField;return d;
  }
  function openFieldDialog(def=null){
    const d=ensureFieldDialog();d.querySelector('#memberFieldDialogTitle').textContent=def?'Edit custom field':'New custom field';
    d.querySelector('#memberFieldDefinitionId').value=def?.id||'';d.querySelector('#memberFieldLabel').value=def?.label||'';
    const key=d.querySelector('#memberFieldKey');key.value=def?.key||'';key.dataset.touched=def?'true':'';
    d.querySelector('#memberFieldType').value=def?.field_type||'text';d.querySelector('#memberFieldPosition').value=String(def?.position||0);
    d.querySelector('#memberFieldDescription').value=def?.description||'';d.querySelector('#memberFieldOptions').value=Array.isArray(def?.options)?def.options.join('\n'):'';
    d.querySelector('#memberFieldOptionsRow').hidden=!['select','multi_select'].includes(d.querySelector('#memberFieldType').value);
    d.querySelector('#memberFieldDialogError').hidden=true;d.showModal();
  }
  async function saveField(e){
    e.preventDefault();const d=ensureFieldDialog(),err=d.querySelector('#memberFieldDialogError');err.hidden=true;
    try{
      const id=d.querySelector('#memberFieldDefinitionId').value,label=d.querySelector('#memberFieldLabel').value.trim(),key=keyify(d.querySelector('#memberFieldKey').value),type=d.querySelector('#memberFieldType').value;
      const options=['select','multi_select'].includes(type)?d.querySelector('#memberFieldOptions').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):[];
      if(!label)throw new Error('Label is required.');if(!/^[a-z][a-z0-9_]{0,31}$/.test(key))throw new Error('Search key must start with a letter and use lowercase letters, numbers, or underscores.');
      if(new Set(options.map(x=>x.toLowerCase())).size!==options.length)throw new Error('Options must be unique.');
      const body={user_id:state.user.id,key,label,description:d.querySelector('#memberFieldDescription').value.trim()||null,field_type:type,options,position:Number(d.querySelector('#memberFieldPosition').value||0)};
      if(id)await nihilityApi.rest('member_field_definitions',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body,prefer:'return=minimal'});
      else await nihilityApi.rest('member_field_definitions',{method:'POST',body,prefer:'return=minimal'});
      d.close();await loadData();renderAll();toast(id?'Custom field updated':'Custom field created');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }
  async function deleteField(def){
    if(!confirm('Delete the custom field "'+def.label+'"? Its values will be removed from every member.'))return;
    await nihilityApi.rest('member_field_definitions',{method:'DELETE',query:'id=eq.'+encodeURIComponent(def.id),prefer:'return=minimal'});
    await loadData();renderAll();toast('Custom field deleted',def.label);
  }

  function ensureTagDialog(){
    let d=document.querySelector('#memberTagDialog');if(d)return d;
    d=document.createElement('dialog');d.id='memberTagDialog';d.className='modal-dialog';
    d.innerHTML='<form id="memberTagForm" class="modal-card"><div class="modal-heading"><div><p class="eyebrow">Member tag</p><h3 id="memberTagDialogTitle">New tag</h3></div><button class="icon-button tag-dialog-close" type="button" aria-label="Close">×</button></div><input id="memberTagId" type="hidden"><div class="form-grid two-col"><label>Name<input id="memberTagName" maxlength="60" required placeholder="frequent"></label><label>Color<input id="memberTagColor" maxlength="7" placeholder="#8B7CF6"></label></div><p id="memberTagDialogError" class="form-error" hidden></p><div class="modal-footer"><button class="secondary-button tag-dialog-close" type="button">Cancel</button><button class="primary-button" type="submit">Save tag</button></div></form>';
    document.body.append(d);d.querySelectorAll('.tag-dialog-close').forEach(b=>b.onclick=()=>d.close());d.querySelector('#memberTagForm').onsubmit=saveTag;return d;
  }
  function openTagDialog(tag=null){
    const d=ensureTagDialog();d.querySelector('#memberTagDialogTitle').textContent=tag?'Edit tag':'New tag';d.querySelector('#memberTagId').value=tag?.id||'';d.querySelector('#memberTagName').value=tag?.name||'';d.querySelector('#memberTagColor').value=tag?.color?'#'+tag.color:'';d.querySelector('#memberTagDialogError').hidden=true;d.showModal();
  }
  async function saveTag(e){
    e.preventDefault();const d=ensureTagDialog(),err=d.querySelector('#memberTagDialogError');err.hidden=true;
    try{
      const id=d.querySelector('#memberTagId').value,name=d.querySelector('#memberTagName').value.trim(),color=hex(d.querySelector('#memberTagColor').value);
      if(!name)throw new Error('Tag name is required.');const body={user_id:state.user.id,name,color:color?color.slice(1).toLowerCase():null};
      if(id)await nihilityApi.rest('member_tags',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body,prefer:'return=minimal'});
      else await nihilityApi.rest('member_tags',{method:'POST',body,prefer:'return=minimal'});
      d.close();await loadData();renderAll();toast(id?'Tag updated':'Tag created');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }
  async function deleteTag(tag){
    if(!confirm('Delete the tag "'+tag.name+'"? It will be removed from every member.'))return;
    await nihilityApi.rest('member_tags',{method:'DELETE',query:'id=eq.'+encodeURIComponent(tag.id),prefer:'return=minimal'});
    await loadData();renderAll();toast('Tag deleted',tag.name);
  }

  const coreRenderSettings=renderSettings;
  renderSettings=function(){coreRenderSettings();renderSettingsPanel()};

  window.nihilityMemberCustom={matchesMember,decorateCard,saveMemberCustomData,renderMemberEditor,renderSettingsPanel};
})();

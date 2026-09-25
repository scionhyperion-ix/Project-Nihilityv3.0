'use strict';

(()=>{
  state.memberConnections=[];

  async function loadAllConnections(){
    const out=[];let offset=0;
    while(true){
      const rows=await nihilityApi.rest('member_connections',{query:'select=*&order=updated_at.desc&limit=1000&offset='+offset});
      out.push(...(rows||[]));
      if(!rows||rows.length<1000)break;
      offset+=1000;
      if(offset>10000)throw new Error('Member connections exceed the safe loading limit.');
    }
    return out;
  }

  const coreLoadData=loadData;
  loadData=async function(){
    const connectionPromise=loadAllConnections();
    await coreLoadData();
    state.memberConnections=await connectionPromise;
    if(!window.nihilityInitialHydration&&!window.nihilitySilentRefresh)renderAll();
  };

  function memberById(id){return state.members.find(m=>m.id===id)||null}
  function connectionsFor(memberId){
    return state.memberConnections.filter(c=>c.source_member_id===memberId||c.target_member_id===memberId);
  }
  function connectionView(connection,memberId){
    const sourceSide=connection.source_member_id===memberId;
    const otherId=sourceSide?connection.target_member_id:connection.source_member_id;
    return {
      connection,
      other:memberById(otherId),
      myLabel:sourceSide?connection.source_label:connection.target_label,
      theirLabel:sourceSide?connection.target_label:connection.source_label
    };
  }

  function ensureProfileSection(){
    if(document.querySelector('#memberConnectionsSection'))return;
    const stage=document.querySelector('#memberFieldsStage');
    if(!stage)return;
    const section=document.createElement('section');
    section.id='memberConnectionsSection';
    section.className='member-connections-section';

    const heading=document.createElement('div');
    heading.className='editor-section-heading member-connections-heading';
    const copy=document.createElement('div');
    const title=document.createElement('span');title.textContent='Connections';
    const small=document.createElement('small');small.textContent='Optional member-to-member relationships stored only in Nihility.';
    copy.append(title,small);

    const actions=document.createElement('div');actions.className='member-connections-actions';
    const graph=document.createElement('button');graph.id='viewMemberGraphButton';graph.type='button';graph.className='secondary-button';graph.textContent='View graph';
    const add=document.createElement('button');add.id='addMemberConnectionButton';add.type='button';add.className='secondary-button';add.textContent='Add connection';
    actions.append(graph,add);
    heading.append(copy,actions);

    const list=document.createElement('div');list.id='memberConnectionsList';list.className='member-connections-list';
    section.append(heading,list);
    stage.append(section);

    add.onclick=()=>openConnectionDialog();
    graph.onclick=()=>openGraphDialog();
  }

  function renderProfileConnections(member=null){
    ensureProfileSection();
    const list=document.querySelector('#memberConnectionsList');
    const add=document.querySelector('#addMemberConnectionButton');
    const graph=document.querySelector('#viewMemberGraphButton');
    if(!list||!add||!graph)return;

    list.replaceChildren();
    if(!member?.id){
      add.disabled=true;graph.disabled=true;
      const p=document.createElement('p');p.className='muted';p.textContent='Save this member before adding connections.';list.append(p);return;
    }

    add.disabled=Boolean(member.archived_at);
    add.title=member.archived_at?'Archived members keep existing connections but cannot receive new ones.':'';
    const rows=connectionsFor(member.id).map(c=>connectionView(c,member.id)).filter(x=>x.other);
    graph.disabled=rows.length===0;

    if(!rows.length){
      const p=document.createElement('p');p.className='muted';p.textContent='No member connections yet.';list.append(p);return;
    }

    rows.sort((a,b)=>label(a.other).localeCompare(label(b.other),undefined,{sensitivity:'base',numeric:true}));
    rows.forEach(view=>{
      const row=document.createElement('div');row.className='member-connection-row';
      const identity=document.createElement('button');identity.type='button';identity.className='member-connection-identity';
      identity.append(avatarEl(view.other,'timeline-avatar'));
      const copy=document.createElement('span');copy.className='member-connection-copy';
      const strong=document.createElement('strong');strong.textContent=label(view.other);
      const relationship=document.createElement('small');relationship.textContent=view.myLabel+' · '+view.theirLabel+' to you';
      copy.append(strong,relationship);identity.append(copy);
      identity.onclick=()=>{document.querySelector('#memberDialog')?.close();openMember(view.other)};

      const controls=document.createElement('div');controls.className='member-connection-controls';
      const edit=document.createElement('button');edit.type='button';edit.className='text-button';edit.textContent='Edit';edit.onclick=()=>openConnectionDialog(view.connection);
      const del=document.createElement('button');del.type='button';del.className='text-button danger-text';del.textContent='Remove';del.onclick=()=>removeConnection(view.connection,member);
      controls.append(edit,del);
      row.append(identity,controls);list.append(row);
    });
  }

  const coreOpenMember=openMember;
  openMember=function(member=null){
    coreOpenMember(member);
    renderProfileConnections(member);
  };

  function ensureConnectionDialog(){
    let d=document.querySelector('#memberConnectionDialog');if(d)return d;
    d=document.createElement('dialog');d.id='memberConnectionDialog';d.className='modal-dialog';
    d.innerHTML='<form id="memberConnectionForm" class="modal-card"><div class="modal-heading"><div><p class="eyebrow">Member connection</p><h3 id="memberConnectionDialogTitle">Add connection</h3><p class="muted">Labels are directional. For example, Parent to them and Child to you.</p></div><button class="icon-button member-connection-close" type="button" aria-label="Close">×</button></div><input id="memberConnectionId" type="hidden"><input id="memberConnectionMemberId" type="hidden"><label>Connected member<select id="memberConnectionTarget" required></select></label><div class="form-grid two-col"><label id="memberConnectionMyLabelWrap">This member is their<input id="memberConnectionMyLabel" maxlength="80" required placeholder="Parent"></label><label id="memberConnectionTheirLabelWrap">They are this member&apos;s<input id="memberConnectionTheirLabel" maxlength="80" required placeholder="Child"></label></div><p id="memberConnectionError" class="form-error" hidden></p><div class="modal-footer"><button class="secondary-button member-connection-close" type="button">Cancel</button><button class="primary-button" type="submit">Save connection</button></div></form>';
    document.body.append(d);
    d.querySelectorAll('.member-connection-close').forEach(b=>b.onclick=()=>d.close());
    d.querySelector('#memberConnectionForm').onsubmit=saveConnection;
    return d;
  }

  function currentEditedMember(){
    const id=document.querySelector('#memberId')?.value;
    return id?memberById(id):null;
  }

  function fillTargetOptions(current,editing=null){
    const select=document.querySelector('#memberConnectionTarget');select.replaceChildren();
    const existingOtherIds=new Set(connectionsFor(current.id).map(c=>c.source_member_id===current.id?c.target_member_id:c.source_member_id));
    const editingView=editing?connectionView(editing,current.id):null;
    const candidates=state.members
      .filter(m=>m.id!==current.id)
      .filter(m=>!m.archived_at||m.id===editingView?.other?.id)
      .filter(m=>!existingOtherIds.has(m.id)||m.id===editingView?.other?.id)
      .sort((a,b)=>label(a).localeCompare(label(b),undefined,{sensitivity:'base',numeric:true}));
    candidates.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=label(m)+(m.archived_at?' (archived)':'');select.append(o)});
    return candidates;
  }

  function openConnectionDialog(connection=null){
    const current=currentEditedMember();if(!current?.id)return;
    if(!connection&&current.archived_at){toast('Archived member','Restore the member before adding a new connection.');return}
    const d=ensureConnectionDialog();
    const view=connection?connectionView(connection,current.id):null;
    const candidates=fillTargetOptions(current,connection);
    d.querySelector('#memberConnectionDialogTitle').textContent=connection?'Edit connection':'Add connection';
    d.querySelector('#memberConnectionId').value=connection?.id||'';
    d.querySelector('#memberConnectionMemberId').value=current.id;
    d.querySelector('#memberConnectionTarget').disabled=Boolean(connection);
    if(connection&&view?.other)d.querySelector('#memberConnectionTarget').value=view.other.id;
    d.querySelector('#memberConnectionMyLabel').value=view?.myLabel||'';
    d.querySelector('#memberConnectionTheirLabel').value=view?.theirLabel||'';
    d.querySelector('#memberConnectionMyLabelWrap').firstChild.textContent=label(current)+' is their';
    d.querySelector('#memberConnectionTheirLabelWrap').firstChild.textContent='They are '+label(current)+"'s";
    d.querySelector('#memberConnectionError').hidden=true;
    if(!connection&&!candidates.length){
      toast('No available members','Every eligible active member is already connected.');
      return;
    }
    d.showModal();
  }

  async function saveConnection(event){
    event.preventDefault();
    const d=ensureConnectionDialog(),err=d.querySelector('#memberConnectionError');err.hidden=true;
    try{
      const id=d.querySelector('#memberConnectionId').value;
      const currentId=d.querySelector('#memberConnectionMemberId').value;
      const current=memberById(currentId);
      const targetId=d.querySelector('#memberConnectionTarget').value;
      const myLabel=d.querySelector('#memberConnectionMyLabel').value.trim();
      const theirLabel=d.querySelector('#memberConnectionTheirLabel').value.trim();
      if(!current||!targetId)throw new Error('Choose a connected member.');
      if(!myLabel||!theirLabel)throw new Error('Both directional relationship labels are required.');

      if(id){
        const existing=state.memberConnections.find(c=>c.id===id);
        if(!existing)throw new Error('Connection no longer exists.');
        const sourceSide=existing.source_member_id===current.id;
        const body=sourceSide
          ?{source_label:myLabel,target_label:theirLabel}
          :{source_label:theirLabel,target_label:myLabel};
        await nihilityApi.rest('member_connections',{method:'PATCH',query:'id=eq.'+encodeURIComponent(id),body,prefer:'return=minimal'});
      }else{
        const target=memberById(targetId);
        if(target?.archived_at)throw new Error('Restore the connected member before creating this relationship.');
        await nihilityApi.rest('member_connections',{
          method:'POST',
          body:{user_id:state.user.id,source_member_id:current.id,target_member_id:targetId,source_label:myLabel,target_label:theirLabel},
          prefer:'return=minimal'
        });
      }

      d.close();await loadData();
      const refreshed=memberById(current.id);if(refreshed&&document.querySelector('#memberDialog')?.open)renderProfileConnections(refreshed);
      toast(id?'Connection updated':'Connection added');
    }catch(error){err.textContent=error.message;err.hidden=false}
  }

  async function removeConnection(connection,current){
    const view=connectionView(connection,current.id);
    if(!confirm('Remove the connection between '+label(current)+' and '+label(view.other)+'?'))return;
    await nihilityApi.rest('member_connections',{method:'DELETE',query:'id=eq.'+encodeURIComponent(connection.id),prefer:'return=minimal'});
    await loadData();
    if(document.querySelector('#memberDialog')?.open)renderProfileConnections(memberById(current.id));
    toast('Connection removed');
  }

  function ensureGraphDialog(){
    let d=document.querySelector('#memberRelationshipGraphDialog');if(d)return d;
    d=document.createElement('dialog');d.id='memberRelationshipGraphDialog';d.className='modal-dialog member-relationship-graph-dialog';
    d.innerHTML='<div class="modal-card member-relationship-graph-card"><div class="modal-heading"><div><p class="eyebrow">Relationship graph</p><h3 id="memberRelationshipGraphTitle">Connections</h3><p id="memberRelationshipGraphNote" class="muted"></p></div><button class="icon-button member-graph-close" type="button" aria-label="Close">×</button></div><div id="memberRelationshipGraphCanvas" class="member-relationship-graph-canvas"></div><div class="modal-footer"><button class="secondary-button member-graph-close" type="button">Close</button></div></div>';
    document.body.append(d);
    d.querySelectorAll('.member-graph-close').forEach(b=>b.onclick=()=>d.close());
    return d;
  }

  function svgEl(name,attrs={}){
    const node=document.createElementNS('http://www.w3.org/2000/svg',name);
    Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,String(v)));
    return node;
  }

  function openGraphDialog(){
    const current=currentEditedMember();if(!current?.id)return;
    const views=connectionsFor(current.id).map(c=>connectionView(c,current.id)).filter(v=>v.other);
    if(!views.length)return;
    const d=ensureGraphDialog(),box=d.querySelector('#memberRelationshipGraphCanvas');box.replaceChildren();
    d.querySelector('#memberRelationshipGraphTitle').textContent=label(current)+' connections';

    const shown=views.slice(0,40);
    d.querySelector('#memberRelationshipGraphNote').textContent=views.length>40
      ?'Showing 40 of '+views.length+' direct connections. The profile list still contains every connection.'
      :'Direct connections only. Select a member node to open their profile.';

    const width=900,height=Math.max(520,Math.min(900,360+shown.length*8)),cx=width/2,cy=height/2;
    const radius=Math.min(width,height)*0.34;
    const svg=svgEl('svg',{viewBox:'0 0 '+width+' '+height,role:'img','aria-label':'Relationship graph for '+label(current)});
    const center=svgEl('g',{class:'relationship-graph-node relationship-graph-center',tabindex:'0',role:'button'});
    const centerCircle=svgEl('circle',{cx,cy,r:46});const centerText=svgEl('text',{x:cx,y:cy+5,'text-anchor':'middle'});centerText.textContent=label(current).slice(0,18);
    center.append(centerCircle,centerText);svg.append(center);

    shown.forEach((view,index)=>{
      const angle=(Math.PI*2*index/shown.length)-Math.PI/2;
      const x=cx+Math.cos(angle)*radius,y=cy+Math.sin(angle)*radius;
      const line=svgEl('line',{x1:cx,y1:cy,x2:x,y2:y,class:'relationship-graph-edge'});
      svg.insertBefore(line,center);

      const mx=(cx+x)/2,my=(cy+y)/2;
      const edgeLabel=svgEl('text',{x:mx,y:my-6,'text-anchor':'middle',class:'relationship-graph-edge-label'});
      edgeLabel.textContent=(view.myLabel+' / '+view.theirLabel).slice(0,28);svg.append(edgeLabel);

      const group=svgEl('g',{class:'relationship-graph-node',tabindex:'0',role:'button','aria-label':'Open '+label(view.other)});
      const circle=svgEl('circle',{cx:x,cy:y,r:35});
      const text=svgEl('text',{x,y:y+4,'text-anchor':'middle'});text.textContent=label(view.other).slice(0,14);
      group.append(circle,text);
      const open=()=>{d.close();document.querySelector('#memberDialog')?.close();openMember(view.other)};
      group.addEventListener('click',open);
      group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}});
      svg.append(group);
    });
    box.append(svg);d.showModal();
  }

  window.nihilityMemberConnections={connectionsFor,renderProfileConnections,openGraphDialog};
})();

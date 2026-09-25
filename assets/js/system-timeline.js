'use strict';

(()=>{
  state.timelineEvents=[];
  state.timelineHasMore=false;
  state.timelineLoaded=0;
  const PAGE_SIZE=150;

  async function fetchTimelinePage(offset=0){
    const rows=await nihilityApi.rest('system_events',{
      query:'select=*&order=occurred_at.desc,id.desc&limit='+PAGE_SIZE+'&offset='+offset
    });
    return rows||[];
  }

  const coreLoadData=loadData;
  loadData=async function(){
    const timelinePromise=fetchTimelinePage(0);
    await coreLoadData();
    const rows=await timelinePromise;
    state.timelineEvents=rows;
    state.timelineLoaded=rows.length;
    state.timelineHasMore=rows.length===PAGE_SIZE;
    if(!window.nihilitySilentRefresh)renderTimeline();
  };

  function memberNameById(id){
    const m=state.members.find(x=>x.id===id);
    return m?label(m):'Member';
  }
  function groupNameById(id){
    const g=(state.groups||[]).find(x=>x.id===id);
    return g?(g.display_name||g.name||'Group'):'Group';
  }
  function frontMembersForEvent(event){
    if(!event.front_id)return[];
    const ids=state.frontMembers.filter(x=>x.front_id===event.front_id).map(x=>x.member_id);
    return ids.map(id=>state.members.find(m=>m.id===id)).filter(Boolean);
  }
  function categoryFor(type){
    if(type==='front_logged')return'fronting';
    if(type.startsWith('member_'))return'members';
    if(type.startsWith('group_')||type.startsWith('member_group_'))return'groups';
    if(type.startsWith('connection_'))return'relationships';
    if(type.startsWith('integration_'))return'integrations';
    if(type==='backup_restored')return'data';
    return'other';
  }
  function safeSource(event){
    const source=String(event?.metadata?.source||'').toLowerCase();
    if(source==='pluralkit')return'PluralKit';
    if(source==='tupperbox')return'Tupperbox';
    if(source==='nihility')return'Nihility';
    return source?'Integration':'Integration';
  }
  function describe(event){
    const meta=event.metadata||{};
    const member=event.member_id?memberNameById(event.member_id):'Member';
    const related=event.related_member_id?memberNameById(event.related_member_id):'Member';
    const group=event.group_id?groupNameById(event.group_id):'Group';

    switch(event.event_type){
      case'front_logged':{
        const members=frontMembersForEvent(event);
        return{
          title:members.length?('Front started · '+members.map(label).join(', ')):'Switch-out recorded',
          detail:'Front history event',
          icon:'↻'
        };
      }
      case'member_created':return{title:member+' was created',detail:'Member profile added',icon:'+'};
      case'member_archived':return{title:member+' was archived',detail:'Member remains available to historical records',icon:'□'};
      case'member_restored':return{title:member+' was restored',detail:'Member returned to the active directory',icon:'↥'};
      case'group_created':return{title:group+' was created',detail:'System group added',icon:'▦'};
      case'member_group_added':return{title:member+' joined '+group,detail:'Group membership added',icon:'+'};
      case'member_group_removed':return{title:member+' left '+group,detail:'Group membership removed',icon:'−'};
      case'connection_added':return{title:member+' connected with '+related,detail:[meta.source_label,meta.target_label].filter(Boolean).join(' ↔ ')||'Relationship added',icon:'◇'};
      case'connection_updated':return{title:'Connection updated · '+member+' / '+related,detail:[meta.source_label,meta.target_label].filter(Boolean).join(' ↔ ')||'Relationship labels changed',icon:'◇'};
      case'connection_removed':return{title:'Connection removed · '+member+' / '+related,detail:[meta.source_label,meta.target_label].filter(Boolean).join(' ↔ ')||'Relationship removed',icon:'◇'};
      case'integration_imported':return{title:safeSource(event)+' import completed',detail:'Imported data was recorded in Nihility',icon:'⇣'};
      case'integration_synced':{
        const toN=Number(meta.members_to_nihility||0)+Number(meta.groups_to_nihility||0)+Number(meta.memberships_to_nihility||0)+Number(meta.members_created_in_nihility||0)+Number(meta.groups_created_in_nihility||0);
        const toP=Number(meta.members_to_pk||0)+Number(meta.groups_to_pk||0)+Number(meta.memberships_to_pk||0)+Number(meta.members_created_in_pk||0)+Number(meta.groups_created_in_pk||0);
        const conflicts=Number(meta.conflicts_skipped||0),blocked=Number(meta.blocked_count||0);
        const parts=[toN?toN+' to Nihility':'',toP?toP+' to PluralKit':'',conflicts?conflicts+' conflicts skipped':'',blocked?blocked+' blocked':''].filter(Boolean);
        return{title:'PluralKit sync completed',detail:parts.join(' · ')||'No data changes were required',icon:'⇄'};
      }
      case'backup_restored':return{title:'Nihility backup restored',detail:'Replacement restore completed successfully',icon:'↺'};
      default:return{title:'System activity',detail:event.event_type.replaceAll('_',' '),icon:'•'};
    }
  }

  function eventSearchText(event){
    const view=describe(event);
    return[
      view.title,view.detail,event.event_type,
      event.member_id?memberNameById(event.member_id):'',
      event.related_member_id?memberNameById(event.related_member_id):'',
      event.group_id?groupNameById(event.group_id):''
    ].join(' ').toLowerCase();
  }
  function selectedMemberMatches(event,memberId){
    if(memberId==='all')return true;
    if(event.member_id===memberId||event.related_member_id===memberId)return true;
    if(event.front_id&&state.frontMembers.some(x=>x.front_id===event.front_id&&x.member_id===memberId))return true;
    return false;
  }
  function filteredEvents(){
    const q=(document.querySelector('#timelineSearch')?.value||'').trim().toLowerCase();
    const category=document.querySelector('#timelineCategoryFilter')?.value||'all';
    const member=document.querySelector('#timelineMemberFilter')?.value||'all';
    const range=document.querySelector('#timelineRangeFilter')?.value||'all';
    const now=Date.now();
    return state.timelineEvents.filter(event=>{
      if(category!=='all'&&categoryFor(event.event_type)!==category)return false;
      if(!selectedMemberMatches(event,member))return false;
      if(q&&!eventSearchText(event).includes(q))return false;
      if(range!=='all'){
        const days=Number(range);
        if(Number.isFinite(days)&&now-new Date(event.occurred_at).getTime()>days*86400000)return false;
      }
      return true;
    });
  }
  function dateKey(ts){
    const d=new Date(ts);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function dateHeading(ts){
    const d=new Date(ts),today=new Date(),yesterday=new Date(Date.now()-86400000);
    if(d.toDateString()===today.toDateString())return'Today';
    if(d.toDateString()===yesterday.toDateString())return'Yesterday';
    return d.toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});
  }
  function timeText(ts){
    return new Date(ts).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  }

  function installTimelineRoute(){
    if(!document.querySelector('#timelineRoute')){
      const route=document.createElement('section');route.id='timelineRoute';route.className='route-view';route.hidden=true;
      route.innerHTML='<article class="panel section-panel system-timeline-panel"><div class="panel-heading split-heading"><div><p class="eyebrow">System history</p><h3>Timeline</h3></div><span id="timelineResultCount" class="soft-pill">0 events</span></div><p class="muted timeline-intro">A chronological view of fronting, member lifecycle, groups, relationships, imports, syncs, and restores. Private notes, mood, context, credentials, and security logs are not copied into timeline events.</p><div class="timeline-toolbar"><label class="search-field timeline-search-field"><span>⌕</span><input id="timelineSearch" type="search" placeholder="Search timeline" autocomplete="off" aria-label="Search timeline"></label><label class="timeline-filter-field"><span class="timeline-filter-label">Category</span><span class="timeline-select-wrap"><select id="timelineCategoryFilter"><option value="all">All activity</option><option value="fronting">Fronting</option><option value="members">Members</option><option value="groups">Groups</option><option value="relationships">Relationships</option><option value="integrations">Integrations</option><option value="data">Data safety</option></select></span></label><label class="timeline-filter-field"><span class="timeline-filter-label">Member</span><span class="timeline-select-wrap"><select id="timelineMemberFilter"><option value="all">All members</option></select></span></label><label class="timeline-filter-field"><span class="timeline-filter-label">Range</span><span class="timeline-select-wrap"><select id="timelineRangeFilter"><option value="all">All loaded</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select></span></label></div><div id="systemTimelineList" class="system-timeline-list"></div><div class="timeline-load-row"><button id="timelineLoadOlderButton" class="secondary-button" type="button">Load older</button></div></article>';
      document.querySelector('#historyRoute')?.insertAdjacentElement('beforebegin',route);
      route.querySelector('#timelineSearch').oninput=renderTimeline;
      route.querySelector('#timelineCategoryFilter').onchange=renderTimeline;
      route.querySelector('#timelineMemberFilter').onchange=renderTimeline;
      route.querySelector('#timelineRangeFilter').onchange=renderTimeline;
      route.querySelector('#timelineLoadOlderButton').onclick=loadOlderTimeline;
    }

    if(!document.querySelector('.nav-list [data-route="timeline"]')){
      const b=document.createElement('button');b.className='nav-item';b.dataset.route='timeline';b.type='button';b.innerHTML='<span>◷</span>Timeline';
      document.querySelector('.nav-list [data-route="history"]')?.insertAdjacentElement('beforebegin',b);
      b.onclick=()=>setRoute('timeline');
    }
    if(!document.querySelector('.mobile-nav [data-route="timeline"]')){
      const b=document.createElement('button');b.className='mobile-nav-item';b.dataset.route='timeline';b.type='button';b.innerHTML='<span>◷</span>Timeline';
      document.querySelector('.mobile-nav [data-route="history"]')?.insertAdjacentElement('beforebegin',b);
      b.onclick=()=>setRoute('timeline');
    }
  }

  function refreshMemberFilter(){
    const select=document.querySelector('#timelineMemberFilter');if(!select)return;
    const current=select.value||'all';select.replaceChildren();
    const all=document.createElement('option');all.value='all';all.textContent='All members';select.append(all);
    [...state.members].sort((a,b)=>label(a).localeCompare(label(b),undefined,{numeric:true,sensitivity:'base'})).forEach(m=>{
      const o=document.createElement('option');o.value=m.id;o.textContent=label(m)+(m.archived_at?' (archived)':'');select.append(o);
    });
    select.value=[...select.options].some(o=>o.value===current)?current:'all';
  }

  function renderTimeline(){
    installTimelineRoute();
    refreshMemberFilter();
    const list=document.querySelector('#systemTimelineList');if(!list)return;
    const rows=filteredEvents();list.replaceChildren();
    const count=document.querySelector('#timelineResultCount');if(count)count.textContent=rows.length+' event'+(rows.length===1?'':'s');
    const load=document.querySelector('#timelineLoadOlderButton');if(load)load.hidden=!state.timelineHasMore;

    if(!rows.length){
      const empty=document.createElement('div');empty.className='empty-state timeline-empty';
      const h=document.createElement('h3');h.textContent='No timeline events found';
      const p=document.createElement('p');p.textContent='Try another filter, or create new system activity.';
      empty.append(h,p);list.append(empty);return;
    }

    let lastDate='';
    rows.forEach(event=>{
      const key=dateKey(event.occurred_at);
      if(key!==lastDate){
        const heading=document.createElement('div');heading.className='timeline-date-heading';heading.textContent=dateHeading(event.occurred_at);list.append(heading);lastDate=key;
      }
      const view=describe(event);
      const row=document.createElement('article');row.className='system-timeline-event';
      const icon=document.createElement('span');icon.className='system-timeline-icon';icon.textContent=view.icon;
      const body=document.createElement('div');body.className='system-timeline-copy';
      const title=document.createElement('strong');title.textContent=view.title;
      const detail=document.createElement('small');detail.textContent=view.detail;
      body.append(title,detail);
      const time=document.createElement('time');time.dateTime=event.occurred_at;time.textContent=timeText(event.occurred_at);
      row.append(icon,body,time);

      const openMemberId=event.member_id||event.related_member_id;
      if(openMemberId){
        const target=state.members.find(m=>m.id===openMemberId);
        if(target){
          row.classList.add('is-actionable');row.tabIndex=0;row.setAttribute('role','button');
          const open=()=>openMember(target);
          row.onclick=open;
          row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}};
        }
      }else if(event.front_id&&window.nihilityOpenFrontHistoryEditor){
        row.classList.add('is-actionable');row.tabIndex=0;row.setAttribute('role','button');
        const open=()=>window.nihilityOpenFrontHistoryEditor(event.front_id);
        row.onclick=open;
        row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}};
      }
      list.append(row);
    });
  }

  async function loadOlderTimeline(){
    const button=document.querySelector('#timelineLoadOlderButton');if(button){button.disabled=true;button.textContent='Loading...'}
    try{
      const rows=await fetchTimelinePage(state.timelineLoaded);
      state.timelineLoaded+=rows.length;
      const seen=new Set(state.timelineEvents.map(x=>x.id));
      state.timelineEvents.push(...rows.filter(x=>!seen.has(x.id)));
      state.timelineEvents.sort((a,b)=>{
        const byTime=new Date(b.occurred_at)-new Date(a.occurred_at);
        return byTime||String(b.id).localeCompare(String(a.id));
      });
      state.timelineHasMore=rows.length===PAGE_SIZE;
      renderTimeline();
    }catch(error){
      toast('Unable to load older timeline events',error.message,'error');
    }finally{
      if(button){button.disabled=false;button.textContent='Load older'}
    }
  }

  const coreSetRoute=setRoute;
  setRoute=function(route){
    if(route!=='timeline')return coreSetRoute(route);
    installTimelineRoute();
    state.route='timeline';
    document.querySelector('#pageEyebrow').textContent='System history';
    document.querySelector('#pageTitle').textContent='Timeline';
    document.querySelectorAll('.route-view').forEach(v=>v.hidden=v.id!=='timelineRoute');
    document.querySelectorAll('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route==='timeline'));
    const oldFrontManager=document.querySelector('#openFrontManager');if(oldFrontManager)oldFrontManager.hidden=true;
    history.replaceState(null,'',location.pathname+'#timeline');
    renderTimeline();
  };

  installTimelineRoute();
  window.nihilitySystemTimeline={render:renderTimeline,loadOlder:loadOlderTimeline};
  document.addEventListener('nihility-silent-refresh-applied',()=>{
    if(state.route==='timeline')renderTimeline();
  });

})();

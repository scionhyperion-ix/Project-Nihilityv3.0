'use strict';

(function installFriendsFeature(){
  const REFRESH_MS=20000;
  let dashboard=null;
  let loading=false;
  let refreshTimer=null;

  function formatFriendCode(value){
    const clean=String(value||'').replace(/[^0-9A-F]/gi,'').toUpperCase();
    return clean.match(/.{1,5}/g)?.join('-')||clean;
  }

  function friendInitial(name){
    return String(name||'N').trim().charAt(0).toUpperCase()||'N';
  }

  function elapsedText(ts){
    if(!ts)return'';
    const ms=Math.max(0,Date.now()-new Date(ts).getTime());
    const minutes=Math.floor(ms/60000);
    if(minutes<1)return'now';
    if(minutes<60)return minutes+'m';
    const hours=Math.floor(minutes/60);
    const rest=minutes%60;
    if(hours<24)return rest?hours+'h '+rest+'m':hours+'h';
    const days=Math.floor(hours/24);
    return days+'d '+(hours%24)+'h';
  }

  function setFriendsMessage(message,type=''){
    const box=document.querySelector('#friendsMessage');
    if(!box)return;
    box.textContent=message||'';
    box.classList.toggle('friend-message-error',type==='error');
  }

  function installFriendsRoute(){
    if(!document.querySelector('#friendsRoute')){
      const route=document.createElement('section');
      route.id='friendsRoute';
      route.className='route-view friends-route';
      route.hidden=true;
      route.innerHTML=`
        <div class="friends-heading">
          <div>
            <p class="eyebrow">Private social sharing</p>
            <h3>Friends</h3>
            <p class="muted">Add another Nihility user and share only your current front with accepted friends.</p>
          </div>
        </div>

        <div class="friends-grid">
          <article class="panel friend-code-panel">
            <div class="friend-panel-heading">
              <div><p class="eyebrow">Your Friend Code</p><h3 id="friendCodeValue">Loading...</h3></div>
              <button id="copyFriendCodeButton" class="secondary-button" type="button">Copy</button>
            </div>
            <p class="muted friend-panel-copy">Share this code with someone you trust. It does not expose your email or account ID.</p>
            <label class="friend-share-toggle">
              <span><strong>Share current front</strong><small>Accepted friends can see current fronter names, pronouns, colors, and front start times.</small></span>
              <input id="friendShareFront" type="checkbox">
            </label>
          </article>

          <article class="panel friend-add-panel">
            <p class="eyebrow">Add friend</p>
            <h3>Send a request</h3>
            <p class="muted friend-panel-copy">Enter their Friend Code. They must accept before either side appears as friends.</p>
            <form id="friendRequestForm" class="friend-request-form">
              <input id="friendCodeInput" type="text" inputmode="text" autocomplete="off" maxlength="32" placeholder="ABCDE-FGHIJ-KLMNO-PQRST" aria-label="Friend Code" required>
              <button class="primary-button" type="submit">Send request</button>
            </form>
            <p id="friendsMessage" class="form-message"></p>
          </article>
        </div>

        <article class="panel section-panel friends-section">
          <div class="panel-heading split-heading">
            <div><p class="eyebrow">Connected</p><h3>Your friends</h3></div>
          </div>
          <div id="friendsList" class="friends-list"></div>
        </article>

        <div class="friends-request-grid">
          <article class="panel section-panel friends-section">
            <div class="panel-heading split-heading">
              <div><p class="eyebrow">Requests</p><h3>Incoming</h3></div>
            </div>
            <div id="friendIncomingList" class="friend-request-list"></div>
          </article>

          <article class="panel section-panel friends-section">
            <div class="panel-heading split-heading">
              <div><p class="eyebrow">Requests</p><h3>Sent</h3></div>
            </div>
            <div id="friendOutgoingList" class="friend-request-list"></div>
          </article>
        </div>
      `;
      document.querySelector('#historyRoute')?.insertAdjacentElement('beforebegin',route);

      route.querySelector('#friendRequestForm').addEventListener('submit',sendFriendRequest);
      route.querySelector('#copyFriendCodeButton').addEventListener('click',copyFriendCode);
      route.querySelector('#friendShareFront').addEventListener('change',updateSharing);
    }

    if(!document.querySelector('.nav-list [data-route="friends"]')){
      const button=document.createElement('button');
      button.className='nav-item';
      button.dataset.route='friends';
      button.type='button';
      button.innerHTML='<span>♧</span>Friends';
      document.querySelector('.nav-list [data-route="history"]')?.insertAdjacentElement('beforebegin',button);
      button.onclick=()=>setRoute('friends');
    }

    const more=document.querySelector('#mobileNavMoreMenu');
    if(more&&!more.querySelector('[data-route="friends"]')){
      const button=document.createElement('button');
      button.className='mobile-nav-more-option';
      button.dataset.route='friends';
      button.type='button';
      button.setAttribute('role','menuitem');
      button.innerHTML='<span>♧</span><span>Friends</span>';
      more.prepend(button);
      button.onclick=()=>setRoute('friends');
    }
  }

  async function loadFriends({quiet=false}={}){
    if(loading)return;
    loading=true;
    if(!quiet)setFriendsMessage('');
    try{
      dashboard=await nihilityApi.rpc('friend_dashboard');
      renderFriends();
    }catch(error){
      if(!quiet)setFriendsMessage(error.message||'Unable to load friends.','error');
      const list=document.querySelector('#friendsList');
      if(list&&!quiet){
        list.replaceChildren();
        const p=document.createElement('p');
        p.className='muted friends-empty';
        p.textContent='Friends could not be loaded.';
        list.append(p);
      }
    }finally{
      loading=false;
    }
  }

  function renderFriends(){
    if(!dashboard)return;
    const code=document.querySelector('#friendCodeValue');
    const share=document.querySelector('#friendShareFront');
    if(code)code.textContent=formatFriendCode(dashboard.friend_code);
    if(share)share.checked=Boolean(dashboard.share_front);

    renderAcceptedFriends(Array.isArray(dashboard.friends)?dashboard.friends:[]);
    renderIncoming(Array.isArray(dashboard.incoming)?dashboard.incoming:[]);
    renderOutgoing(Array.isArray(dashboard.outgoing)?dashboard.outgoing:[]);
  }

  function renderAcceptedFriends(friends){
    const list=document.querySelector('#friendsList');
    if(!list)return;
    list.replaceChildren();

    if(!friends.length){
      const empty=document.createElement('div');
      empty.className='friends-empty';
      empty.innerHTML='<strong>No friends yet</strong><span>Send a Friend Code request, or accept one when it arrives.</span>';
      list.append(empty);
      return;
    }

    friends.forEach(friend=>{
      const card=document.createElement('article');
      card.className='friend-card';

      const header=document.createElement('div');
      header.className='friend-card-header';

      const identity=document.createElement('div');
      identity.className='friend-identity';
      const avatar=document.createElement('div');
      avatar.className='friend-avatar';
      avatar.textContent=friendInitial(friend.display_name);
      const copy=document.createElement('div');
      copy.className='friend-identity-copy';
      const name=document.createElement('strong');
      name.textContent=friend.display_name||'Nihility friend';
      const status=document.createElement('span');
      status.textContent=friend.sharing_enabled?'Current front shared':'Front sharing is hidden';
      copy.append(name,status);
      identity.append(avatar,copy);

      const remove=document.createElement('button');
      remove.type='button';
      remove.className='text-button danger-text friend-remove-button';
      remove.textContent='Remove';
      remove.onclick=()=>removeFriend(friend.friendship_id,friend.display_name);

      header.append(identity,remove);
      card.append(header);

      const front=document.createElement('div');
      front.className='friend-front';

      if(!friend.sharing_enabled){
        const hidden=document.createElement('p');
        hidden.className='muted friend-front-empty';
        hidden.textContent='This friend is not sharing their current front.';
        front.append(hidden);
      }else{
        const fronters=Array.isArray(friend.fronters)?friend.fronters:[];
        if(!fronters.length){
          const empty=document.createElement('p');
          empty.className='muted friend-front-empty';
          empty.textContent='Nobody is currently fronting.';
          front.append(empty);
        }else{
          fronters.forEach(fronter=>{
            const row=document.createElement('div');
            row.className='friend-fronter-row';
            const dot=document.createElement('span');
            dot.className='friend-fronter-dot';
            if(/^[0-9A-Fa-f]{6}$/.test(String(fronter.color||'')))dot.style.background='#'+fronter.color;
            const details=document.createElement('div');
            details.className='friend-fronter-copy';
            const memberName=document.createElement('strong');
            memberName.textContent=fronter.display_name||'Member';
            const meta=document.createElement('span');
            const bits=[];
            if(fronter.pronouns)bits.push(fronter.pronouns);
            if(fronter.joined_at)bits.push('fronting '+elapsedText(fronter.joined_at));
            meta.textContent=bits.join(' · ')||'Currently fronting';
            details.append(memberName,meta);
            row.append(dot,details);
            front.append(row);
          });
        }
      }

      card.append(front);
      list.append(card);
    });
  }

  function requestRow(item,kind){
    const row=document.createElement('div');
    row.className='friend-request-row';

    const copy=document.createElement('div');
    copy.className='friend-request-copy';
    const name=document.createElement('strong');
    name.textContent=item.display_name||'Nihility user';
    const time=document.createElement('span');
    time.textContent=kind==='incoming'?'Wants to be friends':'Waiting for acceptance';
    copy.append(name,time);

    const actions=document.createElement('div');
    actions.className='friend-request-actions';

    if(kind==='incoming'){
      const accept=document.createElement('button');
      accept.type='button';
      accept.className='secondary-button';
      accept.textContent='Accept';
      accept.onclick=()=>respondToFriend(item.friendship_id,true);

      const decline=document.createElement('button');
      decline.type='button';
      decline.className='text-button danger-text';
      decline.textContent='Decline';
      decline.onclick=()=>respondToFriend(item.friendship_id,false);
      actions.append(accept,decline);
    }else{
      const cancel=document.createElement('button');
      cancel.type='button';
      cancel.className='text-button danger-text';
      cancel.textContent='Cancel';
      cancel.onclick=()=>cancelFriendRequest(item.friendship_id);
      actions.append(cancel);
    }

    row.append(copy,actions);
    return row;
  }

  function renderIncoming(items){
    const list=document.querySelector('#friendIncomingList');
    if(!list)return;
    list.replaceChildren();
    if(!items.length){
      const p=document.createElement('p');
      p.className='muted friend-request-empty';
      p.textContent='No incoming requests.';
      list.append(p);
      return;
    }
    items.forEach(item=>list.append(requestRow(item,'incoming')));
  }

  function renderOutgoing(items){
    const list=document.querySelector('#friendOutgoingList');
    if(!list)return;
    list.replaceChildren();
    if(!items.length){
      const p=document.createElement('p');
      p.className='muted friend-request-empty';
      p.textContent='No pending sent requests.';
      list.append(p);
      return;
    }
    items.forEach(item=>list.append(requestRow(item,'outgoing')));
  }

  async function copyFriendCode(){
    if(!dashboard?.friend_code)return;
    const formatted=formatFriendCode(dashboard.friend_code);
    try{
      await navigator.clipboard.writeText(formatted);
      toast('Friend Code copied','Share it only with someone you trust.');
    }catch{
      setFriendsMessage('Could not copy automatically. Select the Friend Code and copy it manually.','error');
    }
  }

  async function sendFriendRequest(event){
    event.preventDefault();
    const input=document.querySelector('#friendCodeInput');
    const code=input?.value||'';
    if(!code.trim())return;
    const submit=event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled=true;
    setFriendsMessage('Sending request...');
    try{
      await nihilityApi.rpc('friend_request',{p_friend_code:code});
      input.value='';
      setFriendsMessage('Friend request sent.');
      await loadFriends({quiet:true});
    }catch(error){
      setFriendsMessage(error.message||'Unable to send friend request.','error');
    }finally{
      submit.disabled=false;
    }
  }

  async function respondToFriend(id,accept){
    setFriendsMessage(accept?'Accepting request...':'Declining request...');
    try{
      await nihilityApi.rpc('friend_respond',{p_friendship_id:id,p_accept:Boolean(accept)});
      setFriendsMessage(accept?'Friend added.':'Request declined.');
      await loadFriends({quiet:true});
    }catch(error){
      setFriendsMessage(error.message||'Unable to update friend request.','error');
    }
  }

  async function cancelFriendRequest(id){
    setFriendsMessage('Cancelling request...');
    try{
      await nihilityApi.rpc('friend_cancel_request',{p_friendship_id:id});
      setFriendsMessage('Request cancelled.');
      await loadFriends({quiet:true});
    }catch(error){
      setFriendsMessage(error.message||'Unable to cancel request.','error');
    }
  }

  async function removeFriend(id,name){
    if(!confirm('Remove '+(name||'this friend')+'? They will immediately lose access to your shared current front.'))return;
    setFriendsMessage('Removing friend...');
    try{
      await nihilityApi.rpc('friend_remove',{p_friendship_id:id});
      setFriendsMessage('Friend removed.');
      await loadFriends({quiet:true});
    }catch(error){
      setFriendsMessage(error.message||'Unable to remove friend.','error');
    }
  }

  async function updateSharing(event){
    const input=event.currentTarget;
    input.disabled=true;
    try{
      await nihilityApi.rpc('friend_set_sharing',{p_enabled:Boolean(input.checked)});
      if(dashboard)dashboard.share_front=Boolean(input.checked);
      toast(
        input.checked?'Front sharing enabled':'Front sharing hidden',
        input.checked?'Accepted friends can now see your current front.':'Accepted friends can no longer see your current front.'
      );
    }catch(error){
      input.checked=!input.checked;
      setFriendsMessage(error.message||'Unable to update front sharing.','error');
    }finally{
      input.disabled=false;
    }
  }

  function startFriendRefresh(){
    stopFriendRefresh();
    refreshTimer=setInterval(()=>{
      if(state.route==='friends'&&!document.hidden)void loadFriends({quiet:true});
    },REFRESH_MS);
  }

  function stopFriendRefresh(){
    if(refreshTimer){
      clearInterval(refreshTimer);
      refreshTimer=null;
    }
  }

  installFriendsRoute();

  const previousSetRoute=setRoute;
  setRoute=function setRouteWithFriends(route){
    if(route!=='friends'){
      stopFriendRefresh();
      return previousSetRoute(route);
    }

    installFriendsRoute();
    state.route='friends';
    document.querySelector('#pageEyebrow').textContent='Private social sharing';
    document.querySelector('#pageTitle').textContent='Friends';
    document.querySelectorAll('.route-view').forEach(view=>view.hidden=view.id!=='friendsRoute');
    document.querySelectorAll('[data-route]').forEach(button=>button.classList.toggle('active',button.dataset.route==='friends'));
    const more=document.querySelector('#mobileNavMoreMenu');
    if(more)more.hidden=true;
    const moreButton=document.querySelector('#mobileNavMoreButton');
    if(moreButton)moreButton.setAttribute('aria-expanded','false');
    history.replaceState(null,'',location.pathname+'#friends');
    void loadFriends();
    startFriendRefresh();
  };

  document.addEventListener('visibilitychange',()=>{
    if(state.route==='friends'&&!document.hidden)void loadFriends({quiet:true});
  });

  window.nihilityFriends={
    refresh:()=>loadFriends({quiet:true})
  };
})();

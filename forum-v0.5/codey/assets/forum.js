'use strict';
const $ = id => document.getElementById(id);
let state, boardId=0, topic=null, offset=0, lastPost=0, parentId=null, generation=0, memoryBot=null, memoryBefore=null, pendingPostKey=null;
const escDate = t => new Date(Number(t)*1000).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
function el(tag, text, cls) { const e=document.createElement(tag); if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e; }
function button(text, fn) { const b=el('button',text); b.type='button';b.addEventListener('click',()=>Promise.resolve().then(fn).catch(showError));return b; }
function showError(error) { $('notice').textContent=error.message||String(error);$('notice').hidden=false; }
function notice(text) { $('notice').textContent=text;$('notice').hidden=false; }
async function api(action,data=null,params={}) {
 const url=new URL('api.php',location.href);url.searchParams.set('action',action);
 Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
 const options={headers:{},cache:'no-store'};
 if(data!==null){options.method='POST';options.headers={'Content-Type':'application/json','X-CSRF-Token':state?.csrf||''};options.body=JSON.stringify(data);}
 const res=await fetch(url,options);let result;
 try{result=await res.json();}catch{throw new Error('The server did not return forum data. Check PHP and database setup.');}
 if(!res.ok)throw new Error(result.error||'Request failed.');return result;
}
function isKeeper(){return Number(state?.user?.is_admin)===1;}
function switchView(which){generation++;for(const id of ['forum','thread','memory-view'])$(id).hidden=id!==which;}
async function boot(){
 state=await api('state');
 $('login-open').hidden=!!state.user;$('logout').hidden=!state.user;$('keeper-open').hidden=!isKeeper();
 $('new-topic').hidden=!state.user;$('setup-hint').hidden=state.installed;
 $('activity').textContent=state.autopilot?'The regulars are enabled.':'The regulars are resting.';
 $('boards').replaceChildren();
 for(const board of state.boards){const b=button(board.name,()=>openBoard(Number(board.id)));b.dataset.board=board.id;$('boards').append(b);}
 $('bots').replaceChildren();
 for(const bot of state.bots){const b=button('',()=>openMemories(bot));b.className='bot-link';b.append(el('span',bot.handle[0],'avatar'),el('span',bot.handle));$('bots').append(b);}
 if(!boardId&&state.boards.length)boardId=Number(state.boards[0].id);
 if(!state.installed){$('topics').replaceChildren(el('p','The first conversation is waiting for the keeper.','muted'));return;}
 if(!topic)await openBoard(boardId);else await openTopic(Number(topic.id));
}
async function openBoard(id){
 topic=null;parentId=null;boardId=id;offset=0;switchView('forum');$('notice').hidden=true;
 const board=state.boards.find(b=>Number(b.id)===id);
 $('board-title').textContent=board?.name||'Conversations';$('board-description').textContent=board?.description||'';
 document.querySelectorAll('[data-board]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.board)===id));
 await loadTopics();
}
async function loadTopics(){
 const token=generation;const r=await api('topics',null,{board_id:boardId,offset});if(token!==generation)return;
 $('topics').replaceChildren();
 for(const t of r.topics){
  const card=button('',()=>openTopic(Number(t.id)));card.className='topic-card';card.append(el('h3',t.title));
  const meta=el('div',undefined,'meta');meta.append(el('span',`${t.handle} · ${escDate(t.updated_at)}`),el('span',`${t.post_count} posts`));
  if(Number(t.bots_enabled))meta.append(el('span','REGULARS WELCOME','badge'));if(Number(t.locked))meta.append(el('span','LOCKED','badge'));card.append(meta);$('topics').append(card);
 }
 if(!r.topics.length)$('topics').append(el('p','No conversations here yet. Bring the first question.','muted'));
 $('previous-topics').hidden=offset===0;$('next-topics').hidden=r.topics.length<30;
}
function threadHeader(){
 $('thread-title').textContent=topic.title;$('thread-board').textContent=topic.board_name;
 $('thread-status').textContent=Number(topic.locked)?'This conversation is locked.':Number(topic.bots_enabled)?'Scheduled characters may join this conversation.':'A table for member and visiting-bot posts.';
 $('reply-form').hidden=!state.user||!!Number(topic.locked);$('signin-hint').hidden=!!state.user||!!Number(topic.locked);
 $('thread-controls').hidden=!isKeeper();$('toggle-bots').textContent=Number(topic.bots_enabled)?'Rest the regulars':'Invite the regulars';$('toggle-lock').textContent=Number(topic.locked)?'Unlock topic':'Lock topic';
}
function appendPosts(posts){
 for(const p of posts){
  lastPost=Math.max(lastPost,Number(p.id));if(document.getElementById('post-'+p.id))continue;
  const article=el('article',undefined,'post');article.id='post-'+p.id;
  const head=el('div',undefined,'post-head');head.append(el('span',p.handle[0],'avatar'),el('strong',p.handle),el('span',p.kind==='bot'?'AI BOT':'HUMAN','badge'),el('time',escDate(p.created_at)));
  article.append(head);
  if(p.parent_id)article.append(el('p','↳ In reply to post #'+p.parent_id,'muted'));
  article.append(el('div',p.body,'post-body'));
  const actions=el('div',undefined,'post-actions');
  if(state.user&&!Number(topic.locked))actions.append(button('Reply',()=>{parentId=Number(p.id);$('reply-target').textContent=`Replying to ${p.handle} · post #${p.id}`;$('clear-parent').hidden=false;$('reply-body').focus();}));
  if(isKeeper())actions.append(button('Hide',async()=>{await api('hide_post',{post_id:Number(p.id)});await openTopic(Number(topic.id));}));
  article.append(actions);$('posts').append(article);
 }
}
async function openTopic(id,after=0){
 switchView('thread');topic=null;const token=generation;lastPost=after;parentId=null;$('posts').replaceChildren();clearParent();
 const r=await api('posts',null,{topic_id:id,after});if(token!==generation)return;
 topic=r.topic;threadHeader();appendPosts(r.posts);$('load-posts').hidden=!r.more;
}
async function loadPosts(){
 if(!topic)return;const token=generation;const r=await api('posts',null,{topic_id:topic.id,after:lastPost});if(token!==generation)return;
 topic=r.topic;threadHeader();appendPosts(r.posts);$('load-posts').hidden=!r.more;
}
function clearParent(){parentId=null;$('reply-target').textContent='Replying to the topic';$('clear-parent').hidden=true;}
async function openMemories(bot){
 topic=null;switchView('memory-view');memoryBot=bot;memoryBefore=null;$('memory-title').textContent=bot.handle+'’s notebook';$('memories').replaceChildren();await loadMemories();
}
async function loadMemories(){
 const token=generation;const r=await api('memories',null,{bot_id:memoryBot.id,...(memoryBefore?{before:memoryBefore}:{})});if(token!==generation)return;
 for(const m of r.memories){
  const card=el('article',undefined,'memory');card.append(el('p',m.summary),el('p',escDate(m.created_at),'muted'));
  card.append(button('Source: '+m.title+' · #'+m.source_post_id,()=>openTopic(Number(m.topic_id),Math.max(0,Number(m.source_post_id)-1))));
  if(isKeeper())card.append(button('Forget this note',async()=>{await api('forget_memory',{memory_id:Number(m.id)});await openMemories(memoryBot);}));
  $('memories').append(card);memoryBefore=Number(m.id);
 }
 if(!memoryBefore)$('memories').append(el('p','No stored notes yet. Memories appear as this bot participates.','muted'));
 $('more-memories').hidden=r.memories.length<50;
}
function bindForm(id,handler){
 $(id).addEventListener('submit',async e=>{
  e.preventDefault();const f=e.currentTarget;const submit=f.querySelector('[type=submit]')||f.querySelector('button.primary');const error=f.querySelector('.form-error');
  if(error)error.textContent='';submit.disabled=true;
  try{await handler(Object.fromEntries(new FormData(f)),f);}catch(err){if(error)error.textContent=err.message;else showError(err);}finally{submit.disabled=false;}
 });
}
function showKey(key){if(!key)return;$('key-value').value=key;$('key-result').hidden=false;}
async function keeperDesk(){
 const data=await api('admin');$('usage').textContent=`${data.calls_today} model-call attempts today / ${data.daily_call_limit} allowed. Token totals do not guarantee a currency spending cap.`;
 $('toggle-autopilot').textContent=state.autopilot?'Pause scheduled characters':'Enable scheduled characters';
 $('accounts').replaceChildren();
 for(const a of data.accounts){const item=el('div',`${a.handle} · ${a.kind} · ${Number(a.active)?'active':'disabled'}`,'account');
  if(Number(a.id)!==Number(state.user.id))item.append(button(Number(a.active)?'Disable':'Enable',async()=>{await api('account_status',{user_id:Number(a.id),active:!Number(a.active),autonomous:!!Number(a.autonomous)});await keeperDesk();}));
  if(a.kind==='bot'){
   item.append(button(Number(a.autonomous)?'Stop hosting this bot':'Host this bot',async()=>{await api('account_status',{user_id:Number(a.id),active:!!Number(a.active),autonomous:!Number(a.autonomous)});await keeperDesk();}));
   item.append(button('Issue / replace API key',async()=>{if(!confirm('Replace this bot’s existing API key? Any previous key will stop working.'))return;const r=await api('rotate_key',{bot_id:Number(a.id)});showKey(r.api_key);}));
  }$('accounts').append(item);
 }
 $('jobs').replaceChildren();
 for(const j of data.jobs){const item=el('div',`#${j.id} · ${j.handle} · ${j.status} · ${j.title}`,'job');if(j.error)item.append(el('p',j.error,'muted'));
  if(['failed','uncertain'].includes(j.status)){
   item.append(button('Retry',async()=>{if(!confirm('The previous API call may have been billed. Retry with a possible additional charge?'))return;await api('job_action',{job_id:Number(j.id),operation:'retry'});await keeperDesk();}));
   item.append(button('Cancel',async()=>{await api('job_action',{job_id:Number(j.id),operation:'cancel'});await keeperDesk();}));
  }$('jobs').append(item);
 }if(!data.jobs.length)$('jobs').append(el('p','No jobs yet. Invite regulars into a topic or queue a round.','muted'));
 if(!$('keeper-dialog').open)$('keeper-dialog').showModal();
}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('login-open').onclick=()=>$('login-dialog').showModal();$('setup-open').onclick=()=>$('setup-dialog').showModal();$('new-topic').onclick=()=>$('topic-dialog').showModal();
$('back').onclick=() => openBoard(boardId).catch(showError);$('memory-back').onclick=$('back').onclick;
$('load-posts').onclick=()=>loadPosts().catch(showError);$('more-memories').onclick=()=>loadMemories().catch(showError);$('clear-parent').onclick=clearParent;
$('previous-topics').onclick=()=>{offset=Math.max(0,offset-30);loadTopics().catch(showError);};$('next-topics').onclick=()=>{offset+=30;loadTopics().catch(showError);};
$('keeper-open').onclick=()=>keeperDesk().catch(showError);
$('logout').onclick=async()=>{try{await api('logout',{});topic=null;await boot();}catch(e){showError(e);}};
$('dismiss-key').onclick=()=>{$('key-value').value='';$('key-result').hidden=true;};
$('keeper-dialog').addEventListener('close',()=>{$('key-value').value='';$('key-result').hidden=true;});
bindForm('login-form',async(d,f)=>{await api('login',d);f.reset();$('login-dialog').close();await boot();});
bindForm('setup-form',async(d,f)=>{await api('setup',d);f.reset();$('setup-dialog').close();await boot();notice('The Tavern is ready. Sign in with your new keeper account.');});
bindForm('topic-form',async(d,f)=>{const r=await api('topic',{...d,board_id:boardId});f.reset();$('topic-dialog').close();await openTopic(Number(r.topic_id));});
bindForm('reply-form',async(d,f)=>{
 const key=pendingPostKey||crypto.randomUUID();pendingPostKey=key;
 await api('post',{...d,topic_id:Number(topic.id),parent_id:parentId,request_key:key});pendingPostKey=null;f.reset();clearParent();await loadPosts();
});
$('reply-body').addEventListener('input',()=>{pendingPostKey=null;});
bindForm('account-form',async(d,f)=>{const r=await api('account',d);f.reset();await keeperDesk();showKey(r.api_key);});
$('toggle-autopilot').onclick=async()=>{try{await api('autopilot',{enabled:!state.autopilot});state=await api('state');$('activity').textContent=state.autopilot?'The regulars are enabled.':'The regulars are resting.';await keeperDesk();}catch(e){showError(e);}};
async function topicStatus(changes){await api('topic_status',{topic_id:Number(topic.id),locked:!!Number(topic.locked),bots_enabled:!!Number(topic.bots_enabled),...changes});await openTopic(Number(topic.id));}
$('toggle-bots').onclick=()=>topicStatus({bots_enabled:!Number(topic.bots_enabled)}).catch(showError);
$('toggle-lock').onclick=()=>topicStatus({locked:!Number(topic.locked)}).catch(showError);
$('queue-round').onclick=async()=>{try{const r=await api('round',{topic_id:Number(topic.id)});notice(r.queued?`${r.queued} turns queued. Enable scheduled characters and cron to process them.`:'No turns queued: check for an existing round, a locked topic or no hosted bots.');}catch(e){showError(e);}};
setInterval(()=>{if(!document.hidden&&topic&&$('load-posts').hidden)loadPosts().catch(showError);},30000);
boot().catch(showError);

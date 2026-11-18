/* CRM uses Lumen's local API; it never sends email or places calls. */
(function () {
  'use strict';
  const root = document.getElementById('lumen-crm');
  let state, tab = 'Contacts', selected = '', query = '', archived = false, month = new Date();
  let loading = false;
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const btn = (label, action, id = '', primary = false) => `<button type="button" class="btn ${primary ? 'primary' : ''}" data-action="${action}" data-id="${h(id)}">${h(label)}</button>`;
  const fmt = date => new Date(date).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
  const dayKey = d => [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
  const localTime = iso => {const d=iso ? new Date(iso) : new Date();return `${dayKey(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
  const contact = id => state.contacts.find(c => c.id === id);
  const active = c => c && !c.archived;
  const visibleContacts = () => state.contacts.filter(c => c.archived === archived && [c.name,c.company,c.email,c.phone,c.source,c.owner].join(' ').toLowerCase().includes(query.toLowerCase()));
  const empty = message => `<div class="crm-empty">${h(message)}</div>`;
  async function api(path, data, patch = false, remove = false) {
    const response = await fetch('/api/crm/' + path, data === undefined ? {} : {method:remove ? 'DELETE' : patch ? 'PATCH' : 'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window.__CSRF__ || ''},body:JSON.stringify(data)});
    let result; try { result = await response.json(); } catch (_) { throw new Error('Lumen could not complete this request. Refresh and try again.'); }
    if (!response.ok) throw new Error(result.error || 'Unable to save.');
    return result;
  }
  async function refresh() {state=await api('state');render();}
  function error(message) {const box=root.querySelector('#crm-error');if(box){box.hidden=false;box.textContent=message;}}
  function listItems(items) {
    if (!items.length) return empty('No tasks or meetings here yet.');
    return `<div class="crm-agenda">${items.slice().sort((a,b)=>a.due.localeCompare(b.due)).map(i=>`<div class="crm-agenda-row"><div class="crm-agenda-date"><strong>${h(new Date(i.due).toLocaleDateString([],{day:'numeric',month:'short'}))}</strong><span>${h(new Date(i.due).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</span></div><div class="crm-agenda-text"><span class="crm-eyebrow">${h(i.kind)}</span><strong>${h(i.title)}</strong><button class="crm-link" data-action="contact" data-id="${i.contact_id}">${h(contact(i.contact_id)?.name)}</button></div><span class="crm-agenda-status ${i.status==='Scheduled'&&new Date(i.due)<new Date()?'overdue':''}">${i.status==='Scheduled'&&new Date(i.due)<new Date()?'Past due':h(i.status)}</span>${btn('Edit','item',i.id)}</div>`).join('')}</div>`;
  }
  function render() {
    // A background refresh must never remove a form containing unsaved work.
    if(root.querySelector('dialog[open]')) return;
    const names=['Contacts','Pipeline','Tasks','Calendar','Reports'];
    root.innerHTML=`<div class="crm-tabs" aria-label="CRM views">${names.map(n=>`<button class="btn" data-action="tab" data-id="${n}" ${tab===n?'aria-current="page"':''}>${n}</button>`).join('')}<span class="crm-grow"></span>${btn('Refresh','refresh')}</div><div id="crm-error" class="crm-error" role="alert" hidden></div><div id="crm-body"></div><p class="crm-muted">Local CRM · Calls and outreach are manually logged. Calendar times: ${h(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Follow-ups are shown in Tasks; no background notifications.</p>`;
    const body=root.querySelector('#crm-body');
    if(selected && contact(selected)) {body.innerHTML=detail(contact(selected));return;}
    if(tab==='Contacts') {
      const contacts=visibleContacts();
      body.innerHTML=`<div class="crm-overview"><div><span class="crm-eyebrow">YOUR NETWORK</span><strong>${state.contacts.filter(active).length}<small>active contacts</small></strong></div><div><span class="crm-eyebrow">NEXT STEPS</span><strong>${state.items.filter(i=>active(contact(i.contact_id))&&i.status==='Scheduled').length}<small>scheduled activities</small></strong></div><div><span class="crm-eyebrow">IN PROGRESS</span><strong>${state.deals.filter(d=>active(contact(d.contact_id))&&!['Won','Lost'].includes(d.stage)).length}<small>open deals</small></strong></div></div><div class="crm-bar"><input class="crm-grow" id="crm-search" aria-label="Search contacts" placeholder="Search name, company, email, owner…" value="${h(query)}"><select id="crm-archive" aria-label="Contact visibility" style="width:auto"><option value="active" ${!archived?'selected':''}>Active contacts</option><option value="archived" ${archived?'selected':''}>Archived contacts</option></select>${btn('Add contact','new-contact','',true)}</div>${contacts.length?`<div class="crm-box crm-scroll"><table><thead><tr><th>Contact</th><th>Email / phone</th><th>Source</th><th>Owner</th><th>Next action</th></tr></thead><tbody>${contacts.map(c=>{const next=state.items.filter(i=>i.contact_id===c.id&&i.status==='Scheduled').sort((a,b)=>a.due.localeCompare(b.due))[0];return `<tr><td><div class="crm-person"><span class="crm-person-avatar" aria-hidden="true">${h(c.name.slice(0,1).toUpperCase())}</span><div><button class="crm-link" data-action="contact" data-id="${c.id}">${h(c.name)}</button><div class="crm-muted">${h(c.company)}</div></div></div></td><td>${h(c.email||'—')}<br>${h(c.phone||'—')}</td><td><span class="crm-source">${h(c.source||'—')}</span></td><td>${h(c.owner||'—')}</td><td>${next?h(next.title)+'<div class="crm-muted">'+h(fmt(next.due))+'</div>':'No follow-up scheduled'}</td></tr>`;}).join('')}</tbody></table></div>`:empty('Add your first contact to start tracking calls, deals and follow-ups.')}`;
    } else if(tab==='Pipeline') {
      const deals=state.deals.filter(d=>active(contact(d.contact_id)));
      body.innerHTML=`<div class="crm-bar"><p class="crm-grow">Each card is a deal. A contact can have more than one.</p>${btn('Add deal','new-deal','',true)}</div><div class="crm-board">${state.stages.map(stage=>`<section class="crm-column"><h3>${h(stage)} · ${deals.filter(d=>d.stage===stage).length}</h3>${deals.filter(d=>d.stage===stage).map(d=>`<div class="crm-deal"><button class="crm-link" data-action="deal" data-id="${d.id}">${h(d.title)}</button><div>${h(contact(d.contact_id).name)}</div><div class="crm-muted">${h(d.currency)} ${h(d.value)}</div><select aria-label="Stage for ${h(d.title)}" data-stage="${d.id}">${state.stages.map(s=>`<option ${s===stage?'selected':''}>${h(s)}</option>`).join('')}</select></div>`).join('')||'<p class="crm-muted">No deals</p>'}</section>`).join('')}</div>`;
    } else if(tab==='Tasks') {
      const items=state.items.filter(i=>active(contact(i.contact_id)));
      body.innerHTML=`<div class="crm-bar"><h3 class="crm-grow">Scheduled follow-ups and meetings</h3>${btn('Add task','new-task','',true)}${btn('Add meeting','new-meeting')}</div>${listItems(items.filter(i=>i.status==='Scheduled'))}<details class="crm-box" style="margin-top:20px"><summary>Completed, cancelled and no-show history</summary>${listItems(items.filter(i=>i.status!=='Scheduled'))}</details>`;
    } else if(tab==='Calendar') {
      const start=new Date(month.getFullYear(),month.getMonth(),1); start.setDate(start.getDate()-((start.getDay()+6)%7));
      const items=state.items.filter(i=>active(contact(i.contact_id)));
      body.innerHTML=`<div class="crm-bar">${btn('Previous','prev')}${btn('Today','today')}${btn('Next','next')}<h3 class="crm-grow">${h(month.toLocaleDateString([],{month:'long',year:'numeric'}))}</h3>${btn('Add meeting','new-meeting','',true)}</div><div class="crm-scroll"><div class="crm-calendar">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="crm-dayhead">${d}</div>`).join('')}${Array.from({length:42},(_,n)=>{const d=new Date(start);d.setDate(d.getDate()+n);const key=dayKey(d);return `<div class="crm-day ${d.getMonth()!==month.getMonth()?'outside':''} ${key===dayKey(new Date())?'today':''}"><b>${d.getDate()}</b>${items.filter(i=>dayKey(new Date(i.due))===key).sort((a,b)=>a.due.localeCompare(b.due)).map(i=>`<button class="crm-event ${i.kind} ${i.status!=='Scheduled'?'finished':''}" data-action="item" data-id="${i.id}">${h(new Date(i.due).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))} ${h(i.title)}<br>${h(contact(i.contact_id).name)} · ${h(i.status)}</button>`).join('')}</div>`;}).join('')}</div></div>`;
    } else {
      const deals=state.deals.filter(d=>active(contact(d.contact_id))), won=deals.filter(d=>d.stage==='Won'), lost=deals.filter(d=>d.stage==='Lost');
      const calls=state.activities.filter(a=>a.kind==='call'&&active(contact(a.contact_id)));
      const overdue=state.items.filter(i=>active(contact(i.contact_id))&&i.status==='Scheduled'&&new Date(i.due)<new Date());
      const totals={};for(const d of won)totals[d.currency]=(totals[d.currency]||0)+Math.round(Number(d.value)*100);
      body.innerHTML=`<p class="crm-muted">All-time · active contacts only · manually recorded outcomes. Won value is not collected revenue.</p><div class="crm-grid">${[['Contacts',state.contacts.filter(active).length],['Calls logged',calls.length],['Won deals',won.length],['Closed-deal win rate',won.length+lost.length?Math.round(100*won.length/(won.length+lost.length))+'%':'—'],['Past-due activities',overdue.length]].map(([label,value])=>`<div class="crm-box"><div class="crm-muted">${label}</div><div class="crm-count">${value}</div></div>`).join('')}</div><div class="crm-box"><h3>Won deal value by currency</h3>${Object.entries(totals).map(([currency,value])=>`<p>${h(currency)} ${(value/100).toFixed(2)}</p>`).join('')||'<p>No won deals yet.</p>'}<p class="crm-muted">Win rate = won ÷ (won + lost). Open deals are excluded.</p></div><div class="crm-box"><h3>Call outcomes</h3>${state.outcomes.map(o=>`<div>${h(o)}: ${calls.filter(c=>c.outcome===o).length}</div>`).join('')}</div>`;
    }
  }
  function detail(c) {
    const history=state.activities.filter(a=>a.contact_id===c.id).sort((a,b)=>b.occurred.localeCompare(a.occurred));
    const items=state.items.filter(i=>i.contact_id===c.id);
    const deals=state.deals.filter(d=>d.contact_id===c.id);
    return `<div class="crm-bar">${btn('Back','back')}<span class="crm-grow"></span>${btn('Edit contact','edit-contact',c.id)}${btn(c.archived?'Restore contact':'Archive contact','archive',c.id)}${btn('Delete contact','delete-contact',c.id)}</div>
      <div class="crm-record"><aside class="crm-box crm-profile"><div class="crm-avatar" aria-hidden="true">${h(c.name.slice(0,1).toUpperCase())}</div><h2>${h(c.name)}</h2><div class="crm-muted">${h(c.company || 'Individual contact')}${c.archived?' · Archived':''}</div>
      <dl>${[['Email',c.email],['Phone',c.phone],['Source',c.source||'Unspecified'],['Owner',c.owner||'Unassigned']].map(([label,value])=>`<dt>${label}</dt><dd>${h(value||'Not added')}</dd>`).join('')}${c.website?`<dt>Website</dt><dd><a href="${h(c.website)}" target="_blank" rel="noopener noreferrer">${h(c.website)}</a></dd>`:''}</dl>${c.notes?`<dl><dt>Contact notes</dt><dd style="white-space:pre-wrap">${h(c.notes)}</dd></dl>`:''}</aside>
      <div class="crm-record-main">${!c.archived?`<div class="crm-bar">${btn('Log call','call',c.id,true)}${btn('Add note','note',c.id)}${btn('Log outreach','outreach',c.id)}${btn('Add task','new-task',c.id)}${btn('Add meeting','new-meeting',c.id)}${btn('Add deal','new-deal',c.id)}</div>`:''}
      <div class="crm-box"><h3>Activity history <span class="crm-muted">· ${history.length}</span></h3>${history.map(a=>`<div class="crm-history"><div class="crm-muted">${h(fmt(a.occurred))} · ${h(a.kind==='outreach'?'outreach (manual)':a.kind)}</div>${a.kind==='call'?`<b>${h(a.direction)} · ${h(a.outcome)} · ${a.duration} min</b><br>`:''}${h(a.text)}${a.due?`<br><span class="crm-muted">Scheduled for ${h(fmt(a.due))}</span>`:''}</div>`).join('')||empty('No activity yet. Log a call, outreach or note to start this contact’s timeline.')}</div>
      <div class="crm-box"><h3>Tasks and meetings <span class="crm-muted">· ${items.length}</span></h3>${listItems(items)}</div>
      <div class="crm-box"><h3>Deals <span class="crm-muted">· ${deals.length}</span></h3>${deals.map(d=>`<p><button class="crm-link" data-action="deal" data-id="${d.id}">${h(d.title)}</button> · ${h(d.stage)} · ${h(d.currency)} ${h(d.value)}</p>`).join('')||'<p class="crm-muted">No deals yet.</p>'}</div></div></div>`;
  }

  function field(name,label,value='',type='text',required=false) {return `<label>${h(label)}<input name="${name}" type="${type}" value="${h(value)}" ${required?'required':''} ${type==='number'?'min="0" step="1"':'maxlength="500"'}></label>`;}
  function deleteContact(c) {
    const dialog=document.createElement('dialog');dialog.className='crm-dialog';dialog.setAttribute('aria-label','Delete contact');
    const count=table=>state[table].filter(r=>r.contact_id===c.id).length;
    dialog.innerHTML=`<h2>Delete ${h(c.name)}?</h2><p>This permanently deletes this contact and its ${count('deals')} deals, ${count('items')} tasks/meetings and ${count('activities')} history entries from CRM. This cannot be undone.</p><p>Use Archive instead if you may need the record again. Existing outreach files and Workspace pages are not deleted.</p><div class="crm-error" role="alert" hidden></div><div class="crm-bar"><button type="button" class="btn crm-danger" data-confirm-delete>Delete permanently</button><button type="button" class="btn" data-cancel-delete>Cancel</button></div>`;
    root.append(dialog);dialog.showModal();dialog.querySelector('[data-cancel-delete]').focus();
    dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('[data-cancel-delete]').onclick=()=>dialog.close();
    dialog.querySelector('[data-confirm-delete]').onclick=async event=>{
      const button=event.target;button.disabled=true;
      try {
        await api('contacts/'+c.id,{revision:c.revision},false,true);
        selected='';dialog.close();
        // Remove the deleted data immediately even if the following refresh fails.
        state.contacts=state.contacts.filter(r=>r.id!==c.id);
        for(const table of ['deals','items','activities'])state[table]=state[table].filter(r=>r.contact_id!==c.id);
        render();await refresh();
      }catch(err){if(dialog.isConnected){const box=dialog.querySelector('[role=alert]');box.hidden=false;box.textContent=err.message;}else error(err.message);}
      finally{button.disabled=false;}
    };
  }
  function options(name,label,values,value) {return `<label>${h(label)}<select name="${name}" aria-label="${h(label)}">${values.map(v=>`<option value="${h(v)}" ${v===value?'selected':''}>${h(v)}</option>`).join('')}</select></label>`;}
  function memo(name,label,value='') {return `<label class="crm-wide">${label}<textarea name="${name}" maxlength="10000">${h(value)}</textarea></label>`;}
  function form(table, record = {}, kind) {
    if(table!=='contacts' && !state.contacts.some(active)) {error('Add or restore a contact first.');return;}
    if(record.contact_id && !active(contact(record.contact_id))) {error('Restore this contact before editing its work.');return;}
    const edit=!!record.id;
    let fields='', title='';
    if(table==='contacts') {
      title=edit?'Edit contact':'Add contact';
      fields=field('name','Contact name',record.name,'text',true)+field('company','Company',record.company)+field('email','Email',record.email,'email')+field('phone','Phone',record.phone)+field('website','Website (https://…)',record.website,'url')+field('source','Lead source',record.source)+field('owner','Assigned to',record.owner)+memo('notes','Notes',record.notes);
    } else {
      fields=`<label class="crm-wide">Contact<select name="contact_id" ${edit?'disabled':''}>${state.contacts.filter(active).map(c=>`<option value="${c.id}" ${c.id===(record.contact_id||selected)?'selected':''}>${h(c.name)}${c.company?' — '+h(c.company):''}</option>`).join('')}</select></label>`;
      if(table==='deals') {
        title=edit?'Edit deal':'Add deal';fields+=field('title','Deal title',record.title,'text',true)+options('stage','Sales stage',state.stages,record.stage||'New')+field('value','Deal value',record.value||'0.00')+field('currency','Currency code',record.currency||'USD')+memo('loss_reason','Loss reason (if lost)',record.loss_reason);
      } else if(table==='items') {
        kind=record.kind||kind;title=(edit?'Edit ':'Add ')+kind;
        const start=record.due||new Date().toISOString();
        fields+=`<input type="hidden" name="kind" value="${kind}">`+field('title',kind==='meeting'?'Meeting title':'Task title',record.title,'text',true)+options('status','Status',kind==='meeting'?['Scheduled','Completed','Cancelled','No-show']:['Scheduled','Completed','Cancelled'],record.status||'Scheduled')+field('due',kind==='meeting'?'Start time':'Due time',localTime(start),'datetime-local',true);
        if(kind==='meeting')fields+=field('end','End time',localTime(record.end||new Date(new Date(start).getTime()+30*60000).toISOString()),'datetime-local',true);
        fields+=memo('notes','Notes',record.notes);
      } else {
        title=kind==='call'?'Log call':kind==='outreach'?'Log outreach manually':'Add note';
        fields+=`<input type="hidden" name="kind" value="${kind}">`+field('occurred','When',localTime(),'datetime-local',true);
        if(kind==='call') fields+=options('direction','Direction',['Outgoing','Incoming'],'Outgoing')+options('outcome','Call outcome',state.outcomes,'Connected')+field('duration','Duration (minutes)',0,'number');
        fields+=memo('text',kind==='outreach'?'Channel, outcome and notes (does not send a message)':'Notes');
      }
    }
    const dialog=document.createElement('dialog');dialog.className='crm-dialog';dialog.setAttribute('aria-label',title);
    dialog.innerHTML=`<form><h2>${h(title)}</h2><div class="crm-error" role="alert" hidden></div><div class="crm-fields">${fields}</div><div class="crm-bar"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-cancel>Cancel</button></div></form>`;
    root.append(dialog);dialog.showModal();dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
    dialog.querySelector('form').onsubmit=async e=>{
      e.preventDefault();const button=dialog.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;
      const values=Object.fromEntries(new FormData(e.target));
      if(edit){values.revision=record.revision;if(record.contact_id)values.contact_id=record.contact_id;}
      if('duration' in values)values.duration=Number(values.duration);
      const box=dialog.querySelector('[role=alert]');box.hidden=true;
      try {
        for(const key of ['due','end','occurred'])if(values[key])values[key]=new Date(values[key]).toISOString();
        const saved=await api(table+(edit?'/'+record.id:''),values,edit);
        if(table==='contacts')selected=saved.id;
        try {state=await api('state');}
        catch(refreshError) {dialog.close();render();error('Saved, but refresh failed. Use Refresh to reload.');return;}
        dialog.close();render();
      } catch(err) {if(dialog.isConnected){box.hidden=false;box.textContent=err.message;}else error('Saved, but refresh failed. Use Refresh to reload.');}
      finally{button.disabled=false;}
    };
  }
  root.addEventListener('click',async event=>{
    const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
    const action=button.dataset.action,id=button.dataset.id;
    try {
      if(action==='tab'){tab=id;selected='';render();}
      else if(action==='contact'){selected=id;render();}
      else if(action==='back'){selected='';render();}
      else if(action==='refresh')await refresh();
      else if(action==='new-contact')form('contacts');
      else if(action==='edit-contact')form('contacts',contact(id));
      else if(action==='delete-contact')deleteContact(contact(id));
      else if(['call','note','outreach'].includes(action))form('activities',{contact_id:id},action);
      else if(action==='new-deal')form('deals',{contact_id:id||selected});
      else if(action==='deal')form('deals',state.deals.find(d=>d.id===id));
      else if(action==='new-task'||action==='new-meeting')form('items',{contact_id:id||selected},action==='new-task'?'task':'meeting');
      else if(action==='item')form('items',state.items.find(i=>i.id===id));
      else if(action==='archive') {const c=contact(id);if(!c.archived&&!confirm('Archive this contact? Its history is kept; its work is hidden from active views.'))return;button.disabled=true;await api('contacts/'+id,{revision:c.revision,archived:!c.archived},true);await refresh();}
      else if(['prev','next','today'].includes(action)){month=action==='today'?new Date():new Date(month.getFullYear(),month.getMonth()+(action==='next'?1:-1),1);render();}
    }catch(err){error(err.message);}finally{button.disabled=false;}
  });
  root.addEventListener('change',async event=>{
    const input=event.target;
    if(input.id==='crm-archive'){archived=input.value==='archived';render();}
    if(input.dataset.stage){const d=state.deals.find(d=>d.id===input.dataset.stage);input.disabled=true;try{await api('deals/'+d.id,{revision:d.revision,stage:input.value},true);await refresh();}catch(err){input.value=d.stage;error(err.message);}finally{input.disabled=false;}}
  });
  root.addEventListener('input',event=>{
    if(event.target.id!=='crm-search')return;
    query=event.target.value;const cursor=event.target.selectionStart;render();const search=root.querySelector('#crm-search');search.focus();search.setSelectionRange(cursor,cursor);
  });
  window.LumenCRM={open:async()=>{if(loading)return;loading=true;try{await refresh();}catch(err){root.innerHTML='<div id="crm-error" class="crm-error" role="alert"></div>'+btn('Retry','refresh');error(err.message);}finally{loading=false;}}};
})();

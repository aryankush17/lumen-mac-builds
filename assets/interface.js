/* Presentation only. Original form controls keep their values and event handlers. */
(() => {
'use strict';
const $=s=>document.querySelector(s);
const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
const labels={'business-info':'Discover','find-emails':'Enrich','email-outreach':'Campaigns',logs:'Activity',sheets:'Workspace',crm:'CRM','website-builder':'Studio',invoice:'Invoices',agreement:'Contracts',settings:'Settings',admin:'Admin'};
document.querySelectorAll('.navi').forEach(button=>{const original=button.textContent.trim();button.title=original;button.setAttribute('aria-label',original);button.querySelector('.lbl').textContent=labels[button.dataset.view]||original;});
const top=$('.topbar'),location=make('div','ui-location');top.querySelector('.tb-sp').before(location);
const searchButton=make('button','ui-search','Jump to a tool');searchButton.type='button';searchButton.append(make('kbd','','Ctrl K'));top.querySelector('.tb-sp').after(searchButton);
const dialog=make('dialog','ui-command');dialog.setAttribute('aria-label','Jump to a tool');
const search=make('input','');search.placeholder='Find a tool…';search.setAttribute('aria-label','Find a tool');
const results=make('div','ui-command-results'),close=make('button','btn','Close');close.type='button';close.onclick=()=>dialog.close();dialog.append(search,results,close);document.body.append(dialog);
dialog.addEventListener('input',event=>event.stopPropagation());
function filter(){results.replaceChildren();document.querySelectorAll('.navi').forEach(nav=>{if(!nav.title.toLowerCase().includes(search.value.toLowerCase()))return;const b=make('button','',nav.title);b.type='button';b.onclick=()=>{dialog.close();nav.click();};results.append(b);});}
function openSearch(){search.value='';filter();dialog.showModal();search.focus();}
searchButton.onclick=openSearch;search.oninput=filter;search.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();results.querySelector('button')?.click();}if(e.key==='ArrowDown'){e.preventDefault();results.querySelector('button')?.focus();}};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&document.body.dataset.view!=='sheets'){e.preventDefault();openSearch();}});
const discovery=$('#v-business-info'),cards=[...discovery.querySelectorAll(':scope > .card')];
const workbench=make('div','ui-discovery'),canvas=make('div','ui-audience'),inspector=make('aside','ui-inspector');
const title=make('div','ui-section-heading');title.append(make('span','ui-index','01'),make('div','','Build your audience'));canvas.append(title,cards[0]);
const geography=cards[0].querySelector('.grid2 > div:last-child');geography.prepend(make('span','ui-index','02'));cards[1].classList.add('ui-market');geography.append(cards[1]);
inspector.append(make('span','ui-eyebrow','SEARCH PLAN'),discovery.querySelector('.statrow'),make('div','ui-inspector-rule'),make('h3','','Ready when you are.'),make('p','ui-subtle','Your search combines each business type with every location. Review the scope, then collect your leads.'),discovery.querySelector('.runbar'));workbench.append(canvas,inspector);discovery.append(workbench);
const email=$('#v-email-outreach'),cols=email.querySelector('.cols'),originalCards=[...cols.querySelector('.main-col').children],preview=cols.querySelector('.side-col');
const steps=make('div','ui-compose-steps');steps.setAttribute('role','tablist');steps.setAttribute('aria-label','Campaign setup');const panels=make('div','ui-compose-panels');
const definitions=[['Write your email','Message & personalisation'],['Choose recipients','Audience & campaign details'],['Set up delivery','Accounts & sending checks']];
const stepPanels=definitions.map((d,i)=>{const p=make('div','ui-compose-panel');p.id='compose-step-'+i;p.setAttribute('role','tabpanel');p.setAttribute('aria-labelledby','compose-tab-'+i);panels.append(p);const b=make('button','ui-compose-tab');b.type='button';b.id='compose-tab-'+i;b.setAttribute('role','tab');b.setAttribute('aria-controls',p.id);b.append(make('span','ui-step-number',String(i+1).padStart(2,'0')),make('span','ui-step-copy',d[0]));b.querySelector('.ui-step-copy').append(make('small','',d[1]));b.onclick=()=>activate(i);b.onkeydown=e=>{if(['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowRight'?1:2))%3;activate(n);steps.children[n].focus();}};steps.append(b);return p;});
stepPanels[0].append(preview);stepPanels[1].append(originalCards[1],originalCards[3]);stepPanels[2].append(originalCards[0],originalCards[2]);cols.replaceWith(steps,panels);
function activate(n){stepPanels.forEach((p,i)=>{p.hidden=i!==n;steps.children[i].setAttribute('aria-selected',String(i===n));steps.children[i].tabIndex=i===n?0:-1;});}activate(0);
function reveal(selector){const target=document.querySelector(selector);const index=stepPanels.findIndex(p=>p.contains(target));if(index>=0)activate(index);}
window.LumenInterface={reveal};
const originalGoTo=window.goTo;window.goTo=function(view,id,focus){const go=originalGoTo(view,id,focus);return function(){reveal('#'+id);go();};};
window.updateGates?.();
email.addEventListener('click',e=>{if(e.target.closest('#mode'))activate(2);},true);
const footer=make('div','ui-compose-navigation'),previous=make('button','btn','Previous step'),next=make('button','btn','Next step →');previous.type=next.type='button';footer.append(previous,next);panels.after(footer);const current=()=>stepPanels.findIndex(p=>!p.hidden);previous.onclick=()=>activate(Math.max(0,current()-1));next.onclick=()=>activate(Math.min(2,current()+1));
for(const id of ['invoice','agreement']){const view=$('#v-'+id),col=view.querySelector('.main-col');if(!col)continue;const headings=[...col.querySelectorAll('.card-h h3')],outline=make('nav','ui-document-outline');outline.setAttribute('aria-label',id+' sections');outline.append(make('span','ui-eyebrow','DOCUMENT SETUP'));headings.forEach((h,i)=>{const b=make('button','',String(i+1).padStart(2,'0')+'  '+h.textContent);b.type='button';b.onclick=()=>h.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});outline.append(b);});col.before(outline);view.querySelector('.cols').classList.add('ui-document');}
const oldShow=window.show;window.show=function(v){oldShow(v);sync(v);};function sync(v){const title=window.TITLES?.[v];location.textContent=(title?.[2]||'Lumen')+' / '+(title?.[0]||v);document.body.dataset.uiModule=v;}sync(document.body.dataset.view||'business-info');
})();

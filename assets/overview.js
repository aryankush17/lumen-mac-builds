/* Overview and navigation groups; existing modules retain their original UI. */
(() => {
 'use strict';
 const $=s=>document.querySelector(s);
 const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e};
 const button=(text,action,cls='btn')=>{const b=make('button',cls,text);b.type='button';b.onclick=action;return b};
 const nav=$('.nav'), existing=new Map([...document.querySelectorAll('.navi')].map(b=>[b.dataset.view,b]));
 const home=button('',()=>window.show('home'),'navi');home.dataset.view='home';home.title='Overview';home.setAttribute('aria-label','Overview');
 home.innerHTML='<span class="step" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span><span class="navtext"><span class="lbl">Overview</span></span>';
 existing.set('home',home);nav.replaceChildren();nav.removeAttribute('aria-labelledby');nav.setAttribute('aria-label','Lumen tools');
 for(const [label,ids] of [['Start',['home']],['Grow your business',['business-info','find-emails','email-outreach','crm']],['Create & organise',['sheets','website-builder','invoice','agreement']],['Manage',['logs','settings','admin']]]){
  const group=make('div','overview-nav-group');group.setAttribute('role','group');group.setAttribute('aria-label',label);group.append(make('div','overview-nav-label',label));
  for(const id of ids){const b=existing.get(id);if(b)group.append(b)}nav.append(group);
 }
 // Overview offers real entry points, never invented metrics.
 window.TITLES.home=['Your work, in one place.','Find the next opportunity. Keep the details together.','Overview'];
 const overview=make('section','view');overview.id='v-home';overview.tabIndex=-1;overview.setAttribute('aria-labelledby','vtitle');
 overview.innerHTML='<div class="overview-hero"><div><span class="overview-kicker">A CLEARER WAY TO WORK</span><h2>Make room for<br><em>what comes next.</em></h2><p>From your first lead to your next project.<br>Choose a starting point and keep moving.</p></div><div class="overview-orbit" aria-hidden="true"><span></span><span></span><span></span><img src="/assets/logo.png" alt=""></div></div><div class="overview-section-label"><h2>Pick up your work</h2><span>One place for every step</span></div><div class="overview-launch-grid"></div><div class="overview-bottom-grid"><section class="overview-surface"><span class="overview-kicker">YOUR WORKFLOW</span><h3>Build a better pipeline.</h3><div class="overview-path"></div></section><section class="overview-surface overview-note"><span class="overview-kicker">YOUR SPACE</span><h3>Built around your rhythm.</h3><p>Choose a theme that suits you, organise your workspace, or jump directly to a tool with Ctrl K.</p><div class="overview-personalise"></div></section></div>';
 $('#content').append(overview);
 for(const[id,label,description]of [['business-info','Discover opportunities','Build a focused business list.'],['sheets','Open your workspace','Notes, plans and ideas, together.'],['crm','Manage relationships','Contacts, calls and next steps.'],['website-builder','Create a website','Start with a template or a blank canvas.']]){const b=button('',()=>window.show(id),'overview-launch');const icon=existing.get(id)?.querySelector('.step')?.cloneNode(true);if(icon)b.append(icon);b.append(make('strong','',label),make('span','',description),make('span','overview-arrow','↗'));overview.querySelector('.overview-launch-grid').append(b)}
 for(const[id,label]of [['business-info','01  Find businesses'],['find-emails','02  Find contact details'],['email-outreach','03  Start a conversation']])overview.querySelector('.overview-path').append(button(label+'  →',()=>window.show(id),'overview-path-step'));
 overview.querySelector('.overview-personalise').append(button('Personalise Lumen →',()=>{window.show('settings');openSettingsPage('theme')}));


 // Preserve the original last-section restoration; Overview is available on refresh too.
 let saved;try{saved=sessionStorage.getItem('lumen-active-section')}catch(e){}
 if(saved==='home')window.show('home');
})();

import React, {useState, useEffect} from 'react';
import {coverStyle} from './PageAppearance';
import {openFonts} from './openFonts';
import {createReactBlockSpec} from '@blocknote/react';

export const Guidance = createReactBlockSpec(
 {type:'guidance',propSchema:{},content:'inline'},
 {render:({contentRef})=><div className="workspace-guidance"><span contentEditable={false} aria-hidden="true">✦</span><div ref={contentRef}/></div>}
);

export function textOf(value: any): string {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(textOf).join(' ');
  if(value&&typeof value==='object')return [value.text, value.content, value.rows, value.cells].filter(Boolean).map(textOf).join(' ');
  return '';
}
export function jumpToBlock(id: string) {
  const block=Array.from(document.querySelectorAll<HTMLElement>('#lumen-workspace [data-id]')).find(el=>el.dataset.id===id);
  if(block){
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    block.scrollIntoView({block:'center',behavior:reduced?'instant':'smooth'});
    // Avoid changing editor-owned DOM attributes, which ProseMirror restores.
    if(!reduced)block.animate([{backgroundColor:getComputedStyle(block).getPropertyValue('--hover')},{backgroundColor:'transparent'}],{duration:1400});
  }
}
export function DocumentGuide({blocks}:{blocks:any[]}) {
  const [shown,setShown]=useState(false),[active,setActive]=useState('');
  const flat:any[]=[];
  const walk=(items:any[])=>items.forEach(b=>{flat.push(b);if(b.children)walk(b.children);});walk(blocks);
  const words=flat.map(b=>textOf(b.content)).join(' ').trim().split(/\s+/).filter(Boolean).length;
  const headings=flat.filter(b=>b.type==='heading');
  const tasks=flat.filter(b=>b.type==='checkListItem');
  const ids=headings.map(h=>h.id).join('|');
  useEffect(()=>{
    let frame=0;
    const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
      const nodes=Array.from(document.querySelectorAll<HTMLElement>('#lumen-workspace [data-id]'));
      const entries=ids.split('|').map(id=>({id,node:nodes.find(n=>n.dataset.id===id)})).filter(e=>e.node);
      setActive(entries.filter(e=>e.node!.getBoundingClientRect().top<=220).at(-1)?.id||entries[0]?.id||'');
    });};
    document.addEventListener('scroll',update,true);update();return()=>{document.removeEventListener('scroll',update,true);cancelAnimationFrame(frame);};
  },[ids]);
  if(!headings.length)return null;
  return <div className={`outline-rail ${shown?'expanded':''}`} onMouseEnter={()=>setShown(true)} onMouseLeave={()=>{if(!document.querySelector('.outline-rail')?.contains(document.activeElement))setShown(false);}} onFocusCapture={()=>setShown(true)} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setShown(false);}} onKeyDown={e=>{if(e.key==='Escape'){setShown(false);(document.activeElement as HTMLElement)?.blur();}}}>
   <button className="outline-trigger" aria-label="Page outline" aria-expanded={shown} onClick={()=>setShown(true)}><span aria-hidden="true">{headings.map(h=><i key={h.id} className={active===h.id?'current':''} style={{width:h.props?.level===1?22:h.props?.level===3?12:17}}/>)}</span></button>
   {shown&&<nav className="outline-popover" aria-label="Page outline"><div className="outline-label">ON THIS PAGE</div>{headings.map(h=><button key={h.id} aria-current={active===h.id?'location':undefined} style={{paddingLeft:12+(h.props?.level-1||0)*12}} onClick={()=>{jumpToBlock(h.id);setShown(false);}}>{textOf(h.content)||'Untitled heading'}</button>)}<div className="outline-stats">{words} words · {Math.max(1,Math.ceil(words/200))} min read{tasks.length?` · ${tasks.filter(t=>t.props?.checked).length}/${tasks.length} tasks done`:''}</div></nav>}
  </div>;
}
const heading=(content:string)=>({type:'heading',props:{level:2},content});
const paragraph=(content:string)=>({type:'paragraph',content});
const note=(content:string)=>({type:'guidance',content});
const bullet=(content:string)=>({type:'bulletListItem',content});
const step=(content:string)=>({type:'numberedListItem',content});
const task=(content:string)=>({type:'checkListItem',props:{checked:false},content});
const table=(rows:string[][])=>({type:'table',content:{type:'tableContent',rows:rows.map(cells=>({cells:cells.map(text=>[{type:'text',text,styles:{}}])}))}});
const templateDrafts=[
 {id:'client',name:'Client brief',category:'Client delivery',icon:'◎',description:'From an ambiguous request to a shared, measurable plan.',sections:['Project snapshot','Audience & offer','Scope & success','Delivery plan','Approval checklist'],blocks:[
 note('PROJECT NORTH STAR · Describe the change this project should create in one sentence.'),
 heading('Project snapshot'),table([['Project','Working agreement'],['Client / project','Add business and project name'],['Lead & approver','Name the person doing the work and the decision maker'],['Target launch','Set the date and any fixed milestones'],['Budget & capacity','Record the agreed limits']]),
 heading('The opportunity'),paragraph('What is happening today? Describe the problem using evidence from the client, not assumptions.'),bullet('Current situation — baseline, friction and business impact.'),bullet('Desired outcome — what should be different after delivery?'),
 heading('Audience & offer'),table([['Audience','Need / barrier','Promise / proof'],['Primary customer','What stops them today?','Why should they choose this offer?'],['Secondary customer','What matters to them?','What evidence supports the promise?']]),
 heading('Scope & success'),table([['Deliverable','Acceptance criteria','Owner'],['Core deliverable','What must be true to approve it?','Assign owner'],['Supporting asset','How will quality be checked?','Assign owner']]),
 note('BOUNDARIES · List exclusions here. New requests should be agreed before changing scope, timing or cost.'),paragraph('Out of scope: add exclusions and dependencies.'),
 heading('Delivery plan'),step('Discovery — validate the brief and collect source material.'),step('Direction — agree on the approach before production.'),step('Delivery — review against acceptance criteria and hand over.'),
 heading('Risks & decisions'),table([['Risk / question','Impact','Resolution / owner'],['Missing input','Which milestone could slip?','Who will resolve it, and when?']]),
 heading('Next actions'),task('Confirm the brief with the client'),task('Agree on scope and the next review'),paragraph('Approval record: name, date, and the version agreed.')
 ]},
 {id:'outreach',name:'Outreach experiment',category:'Growth & learning',icon:'↗',description:'Build a testable campaign, compare results and decide what to change.',sections:['Test hypothesis','Audience criteria','Message workshop','Experiment log','Decision record'],blocks:[
 note('EXPERIMENT RULE · Change one meaningful variable at a time. Define success before sending.'),
 heading('The hypothesis'),paragraph('If we offer [specific value] to [audience], then [measurable response] will improve because [reason].'),
 table([['Test setup','Your plan'],['Owner & dates','Name / start / review date'],['Channel','Email, calls, or another agreed channel'],['Variable','The single change being tested'],['Success threshold','Define the measure and target']]),
 heading('Who & why'),bullet('Include: role, business type, location and a real signal of need.'),bullet('Exclude: poor fit, existing customers, opt-outs and duplicate contacts.'),bullet('Relevance: explain why this offer is timely for this audience.'),
 heading('Message to test'),table([['Part','Draft'],['Opening','A specific, relevant observation'],['Value','One outcome you can credibly help achieve'],['Proof','A short example or evidence'],['Next step','One easy question or invitation']]),
 note('QUALITY CHECK · Use accurate claims, respect opt-outs and review the message in context before sending.'),
 heading('Test sequence'),step('Select a small, comparable audience and record its source.'),step('Run the planned variant; keep other variables consistent.'),step('Wait for the agreed review window before drawing conclusions.'),
 heading('Results & learning'),paragraph('Manual experiment notes — this table does not send outreach or sync campaign metrics.'),table([['Variant / period','Contacted','Replies','Qualified','Conversions'],['Baseline','—','—','—','—'],['Test variant','—','—','—','—']]),
 heading('What did people tell us?'),bullet('Repeated objections:'),bullet('Phrases that resonated:'),bullet('Unexpected signals:'),
 heading('Decision record'),table([['Decision','Evidence','Next test'],['Continue / change / stop','What supports the decision?','What will you test next?']]),
 heading('Next actions'),task('Review the audience and message'),task('Record the results and decide what to change')
 ]},
 {id:'meeting',name:'Meeting → action',category:'Team alignment',icon:'◷',description:'A decision-led agenda with context, ownership and a clean handover.',sections:['Meeting brief','Timed agenda','Discussion notes','Decision register','Follow-through'],blocks:[
 note('MEETING OUTCOME · By the end of this conversation, we need to decide…'),
 heading('Purpose & people'),table([['Detail','Notes'],['Date & duration','Add date, time and time zone'],['Facilitator / note-taker','Assign the two roles'],['Attendees','Who needs to contribute or decide?'],['Pre-read','Add links or context to review beforehand']]),
 heading('Agenda'),table([['Time','Topic','Desired result'],['5 min','Context & changes','Shared understanding'],['15 min','Options & trade-offs','A clear recommendation'],['10 min','Decision & owners','Agreed next steps']]),
 heading('Discussion notes'),bullet('Context: what changed since the last conversation?'),bullet('Options: which alternatives did we consider?'),bullet('Trade-offs: what are we choosing to accept?'),
 heading('Decisions'),table([['Decision','Why','Decision maker'],['Record the agreement','Capture evidence and trade-offs','Name']]),
 note('READ-BACK · Confirm decisions and next steps aloud before the meeting ends.'),
 heading('Actions'),task('Owner — next step — due date'),table([['Follow-through','Owner','Due / checkpoint'],['Add the agreed deliverable','Name','Date'],['Dependency or support needed','Name','Date']]),
 heading('Parking lot'),bullet('Important questions outside today’s scope:'),bullet('Who will pick them up, and where?'),
 heading('Next check-in'),paragraph('Review date / channel:'),paragraph('Evidence to bring: what will show that the agreed actions are complete?')
 ]},
 {id:'weekly',name:'Weekly review',category:'Personal planning',icon:'◇',description:'Review evidence, clear loose ends and protect next week’s priorities.',sections:['Week at a glance','Progress review','Blockers & learning','Next week’s focus','Closing ritual'],blocks:[
 note('WEEKLY RESET · Make room for what matters. Review honestly, then choose a realistic amount of work.'),
 heading('Week at a glance'),table([['Week of','Capacity','Main outcome'],['Add date','Available days / constraints','The result that mattered most']]),
 heading('What moved forward'),table([['Outcome','Evidence','What helped?'],['Shipped / completed','Link, feedback or measure','Repeatable practice'],['Progress in motion','What changed this week?','Useful support or decision']]),
 heading('What needs attention'),table([['Open loop','Waiting on','Next move'],['Blocked work','Person / input','Follow up, re-scope or stop'],['Unanswered question','Decision maker','Set a review point']]),
 note('CAPACITY CHECK · Carrying work forward is a decision. Remove or renegotiate something before adding more.'),
 heading('What we learned'),bullet('Repeat — a practice that made work easier or better.'),bullet('Change — a friction point we can improve.'),bullet('Stop — work that no longer supports the goal.'),
 heading('Next week’s focus'),task('Choose the most important outcome'),task('Close or reschedule unfinished follow-ups'),table([['Priority','First concrete step','Protected time'],['01 · Main outcome','What can start in 30 minutes?','Day / time'],['02 · Supporting work','What moves this forward?','Day / time'],['03 · Maintenance','What needs to stay healthy?','Day / time']]),
 heading('Closing ritual'),step('Review unfinished actions and make an explicit decision for each.'),step('Check the calendar against actual capacity.'),step('Write the first step for Monday, then close the week.'),paragraph('A note to next week’s self:')
 ]}
 ,{id:'launch',name:'Project launch',category:'Delivery & operations',icon:'↗',description:'Coordinate dependencies, launch readiness and the first week after release.',sections:['Launch charter','Milestones','Readiness review','Release day','Aftercare'],blocks:[
 note('LAUNCH PRINCIPLE · A launch is ready when the experience works end to end, not when every idea has been added.'),
 heading('Launch charter'),paragraph('Outcome: describe the customer or business change this release makes possible.'),table([['Launch detail','Agreement'],['Release / owner','Name the release and accountable owner'],['Target date','Date, time and time zone'],['Audience','Who receives this first?'],['Success signal','What will we measure in the first week?']]),
 heading('Milestones & dependencies'),table([['Milestone','Dependency','Owner','Checkpoint'],['Scope locked','Decision maker approval','Name','Date'],['Ready for review','Working end-to-end experience','Name','Date'],['Ready to release','Sign-off and support plan','Name','Date']]),
 heading('Readiness review'),task('Validate the complete customer journey'),task('Confirm support ownership and rollback plan'),task('Approve launch communications'),
 note('GO / NO-GO · Record the final decision and its owner. Unresolved critical issues should have an explicit response.'),
 heading('Release day runbook'),step('Confirm the final version, owners and communication channel.'),step('Run the agreed release steps and record the time of each checkpoint.'),step('Check the live experience and communicate the outcome.'),
 heading('Risks & recovery'),table([['Risk','Early warning','Response'],['Customer-facing issue','What signal triggers action?','Who acts, and how do we recover?'],['Missing dependency','What is the latest safe checkpoint?','Alternative or delay decision']]),
 heading('First-week aftercare'),bullet('Monitor: customer feedback and the agreed success signal.'),bullet('Resolve: separate urgent defects from future improvements.'),paragraph('Retrospective prompt: what should the next launch repeat or change?')
 ]},
 {id:'brand',name:'Brand strategy',category:'Creative direction',icon:'◇',description:'Connect audience insight, positioning and a recognisable verbal and visual identity.',sections:['Brand foundation','Audience insight','Positioning','Voice & visual direction','Brand checkpoints'],blocks:[
 note('BRAND ESSENCE · Write the one idea people should remember after experiencing this business.'),
 heading('The foundation'),paragraph('Purpose: why does this business deserve to exist beyond making a sale?'),paragraph('Ambition: what do we want to become known for?'),table([['Value','What it looks like in practice','What we avoid'],['Choose a defining value','A concrete behaviour','The opposite behaviour'],['Choose a second value','A concrete behaviour','The opposite behaviour']]),
 heading('Audience insight'),bullet('They want: the practical result and the emotional reward.'),bullet('They struggle with: uncertainty, friction or unmet expectations.'),bullet('They need to believe: the promise we must prove.'),
 heading('Positioning statement'),paragraph('For [specific audience], we are the [category] that delivers [distinct value], because [credible proof].'),table([['Alternative','What it does well','Our meaningful difference'],['Competitor or current habit','Respect the real strength','A difference the audience values']]),
 heading('Voice & personality'),table([['We sound','We do not sound','Example phrase'],['Clear and assured','Cold or inflated','Write a phrase in our voice'],['Warm and specific','Vague or overly familiar','Write another phrase']]),
 heading('Visual direction'),paragraph('Art direction: describe the feeling, imagery, typography and rhythm that support the positioning.'),bullet('Colour roles: base, supporting tone and a restrained accent.'),bullet('Typography roles: expressive headlines and readable everyday text.'),bullet('Image principles: subject, lighting, composition and what to avoid.'),
 note('CONSISTENCY TEST · Would this still feel like us if the logo were removed?'),
 heading('Brand checkpoints'),task('Validate the positioning with real customer language'),task('Review voice examples across key touchpoints'),task('Document the approved direction and its owner')
 ]},
 {id:'research',name:'Research notebook',category:'Insight & discovery',icon:'◎',description:'Keep evidence, interpretation and decisions separate as you explore a question.',sections:['Research question','Study plan','Evidence log','Patterns & tensions','Recommendation'],blocks:[
 note('RESEARCH LENS · Be precise about what you know, what you infer and what still needs to be tested.'),
 heading('The question'),paragraph('We need to understand: name the question and the decision this research will inform.'),table([['Study setup','Plan'],['Owner & review date','Name / date'],['Method','Interviews, observation, desk research or a mixed approach'],['Participants / sources','Who or what can provide useful evidence?'],['Limitations','What this study cannot tell us']]),
 heading('Before you begin'),task('Agree on the research question and scope'),task('Prepare neutral prompts and a consistent note-taking method'),
 heading('Discussion guide'),step('Context — ask about the last real experience, not a hypothetical future.'),step('Behaviour — explore the sequence, friction and workarounds.'),step('Meaning — ask what mattered, and why.'),
 heading('Evidence log'),table([['Source / date','Observation or quote','Context'],['Add source reference','Record the evidence faithfully','What was happening?'],['Add source reference','Record another observation','What might affect interpretation?']]),
 heading('Patterns & tensions'),table([['Pattern','Supporting evidence','Contradicting evidence'],['Candidate insight','Which observations support it?','What does not fit?']]),
 note('INTERPRETATION CHECK · A repeated opinion is a signal, not proof of universal behaviour.'),
 heading('Recommendation'),paragraph('Based on the evidence, we recommend: state the smallest useful next decision.'),bullet('Confidence: strong, emerging or uncertain — explain why.'),bullet('Open questions: what would change our recommendation?'),task('Share findings with source context and limitations')
 ]},
 {id:'content',name:'Content calendar',category:'Editorial planning',icon:'◷',description:'Shape a consistent editorial rhythm, from audience value to publication and learning.',sections:['Editorial promise','Content pillars','Publishing plan','Production brief','Review loop'],blocks:[
 note('EDITORIAL PROMISE · Every piece should help a specific person understand, decide or do something useful.'),
 heading('Editorial direction'),paragraph('Audience: who are we writing for, and what do they need from us?'),paragraph('Voice: describe the tone and the point of view that connects this work.'),
 heading('Content pillars'),table([['Pillar','Audience value','Example angle'],['Teach','Help someone do a useful thing','A practical guide with a worked example'],['Explain','Make a complex choice clearer','A comparison with honest trade-offs'],['Demonstrate','Show evidence and real experience','A case study or behind-the-scenes account']]),
 heading('Publishing plan'),paragraph('Planning table: dates and statuses are editable notes, not automatic scheduling.'),table([['Publish date','Topic / format','Owner','Stage'],['Date','Working title / channel','Name','Idea'],['Date','Working title / channel','Name','Draft'],['Date','Working title / channel','Name','Review']]),
 heading('Production brief'),bullet('Reader takeaway: one sentence describing what changes for the reader.'),bullet('Opening: a concrete question, observation or useful claim.'),bullet('Evidence: sources, examples and permissions to check.'),bullet('Next step: an appropriate action, if one is needed.'),
 heading('Quality gate'),task('Check facts, links and source permissions'),task('Edit for clarity, accessibility and brand voice'),task('Confirm approval and publication details'),
 heading('Review & reuse'),table([['Published piece','Useful signal','Learning / reuse'],['Title / link','Responses, qualified visits or another relevant measure','What should we repeat or repurpose?']]),
 paragraph('Reflection: which topics earned meaningful attention, and which merely filled the calendar?')
 ]}

 ,{id:'daily',name:'Daily work log',category:'Logs & tracking',icon:'◷',description:'A dated collection for progress, blockers and the next step, with a calendar view.',sections:['Daily practice','Log collection','Review prompts'],blocks:[
 note('KEEP IT USEFUL · Record outcomes and decisions, not just a list of hours spent.'),heading('Daily practice'),paragraph('Write a short entry at the end of each working day. Open its record details to capture context, blockers and next steps.'),
 {type:'grid',props:{view:'table',data:JSON.stringify({title:'Daily logs',columns:['Entry','Date','Status','Owner'],types:['text','date','status','text'],rows:[['First daily log','','To do','']],notes:['Progress:\n\nBlockers:\n\nLearning:\n\nNext step:']})}},
 heading('Weekly reflection'),bullet('What moved forward, and what evidence supports that?'),bullet('Which blockers recur? Who can help resolve them?'),paragraph('Next week: choose one practical improvement.')
 ]}

];

const pairings=[
 ['arches','playfairdisplay','manrope'],['grid','spacegrotesk','dm-sans'],
 ['rose','librebaskerville','manrope'],['sage','lora','dm-sans'],
 ['sky','spacegrotesk','manrope'],['confetti','playfairdisplay','dm-sans'],
 ['ink','librebaskerville','manrope'],['ocean-photo','lora','dm-sans'],['waves','lora','manrope']
];
const fontFamily=(id:string)=>openFonts.find(f=>f.id===id)?.family||'sans-serif';
function typeset(text:string,font:string,kind:string) {
 const styles={fontFamily:font};
 if(kind==='heading')return [{type:'text',text,styles:{...styles,bold:true}}];
 const split=text.indexOf(kind==='guidance'?' · ':': ');
 if(split>0&&split<65)return [
  {type:'text',text:text.slice(0,split+1),styles:{...styles,bold:true}},
  {type:'text',text:text.slice(split+1),styles:{...styles,italic:kind==='paragraph'}}
 ];
 return [{type:'text',text,styles:{...styles,...(kind==='paragraph'?{italic:true}:{})}}];
}
export const workspaceTemplates=templateDrafts.map((t,index)=>{
 const [cover,displayFont,bodyFont]=pairings[index];
 return {...t,cover,displayFont,bodyFont,blocks:t.blocks.map((block:any)=>{
  if(block.type==='grid')return block;
  if(block.type==='table')return {...block,content:{...block.content,rows:block.content.rows.map((row:any,i:number)=>({...row,cells:row.cells.map((cell:any)=>cell.map((part:any)=>({...part,styles:{fontFamily:bodyFont,...(i===0?{bold:true}:{})}})))}))}};
  return {...block,content:typeset(block.content,block.type==='heading'?displayFont:bodyFont,block.type)};
 })};
});
function StyledText({content}:{content:any}){
 if(typeof content==='string')return <>{content}</>;
 return <>{content.map((part:any,i:number)=><span key={i} style={{fontFamily:fontFamily(part.styles?.fontFamily),fontWeight:part.styles?.bold?700:undefined,fontStyle:part.styles?.italic?'italic':undefined}}>{part.text}</span>)}</>;
}

export function TemplateLibrary({busy,onCreate}:{busy:boolean;onCreate:(template:typeof workspaceTemplates[number])=>void}) {
 const [selected,setSelected]=useState<string|null>(null);
 useEffect(()=>{if(selected)document.querySelector('.template-preview')?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});},[selected]);
 const template=workspaceTemplates.find(t=>t.id===selected);
 return <section className="workspace-tools-panel template-library" aria-label="Page templates">
  <div className="tools-heading"><div><div className="eyebrow">A BETTER START</div><h1>Templates for real work</h1><p>Thoughtful starting points. Preview a playbook, make it yours, and build on it.</p></div><span className="tool-badge">{workspaceTemplates.length} playbooks</span></div>
  <div className="template-choices">{workspaceTemplates.map((t,i)=><div className={`template-card tone-${i}`} key={t.id}>
   <div className="template-cover" role="img" aria-label={`${t.name} cover artwork`} style={coverStyle(t.cover)}/><div className="template-card-top"><span className="template-symbol">{t.icon}</span><small>{t.category}</small></div><h2 style={{fontFamily:fontFamily(t.displayFont)}}>{t.name}</h2><p>{t.description}</p>
   <ol className="template-map">{t.sections.slice(0,3).map(s=><li key={s}>{s}</li>)}</ol>
   <div className="template-card-footer"><small>Tables · prompts · actions</small><button aria-label={`Preview ${t.name}`} onClick={()=>setSelected(t.id)}>Preview →</button></div>
  </div>)}</div>
  {template&&<section className="template-preview" aria-label="Template preview"><div className="tools-heading"><div><div className="eyebrow">INSIDE THE PLAYBOOK</div><h2>{template.name}</h2><p>{template.description}</p></div><button aria-label="Close template preview" onClick={()=>setSelected(null)}>✕</button></div>
   <div className="template-preview-layout"><div><h3>Your starting structure</h3><ol>{template.sections.map(s=><li key={s}>{s}</li>)}</ol><p>Every block is editable. Creates a separate page; existing pages stay intact.</p><button className="primary" disabled={busy} aria-label={`Use ${template.name}`} onClick={()=>onCreate(template)}>Use this template →</button></div>
    <div className="template-sample"><div className="template-preview-cover" role="img" aria-label="Template cover artwork" style={coverStyle(template.cover)}/>{template.blocks.map((b:any,i)=>b.type==='grid'?<div className="sample-note" key={i}><strong>Daily logs collection</strong><p>Entry · Date · Status · Owner</p><p>Table, gallery, board and calendar views. Open a record to add notes.</p></div>:b.type==='table'?<div className="sample-table" key={i}><table><tbody>{b.content.rows.map((row:any,j:number)=><tr key={j}>{row.cells.map((c:any,k:number)=><td key={k}><StyledText content={c}/></td>)}</tr>)}</tbody></table></div>:b.type==='heading'?<h3 key={i}><StyledText content={b.content}/></h3>:<p key={i} className={b.type==='guidance'?'sample-note':''}>{b.type==='checkListItem'?'☐ ':b.type==='bulletListItem'?'• ':b.type==='numberedListItem'?'→ ':''}<StyledText content={b.content}/></p>)}</div></div>
  </section>}
 </section>;
}

type RadarTask={page_id:string;title:string;block_id:string;text:string};
export function ActionRadar({tasks,total,busy,error,onOpen}:{tasks:RadarTask[];total:number;busy:boolean;error:string;onOpen:(task:RadarTask)=>void}) {
 const [query,setQuery]=useState('');const [source,setSource]=useState('');
 const sources=Array.from(new Map(tasks.map(t=>[t.page_id,t.title||'Untitled'])).entries());
 const filtered=tasks.filter(t=>(!source||source===t.page_id)&&`${t.text} ${t.title}`.toLowerCase().includes(query.toLowerCase()));
 return <section className="workspace-tools-panel radar-view" aria-label="Action radar"><div className="tools-heading"><div><div className="eyebrow">FOLLOW THROUGH</div><h1>Action radar</h1><p>Loose ends, brought together. Pick a page and take the next step in context.</p></div><span className="tool-badge">Saved checklists</span></div>
  <div className="radar-summary"><div><strong>{busy?'—':total}</strong><span>Open actions</span></div><div><strong>{busy?'—':sources.length}</strong><span>Pages in this view</span></div><p>Complete a checkbox in its original page. Once saved, it leaves this list.</p></div>
  <div className="radar-filters"><input aria-label="Find an action" placeholder="Find an action…" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Filter actions by page" value={source} onChange={e=>setSource(e.target.value)}><option value="">All pages</option>{sources.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></div>
  {busy?<p role="status">Finding open actions…</p>:error?<p role="alert">{error}</p>:<><small>{total} open actions{total>100?' · showing the 100 most recent':''}</small><div className="radar-groups">{sources.filter(([id])=>filtered.some(t=>t.page_id===id)).map(([id,title])=><details className="radar-group" key={id} open><summary><span>{title}</span><small>{filtered.filter(t=>t.page_id===id).length} open</small></summary><div className="action-radar-list">{filtered.filter(t=>t.page_id===id).map((task,i)=><button key={task.block_id||i} onClick={()=>onOpen(task)}><span className="radar-check" aria-hidden="true">○</span><span><strong>{task.text}</strong><small>Open in page</small></span><span aria-hidden="true">↗</span></button>)}</div></details>)}</div>{!filtered.length&&<div className="radar-empty"><h2>{tasks.length?'No matching actions.':'Nothing left open.'}</h2><p>{tasks.length?'Try a different phrase or choose another page.':'Add a checklist with /checklist on any page. Your unfinished items will appear here after saving.'}</p></div>}</>}
 </section>;
}

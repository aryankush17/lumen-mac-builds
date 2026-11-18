import { CalendarDays, Plus, X } from "lucide-react";
import { ColourRules, palette, ruleColour, type Colour, type ColourRule } from "./ColourRules";
import { createReactBlockSpec } from '@blocknote/react';
import { useContext, useEffect, useRef, useState } from 'react';

import {RecordPageNavigation} from './WorkspaceNavigation';

type Kind='text'|'number'|'date'|'status'|'checkbox'|'url'|'email'|'select'|'multiSelect';
type View={colourRules?:ColourRule[];id:string;name:string;layout:string;filterColumn?:number;filterValue?:string;sort?:number;descending?:boolean;group?:number;date?:number;hidden?:number[]};
type Data={colourRules?:ColourRule[];recordColours?:Record<string,Colour>;rowIds?:string[];options?:string[][];views?:View[];activeView?:string;hidden?:number[];columns:string[];rows:string[][];types?:Kind[];notes?:string[];title?:string;filterColumn?:number;filterValue?:string;sort?:number;descending?:boolean;group?:number;date?:number};
const initial:Data={title:'Collection',columns:['Name','Status','Date'],types:['text','status','date'],rows:[['First item','To do',''],['Second item','In progress','']]};
const statuses=['To do','In progress','Done'];
const kinds:Kind[]=['text','number','date','status','checkbox','url','email','select','multiSelect'];
const iso=(y:number,m:number,d:number)=>`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
export const Grid=createReactBlockSpec({type:'grid',propSchema:{data:{default:JSON.stringify(initial)},view:{default:'table'}},content:'none'}, {
 meta: {selectable: false},
 render:({block,editor})=>{
  const openRecordPage=useContext(RecordPageNavigation);
  const [draftDay, setDraftDay] = useState<string | null>(null);
  const [addingDayItem, setAddingDayItem] = useState(false);
  const dayDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (draftDay && !dayDialog.current?.open) dayDialog.current?.showModal(); }, [draftDay]);
  const [draftTitle, setDraftTitle] = useState("");
  const [showColours, setShowColours] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [recordBusy,setRecordBusy]=useState(false);
  const [query,setQuery]=useState(''),[properties,setProperties]=useState(false),[selected,setSelected]=useState<number|null>(null);
  const [month,setMonth]=useState(()=>new Date(new Date().getFullYear(),new Date().getMonth(),1));
  const dialog=useRef<HTMLDialogElement>(null),drag=useRef<number|null>(null);
  useEffect(()=>{if(selected!==null&&!dialog.current?.open)dialog.current?.showModal();},[selected]);
  let data:Data;
  try {data=JSON.parse(block.props.data);if(!Array.isArray(data.columns)||!Array.isArray(data.rows))throw Error();}catch{return <p role="alert">This collection cannot be read. Your saved data has been preserved.</p>;}
  const raw=data;
  const activeView=raw.views?.find(v=>v.id===raw.activeView);
  data=activeView?{...raw,colourRules:activeView.colourRules,filterColumn:activeView.filterColumn,filterValue:activeView.filterValue,sort:activeView.sort,descending:activeView.descending,group:activeView.group,date:activeView.date,hidden:activeView.hidden}:raw;
  const layout=activeView?.layout||block.props.view;
  const rowIds=data.rows.map((_,i)=>data.rowIds?.[i]||crypto.randomUUID());
  const visible=data.columns.map((_,i)=>i).filter(i=>i===0||!data.hidden?.includes(i));
  const options=(c:number)=>[...new Set([...(data.options?.[c]||(types[c]==='status'?statuses:[])),...data.rows.flatMap(row=>types[c]==='multiSelect'?(row[c]||'').split(',').map(s=>s.trim()).filter(Boolean):row[c]?[row[c]]:[])])];
  const types=data.columns.map((_,c)=>data.types?.[c]||'text');
  const save=(next:Data)=>editor.updateBlock(block,{props:{data:JSON.stringify({...next,rowIds:next.rows.map((_,i)=>next.rowIds?.[i]||rowIds[i]||crypto.randomUUID())})}});
  const patch=(next:Partial<Data>)=>{
   const viewKeys=['colourRules','filterColumn','filterValue','sort','descending','group','date','hidden'];
   if(activeView&&Object.keys(next).some(k=>viewKeys.includes(k)))save({...raw,views:raw.views!.map(v=>v.id===activeView.id?{...v,...next}:v)});
   else save({...raw,...next});
  };
  const changeLayout=(view:string)=>activeView?save({...raw,views:raw.views!.map(v=>v.id===activeView.id?{...v,layout:view}:v)}):editor.updateBlock(block,{props:{view}});
  const newView=()=>{const name=window.prompt('Name this saved view','New view');if(!name?.trim())return;const id=crypto.randomUUID();const first=raw.views||[];save({...raw,views:[...first,{id,name:name.trim().slice(0,80),layout,colourRules:data.colourRules,filterColumn:data.filterColumn,filterValue:data.filterValue,sort:data.sort,descending:data.descending,group:data.group,date:data.date,hidden:data.hidden}],activeView:id});};
  const exportCSV=()=>{
   const escape=(value:string)=>'"'+(/^[=+@\-\t\r]/.test(value)?"'"+value:value).replaceAll('"','""')+'"';
   const csv=[visible.map(c=>data.columns[c]),...rows.map(r=>visible.map(c=>r.values[c]||''))].map(row=>row.map(escape).join(',')).join('\r\n');
   const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=(data.title||'Collection')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const cell=(r:number,c:number,value:string)=>{const rows=data.rows.map(row=>[...row]);rows[r][c]=value;patch({rows});};
  const group=types[data.group??-1]==='status'?data.group!:types.indexOf('status');
  const date=types[data.date??-1]==='date'?data.date!:types.indexOf('date');
  const rows=data.rows.map((values,index)=>({values,index})).filter(({values})=>values.join(' ').toLowerCase().includes(query.toLowerCase())&&(!data.filterValue||data.filterColumn===undefined||String(values[data.filterColumn]||'').toLowerCase().includes(data.filterValue.toLowerCase())));
  if(data.sort!==undefined&&data.sort>=0)rows.sort((a,b)=>{const c=data.sort!;const av=a.values[c]||'',bv=b.values[c]||'';const result=types[c]==='number'&&av!==''&&bv!==''&&Number.isFinite(+av)&&Number.isFinite(+bv)?Number(av)-Number(bv):av.localeCompare(bv,undefined,{numeric:true});return result*(data.descending?-1:1);});
  const field=(r:number,c:number)=>{
   const value=data.rows[r]?.[c]||'',label=`${data.columns[c]} row ${r+1}`;
   if(types[c]==='multiSelect')return <select multiple aria-label={label} value={value.split(',').map(v=>v.trim()).filter(Boolean)} onChange={e=>cell(r,c,Array.from(e.target.selectedOptions).map(o=>o.value).join(', '))}>{options(c).map(s=><option key={s}>{s}</option>)}</select>;
   if(types[c]==='status'||types[c]==='select')return <select aria-label={label} value={value} onChange={e=>cell(r,c,e.target.value)}><option value="">Not set</option>{options(c).map(s=><option key={s}>{s}</option>)}</select>;
   if(types[c]==='checkbox')return <input aria-label={label} type="checkbox" checked={value==='true'} onChange={e=>cell(r,c,String(e.target.checked))}/>;
   const kind=types[c];const invalid=kind==='number'&&value!==''&&!Number.isFinite(+value)||kind==='date'&&value!==''&&!/^\d{4}-\d{2}-\d{2}$/.test(value);
   return <input aria-label={label} type={invalid?'text':kind==='text'?'text':kind} value={value} onChange={e=>cell(r,c,e.target.value)}/>;
  };
  const add=(day?:string,title="Untitled")=>{const row=data.columns.map((_,c)=>c===0?title:types[c]==='status'?(options(c)[0]||''):c===date&&day?day:'');patch({rows:[...data.rows,row],notes:[...data.rows.map((_,i)=>data.notes?.[i]||''),''],rowIds:[...rowIds,crypto.randomUUID()]});};
  const recordColour = (index:number) => raw.recordColours?.[rowIds[index]] ??
    ruleColour(data.colourRules ?? [], data.rows[index], types);
  const setRecordColour = (index:number, colour:string) => {
    const recordColours = {...raw.recordColours};
    if (colour) recordColours[rowIds[index]] = colour as Colour;
    else delete recordColours[rowIds[index]];
    patch({recordColours});
  };
  const card=({values,index}:{values:string[];index:number})=><button className="record-card" data-colour={recordColour(index)} key={index} draggable onDragStart={e=>{drag.current=index;e.dataTransfer.setData('text/plain',String(index));e.stopPropagation();}} onDragEnd={()=>drag.current=null} onClick={()=>setSelected(index)}><strong>{values[0]||'Untitled'}</strong>{visible.filter(c=>c>0).map(c=>values[c]).filter(Boolean).slice(0,3).map((v,i)=><small key={i}>{v}</small>)}<span>Open details ↗</span></button>;
  return <div className="database collection-v2" contentEditable={false} tabIndex={-1}
    onMouseDown={event => {
      // Empty collection surfaces must not focus the outer editor's old caret.
      if (!(event.target as HTMLElement).closest("input,textarea,select,button,a,summary")) {
        event.preventDefault();
        event.currentTarget.focus({preventScroll: true});
      }
      event.stopPropagation();
    }}>

   <div className="database-toolbar"><input className="collection-title" aria-label="Collection name" value={data.title??'Collection'} onChange={e=>patch({title:e.target.value})}/><button aria-expanded={properties} onClick={()=>setProperties(!properties)}>Properties</button><button onClick={exportCSV}>Export CSV</button><button className="primary" onClick={()=>add()}>+ New item</button></div>
   <div className="saved-view-controls"><select aria-label="Saved view" value={raw.activeView||''} onChange={e=>save({...raw,activeView:e.target.value})}><option value="">Default view</option>{raw.views?.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select><button onClick={newView}>+ Save new view</button>{activeView&&<><button onClick={()=>{const name=window.prompt('Rename view',activeView.name);if(name?.trim())save({...raw,views:raw.views!.map(v=>v.id===activeView.id?{...v,name:name.trim().slice(0,80)}:v)});}}>Rename view</button><button onClick={()=>save({...raw,views:raw.views!.filter(v=>v.id!==activeView.id),activeView:''})}>Remove view</button></>}</div>
   <div className="collection-views" role="tablist" aria-label="Collection views">{['table','cards','board','calendar'].map(view=><button role="tab" aria-selected={layout===view} key={view} onClick={()=>changeLayout(view)}>{view==='cards'?'Gallery':view[0].toUpperCase()+view.slice(1)}</button>)}</div>
   <div className="collection-controls"><input aria-label="Search collection" placeholder="Search records…" value={query} onChange={e=>setQuery(e.target.value)}/><button aria-expanded={showRules} onClick={() => setShowRules(!showRules)}>Filter &amp; sort{data.filterValue || (data.sort ?? -1) >= 0 ? " · Active" : ""}</button>
   <button aria-expanded={showColours} onClick={() => setShowColours(!showColours)}>Card colours</button></div>
   {showColours && <ColourRules columns={data.columns} rules={data.colourRules ?? []}
     defaultColumn={Math.max(0, types.indexOf("status"))} choices={options}
     onChange={colourRules => patch({colourRules})}/>}
   {showRules && <div className="collection-controls collection-rules"><select aria-label="Sort collection" value={data.sort??-1} onChange={e=>patch({sort:+e.target.value})}><option value={-1}>No sort</option>{data.columns.map((c,i)=><option key={i} value={i}>{c}</option>)}</select><button disabled={(data.sort ?? -1) < 0} aria-label="Reverse sort direction" onClick={()=>patch({descending:!data.descending})}>{data.descending?'Descending ↓':'Ascending ↑'}</button><select aria-label="Filter property" value={data.filterColumn??-1} onChange={e=>patch({filterColumn:+e.target.value,filterValue:''})}><option value={-1}>No filter</option>{data.columns.map((c,i)=><option key={i} value={i}>{c}</option>)}</select>{(data.filterColumn??-1)>=0&&<input aria-label="Filter value" placeholder="Contains…" value={data.filterValue||''} onChange={e=>patch({filterValue:e.target.value})}/>}</div>}
   {properties&&<section className="collection-properties" aria-label="Collection properties"><p>Choose how each property works. Changing its type preserves existing values.</p>{data.columns.map((name,c)=><div key={c}><input aria-label={`Column ${c+1} name`} value={name} onChange={e=>patch({columns:data.columns.map((n,i)=>i===c?e.target.value:n)})}/><select aria-label={`Column ${c+1} type`} value={types[c]} disabled={c===0} onChange={e=>patch({types:types.map((t,i)=>i===c?e.target.value as Kind:t)})}>{kinds.map(t=><option key={t}>{t}</option>)}</select>{['status','select','multiSelect'].includes(types[c])&&<input aria-label={`Column ${c+1} options`} placeholder="Options separated by commas" defaultValue={data.options?.[c]?.join(', ')??(types[c]==='status'?statuses.join(', '):'')} onBlur={e=>patch({options:data.columns.map((_,i)=>i===c?e.target.value.split(',').map(s=>s.trim()).filter(Boolean):data.options?.[i]||(types[i]==='status'?statuses:[]))})}/>}<label><input type="checkbox" aria-label={`Show ${name} property`} disabled={c===0} checked={!data.hidden?.includes(c)} onChange={e=>patch({hidden:e.target.checked?(data.hidden||[]).filter(i=>i!==c):[...(data.hidden||[]),c]})}/>Show</label></div>)}<button onClick={()=>patch({columns:[...data.columns,'Property'],types:[...types,'text'],rows:data.rows.map(row=>[...row,''])})}>+ Add property</button></section>}
   {layout==='table'&&<div className="table-scroll" role="region" aria-label="Collection table, scroll horizontally for more properties" tabIndex={0}><table><thead><tr>{visible.map(i=><th key={i}>{data.columns[i]}<small> · {types[i]}</small></th>)}<th>Details</th></tr></thead><tbody>{rows.map(({index})=><tr data-colour={recordColour(index)} key={index}>{visible.map(c=><td key={c}>{field(index,c)}</td>)}<td><button aria-label={`Open record ${index+1}`} onClick={()=>setSelected(index)}>Open ↗</button></td></tr>)}</tbody></table></div>}
   {layout==='cards'&&<div className="collection-cards">{rows.map(card)}</div>}
   {layout==='board'&&(group<0?<p>Add a Status property to use a board.</p>:<><label>Group by <select aria-label="Board status property" value={group} onChange={e=>patch({group:+e.target.value})}>{data.columns.map((c,i)=>types[i]==='status'&&<option key={i} value={i}>{c}</option>)}</select></label><div className="collection-board">{[...new Set([...options(group),...data.rows.map(r=>r[group]||'Not set')])].map(status=><section key={status} aria-label={status+' group'} onDragOver={e=>{if(drag.current!==null)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(drag.current!==null){cell(drag.current,group,status==='Not set'?'':status);drag.current=null;}}}><h4>{status} <small>{rows.filter(r=>(r.values[group]||'Not set')===status).length}</small></h4>{rows.filter(r=>(r.values[group]||'Not set')===status).map(card)}</section>)}</div></>)}
   {layout==='calendar'&&(date<0?<p>Add a Date property to use a calendar.</p>:<><div className="calendar-controls"><button aria-label="Previous month" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}>←</button><strong>{month.toLocaleDateString(undefined,{month:'long',year:'numeric'})}</strong><button aria-label="Next month" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}>→</button><button onClick={()=>setMonth(new Date(new Date().getFullYear(),new Date().getMonth(),1))}>Today</button><select aria-label="Calendar date property" value={date} onChange={e=>patch({date:+e.target.value})}>{data.columns.map((c,i)=>types[i]==='date'&&<option key={i} value={i}>{c}</option>)}</select></div><div className="calendar-scroll"><div className="collection-calendar">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=><strong key={d}>{d}</strong>)}{Array.from({length:month.getDay()},(_,i)=><div className="empty-day" key={'empty'+i}/>)}{Array.from({length:new Date(month.getFullYear(),month.getMonth()+1,0).getDate()},(_,i)=>{const day=iso(month.getFullYear(),month.getMonth(),i+1);return <div className="calendar-day" key={day}><button className="calendar-add-day" aria-label={'View items on '+day} onClick={() => { setDraftDay(day); setDraftTitle(""); setAddingDayItem(false); if (!dayDialog.current?.open) dayDialog.current?.showModal(); }}><span className="calendar-date-number">{i+1}</span><span className="calendar-add-icon" aria-hidden="true">+</span></button>{rows.filter(r=>r.values[date]===day).map(card)}
       </div>;})}</div></div><details><summary>Without a date · {rows.filter(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.values[date]||'')).length}</summary>{rows.filter(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.values[date]||'')).map(card)}</details></>)}
   {!rows.length&&<p>{data.rows.length ? <>No matching records. <button onClick={() => { setQuery(""); patch({filterColumn:-1, filterValue:""}); }}>Clear search and filter</button></> : "No records yet. Choose + New item to add your first."}</p>}<small>{rows.length} of {data.rows.length} records</small>
   <dialog ref={dayDialog} className="calendar-day-panel" aria-label="Items for selected date"
     onClose={() => { if (!dayDialog.current?.open) { setDraftDay(null); setAddingDayItem(false); } }}>
     {draftDay && <>
       <div className="day-panel-bar">
         <span><CalendarDays size={16} aria-hidden="true"/> {data.title || "Collection"}</span>
         <button className="day-close" aria-label="Close date panel" onClick={() => dayDialog.current?.close()}><X size={18}/></button>
       </div>
       <div className="day-panel-date">
         <span className="day-number" aria-hidden="true">{draftDay.slice(-2)}</span>
         <div><h2>{new Date(draftDay + "T12:00:00").toLocaleDateString(undefined, {weekday:"long"})}</h2>
           <p>{new Date(draftDay + "T12:00:00").toLocaleDateString(undefined, {month:"long", day:"numeric", year:"numeric"})}</p></div>
       </div>
       <div className="day-panel-content">
         {data.rows.some(row => row[date] === draftDay) ?
           data.rows.map((values, index) => ({values, index})).filter(row => row.values[date] === draftDay).map(card) :
           <div className="day-empty"><span className="day-empty-icon"><CalendarDays size={26} strokeWidth={1.3}/></span><h3>A little room in your day</h3><p>Your day is open. Make space for a task, a reminder, or a new idea.</p></div>}
         {addingDayItem ? <form className="calendar-draft" aria-label={"New item on " + draftDay}
           onSubmit={event => {
             event.preventDefault();
             const title = draftTitle.trim();
             if (!title) return;
             add(draftDay, title);
             setAddingDayItem(false);
             setDraftTitle("");
           }}
           onKeyDown={event => {
             if (event.key === "Escape") {
               event.preventDefault();
               event.stopPropagation();
               setAddingDayItem(false);
             }
           }}>
           <label>Item title<input autoFocus aria-label="New item title" placeholder="What would you like to add?" value={draftTitle}
             onChange={event => setDraftTitle(event.target.value)}/></label>
           <div><button type="submit" disabled={!draftTitle.trim()}>Add</button>
             <button type="button" onClick={() => setAddingDayItem(false)}>Cancel</button></div>
         </form> : <button className="primary day-add" onClick={() => { setDraftTitle(""); setAddingDayItem(true); }}><Plus size={16}/> Add item</button>}
       </div>
     </>}
   </dialog>
   <dialog ref={dialog} className="record-peek" aria-label="Record details" onClose={()=>setSelected(null)}>{selected!==null&&data.rows[selected]&&<><div className="record-peek-head"><strong>Record details</strong><button aria-label="Close record details" onClick={()=>dialog.current?.close()}>✕</button></div><h2>{data.rows[selected][0]||'Untitled'}</h2>{data.columns.map((name,c)=><label key={c}>{name}{field(selected,c)}</label>)}<label>Card colour<select aria-label="Card colour override" value={raw.recordColours?.[rowIds[selected]] ?? ""} onChange={e => setRecordColour(selected, e.target.value)}>
     <option value="">Automatic (view rules)</option>{palette.map(colour => <option key={colour}>{colour}</option>)}
   </select></label><label>Notes<textarea aria-label="Record notes" placeholder="Context, progress, decisions and next steps…" value={data.notes?.[selected]||''} onChange={e=>patch({notes:data.rows.map((_,i)=>i===selected?e.target.value:data.notes?.[i]||'')})}/></label><p>Notes stay with this collection. Open the record page for headings, checklists, tables, subpages and other document blocks. Existing notes are copied on the first open.</p><button disabled={recordBusy} onClick={async()=>{setRecordBusy(true);try{save({...raw,rowIds});const doc=editor.document;dialog.current?.close();await openRecordPage(doc,block.id,rowIds[selected]);}finally{setRecordBusy(false);}}}>{recordBusy?'Opening…':'Open full page'}</button><button onClick={()=>{patch({rows:[...data.rows,[...data.rows[selected]]],notes:[...data.rows.map((_,i)=>data.notes?.[i]||''),data.notes?.[selected]||''],rowIds:[...rowIds,crypto.randomUUID()]});}}>Duplicate record</button><button onClick={()=>{if(window.confirm('Remove this record? You can undo in the page editor.')){patch({rows:data.rows.filter((_,i)=>i!==selected),notes:data.rows.flatMap((_,i)=>i===selected?[]:[data.notes?.[i]||'']),rowIds:rowIds.filter((_,i)=>i!==selected)});dialog.current?.close();}}}>Remove record</button></>}</dialog>
  </div>;
 }
});

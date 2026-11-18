import { useEffect, useState } from 'react'
import type { Editor } from 'grapesjs'
import { themes } from './templates'
import { fontChoices } from './siteFonts'
import ElementControls from './ElementControls'

export default function SiteControls({editor,theme}:{editor?:Editor;theme:string}){
  const [,rerender]=useState(0)
  useEffect(()=>{if(!editor)return;const update=()=>rerender(n=>n+1);editor.on('component:selected component:deselected update undo redo page:select',update);return()=>{editor.off('component:selected component:deselected update undo redo page:select',update)}},[editor])
  const base=themes.find(t=>t.id===theme)||themes[0], selected=editor?.getSelected(), root=editor?.Css.getRule(':root')?.getStyle()||{}
  const color=(key:string,fallback:string)=>String(root[key]||fallback)
  function setColor(key:string,value:string){
    editor?.Css.setRule(':root',{...root,[key]:value})
    const rule=(selector:string,style:Record<string,string>)=>editor?.Css.setRule(selector,{...editor.Css.getRule(selector)?.getStyle(),...style})
    if(key==='--site-bg')rule('body',{'background-color':'var(--site-bg)'})
    if(key==='--site-ink')rule('body',{'color':'var(--site-ink)'})
    if(key==='--site-accent')rule('.button',{'background-color':'var(--site-accent)'})
    if(key==='--site-button-ink')rule('.button',{'color':'var(--site-button-ink)'})
  }
  function setFont(selector:string,value:string){const rule=editor?.Css.getRule(selector);editor?.Css.setRule(selector,{...rule?.getStyle(),'font-family':value})}
  function move(direction:number){if(!selected)return;const parent=selected.parent();if(!parent)return;const at=parent.components().indexOf(selected)+direction;if(at>=0&&at<parent.components().length)selected.move(parent,{at})}
  const fonts=[...fontChoices,{label:'Verdana (installed)',value:'Verdana, sans-serif'},{label:'Trebuchet (installed)',value:'Trebuchet MS, sans-serif'},{label:'Times (installed)',value:'Times New Roman, serif'}]
  const page=editor?.Pages.getSelected()
  const fontValue=(value:unknown)=>{
    const clean=String(value).replace(/["']/g,'').replace(/,\s*/g,', ')
    return fonts.find(f=>f.value===clean)?.value||fonts.find(f=>f.value.split(',')[0]===clean.split(',')[0])?.value||clean
  }
  const rgbToHex=(value:string)=>{if(/^#[a-f\d]{6}$/i.test(value))return value;const parts=value.match(/\d+/g);return parts?.length&&parts.length>=3?'#'+parts.slice(0,3).map(n=>Number(n).toString(16).padStart(2,'0')).join(''):'#ffffff'}
  const elementColor=(property:string)=>{const el=selected?.getEl();return el?rgbToHex(el.ownerDocument.defaultView!.getComputedStyle(el).getPropertyValue(property)):'#ffffff'}
  return <div className="builder-site-controls">
    <details open><summary>Edit selected item</summary><p className="builder-help">{selected?selected.getName():'Click text, an image, or a section on your page to edit it.'}</p>{selected&&<div className="builder-basic-properties"><label>Text colour<input type="color" aria-label="Selected item text colour" value={elementColor('color')} onChange={e=>selected.addStyle({color:e.target.value})}/></label><label>Background<input type="color" aria-label="Selected item background colour" value={elementColor('background-color')} onChange={e=>selected.addStyle({'background-color':e.target.value})}/></label><label>Text size<input type="number" aria-label="Selected item text size" min={8} max={200} placeholder="Auto" value={parseFloat(String(selected.getStyle()['font-size']||''))||''} onChange={e=>{const size=Number(e.target.value);if(size>=8&&size<=200)selected.addStyle({'font-size':size+'px'})}}/></label><label>Inner spacing<select aria-label="Selected item spacing" value={String(selected.getStyle().padding||'')} onChange={e=>{if(e.target.value)selected.addStyle({padding:e.target.value})}}><option value="">Keep current</option><option value="0px">None</option><option value="12px">Small</option><option value="24px">Medium</option><option value="48px">Large</option></select></label></div>}{selected&&editor&&<ElementControls key={selected.cid} editor={editor} selected={selected}/>}<div className="builder-element-actions"><button disabled={!selected?.parent()} onClick={()=>move(-1)}>↑ Move up</button><button disabled={!selected?.parent()} onClick={()=>move(1)}>↓ Move down</button><button disabled={!selected?.parent()} onClick={()=>{if(selected){const p=selected.parent();p?.append(selected.clone(),{at:p.components().indexOf(selected)+1})}}}>Duplicate</button><button disabled={!selected?.parent()} onClick={()=>selected?.remove()}>Delete</button></div></details>
    <details><summary>Website colours & fonts</summary><p className="builder-help">Changes apply across this website. Individually styled elements can override them.</p>{[['--site-bg','Background',base.background],['--site-ink','Text',base.ink],['--site-accent','Accent',base.accent],['--site-button-ink','Button text',['orbit','pulse','lens'].includes(theme)?base.background:'#ffffff']].map(([key,label,fallback])=><label key={key}>{label}<input aria-label={`Website ${label.toLowerCase()} colour`} type="color" value={color(key,fallback)} onChange={e=>setColor(key,e.target.value)}/></label>)}
      <label>Body font<select aria-label="Website body font" value={fontValue(editor?.Css.getRule('body')?.getStyle()['font-family']||'Arial, sans-serif')} onChange={e=>setFont('body',e.target.value)}>{fonts.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
      <label>Heading font<select aria-label="Website heading font" value={fontValue(editor?.Css.getRule('h1, h2, h3')?.getStyle()['font-family']||base.font)} onChange={e=>setFont('h1, h2, h3',e.target.value)}>{fonts.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
    </details>
    <details><summary>Page title & description</summary><label>Search title<input aria-label="Page search title" maxLength={120} value={String(page?.get('seoTitle')||'')} onChange={e=>page?.set('seoTitle',e.target.value)} placeholder={page?.getName()}/></label><label>Description<textarea aria-label="Page description" maxLength={320} value={String(page?.get('description')||'')} onChange={e=>page?.set('description',e.target.value)}/></label><p className="builder-help">Included in the HTML export. Search engines decide how they display it.</p></details>
  </div>
}

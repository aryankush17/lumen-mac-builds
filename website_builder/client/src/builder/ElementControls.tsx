import { useState } from 'react'
import type { Component, Editor } from 'grapesjs'
import { fontChoices } from './siteFonts'

export default function ElementControls({editor,selected}:{editor:Editor;selected:Component}){
  const [error,setError]=useState(''),attrs=selected.getAttributes()
  const [,refresh]=useState(0)
  const isImage=selected.is('image'),isLink=selected.get('tagName')==='a'
  function link(value:string){
    const clean=value.trim()
    if(clean&&!/^(https?:\/\/|mailto:|tel:|#|(?:[a-zA-Z0-9_-]+\.html)(?:#.*)?$)/i.test(clean)){setError('Use https://, an email link (mailto:), phone link (tel:), #section, or a website page.');return}
    selected.addAttributes({href:clean});setError('')
  }
  function section(){let current:Component|undefined=selected;while(current&&current.get('tagName')!=='section')current=current.parent();if(current)editor.select(current)}
  const hidden=selected.getClasses().includes('lumen-hide-mobile')
  function mobile(value:boolean){
    if(value){selected.addClass('lumen-hide-mobile');editor.Css.setRule('.lumen-hide-mobile',{display:'none !important'},{atRuleType:'media',atRuleParams:'(max-width: 650px)'})}
    else selected.removeClass('lumen-hide-mobile')
    refresh(n=>n+1)
  }
  return <div className="builder-element-details">
    <label>Font<select aria-label="Selected item font" value={String(selected.getStyle()['font-family']||'')} onChange={event=>selected.addStyle({'font-family':event.target.value})}><option value="">Website default</option>{fontChoices.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
    <label>Text alignment<select aria-label="Selected item text alignment" value={String(selected.getStyle()['text-align']||'')} onChange={event=>selected.addStyle({'text-align':event.target.value})}><option value="">Default</option><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option><option value="justify">Justified</option></select></label>
    {isImage&&<><label>Image description<input aria-label="Image description" value={String(attrs.alt||'')} maxLength={300} onChange={event=>selected.addAttributes({alt:event.target.value})}/></label><p className="builder-help">Describe the image for screen readers. Leave empty if it is purely decorative.</p><label>Image fit<select aria-label="Image fit" value={String(selected.getStyle()['object-fit']||'cover')} onChange={event=>selected.addStyle({'object-fit':event.target.value})}><option value="cover">Fill the frame</option><option value="contain">Show the whole image</option></select></label><label>Image focus<select aria-label="Image focus" value={String(selected.getStyle()['object-position']||'center')} onChange={event=>selected.addStyle({'object-position':event.target.value})}><option value="center">Centre</option><option value="top">Top</option><option value="bottom">Bottom</option><option value="left">Left</option><option value="right">Right</option></select></label></>}
    {isLink&&<><label>Link destination<input key={`${selected.cid}:${attrs.href||''}`} aria-label="Link destination" defaultValue={String(attrs.href||'')} onBlur={event=>link(event.target.value)} placeholder="https://example.com or #contact"/></label><label>Link to a page<select aria-label="Link to a website page" value="" onChange={event=>{if(event.target.value)link(event.target.value)}}><option value="">Choose a page…</option>{editor.Pages.getAll().map((p,i)=><option key={p.id} value={i===0?'index.html':`${p.getId()}.html`}>{p.getName()}</option>)}</select></label><label><input type="checkbox" aria-label="Open link in a new tab" checked={attrs.target==='_blank'} onChange={event=>{if(event.target.checked)selected.addAttributes({target:'_blank',rel:'noopener noreferrer'});else selected.removeAttributes(['target','rel']);refresh(n=>n+1)}}/>Open in a new tab</label>{error&&<p role="alert" className="builder-help">{error}</p>}</>}
    <label><input type="checkbox" aria-label="Hide selected item on mobile" checked={hidden} onChange={event=>mobile(event.target.checked)}/>Hide on mobile</label>
    <p className="builder-help">Hidden items remain available in Page layers. Switch to Desktop to show them again.</p>
    <button onClick={section}>Select containing section</button>
  </div>
}

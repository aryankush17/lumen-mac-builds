import { useEffect, useRef, useState } from 'react'
import grapesjs, { type Editor, type Component } from 'grapesjs'
import JSZip from 'jszip'
import DOMPurify from 'dompurify'
import 'grapesjs/dist/css/grapes.min.css'
import './builder.css'
import { blocks, escapeHtml, siteCss, themes, type Draft } from './templates'
import { sites, type Site } from './storage'
import SiteControls from './SiteControls'
import { configureNativeVideo } from './videoComponent'
import { usedFonts, fontFaceCss } from './siteFonts'
import { nichePhoto, films, nicheCredits } from './niche/render'
import { mediaCredits } from './stockMedia'
import {templatePages,pageNames} from './templatePages'
import WebsiteImport from './WebsiteImportPanel'
import type {ImportResult} from './websiteImport'

function download(content: BlobPart, name:string, type='application/json') {
  const url=URL.createObjectURL(new Blob([content],{type})), link=document.createElement('a')
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000)
}
const message = (e:unknown) => e instanceof Error ? e.message : 'Something went wrong. Please try again.'

export default function WebsiteBuilder() {
  const [library,setLibrary]=useState<Site[]>([]), [active,setActive]=useState<Site|null>(null)
  const [error,setError]=useState(''), [status,setStatus]=useState(''), [tab,setTab]=useState('blocks')
  const [pageList,setPageList]=useState<{id:string;name:string}[]>([]), [page,setPage]=useState('')
  const [expanded,setExpanded]=useState(true),[leftOpen,setLeftOpen]=useState(true),[rightOpen,setRightOpen]=useState(true)
  const [preview,setPreview]=useState(false), [prompt,setPrompt]=useState(''), [generating,setGenerating]=useState(false)
  const [importOpen,setImportOpen]=useState(false),[previewPage,setPreviewPage]=useState(0),[videoOnly,setVideoOnly]=useState(false)
  const [theme,setTheme]=useState('atelier'), [aiOpen,setAiOpen]=useState(false)
  const [templateSearch,setTemplateSearch]=useState(''),[templatePreview,setTemplatePreview]=useState(''),[blockSearch,setBlockSearch]=useState('')
  const mount=useRef<HTMLDivElement>(null), editor=useRef<Editor>(), activeRef=useRef<Site|null>(null)
  const pending=useRef<ReturnType<typeof setTimeout>>(), saveChain=useRef(Promise.resolve()), dirty=useRef(false)
  const revision=useRef(0)
  const templateFrame=useRef<HTMLIFrameElement>(null)
  useEffect(()=>{
    if(!templatePreview)return
    let frame=0,cleanup=()=>{}
    const expected=templatePages(templatePreview)[previewPage]?.id
    const attach=()=>{
      const doc=templateFrame.current?.contentDocument
      if(!doc?.querySelector(`[data-template-page="${expected}"]`)){frame=requestAnimationFrame(attach);return}
      const navigate=(click:MouseEvent)=>{
        const href=(click.target as Element)?.closest?.('a')?.getAttribute('href')
        if(!href?.endsWith('.html'))return
        const next=templatePages(templatePreview).findIndex(p=>(p.id==='home'?'index':p.id)+'.html'===href)
        if(next>=0){click.preventDefault();setPreviewPage(next)}
      }
      doc.addEventListener('click',navigate)
      cleanup=()=>doc.removeEventListener('click',navigate)
    }
    frame=requestAnimationFrame(attach)
    return()=>{cancelAnimationFrame(frame);cleanup()}
  },[templatePreview,previewPage])
  const activeId=active?.id
  useEffect(()=>{document.documentElement.dataset.builderEditing=String(Boolean(activeId));window.dispatchEvent(new CustomEvent('lumen-builder-editing',{detail:Boolean(activeId)}));return()=>{delete document.documentElement.dataset.builderEditing;window.dispatchEvent(new CustomEvent('lumen-builder-editing',{detail:false}))}},[activeId])
  useEffect(()=>{if(activeId){setExpanded(true);setLeftOpen(true);setRightOpen(true)}},[activeId])
  useEffect(()=>{
    if(window.parent===window)return
    let origin:string
    try{const parent=new URL(document.referrer);if(!['127.0.0.1','localhost'].includes(parent.hostname))return;origin=parent.origin}catch{return}
    const send=(active:boolean)=>window.parent.postMessage({type:'lumen-builder-editing',active},origin)
    send(Boolean(activeId&&expanded))
    return()=>send(false)
  },[activeId,expanded])
  async function refresh(){try {setLibrary(await sites.list())}catch(e){setError(message(e))}}
  useEffect(()=>{void refresh()},[])
  function persist() {
    if(!editor.current || !activeRef.current)return Promise.resolve()
    const snapshot={...activeRef.current,data:editor.current.getProjectData(),updated:Date.now()}
    const savedRevision=revision.current
    dirty.current=true; setStatus('Saving…')
    saveChain.current=saveChain.current.catch(()=>{}).then(async()=>{
      await sites.save(snapshot)
      if(activeRef.current?.id===snapshot.id && revision.current===savedRevision){dirty.current=false;setStatus('Saved on this browser')}
    }).catch(e=>{setError(message(e));setStatus('Not saved');throw e})
    return saveChain.current
  }
  useEffect(()=>{
    if(!activeId || !mount.current || !activeRef.current)return
    const site=activeRef.current
    for(const id of ['builder-blocks','builder-layers','builder-traits','builder-selectors','builder-styles']) document.getElementById(id)?.replaceChildren()
    const ed=grapesjs.init({container:mount.current,height:'100%',storageManager:false,telemetry:false,
      panels:{defaults:[]},blockManager:{appendTo:'#builder-blocks'},layerManager:{appendTo:'#builder-layers'},
      traitManager:{appendTo:'#builder-traits'},
      styleManager:{appendTo:'#builder-styles',sectors:[
        {name:'Layout',open:true,buildProps:['display','width','max-width','min-height','padding','margin','gap','flex-direction','justify-content','align-items']},
        {name:'Typography',open:false,buildProps:['font-family','font-size','font-weight','line-height','letter-spacing','text-align','color']},
        {name:'Appearance',open:false,buildProps:['background-color','border','border-radius','opacity','box-shadow']},
      ]},
      deviceManager:{devices:[{id:'desktop',name:'Desktop',width:''},{id:'tablet',name:'Tablet',width:'768px',widthMedia:'992px'},{id:'mobile',name:'Mobile',width:'375px',widthMedia:'650px'}]},
      parser:{optionsHtml:{allowScripts:false,allowUnsafeAttr:false,allowUnsafeAttrValue:false}},
      canvas:{scripts:[],styles:[new URL('/fonts/catalog.css',location.href).href]},assetManager:{upload:false},
    })
    configureNativeVideo(ed)
    editor.current=ed
    blocks.forEach(b=>ed.Blocks.add(b.id,{label:b.label,content:b.html,onClick:(_block, instance)=>{const added=instance.addComponents(b.html);if(added[0]){instance.select(added[0]);added[0].getEl()?.scrollIntoView({block:'center'})}},category:b.category||(['text','heading','button','image'].includes(b.id)?'Elements':'Sections')}))
    ed.loadProjectData(site.data)
    const pagesChanged=()=>{setPageList(ed.Pages.getAll().map(p=>({id:p.getId(),name:p.getName()||'Page'})));setPage(ed.Pages.getSelected()?.getId()||'')}
    pagesChanged();ed.on('page',pagesChanged)
    ed.on('update',()=>{revision.current++;dirty.current=true;setStatus('Unsaved changes');clearTimeout(pending.current);pending.current=setTimeout(()=>void persist().catch(()=>{}),700)})
    setStatus('Saved on this browser')
    const beforeUnload=(e:BeforeUnloadEvent)=>{if(dirty.current){e.preventDefault();e.returnValue=''}}
    window.addEventListener('beforeunload',beforeUnload)
    return ()=>{clearTimeout(pending.current);if(dirty.current)void persist().catch(()=>{});window.removeEventListener('beforeunload',beforeUnload);ed.destroy();editor.current=undefined}
  },[activeId])
  useEffect(()=>{
    document.querySelectorAll<HTMLElement>('#builder-blocks .gjs-block').forEach(el=>{el.style.display=el.textContent?.toLowerCase().includes(blockSearch.toLowerCase())?'':'none';el.tabIndex=0;el.setAttribute('role','button')})
    document.querySelectorAll<HTMLElement>('#builder-blocks .gjs-block-category').forEach(el=>{el.style.display=Array.from(el.querySelectorAll<HTMLElement>('.gjs-block')).some(block=>block.style.display!=='none')?'':'none'})
  },[blockSearch,activeId])
  useEffect(()=>{if(!templatePreview)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setTemplatePreview('')};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[templatePreview])
  async function create(id:string,draft?:Draft){
    const site:Site={id:crypto.randomUUID(),name:draft?.business||'Untitled website',theme:id,updated:Date.now(),data:{pages:id==='blank'?[{id:'home',name:'Home',component:'<section style="min-height:400px"><h1>Your website starts here.</h1><p>Double-click to edit, or add a section from the left.</p></section>'}]:templatePages(id,draft),styles:[]}}
    // Parse the template once through GrapesJS to retain responsive CSS in its project format.
    const temp=document.createElement('div'), parser=grapesjs.init({container:temp,storageManager:false,telemetry:false,autorender:false})
    parser.loadProjectData(site.data);parser.setStyle(siteCss(id));site.data=parser.getProjectData();parser.destroy()
    try {await sites.save(site);activeRef.current=site;setActive(site);setAiOpen(false);setTemplatePreview('');setBlockSearch('');setError('');await refresh()}catch(e){setError(message(e))}
  }
  async function acceptImport(result:ImportResult){
    const parser=grapesjs.init({container:document.createElement('div'),storageManager:false,telemetry:false,autorender:false,parser:{optionsHtml:{allowScripts:false,allowUnsafeAttr:false,allowUnsafeAttrValue:false}}})
    let data
    try{parser.loadProjectData({pages:result.pages});data=parser.getProjectData()}finally{parser.destroy()}
    const site:Site={id:crypto.randomUUID(),name:result.name,theme:'imported',updated:Date.now(),data,importReport:{warnings:result.warnings,notices:result.notices,pages:result.pages.map(p=>p.source)}}
    await sites.save(site);activeRef.current=site;setActive(site);setImportOpen(false);setError('');await refresh()
  }
  async function close(){try {clearTimeout(pending.current);await persist();setActive(null);activeRef.current=null;setPreview(false);await refresh()}catch(e){setError(message(e))}}
  function htmlFor(component: ReturnType<Editor['getWrapper']>, title:string,description=''){
    const ed=editor.current!
    const css=ed.getCss({component})||'',fontCss=fontFaceCss('fonts/',usedFonts(css))
    const html=ed.getHtml({component}),body=/^\s*<body(?:\s|>)/i.test(html)?html:`<body>${html}</body>`
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><style>${fontCss}${css}</style></head>${body}</html>`
  }
  async function exportSite(){try{
    const ed=editor.current!,zip=new JSZip()
    ed.Pages.getAll().forEach((p,i)=>zip.file(i===0?'index.html':`${p.getId()}.html`,htmlFor(p.getMainComponent(),String(p.get('seoTitle')||`${activeRef.current?.name} — ${p.getName()}`),String(p.get('description')||''))))
    const fonts=usedFonts(ed.Pages.getAll().map(p=>ed.getCss({component:p.getMainComponent()})||'').join('\n'))
    await Promise.all(fonts.map(async font=>{
      await Promise.all([...font.variants.map(v=>v.file),font.licenseFile].map(async file=>{
        const response=await fetch('/fonts/'+file)
        if(!response.ok)throw new Error('A font could not be included. Please retry the export.')
        zip.file('fonts/'+file,await response.arrayBuffer())
      }))
    }))
    zip.file('FONT-LICENSES.txt',fonts.length?'Included fonts are unmodified SIL Open Font License fonts. Keep the accompanying fonts/*-OFL.txt files when redistributing the fonts.\n'+fonts.map(f=>f.family+' — '+f.source).join('\n'):'No Lumen font binaries are bundled separately. Imported pages may contain embedded fonts; verify their licenses and supplied notices.')
    const imported=activeRef.current?.theme==='imported',report=activeRef.current?.importReport
    if(report){zip.file('IMPORT-REPORT.txt','Static website conversion. Original source files were not changed.\n\nPages:\n'+report.pages.join('\n')+'\n\nChanges and limitations:\n'+report.warnings.join('\n'));zip.file('IMPORTED-NOTICES.txt',report.notices.map(n=>n.path+'\n'+n.text).join('\n\n----------------\n'))}
    zip.file('MEDIA-CREDITS.txt',imported?'Imported assets were supplied by the website owner. Verify rights to images, video and fonts before publication. See IMPORTED-NOTICES.txt for supplied notices. Adding a Lumen stock block also requires its Pexels license.\n\n'+mediaCredits:mediaCredits+nicheCredits)
    zip.file('README.txt','Open index.html to preview. Upload these HTML files to a static host to publish. Contact links open an email app. No forms, payments, analytics, or booking backend are connected. Stock media loads from Pexels and needs internet access. See MEDIA-CREDITS.txt for sources and licensing. Review placeholder content before publishing.')
    download(await zip.generateAsync({type:'blob'}),'website.zip','application/zip');setStatus('Website exported')
  }catch(e){setError(message(e))}}
  async function upload(file?:File){
    if(!file)return
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5*1024*1024){setError('Choose a JPG, PNG, or WebP image under 5 MB.');return}
    try{
      const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas'),ratio=Math.min(1,2000/bitmap.width,2000/bitmap.height)
      canvas.width=Math.round(bitmap.width*ratio);canvas.height=Math.round(bitmap.height*ratio);canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close()
      const src=canvas.toDataURL('image/webp',.85),ed=editor.current!
      ed.AssetManager.add({src,name:file.name});const selected=ed.getSelected()
      if(selected?.is('image'))selected.set('src',src)
      else if(selected?.getClasses().includes('gallery-placeholder'))selected.components({type:'image',src,attributes:{alt:file.name.replace(/\.[^.]+$/,'')}})
      else ed.addComponents({type:'image',src,attributes:{alt:file.name.replace(/\.[^.]+$/,'')}})
      setError('')
    }catch{setError('This image could not be opened. Please choose another file.')}
  }
  function addPage(){const name=window.prompt('Page name');if(!name?.trim())return;const id='page-'+crypto.randomUUID().slice(0,8),ed=editor.current!,header=ed.Pages.getAll()[0]?.getMainComponent().find('nav')[0]?.toHTML()||'';ed.Pages.add({id,name:name.trim().slice(0,80),component:header+blocks[0].html},{select:true})}
  function buildMenu(){const pages=editor.current?.Pages.getAll()||[],links=pages.map((p,i)=>`<a href="${i===0?'index':p.getId()}.html">${escapeHtml(p.getName()||'Page')}</a>`).join('');let count=0;pages.forEach(p=>p.getMainComponent().find('nav .links').forEach(menu=>{menu.components(links);count++}));setStatus(count?'Page menu updated — saving…':'No template header found. Add a header first.')}
  async function generate(){
    if(window.parent===window){setError('Open Website Builder inside Lumen to use the Groq key from Settings.');return}
    setGenerating(true);setError('')
    const requestId=crypto.randomUUID()
    try{
      const draft=await new Promise<Draft>((resolve,reject)=>{
        const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(new Error('Generation timed out. Check your connection and try again.'))},65000)
        function receive(event:MessageEvent){
          if(event.source!==window.parent || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(event.origin)||event.data?.type!=='lumen-website-result'||event.data.requestId!==requestId)return
          clearTimeout(timer);window.removeEventListener('message',receive)
          if(event.data.error)reject(new Error(event.data.error));else resolve(event.data.draft)
        }
        window.addEventListener('message',receive)
        window.parent.postMessage({type:'lumen-website-generate',requestId,prompt},'*')
      })
      await create(theme,draft)
    }catch(e){setError(message(e))}finally{setGenerating(false)}
  }
  async function restore(file?:File){
    if(!file)return
    try{
      if(file.size>30*1024*1024)throw new Error('Backup is too large (maximum 30 MB).')
      const data=JSON.parse(await file.text())
      if(data.format!=='lumen-website-v1'||!Array.isArray(data.site?.data?.pages)||!data.site.data.pages.length)throw new Error('Choose a Lumen website backup.')
      // Do not allow imported component scripts or event attributes to run in the editor.
      const inspect=(v:unknown,depth=0):void=>{
        if(depth>60)throw new Error('This backup is too deeply nested.')
        if(Array.isArray(v)){v.forEach(item=>inspect(item,depth+1));return}
        if(v&&typeof v==='object')for(const [key,value]of Object.entries(v)){
          if(/^script(?:-export)?$/.test(key)||/^on[a-z]+$/i.test(key)||key==='srcdoc'||key==='__proto__')throw new Error('This backup contains executable content and cannot be imported.')
          if(typeof value==='string'&&((key==='tagName'&&/^(script|iframe|object|embed|link|meta|base)$/i.test(value))||(key==='type'&&/^(script|iframe|object|embed)$/i.test(value))))throw new Error('This backup contains unsupported embedded content.')
          if(['href','src','action','xlink:href'].includes(key)&&typeof value==='string'&&/^(javascript|vbscript|data:text|data:image\/svg)/i.test(value.replace(/[\s\x00-\x1f]/g,'')))throw new Error('This backup contains an unsafe link.')
          if(typeof value==='string' && ['content','components','head'].includes(key)){
            (v as Record<string,unknown>)[key]=DOMPurify.sanitize(value,{USE_PROFILES:{html:true},FORBID_TAGS:['form','iframe','object','embed','style','link','meta','base']})
          }
          inspect(value,depth+1)
        }
      }
      inspect(data.site.data)
      const ids=new Set<string>()
      for(const page of data.site.data.pages){if(!page||typeof page.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(page.id)||ids.has(page.id))throw new Error('This backup contains invalid or duplicate page identifiers.');ids.add(page.id)}
      const site:Site={...data.site,id:crypto.randomUUID(),name:String(data.site.name||'Imported website').slice(0,120),updated:Date.now()}
      await sites.save(site);await refresh();setError('')
    }catch(e){setError(message(e))}
  }
  return <section className="site-builder">
    {error&&<div role="alert" className="builder-error">{error}<button onClick={()=>setError('')} aria-label="Dismiss error">×</button></div>}
    {!active?<>
      <header className="builder-intro"><div><p className="builder-eyebrow">LUMEN / WEBSITE STUDIO</p><h1>From first idea<br/>to your own website.</h1><p>Choose a starting point. Make every detail yours.</p></div><div className="builder-start-actions"><button className="btn-secondary" onClick={()=>setImportOpen(!importOpen)}>Import website files</button><button className="btn-secondary" onClick={()=>void create("blank")}>Start from scratch</button><button className="btn-primary" onClick={()=>setAiOpen(!aiOpen)}>✦ Build with AI</button></div></header>
      {importOpen&&<WebsiteImport onImport={acceptImport} onClose={()=>setImportOpen(false)}/>}
      {aiOpen&&<section className="builder-ai"><h2>Describe the website you have in mind.</h2><p>Include the business name, audience, services, tone, and real contact email. Uses your Groq key from Lumen Settings. Your brief is sent to Groq.</p><textarea aria-label="Website brief" maxLength={6000} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="A website for a garden design studio in Bristol…"/><label>Starting theme<select value={theme} onChange={e=>setTheme(e.target.value)}>{themes.map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</select></label><button className="btn-primary" disabled={generating||prompt.trim().length<20} onClick={()=>void generate()}>{generating?'Creating your draft…':'Generate editable website'}</button><small>AI creates the first draft. Review all claims and contact details before publishing.</small></section>}
      <div className="builder-section-heading"><h2>Start with a theme</h2><span>{themes.length} full-length designs. Every design has 4 or 5 purpose-built pages.</span></div>
      <input className="builder-template-search" aria-label="Find a template" placeholder="Find a template: photography, fitness, café…" value={templateSearch} onChange={e=>setTemplateSearch(e.target.value)}/>
      <label className="builder-video-filter"><input type="checkbox" checked={videoOnly} onChange={e=>setVideoOnly(e.target.checked)}/>Show templates with video</label><div className="builder-themes">{themes.filter(t=>(!videoOnly||Boolean(films[t.id]))&&`${t.name} ${t.category}`.toLowerCase().includes(templateSearch.toLowerCase())).map(t=><article className="builder-theme" key={t.id}><button onClick={()=>{setPreviewPage(0);setTemplatePreview(t.id)}} aria-label={`Preview ${t.name} template`} className="builder-theme-preview" style={{background:t.background,color:t.ink,fontFamily:t.font,width:'100%',textAlign:'left'}}><img className="builder-template-photo" src={nichePhoto(t.id,0,640)} alt="" loading="lazy"/><span>{t.name} <i>↗</i></span><strong>{t.headline}</strong><b style={{background:t.accent}}/><div className={`builder-mini-grid preview-${t.id}`}><i/><i/><i/></div></button><div className="builder-theme-label"><strong>{t.name}</strong><span>{t.category} · {pageNames(t.id).length} {pageNames(t.id).length===1?'page':'pages'}{films[t.id]?' · Video':''}</span><button onClick={()=>void create(t.id)} className="btn-secondary" aria-label={`Use ${t.name} theme`}>Use template</button></div></article>)}</div>
      {!themes.some(t=>(!videoOnly||Boolean(films[t.id]))&&`${t.name} ${t.category}`.toLowerCase().includes(templateSearch.toLowerCase()))&&<p className="builder-empty">No matching templates. Try another business type.</p>}
      {templatePreview&&<div className="builder-template-modal" role="dialog" aria-modal="true" aria-label="Template preview"><div className="builder-template-modal-bar"><h2>{themes.find(t=>t.id===templatePreview)?.name}</h2><label>Page<select aria-label="Template preview page" value={previewPage} onChange={e=>setPreviewPage(Number(e.target.value))}>{pageNames(templatePreview).map((n,i)=><option value={i} key={n}>{n}</option>)}</select></label><span>Original layout · editable stock media & sample content</span><button className="btn-primary" onClick={()=>void create(templatePreview)}>Use this template</button><button className="btn-secondary" autoFocus onClick={()=>setTemplatePreview('')}>Close preview</button></div><iframe title="Template website preview" sandbox="allow-same-origin" ref={templateFrame} srcDoc={`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fontFaceCss("/fonts/",usedFonts(siteCss(templatePreview)))}${siteCss(templatePreview)}</style></head><body>${templatePages(templatePreview)[previewPage]?.component||templatePages(templatePreview)[0].component}</body></html>`}/></div>}
      <p className="builder-storage-note"><a href="/third-party-notices.txt" target="_blank" rel="noopener noreferrer">Software & font licenses</a> · <a href="https://www.pexels.com/license/" target="_blank" rel="noopener noreferrer">Stock media license</a></p><div className="builder-section-heading"><h2>Your websites</h2><label className="btn-secondary builder-file">Import backup<input type="file" accept=".json" onChange={e=>void restore(e.target.files?.[0])}/></label></div>
      <p className="builder-storage-note">Saved on this browser and computer. Download backups to keep a separate copy or move between devices. Templates include illustrative stock media from Pexels; replace sample content with your own business details. Media needs an internet connection.</p>
      <div className="builder-library">{library.length?library.map(site=><article key={site.id}><div><h3>{site.name}</h3><p>{themes.find(t=>t.id===site.theme)?.name||'Custom'} · {new Date(site.updated).toLocaleDateString()}</p></div><button className="btn-primary" onClick={()=>{activeRef.current=site;setActive(site)}}>Edit website</button><button className="btn-secondary" onClick={()=>download(JSON.stringify({format:'lumen-website-v1',site}),'website-backup.json')}>Backup</button><button className="btn-secondary" onClick={async()=>{if(window.confirm(`Delete “${site.name}”? Download a backup first if you want to keep it.`)){try{await sites.remove(site.id);await refresh()}catch(e){setError(message(e))}}}}>Delete</button></article>):<p className="builder-empty">Your first website starts with a theme above.</p>}</div>
    </>:<>
      <div className="builder-toolbar"><button onClick={()=>void close()}>← Websites</button><button aria-pressed={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?"Exit expanded view":"Expand editor"}</button><input aria-label="Website name" value={active.name} maxLength={120} onChange={e=>{const next={...active,name:e.target.value};setActive(next);activeRef.current=next;revision.current++;dirty.current=true;clearTimeout(pending.current);pending.current=setTimeout(()=>void persist().catch(()=>{}),700)}}/><span role="status">{status}</span><button onClick={()=>editor.current?.UndoManager.undo()} title="Undo">↶ Undo</button><button onClick={()=>editor.current?.UndoManager.redo()} title="Redo">↷ Redo</button><button onClick={()=>void persist().catch(()=>{})}>Save</button><button onClick={()=>{if(editor.current&&activeRef.current)download(JSON.stringify({format:'lumen-website-v1',site:{...activeRef.current,data:editor.current.getProjectData()}}),'website-backup.json')}}>Backup</button><button className="btn-primary" onClick={()=>void exportSite()}>Export website</button></div>
      <div className="builder-subbar"><label>Page <select aria-label="Current page" value={page} onChange={e=>editor.current?.Pages.select(e.target.value)}>{pageList.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button onClick={addPage}>+ Page</button><details className="builder-page-menu"><summary>Page options</summary><div><button onClick={()=>{const p=editor.current?.Pages.getSelected(),n=window.prompt('Rename page',p?.getName());if(n?.trim())p?.set('name',n.trim().slice(0,80))}}>Rename</button><button onClick={buildMenu} title="Replace template header links on all pages with links to your pages">Build page menu</button><button onClick={()=>{const ed=editor.current!,current=ed.Pages.getSelected();if(current)ed.Pages.add({id:"page-"+crypto.randomUUID().slice(0,8),name:(current.getName()||"Page")+" copy",component:current.getMainComponent().components().map((component:Component)=>component.toHTML()).join(""),styles:ed.getCss({component:current.getMainComponent()}),seoTitle:current.get("seoTitle"),description:current.get("description")},{select:true})}}>Duplicate page</button><button disabled={pageList.length<2} onClick={()=>{if(window.confirm('Delete this page?'))editor.current?.Pages.remove(page)}}>Delete page</button></div></details><button aria-pressed={leftOpen} onClick={()=>setLeftOpen(!leftOpen)}>{leftOpen?"Hide content":"Show content"}</button><button aria-pressed={rightOpen} onClick={()=>setRightOpen(!rightOpen)}>{rightOpen?"Hide settings":"Show settings"}</button><label className="builder-device">Preview size <select aria-label="Preview size" onChange={e=>editor.current?.setDevice(e.target.value)}><option value="desktop">Desktop</option><option value="tablet">Tablet</option><option value="mobile">Mobile</option></select></label><button aria-pressed={preview} onClick={()=>{const next=!preview;setPreview(next);if(next)editor.current?.runCommand('core:preview');else editor.current?.stopCommand('core:preview')}}>{preview?'Back to editing':'Preview'}</button></div>
      <p className="builder-editor-guide"><strong>1. Add</strong> sections from the left · <strong>2. Edit</strong> by clicking your page · <strong>3. Preview & export</strong> when you’re ready. Changes save automatically.</p><div className={`builder-workbench ${preview?'is-preview':''} ${leftOpen?'':'left-collapsed'} ${rightOpen?'':'right-collapsed'}`}>
        <aside className="builder-left"><div className="builder-tabs"><button aria-pressed={tab==='blocks'} onClick={()=>setTab('blocks')}>Add content</button><button aria-pressed={tab==='layers'} onClick={()=>setTab('layers')}>Page layers</button></div><p className="builder-help">Drag a block onto the page, or click to append. Double-click text to edit it.</p><input aria-label="Find a block" placeholder="Find a block…" value={blockSearch} onChange={e=>setBlockSearch(e.target.value)}/><div id="builder-blocks" hidden={tab!=='blocks'} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){const target=(e.target as HTMLElement).closest<HTMLElement>(".gjs-block");if(target){e.preventDefault();target.click()}}}}/><div id="builder-layers" hidden={tab!=='layers'}/><label className="btn-secondary builder-file">Upload image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{void upload(e.target.files?.[0]);e.target.value=''}}/></label><p className="builder-help">Select an image or gallery placeholder to replace it, or upload to add one. JPG, PNG, WebP · up to 5 MB.</p></aside>
        <div ref={mount} className="builder-canvas"/>
        <aside className="builder-right"><h3>Design & settings</h3><SiteControls editor={editor.current} theme={active.theme}/><p className="builder-help">Select an element to change its layout, colours, text, and links. Use the element toolbar to move, duplicate, or delete it.</p><div id="builder-traits"/><details className="builder-advanced"><summary>More design options</summary><p className="builder-help">Fine-tune size, alignment, borders, and layout.</p><div id="builder-selectors"/><div id="builder-styles"/></details></aside>
      </div><p className="builder-footnote">Your work saves on this browser. Download a backup to keep a separate copy. Export downloads the website files; booking, payment, and form services connect separately.</p>
    </>}
  </section>
}

import JSZip from 'jszip'
import DOMPurify from 'dompurify'

export type InputFile={path:string;file:File}
export type ImportPage={id:string;name:string;component:string;styles:string;seoTitle:string;description:string;source:string}
export type ImportResult={name:string;pages:ImportPage[];warnings:string[];files:number;bytes:number;ignored:number;notices:{path:string;text:string}[]}
const LIMIT=60*1024*1024,FILE_LIMIT=20*1024*1024,COUNT=800
const mime:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',ico:'image/x-icon',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'}
const ext=(p:string)=>p.split('.').pop()?.toLowerCase()||''
function path(p:string){
 if(!p||p.startsWith('/')||p.includes('\\')||/[:\x00-\x1f]/.test(p)||p.split('/').some(v=>v==='..'||v==='.'))throw new Error('The archive contains an invalid file path. Export a clean website folder and try again.')
 return p
}
const excluded=(p:string)=>p.split('/').some(v=>v.startsWith('.')||['node_modules','__MACOSX','vendor'].includes(v))
const notice=(p:string)=>/^(?:licen[sc]e|notice|copying|ofl)(?:[-._][\w.-]+)?$/i.test(p.split('/').pop()||'')
const supported=(p:string)=>notice(p)||['html','htm','css',...Object.keys(mime)].includes(ext(p))
function unpack(file:JSZip.JSZipObject,limit:number):Promise<Uint8Array>{return new Promise((resolve,reject)=>{
 const chunks:Uint8Array[]=[];let size=0,failed=false
 const stream=(file as unknown as {internalStream:(type:string)=>{on:(event:string,callback:(chunk:any)=>void)=>void;pause:()=>void;resume:()=>void}}).internalStream('uint8array')
 stream.on('data',(chunk:Uint8Array)=>{size+=chunk.length;if(size>limit){failed=true;stream.pause();reject(new Error('An expanded file exceeds the import size limit.'))}else chunks.push(chunk)})
 stream.on('error',reject);stream.on('end',()=>{if(failed)return;const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length}resolve(bytes)});stream.resume()
})}
export async function importWebsite(inputs:InputFile[]):Promise<ImportResult>{
 if(!inputs.length)throw new Error('Choose a website folder, ZIP, or HTML file.')
 if(inputs.length>COUNT||inputs.reduce((n,f)=>n+f.file.size,0)>LIMIT)throw new Error('Choose up to 800 files totalling 60 MB. Leave out dependencies and build caches.')
 const files=new Map<string,Uint8Array>(),warnings=new Set<string>();let total=0,ignored=0
 const add=(name:string,bytes:Uint8Array)=>{if(files.has(name))throw new Error('The import contains duplicate paths.');total+=bytes.length;if(total>LIMIT||bytes.length>FILE_LIMIT)throw new Error('Import limit: 60 MB total and 20 MB per expanded file.');files.set(name,bytes)}
 if(inputs.length===1&&ext(inputs[0].path)==='zip'){
  const zip=await JSZip.loadAsync(await inputs[0].file.arrayBuffer());const entries=Object.values(zip.files)
  if(entries.length>COUNT)throw new Error('This ZIP has too many entries (maximum 800). Export only the finished website files.')
  for(const f of entries){
   if(f.dir)continue
   const original=(f as JSZip.JSZipObject&{unsafeOriginalName?:string}).unsafeOriginalName||f.name
   const name=path(original);if(excluded(name)){ignored++;continue}
   if(!supported(name)){ignored++;continue}
   const declared=(f as unknown as {_data?:{uncompressedSize?:number}})._data?.uncompressedSize
   if(declared&&declared>Math.min(FILE_LIMIT,LIMIT-total))throw new Error('An expanded file exceeds the import size limit.')
   add(name,await unpack(f,Math.min(FILE_LIMIT,LIMIT-total)))
  }
 }else for(const input of inputs){const name=path(input.path);if(excluded(name)||!supported(name)){ignored++;continue}if(input.file.size>FILE_LIMIT)throw new Error('Each file must be under 20 MB.');add(name,new Uint8Array(await input.file.arrayBuffer()))}
 const html=[...files.keys()].filter(p=>/\.html?$/i.test(p)).sort((a,b)=>{
  const score=(s:string)=>(/(^|\/)(dist|build|out)\/index\.html$/i.test(s)?-1000:/(^|\/)index\.html$/i.test(s)?-100:0)+s.split('/').length
  return score(a)-score(b)||a.localeCompare(b)
 })
 if(!html.length)throw new Error('No HTML pages found. For React, Vue, Node, Java or a Replit project, export pre-rendered/static HTML pages with their assets first. Studio does not run applications or install dependencies.')
 if(html.length>30)throw new Error('This import has more than 30 HTML pages. Import a smaller website.')
 const home=html[0],root=home.slice(0,home.lastIndexOf('/')+1)
 const htmlPaths=html.filter(p=>p.startsWith(root))
 if(htmlPaths.length<html.length)warnings.add('HTML files outside the chosen website root were skipped. Import the intended build folder directly if this is not the right site.')
 const pageIds=new Map(htmlPaths.map((p,i)=>[p,i===0?'home':`import-page-${i}`]))
 const text=(p:string)=>new TextDecoder().decode(files.get(p)!)
 const output=(p:string)=>pageIds.get(p)==='home'?'index.html':`${pageIds.get(p)}.html`
 function local(value:string,base:string){
  const clean=value.trim();if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(clean))return null
  let decoded:string;try{decoded=decodeURIComponent(clean.split(/[?#]/)[0])}catch{return null}
  if(decoded.includes('\\')||/[\x00-\x1f]/.test(decoded))return null
  const pieces=(decoded.startsWith('/')?root:base.slice(0,base.lastIndexOf('/')+1)).split('/').filter(Boolean)
  for(const part of decoded.replace(/^\//,'').split('/')){if(part==='..'){if(!pieces.length)return null;pieces.pop()}else if(part&&part!=='.')pieces.push(part)}
  return pieces.join('/')
 }
 const assets=new Map<string,string>()
 function asset(value:string,base:string):string{
  const target=local(value,base)
  if(target&&files.has(target)&&mime[ext(target)]){
   if(!assets.has(target)){const bytes=files.get(target)!;let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));assets.set(target,`data:${mime[ext(target)]};base64,${btoa(binary)}`)}
   return assets.get(target)!
  }
  if(/^data:(?:image\/(?:png|jpeg|webp|gif|avif)|font\/(?:woff2?|ttf|otf));base64,[a-z\d+/=]+$/i.test(value)&&value.length<FILE_LIMIT)return value
  if(value)warnings.add(`Missing or external asset omitted: ${value.slice(0,140)}`)
  return ''
 }
 function cleanStyle(value:string,base:string){
  // Reject legacy/executable constructs and escapes rather than attempting to decode them.
  if(/\\|expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|<\s*\/|image-set\s*\(/i.test(value)){warnings.add('An unsupported or unsafe CSS declaration was removed.');return ''}
  return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,(_m,a,b,c)=>`url("${asset(a??b??c,base)}")`)
 }
 function css(source:string,base:string,scope:string,seen=new Set<string>()):string{
  if(source.length>1024*1024)throw new Error('A stylesheet exceeds 1 MB. Import a smaller static build.')
  if(seen.has(base)||seen.size>20){warnings.add('A circular or deeply nested stylesheet import was skipped.');return ''}seen.add(base)
  const sheet=new CSSStyleSheet();try{sheet.replaceSync(source)}catch{warnings.add(`Could not parse stylesheet: ${base}`);return ''}
  if(sheet.cssRules.length>10000)throw new Error('A stylesheet has too many rules to edit smoothly.')
  // CSSStyleSheet.replaceSync drops @import; expand local imports before parsing.
  let imported='';for(const match of source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/gi)){
   const target=local(match[1],base);if(target&&files.has(target)&&ext(target)==='css'){
    const expanded=css(text(target),target,scope,new Set(seen));imported+=match[2]?`@media ${match[2]}{${expanded}}`:expanded
   }else warnings.add(`Stylesheet import omitted: ${match[1].slice(0,100)}`)
  }
  function rules(list:CSSRuleList):string{return Array.from(list).map(rule=>{
   if(rule.type===CSSRule.STYLE_RULE){const r=rule as CSSStyleRule
    // Namespace each page so common class names cannot alter another imported page.
    const parts:string[]=[];let depth=0,start=0,quote=''
    for(let i=0;i<r.selectorText.length;i++){const c=r.selectorText[i];if(quote){if(c===quote&&r.selectorText[i-1]!=='\\')quote='';continue}if(c==='"'||c==="'"){quote=c;continue}if(c==='('||c==='[')depth++;if(c===')'||c===']')depth--;if(c===','&&!depth){parts.push(r.selectorText.slice(start,i));start=i+1}}
    parts.push(r.selectorText.slice(start))
    const scoped=parts.map(part=>{const s=part.trim().replace(/^(?:html\s+)?body\b|^html\b|^:root\b/,scope);return s.startsWith(scope)?s:`${scope} ${s}`}).join(',')
    return `${scoped}{${cleanStyle(r.style.cssText,base)}}`
   }
   if(rule.type===CSSRule.MEDIA_RULE){const r=rule as CSSMediaRule;return `@media ${r.conditionText}{${rules(r.cssRules)}}`}
   if(rule.type===CSSRule.SUPPORTS_RULE){const r=rule as CSSSupportsRule;return `@supports ${r.conditionText}{${rules(r.cssRules)}}`}
   if(rule.type===CSSRule.FONT_FACE_RULE)return `@font-face{${cleanStyle((rule as CSSFontFaceRule).style.cssText,base)}}`
   warnings.add('Some CSS features (such as keyframes or cascade layers) require manual adjustment.');return ''
  }).join('\n')}
  return imported+rules(sheet.cssRules)
 }
 const pages:ImportPage[]=[]
 for(const source of htmlPaths){
  const raw=text(source);if(raw.length>3*1024*1024)throw new Error('An HTML page is too large (maximum 3 MB).')
  const doc=new DOMParser().parseFromString(raw,'text/html'),id=pageIds.get(source)!,scope=`[data-import-page="${id}"]`
  if(doc.querySelectorAll('*').length>20000)throw new Error('A page contains too many elements to edit smoothly.')
  const name=doc.title.trim()||source.split('/').pop()!,description=doc.querySelector('meta[name="description"]')?.getAttribute('content')||''
  let styles=''
  for(const el of doc.querySelectorAll('style,link[rel="stylesheet"]')){
   if(el.tagName==='STYLE')styles+=css(el.textContent||'',source,scope)
   else{const target=local(el.getAttribute('href')||'',source);if(target&&files.has(target))styles+=css(text(target),target,scope);else warnings.add(`External or missing stylesheet omitted: ${el.getAttribute('href')}`)}
  }
  const hasScripts=Boolean(doc.querySelector('script'))
  if(hasScripts)warnings.add('JavaScript was excluded. Script-driven menus, widgets, forms and application behaviour must be rebuilt in Studio.')
  if(doc.querySelector('svg,canvas,iframe,object,embed'))warnings.add('Embedded applications, SVG and canvas graphics were omitted. Use PNG or WebP images for graphics you want to edit.')
  if(doc.querySelector('form,input,textarea,select'))warnings.add('Forms were converted to static content. Submission and backend services are not imported.')
  doc.querySelectorAll('script,style,link,meta,base,iframe,object,embed,svg,canvas').forEach(el=>el.remove())
  if((hasScripts&&doc.body.textContent!.trim().length<20||!doc.body.textContent!.trim())&&doc.querySelectorAll('img,video').length===0)throw new Error(`${source}: this appears to be an empty application shell. Export pre-rendered HTML, not a JavaScript-only build.`)
  for(const el of doc.body.querySelectorAll('*')){
   for(const attr of [...el.attributes]){if(/^(on|data-gjs-)/i.test(attr.name)||['data-import-page','srcset','ping','action','formaction','srcdoc','autofocus'].includes(attr.name))el.removeAttribute(attr.name)}
   for(const key of ['src','poster','background'])if(el.hasAttribute(key)){const value=asset(el.getAttribute(key)!,source);if(value)el.setAttribute(key,value);else el.removeAttribute(key)}
   if(el.hasAttribute('style'))el.setAttribute('style',cleanStyle(el.getAttribute('style')!,source))
   if(el.hasAttribute('href')){
    const href=el.getAttribute('href')!.trim(),target=local(href,source),hash=href.includes('#')?'#'+href.split('#').slice(1).join('#'):''
    const resolved=target&&[target,target+'/index.html',target+'.html'].find(p=>pageIds.has(p))
    if(href.startsWith('#'))el.setAttribute('href',href)
    else if(resolved)el.setAttribute('href',output(resolved)+hash)
    else if(/^(https?:\/\/|mailto:|tel:)/i.test(href))el.setAttribute('rel','noopener noreferrer')
    else{el.removeAttribute('href');warnings.add(`Unresolved page link removed: ${href.slice(0,100)}`)}
   }
   if(el.tagName==='VIDEO'){el.removeAttribute('autoplay');el.setAttribute('controls','');el.setAttribute('preload','none');el.setAttribute('playsinline','')}
  }
  for(const form of doc.querySelectorAll('form')){const div=doc.createElement('div');div.innerHTML=form.innerHTML;form.replaceWith(div)}
  const clean=DOMPurify.sanitize(doc.body.innerHTML,{USE_PROFILES:{html:true},FORBID_TAGS:['input','textarea','select','form','iframe','object','embed','style','link','meta','base','script'],FORBID_ATTR:['srcdoc','formaction','action']})
  const wrapper=doc.createElement('div')
  for(const el of [doc.documentElement,doc.body])for(const attr of [...el.attributes]){
   if(['id','lang','dir'].includes(attr.name)||attr.name.startsWith('data-')&&!attr.name.startsWith('data-gjs-'))wrapper.setAttribute(attr.name,attr.value)
  }
  wrapper.className=[doc.documentElement.className,doc.body.className].filter(Boolean).join(' ')
  wrapper.setAttribute('data-import-page',id)
  wrapper.setAttribute('style',cleanStyle(doc.body.getAttribute('style')||'',source))
  wrapper.innerHTML=clean
  pages.push({id,name:name.slice(0,80),seoTitle:name.slice(0,120),description:description.slice(0,320),source,component:wrapper.outerHTML,styles:`body{margin:0}${styles}`})
  if(pages.reduce((n,p)=>n+p.component.length+p.styles.length,0)>40*1024*1024)throw new Error('The converted pages exceed 40 MB. Resize large assets or import fewer pages.')
 }
 if(ignored)warnings.add(`${ignored} unsupported, dependency, hidden or source files were excluded. No JavaScript, server code or project commands were executed.`)
 const notices=[...files.keys()].filter(notice).map(p=>({path:p,text:text(p)}))
 if([...files.keys()].some(p=>['woff','woff2','ttf','otf'].includes(ext(p)))&&!notices.length)warnings.add('Fonts were included without accompanying license notices. Verify your rights and add their notices before publishing.')
 return {name:pages[0].name,pages,warnings:[...warnings].slice(0,100),files:files.size,bytes:total,ignored,notices}
}

// Chromium directory entries must be drained repeatedly; one read can truncate a large folder.
export async function droppedFiles(items:DataTransferItemList):Promise<InputFile[]>{
 const result:InputFile[]=[]
 async function walk(entry:FileSystemEntry,prefix=''):Promise<void>{
  if(result.length>=COUNT)throw new Error('The folder has too many files. Drop the finished website folder without dependencies.')
  if(excluded(prefix+entry.name))return
  if(entry.isFile){const file=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));result.push({path:prefix+entry.name,file})}
  else{const reader=(entry as FileSystemDirectoryEntry).createReader();while(true){const batch=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await walk(child,prefix+entry.name+'/')}}
 }
 const entries=Array.from(items).map(item=>({entry:item.webkitGetAsEntry?.(),file:item.getAsFile()}))
 for(const {entry,file} of entries){if(entry)await walk(entry);else if(file)result.push({path:file.name,file})}
 return result
}

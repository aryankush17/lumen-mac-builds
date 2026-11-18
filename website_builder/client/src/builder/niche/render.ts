import {firstFiveIds,firstFiveOpening,firstFiveSections} from './firstFive'
import {blueprints,type Block} from './blueprints'
import photos from './photos.json'
import type {Draft} from '../templates'
type Theme={id:string;name:string;description:string}
const e=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
const catalog=photos as Record<string,{id:number;alt:string;source:string}[]>
export function nichePhoto(id:string,index=0,width=1400){const photo=catalog[id]?.[index];return photo?`https://images.pexels.com/photos/${photo.id}/pexels-photo-${photo.id}.jpeg?auto=compress&cs=tinysrgb&w=${width}`:''}
export const films:Record<string,{src:string;source:string}>={
 pulse:{src:'https://videos.pexels.com/video-files/5747987/5747987-hd_720_1280_60fps.mp4',source:'https://www.pexels.com/video/gym-weights-5747987/'},
 kiln:{src:'https://videos.pexels.com/video-files/8066068/8066068-hd_1280_720_24fps.mp4',source:'https://www.pexels.com/video/a-person-making-a-clay-jar-8066068/'},
 table:{src:'https://videos.pexels.com/video-files/1858094/1858094-hd_720_1280_30fps.mp4',source:'https://www.pexels.com/video/chef-cooking-in-front-of-customer-1858094/'},
 roam:{src:'https://videos.pexels.com/video-files/8775682/8775682-hd_1280_720_25fps.mp4',source:'https://www.pexels.com/video/man-doing-hiking-8775682/'},
 grain:{src:'https://videos.pexels.com/video-files/9717005/9717005-hd_1080_1920_25fps.mp4',source:'https://www.pexels.com/video/a-person-pouring-hot-coffee-in-a-cup-9717005/'},
 cove:{src:'https://videos.pexels.com/video-files/4631568/4631568-hd_1920_1080_24fps.mp4',source:'https://www.pexels.com/video/aerial-view-of-ocean-waves-4631568/'},
}
export const nicheCredits='\n\nLUMEN NICHE COLLECTION\nOriginal layouts and illustrative copy by Lumen. Photography and films: Pexels, https://www.pexels.com/license/. Assets remain subject to the Pexels license; do not imply endorsement by depicted people or brands. Replace sample business claims before publishing.\n\n'+Object.entries(catalog).map(([id,items])=>id+'\n'+items.map(p=>p.alt+' — '+p.source).join('\n')).join('\n\n')+'\n\nFilms\n'+Object.entries(films).map(([id,f])=>id+' — '+f.source).join('\n')
const pools=[[0,1,2],[3,4],[5,6],[7],[1,4]]
const path=(id:string)=>id==='home'?'index.html':id+'.html'
const picture=(id:string,n:number,hero=false)=>`<img src="${nichePhoto(id,n)}" alt="${e(catalog[id][n].alt)}" width="1400" height="1000" loading="${hero?'eager':'lazy'}" decoding="async"/>`
const row=(s:string,i:number)=>{const [title,detail,meta]=s.split('|');return `<article><span class="nc-number">${String(i+1).padStart(2,'0')}</span><div><h3>${e(title)}</h3>${detail?`<p>${e(detail)}</p>`:''}</div>${meta?`<small>${e(meta)}</small>`:''}</article>`}
function moduleKind(kind:string){
 if(/film/.test(kind))return 'film'
 if(/faq|question-answer/.test(kind))return 'faq'
 if(/menu|wine|ledger|register|specs|schedule|agenda|timeline|calendar|programme|packing|checklist|index|directory|list|hours/.test(kind))return 'ledger'
 if(/quote|manifesto|closing-line|ticker/.test(kind))return 'statement'
 if(/questionnaire|brief|worksheet|prompts/.test(kind))return 'questions'
 if(/demo|workspace|report-preview|dashboard|workflow/.test(kind))return 'console'
 if(/pathway|milestones|process|journey|steps|loop|onboarding/.test(kind))return 'steps'
 if(/letter|essay|note|story|postcard|portrait|reading/.test(kind))return 'letter'
 if(/contact|invitation|enquiry|enquiries|booking|rsvp/.test(kind))return 'contact'
 if(/wall|gallery|diptych|album|project|collection|catalog|editions|shelf|rooms|objects|exhibition/.test(kind))return 'gallery'
 return 'features'
}
function blockHtml(block:Block,id:string,pool:number[],used:Set<number>,contact:string,email:string){
 const kind=moduleKind(block.kind),available=block.photo===undefined?undefined:pool[block.photo],photo=available!==undefined&&!used.has(available)?available:undefined
 if(photo!==undefined)used.add(photo)
 const image=photo===undefined?'':`<figure>${picture(id,photo)}<figcaption>${e(catalog[id][photo].alt)}</figcaption></figure>`
 const title=`<header><span class="nc-label">${e(block.kind.replace(/-/g,' '))}</span><h2>${e(block.title)}</h2>${block.text?`<p>${e(block.text)}</p>`:''}</header>`
 let content=block.items.map(row).join('')
 if(kind==='faq')content=block.items.map(s=>{const [q,a]=s.split('|');return `<details><summary>${e(q)}</summary><p>${e(a||'Contact us for the current details.')}</p></details>`}).join('')
 if(kind==='steps')content=`<ol>${block.items.map(s=>{const [t,d]=s.split('|');return `<li><h3>${e(t)}</h3>${d?`<p>${e(d)}</p>`:''}</li>`}).join('')}</ol>`
 if(kind==='statement')content=`<p class="nc-caption">${block.items.map(e).join(' · ')}</p>`
 if(kind==='letter')content=block.items.map(s=>`<p>${e(s).replace(/\|/g,' — ')}</p>`).join('')
 if(kind==='questions')content=`<ol>${block.items.map(s=>{const[t,d]=s.split('|');return `<li><h3>${e(t)}</h3><p>${e(d||'')}</p></li>`}).join('')}</ol>`
 if(kind==='console')content=`<div class="nc-console-bar"><span>Project overview</span><span>Illustrative workspace</span></div><div class="nc-console-grid">${content}</div>`
 if(kind==='film'&&films[id])content=`<video controls playsinline preload="none" poster="${nichePhoto(id,pool[0])}" src="${films[id].src}" aria-label="${e(block.title)}"></video><a class="nc-source" href="${films[id].source}" target="_blank" rel="noopener noreferrer">Stock film / Pexels ↗</a>`
 if(kind==='contact')content+=`<a class="nc-action" href="${e(contact)}">${contact.startsWith('mailto:')?'Email your enquiry ↗':'Explore the next step ↗'}</a><a class="nc-email" href="mailto:${e(email)}">${e(email)}</a>`
 return `<section class="nc-module nc-${kind} nc-kind-${block.kind}${image?' nc-with-image':''}" data-layout="${block.kind}">${title}${image}<div class="nc-content">${content}</div></section>`
}
const homeLayouts:Record<string,string>={atelier:'poster',evergreen:'arch',orbit:'product',table:'masthead',folio:'letter',meridian:'landscape',pulse:'cover',petal:'arch',grain:'masthead',lens:'gallery',assembly:'poster',kindred:'split',cove:'cover',roam:'cover',haven:'landscape',vow:'invitation',ledger:'product',chapter:'split',kiln:'object',margin:'poster'}
function openingLayout(opening:string,index:number,id:string){if(index===0)return homeLayouts[id];if(/menu|chalkboard|ledger|programme|catalog|index|atlas|calendar/.test(opening))return 'index';if(/letter|note|correspondence|manifesto|portrait/.test(opening))return 'letter';if(/brief|contact|enquiry|request|rsvp|appointment|enrolment|reservation/.test(opening))return 'request';if(/gallery|album|wall|sheet|work/.test(opening))return 'gallery';if(/landscape|room|garden|trail|retreat/.test(opening))return 'landscape';return ['split','object','invitation','letter'][index%4]}
export function nichePages(t:Theme,draft?:Draft){const bp=blueprints[t.id];if(!bp)return [];const name=draft?.business||t.name,email=draft?.email||'hello@example.com',contact=path(bp.pages[bp.pages.length-1].id)
 return bp.pages.map((page,index)=>{const pool=pools[index],used=new Set<number>([pool[0]]),layout=openingLayout(page.opening,index,t.id),title=index===0&&draft?.headline?draft.headline:page.title,intro=index===0&&draft?.description?draft.description:page.intro
 const nav=`<nav class="nc-nav nc-nav-${bp.nav}" aria-label="Website navigation"><a class="nc-brand" href="index.html">${e(name)}</a><div>${bp.pages.map((p,i)=>`<a href="${path(p.id)}"${index===i?' aria-current="page"':''}>${e(p.name)}</a>`).join('')}</div></nav>`
 const standardOpening=`<section class="nc-opening nc-opening-${layout}" data-opening="${page.opening}"><div class="nc-opening-copy"><p class="nc-label">${e(name)} / ${e(page.name)}</p><h1>${e(title)}</h1><p class="nc-intro">${e(intro)}</p><a class="nc-text-link" href="#explore">${index===0&&draft?.action?e(draft.action):'Take a closer look'} ↓</a></div><figure>${picture(t.id,pool[0],true)}<figcaption>${e(page.name)} / ${String(index+1).padStart(2,'0')}</figcaption></figure><span class="nc-page-mark" aria-hidden="true">${String(index+1).padStart(2,'0')}</span></section>`
 const opening=index===0&&firstFiveIds.has(t.id)?firstFiveOpening(t.id,e(title),e(intro),picture(t.id,pool[0],true)):standardOpening
 const newSections=firstFiveSections(t.id,page.id)
 const insertAt=index===0?(t.id==='atelier'?0:1):Math.max(1,page.blocks.length-1)
 const modules=page.blocks.map((block,i)=>(i===insertAt?newSections:'')+blockHtml(block,t.id,pool,used,path(page.id)===contact?'mailto:'+email:contact,email)).join('')
 const extra=index===0&&draft?.services?.length?`<section class="nc-module nc-features"><header><h2>What we do</h2></header><div class="nc-content">${draft.services.map(s=>`<article><h3>${e(s.title)}</h3><p>${e(s.description)}</p></article>`).join('')}</div></section>`:''
 const footer=`<footer class="nc-footer"><div><a class="nc-brand" href="index.html">${e(name)}</a><p>${e(t.description)}</p><a href="mailto:${e(email)}">${e(email)}</a></div><div class="nc-footer-links">${bp.pages.map(p=>`<a href="${path(p.id)}">${e(p.name)} ↗</a>`).join('')}</div><div class="nc-colophon"><span>Original Lumen design · illustrative content</span><a href="https://www.pexels.com/license/" target="_blank" rel="noopener noreferrer">Photography / Pexels</a><a href="#top">Back to top ↑</a></div></footer>`
 return {id:page.id,name:page.name,component:`<div id="top" class="nc-site nc-site-${t.id} nc-density-${bp.density}${firstFiveIds.has(t.id)?' ff-site':''}" data-template-page="${page.id}">${nav}<main>${opening}<div id="explore">${modules}${extra}</div></main>${footer}</div>`}
 })
}

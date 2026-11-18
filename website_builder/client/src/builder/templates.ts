import {firstFiveCss} from './niche/firstFiveStyles'
import {nichePages} from './niche/render'
import {nicheCss} from './niche/styles'
import {blueprints} from './niche/blueprints'
import { collectionCss, extraThemes } from './collection'
import { richCss } from './richTemplates'
import { stockFilms } from './stockMedia'
import { extraBlocks } from './extraBlocks'
import { newThemes } from './newCollection'
import { multiPageCss } from './templatePages'
export const themes = [
  { id:'atelier', name:'Atelier', category:'Creative studio', background:'#eeeae1', ink:'#252622', accent:'#a63e2b', font:'Georgia, serif', headline:'Good ideas deserve extraordinary design.', description:'A thoughtful studio for brands ready to do things differently.' },
  { id:'evergreen', name:'Evergreen', category:'Local services', background:'#f1f0e7', ink:'#283e32', accent:'#627b49', font:'Arial, sans-serif', headline:'Expert care. A personal approach.', description:'Reliable, considered services built around you and your community.' },
  { id:'orbit', name:'Orbit', category:'Technology & SaaS', background:'#101522', ink:'#e8ecf4', accent:'#a8b5fa', font:'Arial, sans-serif', headline:'Less busywork. More possibility.', description:'One clear place to bring your team, your work, and your next big idea together.' },
  { id:'table', name:'The Sunday Table', category:'Hospitality', background:'#f2ead9', ink:'#4a2b21', accent:'#963d2a', font:'Georgia, serif', headline:'A little slower. A little more special.', description:'Seasonal ingredients, warm welcomes, and the moments that stay with you.' },
  { id:'folio', name:'Form & Field', category:'Consultants & portfolios', background:'#ecece4', ink:'#283d49', accent:'#34637b', font:'Georgia, serif', headline:'Clarity for your next chapter.', description:'Independent expertise. Practical strategy. Work that moves your business forward.' },
  ...extraThemes,
  ...newThemes,
].map(t=>({...t,font:`"${blueprints[t.id].font}", serif`}))
export type Draft = { business: string; headline: string; description: string; action: string; services: {title:string;description:string}[]; email: string }
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export function siteCss(id:string) {
  const t = themes.find(t=>t.id===id) || themes[0]
  return `:root{--site-bg:${t.background};--site-ink:${t.ink};--site-accent:${t.accent};--site-button-ink:${["orbit","pulse","lens"].includes(id)?t.background:"#ffffff"}}*{box-sizing:border-box}body{margin:0;background-color:var(--site-bg);color:var(--site-ink);font-family:Arial,sans-serif;font-size:16px;line-height:1.6}h1,h2,h3{font-family:${t.font};font-weight:500;line-height:1.1;margin:0 0 24px}h1{font-size:clamp(40px,6vw,84px);letter-spacing:-.045em;max-width:950px}h2{font-size:clamp(30px,4vw,48px);letter-spacing:-.03em}h3{font-size:25px}p{max-width:640px;margin:0 0 24px}a{color:inherit}img{max-width:100%;height:auto;border-radius:12px}nav,section,footer{padding:64px max(6%,24px)}nav{padding-top:24px;padding-bottom:24px;display:flex;justify-content:space-between;align-items:center;gap:20px;border-bottom:1px solid currentColor}nav a{text-decoration:none}nav .links{display:flex;gap:24px}.brand{font-size:22px;font-weight:700;letter-spacing:-.04em}.eyebrow{text-transform:uppercase;letter-spacing:.15em;font-size:12px;margin-bottom:28px}.hero{padding-top:100px;padding-bottom:100px}.hero p{font-size:21px}.button{display:inline-block;background-color:var(--site-accent);color:var(--site-button-ink);padding:14px 25px;border-radius:6px;text-decoration:none;font-weight:600}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px}.card{padding:28px;border:1px solid currentColor;border-radius:12px}.card p{margin:0}.split{display:grid;grid-template-columns:1fr 1fr;gap:50px;align-items:center}.art{min-height:280px;border-radius:140px 140px 10px 10px;background-image:linear-gradient(140deg,${t.accent},${t.ink});opacity:.85}.band{background-color:var(--site-ink);color:var(--site-bg)}.band .button{background-color:var(--site-bg);color:var(--site-ink)}footer{padding-top:30px;padding-bottom:30px;border-top:1px solid currentColor;font-size:14px}details{padding:20px 0;border-bottom:1px solid currentColor}summary{cursor:pointer;font-weight:600}details p{margin:16px 0 0}@media(max-width:650px){.grid,.split{grid-template-columns:1fr}nav{align-items:flex-start;flex-wrap:wrap}.hero{padding-top:60px;padding-bottom:60px}section{padding-top:45px;padding-bottom:45px}}` + collectionCss + richCss + multiPageCss + nicheCss(id) + firstFiveCss(id)
}
export type BlockDefinition = { id:string; label:string; html:string|{type:string}; category?:string }
export const blocks: BlockDefinition[] = [
  {id:'hero', label:'Hero', html:'<section class="hero"><p class="eyebrow">Your next chapter</p><h1>Make something people remember.</h1><p>Tell your visitors what you do and why it matters.</p><a class="button" href="#contact">Let’s talk</a></section>'},
  {id:'services',label:'Services',html:'<section id="services"><p class="eyebrow">What we do</p><h2>Built around your needs.</h2><div class="grid">'+[1,2,3].map(n=>`<div class="card"><h3>Service ${n}</h3><p>Explain the value of this service in one clear sentence.</p></div>`).join('')+'</div></section>'},
  {id:'about',label:'About / two columns',html:'<section id="about" class="split"><div><p class="eyebrow">Our approach</p><h2>Good work starts with listening.</h2><p>Share your story, your values, and what makes your approach different.</p></div><div class="art"></div></section>'},
  {id:'cta',label:'Call to action',html:'<section class="band"><h2>Ready for your next step?</h2><p>Start a conversation about what you want to achieve.</p><a class="button" href="#contact">Get in touch</a></section>'},
  {id:'faq',label:'FAQ',html:'<section><h2>A few good questions.</h2><details><summary>How do we get started?</summary><p>Contact us to discuss your project and the next steps.</p></details><details><summary>What should I expect?</summary><p>Describe your process, timing, and what customers need to know.</p></details></section>'},
  {id:'contact',label:'Contact',html:'<section id="contact"><p class="eyebrow">Get in touch</p><h2>Let’s make it happen.</h2><p>Add your real contact details before publishing.</p><a href="mailto:hello@example.com">hello@example.com</a></section>'},
  {id:'text',label:'Text',html:'<p>Double-click to write your own text.</p>'},
  {id:'heading',label:'Heading',html:'<h2>A new perspective.</h2>'},
  {id:'button',label:'Button',html:'<a class="button" href="#contact">Get in touch</a>'},
  {id:'image',label:'Image',html:{type:'image'}},
  {id:'columns',label:'Empty columns',html:'<section class="grid"><div class="card"><p>First column</p></div><div class="card"><p>Second column</p></div><div class="card"><p>Third column</p></div></section>'},
  ...extraBlocks,
  ...Object.entries(stockFilms).map(([key,film])=>({id:'stock-film-'+key,label:key==='coffee'?'Coffee film':'Coastal film',category:'Media',html:`<section class="rt-film"><div><p class="eyebrow">A moment in motion</p><h2>${film.title}</h2><p>Replace this illustrative stock film with your own story whenever you like.</p><a href="${film.source}" target="_blank" rel="noopener noreferrer">Film by ${film.credit} / Pexels</a></div><video controls playsinline preload="none" poster="${film.poster}" src="${film.src}" aria-label="${film.title}"></video></section>`})),
]
export function templateHtml(id:string, draft?:Draft) {
  return nichePages(themes.find(t=>t.id===id)||themes[0],draft)[0].component
}

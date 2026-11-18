import { openFonts } from '../openFonts'
export { openFonts }
export const fontChoices = [
  {label:'System sans',value:'Arial, sans-serif'},
  {label:'System serif',value:'Georgia, serif'},
  {label:'System monospace',value:'Courier New, monospace'},
  ...openFonts.map(f=>({label:f.family,value:`${f.family}, ${f.fallback}`})),
]
export function usedFonts(css:string){return openFonts.filter(f=>css.includes(f.family))}
export function fontFaceCss(base:string,fonts:ReturnType<typeof usedFonts>){
  return fonts.flatMap(f=>f.variants.map(v=>`@font-face{font-family:"${f.family}";src:url("${base}${v.file}") format("truetype");font-weight:${v.weight};font-style:${v.style};font-display:swap}`)).join('\n')
}

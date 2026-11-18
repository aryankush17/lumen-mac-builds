import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, Smile, Upload, X } from 'lucide-react';

const covers = [
 ['arches','Atelier arches'],['grid','Orbital study'],['waves','Tidal contours'],
 ['sand','Desert layers'],['sage','Botanical paper'],['sky','Alpine morning'],
 ['rose','Sculpted blush'],['ink','Midnight orbit'],['dots','Studio dots'],
 ['confetti','Colour study'],['dunes-photo','Quiet terrain'],['ocean-photo','Evening tide'],
];
const icons = [
  ['📄','Document'],['📝','Notes'],['📚','Books'],['💡','Idea'],['🎯','Target'],['📊','Chart'],['🚀','Rocket'],['🌿','Leaf'],
  ['🗓️','Calendar'],['📌','Pin'],['💼','Work'],['🧭','Compass'],['🔖','Bookmark'],['🧩','Puzzle'],['🎨','Art'],['🛠️','Tools'],
  ['🌍','World'],['⭐','Star'],['🔥','Fire'],['🌊','Ocean'],['🏡','Home'],['🎵','Music'],['💬','Conversation'],['✅','Done'],
  ['🔬','Research'],['📷','Camera'],['☕','Coffee'],['🏆','Trophy'],['🤝','Partnership'],['💎','Diamond'],['🌙','Moon'],['✦','Spark'],
];
export function coverStyle(cover: string): React.CSSProperties {
  if (/^upload-[a-f0-9]{32}$/.test(cover)) return {backgroundImage:`url(/api/pages-cover/${cover})`};
  if (covers.some(([id])=>id===cover)) return {backgroundImage:`url(/assets/covers/${cover}-art.svg)`,backgroundSize:'cover',backgroundPosition:'center'};
  return {};
}

export function PageAppearance({icon,cover,onChange,upload}: {
  icon:string; cover:string; onChange:(data:{icon?:string;cover?:string})=>void;
  upload:(image:string)=>Promise<{cover:string}>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null), image = useRef<HTMLImageElement|null>(null);
  const [tab,setTab]=useState<'covers'|'icons'>('covers'),[query,setQuery]=useState('');
  const [url,setUrl]=useState(''),[ready,setReady]=useState(false),[zoom,setZoom]=useState(1),[x,setX]=useState(.5),[y,setY]=useState(.5);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const mounted=useRef(true);
  useEffect(()=>()=>{mounted.current=false;},[]);
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
  const rect=()=>{
    const i=image.current!;
    const width=Math.min(i.naturalWidth,i.naturalHeight*4)/zoom,height=width/4;
    return {sx:(i.naturalWidth-width)*x,sy:(i.naturalHeight-height)*y,width,height};
  };
  useEffect(()=>{
    if(!ready||!canvas.current||!image.current)return;
    const {sx,sy,width,height}=rect(),ctx=canvas.current.getContext('2d')!;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,1600,400);
    ctx.drawImage(image.current,sx,sy,width,height,0,0,1600,400);
  },[ready,x,y,zoom]);
  function open(next:'covers'|'icons'){setTab(next);setError('');dialog.current?.showModal();}
  function close(){if(busy)return;dialog.current?.close();setUrl('');setReady(false);setError('');}
  function chooseFile(selected?:File){
    setError('');
    if(!selected)return;
    if(!['image/jpeg','image/png','image/webp'].includes(selected.type)||selected.size>12*1024*1024){setError('Choose a JPEG, PNG or WebP image up to 12 MB.');return;}
    setReady(false);const next=URL.createObjectURL(selected);setUrl(next);
    const img=new Image();image.current=img;
    img.onload=()=>{if(image.current!==img)return;if(img.naturalWidth*img.naturalHeight>40_000_000){setError('This image is too large. Choose one under 40 megapixels.');setUrl('');return;}setZoom(1);setX(.5);setY(.5);setReady(true);};
    img.onerror=()=>{setError('This image could not be opened. Try another file.');setUrl('');};img.src=next;
  }
  async function save(){
    if(!ready||!canvas.current)return;
    setBusy(true);setError('');
    try{const result=await upload(canvas.current.toDataURL('image/jpeg',.9));if(mounted.current){onChange({cover:result.cover});dialog.current?.close();setUrl('');setReady(false);}}
    catch(e){if(mounted.current)setError((e as Error).message);}
    finally{if(mounted.current)setBusy(false);}
  }
  const drag=useRef<{px:number;py:number;x:number;y:number}|null>(null);
  return <div className="page-customize">
    <button type="button" onClick={()=>open('icons')} aria-label="Choose page icon"><Smile size={15}/><span>{icon} Icon</span></button>
    <button type="button" onClick={()=>open('covers')}><ImagePlus size={15}/>{cover?'Change cover':'Add cover'}</button>
    <dialog ref={dialog} className="appearance-dialog" aria-label="Page appearance" onCancel={e=>{e.preventDefault();close();}}>
      <div className="appearance-head"><div><span className="eyebrow">PAGE APPEARANCE</span><h2>Give this page a personality.</h2></div><button type="button" aria-label="Close appearance" disabled={busy} onClick={close}><X size={18}/></button></div>
      <div className="appearance-tabs" role="tablist" aria-label="Page appearance">
        {(['covers','icons'] as const).map(t=><button type="button" key={t} role="tab" aria-selected={tab===t} onClick={()=>{if(!busy)setTab(t);}}>{t==='covers'?'Covers':'Icons'}</button>)}
      </div>
      {tab==='icons'?<div className="icon-picker"><input aria-label="Find an icon" placeholder="Find an icon…" value={query} onChange={e=>setQuery(e.target.value)}/><div className="icon-grid">{icons.filter(([,name])=>name.toLowerCase().includes(query.toLowerCase())).map(([emoji,name])=><button type="button" key={name} aria-label={name+' icon'} aria-pressed={icon===emoji} onClick={()=>{onChange({icon:emoji});close();}}>{emoji}</button>)}</div><button type="button" onClick={()=>{onChange({icon:''});close();}}>Remove icon</button></div>:
      <div className="cover-picker">
        <input hidden ref={file} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload cover image" onChange={e=>{chooseFile(e.target.files?.[0]);e.target.value='';}}/>
        <button type="button" className="upload-cover" disabled={busy} onClick={()=>file.current?.click()}><Upload size={18}/><span>Upload an image<small>JPEG, PNG or WebP · up to 12 MB · crop before saving</small></span></button>
        {url?<div className="cover-crop"><p>Drag the image to position it. Use the sliders for precise adjustments.</p>
          <canvas ref={canvas} width={1600} height={400} aria-label="Cover crop preview" onPointerDown={e=>{if(!ready||busy)return;drag.current={px:e.clientX,py:e.clientY,x,y};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null} onPointerMove={e=>{if(!drag.current||!image.current||busy)return;const d=drag.current,r=rect(),bounds=e.currentTarget.getBoundingClientRect(),i=image.current;const dx=(i.naturalWidth-r.width)*bounds.width/r.width,dy=(i.naturalHeight-r.height)*bounds.height/r.height;setX(dx?Math.max(0,Math.min(1,d.x-(e.clientX-d.px)/dx)):.5);setY(dy?Math.max(0,Math.min(1,d.y-(e.clientY-d.py)/dy)):.5);}}/>
          {!ready&&<p role="status">Preparing image…</p>}
          <label>Zoom<input type="range" min="1" max="3" step=".01" value={zoom} disabled={busy} onChange={e=>setZoom(+e.target.value)}/></label>
          <label>Horizontal position<input type="range" min="0" max="1" step=".01" value={x} disabled={busy} onChange={e=>setX(+e.target.value)}/></label>
          <label>Vertical position<input type="range" min="0" max="1" step=".01" value={y} disabled={busy} onChange={e=>setY(+e.target.value)}/></label>
          <div className="crop-actions"><button type="button" disabled={busy} onClick={()=>{setUrl('');setReady(false);}}>Cancel upload</button><button type="button" className="primary" disabled={!ready||busy} onClick={()=>void save()}>{busy?'Saving…':'Use this crop'}</button></div>
        </div>:<><div className="cover-grid">{covers.map(([id,name])=><button type="button" key={id} aria-label={name+' cover'} aria-pressed={cover===id} onClick={()=>{onChange({cover:id});close();}}><span className={'cover-swatch '+id} style={coverStyle(id)}/><span>{name}</span></button>)}</div>
        <p className="cover-credit">Original artwork designed for Lumen. Stored locally and ready to use offline.</p>
        {cover&&<button type="button" onClick={()=>{onChange({cover:''});close();}}>Remove cover</button>}</>}
      </div>}
      {error&&<p className="appearance-error" role="alert">{error}</p>}
    </dialog>
  </div>;
}

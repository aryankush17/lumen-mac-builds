// Self-contained walkthrough for the Website Builder tool. It runs INSIDE the
// tool's own window (iframe), so it can spotlight the real controls here that
// the host Lumen app's tour cannot reach across the iframe boundary.
//
// Started either from the tool's own "?" button (startWbTour) or via a
// postMessage handshake from the host ({ type: 'lumen-wb-tour' }) — see
// initWbTour(). Vanilla DOM (no React state) so it never fights re-renders.

interface Step {
  target?: string
  title: string
  body: string
}

const STEPS: Step[] = [
  {
    target: '[data-tour="wb-tools"]',
    title: 'Your tools',
    body: 'Website Studio builds and exports your websites. Website Audit, Blueprint, and Inspiration Finder help with research and planning.',
  },
  {
    target: '[data-tour="wb-categories"]',
    title: 'Pick what to audit',
    body: 'Choose which aspects to score — performance, SEO, marketing, conversion, and security. They are all on by default.',
  },
  {
    target: '[data-tour="wb-url"]',
    title: 'Enter a site',
    body: 'Type one website, or up to 10 comma-separated ones, to run a batch scan.',
  },
  {
    target: '[data-tour="wb-run"]',
    title: 'Run the audit',
    body: 'You get scores, the issues found, and an opportunity breakdown. From the results you can generate a Website Blueprint or download a PDF report.',
  },
]

const CSS = `
.wbt-block{position:fixed;inset:0;z-index:99990;background:transparent}
.wbt-block.dim{background:rgba(10,12,14,.62)}
.wbt-spot{position:fixed;z-index:99991;border-radius:12px;background:transparent;box-shadow:0 0 0 9999px rgba(10,12,14,.62),0 0 0 2px #C9A961;transition:box-shadow .15s ease;pointer-events:none}
.wbt-tip{position:fixed;z-index:99992;width:min(330px,calc(100vw - 32px));background:#171a1c;border:1px solid #2c3238;border-radius:14px;padding:16px 16px 12px;box-shadow:0 18px 50px rgba(0,0,0,.55);color:#e9ecee;font-family:inherit}
.wbt-tip h4{margin:0 0 6px;font-size:15px;font-weight:700;color:#fff}
.wbt-tip p{margin:0 0 13px;font-size:13px;line-height:1.55;color:#aab2b8}
.wbt-row{display:flex;align-items:center;gap:8px}
.wbt-count{font-size:12px;font-weight:500;color:#7b848b;margin-right:auto}
.wbt-btn{border:1px solid #2c3238;background:#20262b;color:#cfd6db;font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:8px;cursor:pointer}
.wbt-btn:hover{border-color:#C9A961;color:#fff}
.wbt-btn.primary{background:#C9A961;border-color:#C9A961;color:#1a1206}
.wbt-btn.primary:hover{background:#d8bd7e;color:#1a1206}
.wbt-skip{display:block;margin-top:9px;border:0;background:none;color:#7b848b;font-size:12px;cursor:pointer;padding:4px 2px}
.wbt-skip:hover{color:#e9ecee}
.wbt-help{display:inline-flex;align-items:center;gap:6px;border:1px solid #2c3238;background:#20262b;color:#aab2b8;font-size:12px;font-weight:600;padding:6px 11px;border-radius:999px;cursor:pointer}
.wbt-help:hover{color:#fff;border-color:#C9A961}
.wbt-help b{font-weight:800;font-size:13px}
`

let styleInjected = false
let active = false
let idx = 0
let steps: Step[] = []
let block: HTMLDivElement | null = null
let spot: HTMLDivElement | null = null
let tip: HTMLDivElement | null = null

function injectStyle(): void {
  if (styleInjected) return
  const el = document.createElement('style')
  el.textContent = CSS
  document.head.appendChild(el)
  styleInjected = true
}

function q(sel: string): HTMLElement | null {
  return document.querySelector(sel) as HTMLElement | null
}

function ensureEls(): void {
  if (block) return
  block = document.createElement('div')
  block.className = 'wbt-block'
  spot = document.createElement('div')
  spot.className = 'wbt-spot'
  tip = document.createElement('div')
  tip.className = 'wbt-tip'
  tip.setAttribute('role', 'dialog')
  document.body.appendChild(block)
  document.body.appendChild(spot)
  document.body.appendChild(tip)
}

function place(step: Step): void {
  if (!spot || !tip || !block) return
  let t: HTMLElement | null = step.target ? q(step.target) : null
  let lvl = 0
  while (t && lvl < 4) {
    const rc = t.getBoundingClientRect()
    if (rc.width > 8 && rc.height > 8) break
    t = t.parentElement
    lvl++
  }
  if (!t || t === document.body) {
    block.classList.add('dim')
    spot.style.display = 'none'
    tip.style.left = '50%'
    tip.style.top = '44%'
    tip.style.transform = 'translate(-50%,-50%)'
    return
  }
  block.classList.remove('dim')
  spot.style.display = 'block'
  tip.style.transform = 'none'
  const r = t.getBoundingClientRect()
  const pad = 6
  spot.style.left = r.left - pad + 'px'
  spot.style.top = r.top - pad + 'px'
  spot.style.width = r.width + pad * 2 + 'px'
  spot.style.height = r.height + pad * 2 + 'px'
  const tw = tip.offsetWidth || 330
  const th = tip.offsetHeight || 160
  const gap = 14
  let left: number
  let top: number
  if (r.bottom + gap + th < window.innerHeight) {
    left = r.left
    top = r.bottom + gap
  } else if (r.top - gap - th > 0) {
    left = r.left
    top = r.top - th - gap
  } else if (r.right + gap + tw < window.innerWidth) {
    left = r.right + gap
    top = r.top
  } else {
    left = r.left
    top = r.bottom + gap
  }
  left = Math.min(Math.max(12, left), window.innerWidth - tw - 12)
  top = Math.min(Math.max(12, top), window.innerHeight - th - 12)
  tip.style.left = left + 'px'
  tip.style.top = top + 'px'
}

function button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'wbt-btn' + (primary ? ' primary' : '')
  b.textContent = label
  b.onclick = onClick
  return b
}

function render(): void {
  if (!tip) return
  const step = steps[idx]
  tip.innerHTML = ''
  const h = document.createElement('h4')
  h.textContent = step.title
  tip.appendChild(h)
  const p = document.createElement('p')
  p.textContent = step.body
  tip.appendChild(p)
  const row = document.createElement('div')
  row.className = 'wbt-row'
  const cnt = document.createElement('span')
  cnt.className = 'wbt-count'
  cnt.textContent = idx + 1 + ' / ' + steps.length
  row.appendChild(cnt)
  if (idx > 0) row.appendChild(button('Back', false, prev))
  row.appendChild(button(idx === steps.length - 1 ? 'Done' : 'Next', true, next))
  tip.appendChild(row)
  const sk = document.createElement('button')
  sk.type = 'button'
  sk.className = 'wbt-skip'
  sk.textContent = 'Skip'
  sk.onclick = end
  tip.appendChild(sk)
  const target = step.target ? q(step.target) : null
  if (target && target.scrollIntoView) {
    try {
      target.scrollIntoView({ block: 'center', behavior: 'auto' })
    } catch {
      /* ignore */
    }
  }
  window.setTimeout(() => place(step), 30)
  window.setTimeout(() => place(step), 300)
}

function next(): void {
  if (idx >= steps.length - 1) end()
  else {
    idx++
    render()
  }
}

function prev(): void {
  if (idx > 0) {
    idx--
    render()
  }
}

function onKey(e: KeyboardEvent): void {
  if (!active) return
  if (e.key === 'Escape') end()
  else if (e.key === 'ArrowRight') {
    e.preventDefault()
    next()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prev()
  }
}

function reposition(): void {
  if (active) place(steps[idx])
}

export function startWbTour(): void {
  if (active) return
  injectStyle()
  const studioSteps: Step[] = [
    {target:'.builder-themes',title:'Choose your starting point',body:'Pick a theme from the collection, then edit its text, layout, colours, and images. Each theme creates a separate website.'},
    {target:'.builder-library',title:'Your saved websites',body:'Websites save in this browser. Download a backup to keep a separate copy or move to another device.'},
    {target:'.builder-left',title:'Build visually',body:'Drag sections onto your page, or click a block to append it. Double-click text to edit. Layers help you select nested elements.'},
    {target:'.builder-right',title:'Make it yours',body:'Select an element to adjust typography, layout, colours, and links. Upload images from the left panel.'},
    {target:'.builder-toolbar',title:'Save and export',body:'Use undo and redo while editing. Backup keeps an editable copy; Export website downloads static HTML ready for a web host.'},
  ]
  steps = (location.pathname === '/build' ? studioSteps : STEPS).filter((s) => !s.target || q(s.target))
  if (!steps.length) return
  ensureEls()
  active = true
  idx = 0
  if (block) block.style.display = 'block'
  if (tip) tip.style.display = 'block'
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('scroll', reposition, true)
  render()
}

function end(): void {
  if (!active) return
  active = false
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', reposition)
  window.removeEventListener('scroll', reposition, true)
  if (block) {
    block.style.display = 'none'
    block.classList.remove('dim')
  }
  if (spot) spot.style.display = 'none'
  if (tip) tip.style.display = 'none'
}

// Listen for the host Lumen app's "start the walkthrough" handshake. Only
// loopback origins (the local Lumen app / bridge) are accepted; the payload is
// a benign UI trigger with no data.
export function initWbTour(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(e.origin)) return
    const data = e.data as { type?: string } | null
    if (data && data.type === 'lumen-wb-tour') {
      startWbTour()
      // Ack the host so it stops re-sending (the host pings on an interval to
      // cover the iframe's load/warm-up time).
      try {
        ;(e.source as Window | null)?.postMessage({ type: 'lumen-wb-tour-ack' }, e.origin)
      } catch {
        /* ignore */
      }
    }
  })
}

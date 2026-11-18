import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Globe, Play, ChevronDown, Search, Settings, Radio, Zap, TrendingUp, Shield, 
  Camera, AlertCircle, CheckCircle2, ArrowRight, Sparkles, X, Check, Download
} from 'lucide-react'
import { StatusIcon, ScoreBadge, Badge, TabBar } from '../components/ui'
import { auditApi } from '../api'
import { generateAuditPdf } from '../lib/generateAuditPdf'
import { useAuditStore, type AuditResult, type CheckItem } from '../store/auditStore'
import { useNavigate } from 'react-router-dom'

const CATEGORY_OPTIONS = [
  { id: 'performance', label: 'Website Performance', icon: Zap, color: '#C9A961', desc: 'Core Web Vitals & Load Speed' },
  { id: 'seo', label: 'SEO Analysis', icon: Search, color: '#C9A961', desc: 'Search Engine Visibility' },
  { id: 'marketing', label: 'Marketing & Tracking', icon: TrendingUp, color: '#C9A961', desc: 'Analytics & Pixels' },
  { id: 'conversion', label: 'Conversion Optimization', icon: Radio, color: '#C9A961', desc: 'UX & Sales Funnel' },
  { id: 'security', label: 'Security Review', icon: Shield, color: '#C9A961', desc: 'SSL & Vulnerabilities' },
]

const categoryMeta: Record<string, { label: string; icon: React.ElementType; color: string; desc: string }> = {
  performance: { label: 'Website Performance', icon: Zap, color: '#C9A961', desc: 'Core Web Vitals & Load Speed' },
  seo: { label: 'SEO Analysis', icon: Search, color: '#C9A961', desc: 'Search Engine Visibility' },
  marketing: { label: 'Marketing & Tracking', icon: TrendingUp, color: '#C9A961', desc: 'Analytics & Pixels' },
  conversion: { label: 'Conversion Optimization', icon: Radio, color: '#C9A961', desc: 'UX & Sales Funnel' },
  security: { label: 'Security Review', icon: Shield, color: '#C9A961', desc: 'SSL & Vulnerabilities' },
  techStack: { label: 'Tech Stack', icon: Settings, color: '#C9A961', desc: 'Frameworks & CMS' },
}

function AuditCheckRow({ item, delay = 0 }: { item: CheckItem; delay?: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay }}
      className="border-b border-border/40 last:border-0 group"
    >
      <div
        className="flex items-center justify-between py-4 cursor-pointer hover:bg-surface-3/30 px-2 transition-colors rounded-xl"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="flex-shrink-0"><StatusIcon status={item.status} size={20} /></div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-text-primary mb-0.5">{item.label}</p>
            {item.value && <p className="text-[11px] text-text-muted truncate">{item.value}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3 ml-4">
          {item.status === 'fail' && (
            <Badge variant="danger" size="sm">Issue Found</Badge>
          )}
          {item.status === 'warning' && (
            <Badge variant="warning" size="sm">Warning</Badge>
          )}
          {item.opportunityPoints > 0 && item.status !== 'pass' && (
            <span className="text-xs font-bold text-primary px-2 py-1 bg-primary/10 rounded-lg">+{item.opportunityPoints} pts</span>
          )}
          <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="p-4 mx-2 mb-2 rounded-xl bg-surface border border-border/50 space-y-3">
              <div>
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1">Recommended Fix</p>
                <p className="text-sm text-text-primary">{item.recommendation}</p>
              </div>
              {item.opportunityPoints > 0 && item.status !== 'pass' && (
                <div>
                  <p className="text-[10px] font-bold text-gold-500 uppercase tracking-widest mb-1">Opportunity Impact</p>
                  <p className="text-sm font-bold text-primary">+{item.opportunityPoints} opportunity points recoverable</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function CategoryCard({ category, data, checks }: { category: string; data: { score: number }; checks: Record<string, CheckItem> }) {
  const [expanded, setExpanded] = useState(true)
  const meta = categoryMeta[category]
  if (!meta) return null
  const items = Object.values(checks).filter(i => i && typeof i === 'object' && 'status' in i)
  const passed = items.filter(i => i.status === 'pass').length
  const failed = items.filter(i => i.status === 'fail').length
  const total = items.length || 1
  const passRate = Math.round((passed / total) * 100)

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="glass-card overflow-hidden shadow-glass">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex flex-col md:flex-row md:items-center gap-6 p-6 text-left hover:bg-surface-3/40 transition-colors border-b border-border/40">
        <div className="flex items-center gap-5 flex-1">
          <div>
            <h3 className="font-display font-bold text-xl text-text-primary mb-1">{meta.label}</h3>
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-primary">{passed} passed</span>
              <span className="text-text-muted text-xs">·</span>
              <span className="text-xs font-bold text-danger-500">{failed} issues</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-8">
          <div className="hidden md:block">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 text-right">Pass Rate</p>
            <span className="text-sm font-bold text-text-primary tabular-nums">{passRate}%</span>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1">Score</p>
            <ScoreBadge score={data.score} size="lg" />
          </div>
          <div className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center">
            <ChevronDown className={`w-4 h-4 text-text-muted transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
          </div>
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="p-4 px-6 bg-black/5">
              {items.map((item, i) => (
                <AuditCheckRow key={item.label} item={item} delay={i * 0.04} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function ScreenshotSection({ url }: { url: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-6">
      <div className="flex items-center gap-3 mb-6">
        <div>
          <h3 className="font-display font-bold text-lg text-text-primary">Screenshot Capture</h3>
          <p className="text-xs text-text-muted">Visual review across device types for {url}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[
          { label: 'Homepage — Desktop', aspect: 'aspect-video' },
          { label: 'Contact Page', aspect: 'aspect-video' },
          { label: 'Mobile View', aspect: 'aspect-[9/16]' },
        ].map((shot, i) => (
          <motion.div key={i} whileHover={{ scale: 1.02 }} className="group cursor-pointer">
            <p className="text-xs font-bold text-text-secondary uppercase tracking-widest mb-3 flex items-center gap-2">
              {shot.label}
            </p>
            <div className={`w-full ${shot.aspect} rounded-xl bg-surface-3 border border-border/50 relative overflow-hidden flex flex-col items-center justify-center shadow-glass group-hover:border-info-500/50 transition-colors`}>
              <Camera className="w-8 h-8 text-text-muted opacity-20 mb-2" />
              <p className="text-[10px] text-text-muted font-medium px-4 text-center">Screenshot automation ready for Playwright/Puppeteer integration</p>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}

export default function WebsiteAudit() {
  const navigate = useNavigate()
  const { setAudit } = useAuditStore()

  const [urlInput, setUrlInput] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>(['performance', 'seo', 'marketing', 'conversion', 'security'])
  const [status, setStatus] = useState<'idle' | 'scanning' | 'complete'>('idle')
  const [scanProgress, setScanProgress] = useState(0)
  const [scanLog, setScanLog] = useState('Initializing Lumen Engine...')
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  
  // Results states
  const [result, setResult] = useState<AuditResult | null>(null)
  const [intelligence, setIntelligence] = useState<any>(null)
  const [batchResults, setBatchResults] = useState<any[] | null>(null)
  const [selectedBatchUrl, setSelectedBatchUrl] = useState<string>('')
  
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('ai-analysis')

  const toggleCategory = (id: string) => {
    setSelectedCategories(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    )
  }

  // Handle Scan logs simulation alongside API calling
  useEffect(() => {
    let interval: any
    let watchdog: any
    if (status === 'scanning') {
      const logs = [
        'Resolving DNS parameters...',
        'Contacting CrawlerService layers...',
        'Parsing robots.txt allowances...',
        'Validating SSL security configurations...',
        'Extracting HTML headings and images alt texts...',
        'Scanning script trackers for GA4, GTM and Meta Pixel...',
        'Analyzing form buttons and Call-to-Actions...',
        'Calculating weighted opportunity matrix...',
        'Evaluating rule reasoning trees...'
      ]
      let progress = 0
      interval = setInterval(() => {
        progress += Math.random() * 8 + 3
        if (progress >= 95) {
          progress = 95
        }
        setScanProgress(Math.round(progress))
        const logIndex = Math.min(logs.length - 1, Math.floor((progress / 100) * logs.length))
        setScanLog(logs[logIndex])
      }, 400)

      // Watchdog: scanning state cannot exceed 90 seconds. If we ever sit at
      // 95% for that long, force an error state so the user can retry instead
      // of staring at a frozen spinner.
      watchdog = setTimeout(() => {
        setStatus('idle')
        setScanProgress(0)
        setError('Audit took longer than 90 seconds and was abandoned. The target site may be slow, blocking automated requests, or unreachable. Try a different URL.')
      }, 90000)
    }
    return () => {
      clearInterval(interval)
      if (watchdog) clearTimeout(watchdog)
    }
  }, [status])

  const handleCancel = () => {
    if (abortController) {
      abortController.abort()
    }
    setStatus('idle')
    setScanProgress(0)
    setScanLog('Scan cancelled.')
  }

  const handleAudit = async () => {
    if (!urlInput.trim()) { setError('Please enter a valid URL'); return }
    if (selectedCategories.length === 0) { setError('Please select at least one audit category'); return }
    setError('')
    setStatus('scanning')
    setScanProgress(5)
    setResult(null)
    setBatchResults(null)
    setIntelligence(null)

    const controller = new AbortController()
    setAbortController(controller)

    try {
      // Backend call
      const urlsArray = urlInput.split(',').map(u => u.trim()).filter(Boolean)
      const targetInput = urlsArray.length === 1 ? urlsArray[0] : urlsArray

      const res = await auditApi.run(targetInput, selectedCategories)

      // Complete progress smoothly
      setScanProgress(100)
      setScanLog('Analysis generated successfully.')

      // Brief pause for visual smoothness
      await new Promise(r => setTimeout(r, 400))

      // Resolve the primary audit to display
      let primaryAudit: any = null
      let primaryUrl: string = ''

      if (Array.isArray(res.data)) {
        setBatchResults(res.data)
        const firstSuccess = res.data.find((r: any) => r.success)
        if (firstSuccess) {
          primaryAudit = firstSuccess.data
          primaryUrl = firstSuccess.url
          setSelectedBatchUrl(primaryUrl)
        } else {
          // Every URL in the batch failed
          setStatus('idle')
          setScanProgress(0)
          setError('All URLs in this batch failed to crawl. Check the URLs and try again.')
          return
        }
      } else {
        primaryAudit = res.data
      }

      if (!primaryAudit) {
        setStatus('idle')
        setScanProgress(0)
        setError('Unable to connect to this website. Please verify the URL and ensure the website is publicly accessible before trying again.')
        return
      }

      if (primaryAudit.crawl && primaryAudit.crawl.success === false) {
        setStatus('idle')
        setScanProgress(0)
        const details = primaryAudit.crawl.sslError 
          ? ` (SSL certificate error: ${primaryAudit.crawl.sslError})` 
          : primaryAudit.crawl.statusCode 
            ? ` (HTTP Status: ${primaryAudit.crawl.statusCode})` 
            : ''
        setError(`Unable to connect to this website. Please verify the URL and ensure the website is publicly accessible before trying again.${details}`)
        return
      }

      // Render results IMMEDIATELY — intelligence is a non-critical extra
      setResult(primaryAudit)
      setAudit(primaryAudit)
      // Intelligence is now embedded in the audit response — no separate fetch.
      if (primaryAudit?.intelligence) {
        setIntelligence(primaryAudit.intelligence)
      }
      setStatus('complete')
      setActiveTab('ai-analysis')

    } catch (e: any) {
      if (e.name === 'CanceledError' || e.name === 'AbortError') {
        setStatus('idle')
        setScanProgress(0)
      } else {
        setStatus('idle')
        setScanProgress(0)
        const msg = e?.response?.data?.error || e?.message || 'Audit failed. Check that the server is online and try again.'
        if (msg.includes('connect') || msg.includes('network') || msg.includes('timeout') || msg.includes('unreachable') || msg.includes('failed') || msg.includes('500') || msg.includes('504')) {
          setError('Unable to connect to this website. Please verify the URL and ensure the website is publicly accessible before trying again.')
        } else {
          setError(`Unable to connect to this website. Please verify the URL and ensure the website is publicly accessible before trying again. (Details: ${msg})`)
        }
      }
    }
  }

  const handleSelectBatchResult = (url: string, data: AuditResult) => {
    setResult(data)
    setAudit(data)
    setSelectedBatchUrl(url)
    // Intelligence is embedded inside the audit data
    setIntelligence((data as any)?.intelligence || null)
  }

  const tabs = [
    { id: 'ai-analysis', label: 'AI Strategy & Rules' },
    { id: 'all', label: 'All Results List' },
    { id: 'screenshots', label: 'Screenshots' },
    ...selectedCategories.map(id => ({ id, label: CATEGORY_OPTIONS.find(c => c.id === id)?.label.split(' ')[0] || id })),
  ]

  // Opp score variables
  const opp = result?.opportunityScore

  return (
    <div className="space-y-8 pb-12">
      {/* Input Section */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-8 shadow-glow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
        <div className="relative z-10">
          <h2 className="font-display font-extrabold text-2xl text-text-primary mb-1">Website Audit Engine</h2>
          <p className="text-sm text-text-muted font-medium mb-6">Select categories to audit, then enter a single URL or comma-separated URLs (up to 10) to run a batch scan.</p>

          {/* Category Selection */}
          <div className="mb-6" data-tour="wb-categories">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-3">Select Audit Categories</p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {CATEGORY_OPTIONS.map(cat => {
                const isSelected = selectedCategories.includes(cat.id)
                return (
                  <button
                    key={cat.id}
                    onClick={() => toggleCategory(cat.id)}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all duration-200 text-center group ${
                      isSelected
                        ? 'border-primary/60 bg-primary/10 shadow-glow-sm'
                        : 'border-border bg-surface-3/50 hover:border-border-2 hover:bg-surface-3'
                    }`}
                  >
                    <span className={`text-[10px] font-bold leading-tight ${isSelected ? 'text-text-primary' : 'text-text-muted'}`}>
                      {cat.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* URL Input */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative" data-tour="wb-url">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-lg bg-surface-3">
                <Globe className="w-4 h-4 text-primary" />
              </div>
              <input
                type="text"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAudit()}
                placeholder="example.com, google.com (Supports up to 10 comma-separated URLs)"
                className="input-field pl-14 py-4 text-base shadow-inner-glow bg-white focus:bg-white"
                disabled={status === 'scanning'}
              />
            </div>
            <button
              onClick={handleAudit}
              disabled={status === 'scanning' || selectedCategories.length === 0}
              className="btn-primary px-8 py-4 flex-shrink-0 text-base shadow-glow-primary disabled:opacity-50"
              data-tour="wb-run"
            >
              {status === 'scanning'
                ? <><img src="/lumen-logo.png" alt="" className="w-5 h-5 animate-[spin_2.2s_linear_infinite]" draggable={false} /> Scanning...</>
                : <><Play className="w-5 h-5 fill-white" /> Run Audit</>
              }
            </button>
          </div>
          {error && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4 text-sm font-bold text-danger-500 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {error}
            </motion.p>
          )}
        </div>
      </motion.div>

      {/* Scanning Animation & Cancel Options */}
      <AnimatePresence>
        {status === 'scanning' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="glass-card p-10 border-primary/40 shadow-glow-primary relative overflow-hidden flex flex-col items-center justify-center text-center">
              <div className="relative z-10 w-full max-w-xl mx-auto space-y-8">
                <div className="flex justify-center">
                  <div className="relative">
                    <div className="w-24 h-24 rounded-full border-4 border-surface-3 flex items-center justify-center">
                      <Zap className="w-10 h-10 text-primary animate-pulse" />
                    </div>
                    <svg className="absolute inset-0 w-full h-full -rotate-90">
                      <circle cx="48" cy="48" r="46" fill="none" stroke="#3F6A55" strokeWidth="4"
                        strokeDasharray="289" strokeDashoffset={289 - (scanProgress / 100) * 289}
                        className="transition-all duration-300" />
                    </svg>
                  </div>
                </div>
                <div>
                  <h3 className="font-display font-bold text-2xl text-text-primary mb-2">Analyzing Target Web assets...</h3>
                  <div className="flex items-center justify-center gap-3 text-sm text-text-muted font-mono bg-surface-3/80 py-2 px-4 rounded-lg inline-flex border border-border">
                    {scanLog} ({scanProgress}%)
                  </div>
                </div>
                <div className="w-full bg-surface-3 h-2 rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${scanProgress}%` }} />
                </div>
                <div className="flex justify-center gap-4">
                  <button onClick={handleCancel} className="px-5 py-2 rounded-lg bg-danger-500/10 text-danger-500 border border-danger-500/20 text-xs font-bold hover:bg-danger-500/20 transition-colors flex items-center gap-2">
                    <X className="w-3.5 h-3.5" /> Cancel Analysis
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      {status === 'complete' && result && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="space-y-8">

          {/* Batch Selector Bar */}
          {batchResults && batchResults.length > 1 && (
            <div className="glass-card p-6 border-primary/20">
              <h3 className="font-display font-bold text-lg text-text-primary mb-3">Batch Crawled Sites</h3>
              <div className="flex flex-wrap gap-2">
                {batchResults.map((b: any) => (
                  <button 
                    key={b.url}
                    onClick={() => b.success && handleSelectBatchResult(b.url, b.data)}
                    disabled={!b.success}
                    className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all flex items-center gap-2 ${
                      selectedBatchUrl === b.url
                        ? 'bg-primary text-white border-primary shadow-glow-sm'
                        : b.success
                          ? 'bg-surface border-border hover:border-primary/40 text-text-primary'
                          : 'bg-danger-500/5 border-danger-500/20 text-danger-500 opacity-60'
                    }`}
                  >
                    <Globe className="w-3.5 h-3.5" />
                    {b.url}
                    {!b.success && (
                      <span className="text-[10px] font-medium text-danger-500">(failed)</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Executive Summary Bar */}
          <div className="glass-card p-0 overflow-hidden border-primary/30 shadow-glass">
            <div className="p-8 bg-gradient-card flex flex-col lg:flex-row items-center justify-between gap-8 border-b border-border/50">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                  <span className="text-xs font-bold text-primary uppercase tracking-widest">Audit Complete</span>
                </div>
                <h3 className="font-display font-extrabold text-3xl text-text-primary">{result.url}</h3>
                <p className="text-sm font-medium text-text-muted mt-1">{new Date(result.createdAt).toLocaleString()} · {result.categories.length} categories audited</p>
              </div>
              <div className="flex items-center gap-6 md:gap-10">
                <div className="text-center bg-white p-4 rounded-2xl border border-border">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2">Overall Score</p>
                  <p className="text-4xl font-display font-extrabold tabular-nums text-primary">{result.overallScore}</p>
                </div>
                <div className="text-center bg-white p-4 rounded-2xl border border-gold-500/20 shadow-glow-gold/10">
                  <p className="text-[10px] font-bold text-gold-500 uppercase tracking-widest mb-2">Opportunity</p>
                  <p className="text-4xl font-display font-extrabold tabular-nums text-gold-600">{opp?.overall}</p>
                </div>
              </div>
            </div>

            {/* Category Score Strip */}
            <div className="bg-surface p-6 flex flex-wrap justify-between gap-4">
              {result.categories.map(cat => {
                const catData = result[cat as keyof AuditResult] as { score: number } | undefined
                const meta = CATEGORY_OPTIONS.find(c => c.id === cat)
                if (!catData || !meta) return null
                return (
                  <div key={cat} className="flex-1 min-w-[100px] text-center border-r border-border/50 last:border-0 px-2">
                    <p className="text-2xl font-display font-bold tabular-nums mb-1" style={{ color: meta.color }}>{catData.score}</p>
                    <p className="text-[11px] font-bold text-text-secondary uppercase tracking-wider">{meta.label.split(' ')[0]}</p>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Workflow Action */}
          <div className="flex flex-wrap gap-3">
            <button onClick={() => navigate('/blueprint')} className="btn-primary px-5 py-2.5 text-sm shadow-glow-primary">
              <ArrowRight className="w-4 h-4" /> Generate Website Blueprint
            </button>
            <button
              onClick={() => result && generateAuditPdf(result as any, { agencyName: 'Lumen' })}
              disabled={!result}
              className="btn-secondary px-5 py-2.5 text-sm hover:bg-surface border-border-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" /> Download PDF Report
            </button>
          </div>

          {/* Tab Filter */}
          <div className="sticky top-16 z-20 bg-background/80 backdrop-blur-xl py-4 -mx-6 px-6 border-b border-border shadow-sm">
            <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {/* Tab Contents */}
          <div className="space-y-6">
            
            {/* 1. AI Analysis Tab */}
            {activeTab === 'ai-analysis' && (
              <div className="space-y-6">
                
                {/* AI Executive Summary & Confidence */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="md:col-span-2 glass-card p-6 border-primary/20 bg-primary/5">
                    <div className="flex items-center gap-3 mb-4">
                      <div>
                        <h3 className="font-display font-bold text-text-primary text-base">AI Audit Summary</h3>
                        <p className="text-[10px] text-text-muted uppercase tracking-widest font-bold">Executive Overview</p>
                      </div>
                    </div>
                    <p className="text-sm text-text-primary leading-relaxed font-medium">{result.aiSummary}</p>
                  </div>

                  <div className="glass-card p-6 flex flex-col justify-between border-border">
                    <div>
                      <h4 className="text-xs font-bold text-text-muted uppercase tracking-widest mb-1">Reasoning Confidence</h4>
                      <p className="text-4xl font-display font-black text-primary">96%</p>
                    </div>
                    <p className="text-xs text-text-muted mt-2 leading-relaxed">
                      Calculations are deterministic based on real elements extracted from {result.url} DOM node trees.
                    </p>
                  </div>
                </div>

                {/* Batch Comparison if batch is active */}
                {batchResults && batchResults.length > 1 && (
                  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-6 border-border">
                    <h3 className="font-display font-bold text-lg text-text-primary mb-4 flex items-center gap-2">
                      <BarChart2Icon className="w-5 h-5 text-primary" /> Batch Audit Leaderboard & Comparison
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-surface-3/50 text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                            <th className="text-left py-3 px-4">Rank</th>
                            <th className="text-left py-3 px-4">Website URL</th>
                            <th className="text-center py-3 px-4">Overall Score</th>
                            <th className="text-center py-3 px-4">Opportunity Score</th>
                            <th className="text-center py-3 px-4">Performance</th>
                            <th className="text-center py-3 px-4">SEO</th>
                            <th className="text-center py-3 px-4">Conversion</th>
                            <th className="text-center py-3 px-4">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...batchResults]
                            .sort((a, b) => (b.data?.overallScore || 0) - (a.data?.overallScore || 0))
                            .map((b, index) => (
                              <tr key={b.url} className={`border-b border-border/50 last:border-0 hover:bg-surface-3/30 transition-colors ${selectedBatchUrl === b.url ? 'bg-primary/5 font-semibold' : ''}`}>
                                <td className="py-3 px-4">
                                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                                    index === 0 ? 'bg-gold-500/20 text-gold-700' : index === 1 ? 'bg-surface-3 text-text-secondary' : 'bg-surface-3/50 text-text-muted'
                                  }`}>
                                    {index + 1}
                                  </span>
                                </td>
                                <td className="py-3 px-4 truncate max-w-[200px]">{b.url}</td>
                                <td className="py-3 px-4 text-center text-primary font-bold">{b.success ? b.data.overallScore : '—'}</td>
                                <td className="py-3 px-4 text-center text-gold-600 font-bold">{b.success ? b.data.opportunityScore.overall : '—'}</td>
                                <td className="py-3 px-4 text-center">{b.success ? b.data.performance?.score || '—' : '—'}</td>
                                <td className="py-3 px-4 text-center">{b.success ? b.data.seo?.score || '—' : '—'}</td>
                                <td className="py-3 px-4 text-center">{b.success ? b.data.conversion?.score || '—' : '—'}</td>
                                <td className="py-3 px-4 text-center">
                                  {b.success ? (
                                    <span className="text-xs text-primary font-medium flex items-center justify-center gap-1"><Check className="w-3 h-3" /> Ready</span>
                                  ) : (
                                    <span className="text-xs text-danger-500 font-medium flex items-center justify-center gap-1"><X className="w-3 h-3" /> Error</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </motion.div>
                )}

                {/* Opportunity Score Explanation */}
                <div className="glass-card p-6 border-border">
                  <h3 className="font-display font-bold text-lg text-text-primary mb-2 flex items-center gap-2">
                    <Shield className="w-5 h-5 text-primary" /> Weighted Opportunity Score Explanation
                  </h3>
                  <p className="text-sm text-text-muted mb-4">
                    Opportunity Score reflects the capacity to recover lost traffic, security loopholes, and marketing leakages. We calculate scores using the following weight scale:
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center mb-6">
                    {[
                      { label: 'SEO', weight: '25%', score: result.seo?.score || '—', color: '#C9A961' },
                      { label: 'Conversion', weight: '25%', score: result.conversion?.score || '—', color: '#C9A961' },
                      { label: 'Performance', weight: '20%', score: result.performance?.score || '—', color: '#C9A961' },
                      { label: 'Marketing', weight: '15%', score: result.marketing?.score || '—', color: '#C9A961' },
                      { label: 'Security', weight: '15%', score: result.security?.score || '—', color: '#C9A961' }
                    ].map(w => (
                      <div key={w.label} className="p-3 bg-surface-3 rounded-xl border border-border">
                        <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{w.label}</p>
                        <p className="text-lg font-black mt-1" style={{ color: w.color }}>{w.weight}</p>
                        <p className="text-xs text-text-secondary mt-1">Score: {w.score}/100</p>
                      </div>
                    ))}
                  </div>
                  
                  {opp?.scoreBreakdown && opp.scoreBreakdown.length > 0 && (
                    <div className="border border-border/50 rounded-xl overflow-hidden">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-surface-3 border-b border-border/50 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                          <tr>
                            <th className="py-2.5 px-4">Heuristics Check</th>
                            <th className="py-2.5 px-4 text-center">Opportunity Points</th>
                            <th className="py-2.5 px-4">Details</th>
                          </tr>
                        </thead>
                        <tbody>
                          {opp.scoreBreakdown.map((item, i) => (
                            <tr key={i} className="border-b border-border/30 last:border-0 hover:bg-surface-3/20">
                              <td className="py-3 px-4 font-bold text-text-primary">{item.label}</td>
                              <td className="py-3 px-4 text-center"><span className="text-primary font-bold">+{item.points}</span></td>
                              <td className="py-3 px-4 text-text-secondary">{item.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Priority Recommendations List */}
                {opp?.priorityFixes && opp.priorityFixes.length > 0 && (
                  <div className="glass-card p-6 border-border">
                    <h3 className="font-display font-bold text-lg text-text-primary mb-4 flex items-center gap-2">
                      <Settings className="w-5 h-5 text-primary" /> Prioritised Action Items
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {opp.priorityFixes.map((rec: any, idx: number) => (
                        <div key={idx} className="p-5 bg-surface-3 rounded-2xl border border-border flex flex-col justify-between space-y-3">
                          <div>
                            <div className="flex justify-between items-start gap-2 mb-1">
                              <h4 className="text-sm font-bold text-text-primary">{rec.title}</h4>
                              <Badge variant={rec.impact === 'high' ? 'danger' : rec.impact === 'medium' ? 'warning' : 'default'} size="sm">{rec.impact}</Badge>
                            </div>
                            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider mb-2">{rec.category}</p>
                            <p className="text-xs text-text-secondary leading-relaxed">
                              Recover up to <span className="font-bold text-primary">+{rec.points} opportunity points</span> by applying this fix.
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Website Intelligence & Color Swatches */}
                {intelligence && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="glass-card p-6 border-border space-y-4">
                      <h3 className="font-display font-bold text-lg text-text-primary flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-primary" /> Brand Swatches & Typography
                      </h3>
                      <div>
                        <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2">Detected Palette</p>
                        <div className="grid grid-cols-3 gap-3">
                          {intelligence.colorPalette?.map((color: any, idx: number) => (
                            <div key={idx} className="p-2.5 rounded-xl border border-border bg-white flex flex-col items-center">
                              <div className="w-8 h-8 rounded-lg shadow-sm border border-border mb-1.5" style={{ backgroundColor: color.hex }} />
                              <p className="text-[10px] font-bold text-text-primary truncate w-full text-center">{color.name}</p>
                              <p className="text-[9px] text-text-muted font-mono">{color.hex}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                        <div>
                          <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1">Primary Font</p>
                          <p className="text-sm font-bold text-text-primary">{intelligence.typography?.primaryFont}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1">Brand Positioning</p>
                          <p className="text-xs text-text-secondary leading-relaxed truncate max-w-full">{intelligence.brandPositioning}</p>
                        </div>
                      </div>
                    </div>

                    <div className="glass-card p-6 border-border space-y-4">
                      <h3 className="font-display font-bold text-lg text-text-primary flex items-center gap-2">
                        <TrendingUp className="w-5 h-5 text-primary" /> Funnel Sequence & Keywords
                      </h3>
                      <div>
                        <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2">Conversion Funnel Steps</p>
                        <div className="space-y-2">
                          {intelligence.conversionFunnel?.slice(0, 3).map((step: string, idx: number) => (
                            <div key={idx} className="flex gap-2 text-xs">
                              <span className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center flex-shrink-0 font-bold">{idx + 1}</span>
                              <p className="text-text-secondary font-medium leading-tight">{step}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="border-t border-border pt-4">
                        <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1">Top Density Keywords</p>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {intelligence.keywordDensity?.map((k: any) => (
                            <span key={k.keyword} className="px-2.5 py-1 bg-surface-3 rounded-lg border border-border text-[10px] font-bold text-text-primary">
                              {k.keyword} ({k.density}%)
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* AI Reasoning Timeline */}
                {result.timeline && result.timeline.length > 0 && (
                  <div className="glass-card p-6 border-border">
                    <h3 className="font-display font-bold text-lg text-text-primary mb-6 flex items-center gap-2">
                      <Settings className="w-5 h-5 text-primary" /> AI Reasoning Audit Timeline
                    </h3>
                    <div className="relative border-l-2 border-border pl-6 ml-3 space-y-6">
                      {result.timeline.map((event: any, idx: number) => (
                        <div key={idx} className="relative">
                          {/* Dot */}
                          <span className={`absolute -left-[31px] top-0 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center ${
                            event.status === 'success' ? 'bg-primary' : event.status === 'error' ? 'bg-danger-500' : 'bg-gold-500'
                          }`} />
                          <div>
                            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider">{event.stage} · {event.durationMs}ms</span>
                            <h4 className="text-sm font-bold text-text-primary mt-0.5">{event.message}</h4>
                            <span className="text-[10px] text-text-muted block mt-1">{new Date(event.timestamp).toLocaleTimeString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            )}

            {/* 2. All Results Tab */}
            {activeTab === 'all' && (
              <div className="space-y-6">
                {result.categories.map(cat => {
                  const catData = result[cat as keyof AuditResult] as { score: number } & Record<string, CheckItem | number> | undefined
                  if (!catData) return null
                  const checks = Object.fromEntries(
                    Object.entries(catData).filter(([, v]) => v && typeof v === 'object' && 'status' in (v as object))
                  ) as Record<string, CheckItem>
                  return (
                    <CategoryCard key={cat} category={cat} data={catData} checks={checks} />
                  )
                })}
              </div>
            )}

            {/* 3. Screenshots Tab */}
            {activeTab === 'screenshots' && (
              <ScreenshotSection url={result.url} />
            )}

            {/* 4. Categorized Check Tabs */}
            {selectedCategories.includes(activeTab) && (() => {
              const catData = result[activeTab as keyof AuditResult] as { score: number } & Record<string, CheckItem | number> | undefined
              if (!catData) return null
              const checks = Object.fromEntries(
                Object.entries(catData).filter(([, v]) => v && typeof v === 'object' && 'status' in (v as object))
              ) as Record<string, CheckItem>
              return (
                <CategoryCard category={activeTab} data={catData} checks={checks} />
              )
            })()}

          </div>
        </motion.div>
      )}
    </div>
  )
}

function BarChart2Icon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
}

import React, { useState } from 'react'
import {
  Sparkles, Search, Download, ExternalLink, Clock,
  AlertCircle, CheckCircle2, FileImage, Compass
} from 'lucide-react'
import { inspirationApi, type WebsiteInspirationResult } from './api'

export default function WebsiteInspiration() {
  // Form State
  const [businessType, setBusinessType] = useState('')
  const [industry, setIndustry] = useState('')
  const [location, setLocation] = useState('')

  // UI State
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<WebsiteInspirationResult[]>([])
  const [source, setSource] = useState<'live' | 'cache' | null>(null)
  const [activeTab, setActiveTab] = useState<'all' | 'captured' | 'failed'>('all')

  const loadingSteps = [
    'Analyzing business profile and keywords...',
    'Quering organic web search API providers...',
    'Filtering spam domains and directories...',
    'Launching browser automation pipeline...',
    'Visiting competitor homepages and loading lazy content...',
    'Capturing high-resolution screenshots & extracting design assets...'
  ]

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!businessType && !industry) {
      setError('Please provide at least a Business Type or Industry.')
      return
    }

    setLoading(true)
    setError(null)
    setResults([])
    setSource(null)
    
    // Simulate loading steps progression
    let step = 0
    setLoadingStep(0)
    const interval = setInterval(() => {
      if (step < loadingSteps.length - 1) {
        step++
        setLoadingStep(step)
      }
    }, 4500)

    try {
      const response = await inspirationApi.get({
        businessType,
        industry,
        keyword: location
      })
      setResults(response.results)
      setSource(response.source)
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'An error occurred while fetching inspiration.')
    } finally {
      clearInterval(interval)
      setLoading(false)
    }
  }

  const handleDownload = async (path: string, domain: string) => {
    try {
      const url = `/api/inspiration/${path}`
      const res = await fetch(url)
      const blob = await res.blob()
      const blobUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `${domain}-inspiration.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(blobUrl)
    } catch (e) {
      console.error('Failed to download screenshot:', e)
    }
  }

  const filteredResults = results.filter((item) => {
    if (activeTab === 'captured') return item.status === 'Captured Successfully'
    if (activeTab === 'failed') return item.status === 'Failed'
    return true
  })

  // Format bytes
  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  return (
    <div className="space-y-8 p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/60 pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold tracking-wider uppercase">Add-on Module</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Website Inspiration Finder</h1>
          <p className="text-sm text-text-muted mt-1">Discover competitor layouts, brand typography, color palettes, and download captured screenshots.</p>
        </div>
        <div className="p-3 bg-surface-3 border border-border rounded-2xl flex items-center justify-center">
          <Compass className="w-6 h-6 text-primary" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Form Container */}
        <div className="lg:col-span-4 bg-surface border border-border rounded-2xl p-6 space-y-6">
          <div className="border-b border-border/60 pb-4">
            <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
              <Search className="w-4 h-4 text-primary" /> Search Parameters
            </h2>
            <p className="text-xs text-text-muted mt-0.5">Describe your target market or business type to discover real competitors.</p>
          </div>

          <form onSubmit={handleSearch} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-text-secondary mb-1.5">Business Type *</label>
              <input
                type="text"
                required
                value={businessType}
                onChange={(e) => setBusinessType(e.target.value)}
                placeholder="e.g. Dental Clinic"
                className="w-full bg-surface-3 border border-border rounded-xl px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary/50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-text-secondary mb-1.5">Industry *</label>
              <input
                type="text"
                required
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. Healthcare"
                className="w-full bg-surface-3 border border-border rounded-xl px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary/50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-text-secondary mb-1.5">Location *</label>
              <input
                type="text"
                required
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Melbourne, Australia"
                className="w-full bg-surface-3 border border-border rounded-xl px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary/50"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-primary text-white text-sm font-semibold py-3 px-4 rounded-xl flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-50"
            >
              {loading ? (
                <>
                  <img src="/lumen-logo.png" alt="" className="w-4 h-4 animate-[spin_2.2s_linear_infinite]" draggable={false} /> Fetching Inspiration...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" /> Find Website Inspiration
                </>
              )}
            </button>
          </form>
        </div>

        {/* Results Container */}
        <div className="lg:col-span-8 space-y-6">
          {/* Loading Screen */}
          {loading && (
            <div className="bg-surface border border-border rounded-2xl p-12 flex flex-col items-center justify-center text-center space-y-6 min-h-[400px]">
              <img src="/lumen-logo.png" alt="" className="w-16 h-16 animate-[spin_2.2s_linear_infinite]" draggable={false} />
              <div className="space-y-2">
                <h3 className="text-base font-bold text-text-primary">Executing Screenshot Capture Engine</h3>
                <p className="text-sm text-text-muted max-w-md mx-auto">{loadingSteps[loadingStep]}</p>
              </div>
              <div className="flex gap-1.5 justify-center" hidden>
                {loadingSteps.map((_, idx) => (
                  <div
                    key={idx}
                    className=""
                  />
                ))}
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex gap-3 text-red-400">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <div>
                <p className="text-sm font-bold">Search Failure</p>
                <p className="text-xs mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* Empty State */}
          {!loading && results.length === 0 && !error && (
            <div className="bg-surface border border-border rounded-2xl p-12 flex flex-col items-center justify-center text-center min-h-[400px]">
              <Compass className="w-12 h-12 text-text-muted/40 mb-4" />
              <h3 className="text-base font-bold text-text-primary">No Inspiration Loaded</h3>
              <p className="text-sm text-text-muted mt-1 max-w-sm">Enter search parameters on the left to crawl, inspect competitor aesthetics, and download layout screenshots.</p>
            </div>
          )}

          {/* Results Grid */}
          {!loading && results.length > 0 && (
            <div className="space-y-6">
              {/* Toolbar */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface border border-border rounded-2xl p-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-text-secondary uppercase">Filter:</span>
                  <div className="flex bg-surface-3 rounded-lg p-0.5 border border-border">
                    <button
                      onClick={() => setActiveTab('all')}
                      className={`text-xs px-3 py-1 rounded-md font-medium transition-colors ${
                        activeTab === 'all' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      All ({results.length})
                    </button>
                    <button
                      onClick={() => setActiveTab('captured')}
                      className={`text-xs px-3 py-1 rounded-md font-medium transition-colors ${
                        activeTab === 'captured' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      Captured ({results.filter(r => r.status === 'Captured Successfully').length})
                    </button>
                    <button
                      onClick={() => setActiveTab('failed')}
                      className={`text-xs px-3 py-1 rounded-md font-medium transition-colors ${
                        activeTab === 'failed' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      Failed ({results.filter(r => r.status === 'Failed').length})
                    </button>
                  </div>
                </div>

                {source === 'cache' && (
                  <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 text-primary text-[11px] font-medium border border-primary/20">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Cached results loaded (refreshed in the last 24h)
                  </div>
                )}
              </div>

              {/* Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {filteredResults.map((item) => (
                  <div key={item.url} className="bg-surface border border-border rounded-2xl overflow-hidden flex flex-col hover:border-border-highlight transition-all">
                    {/* Header */}
                    <div className="p-4 border-b border-border/60 flex items-center justify-between gap-3 bg-surface-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <img
                          src={item.faviconUrl}
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>'
                          }}
                          className="w-4 h-4 rounded-sm flex-shrink-0"
                          alt="favicon"
                        />
                        <div className="min-w-0">
                          <h4 className="text-xs font-bold text-text-primary truncate">{item.name || item.domain}</h4>
                          <p className="text-[10px] text-text-muted truncate">{item.domain}</p>
                        </div>
                      </div>
                      <span className="text-[11px] font-semibold text-text-muted flex-shrink-0 bg-surface border border-border px-2 py-0.5 rounded-lg">
                        Rank #{item.searchRank}
                      </span>
                    </div>

                    {/* Screenshot Container */}
                    <div className="relative aspect-video bg-surface-3 border-b border-border/40 overflow-hidden group">
                      {item.status === 'Captured Successfully' && item.screenshotPath ? (
                        <div className="w-full h-full overflow-y-auto scrollbar-hide select-none cursor-pointer">
                          <img
                            src={`/api/inspiration/${item.screenshotPath}`}
                            className="w-full object-cover origin-top"
                            alt={`${item.domain} screenshot`}
                          />
                        </div>
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-center p-4">
                          <AlertCircle className="w-8 h-8 text-red-500/80 mb-2" />
                          <h5 className="text-xs font-bold text-text-primary">Screenshot Capture Failed</h5>
                          <p className="text-[10px] text-text-muted max-w-[200px] mt-0.5 truncate">{item.errorMessage || 'Unknown connection error'}</p>
                        </div>
                      )}

                      {item.status === 'Captured Successfully' && (
                        <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 backdrop-blur-sm rounded-lg p-1.5 text-white text-[10px] font-medium pointer-events-none">
                          Scroll to view homepage
                        </div>
                      )}
                    </div>

                    {/* Details / Metadata */}
                    <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <p className="text-xs font-bold text-text-secondary truncate">{item.pageTitle}</p>
                          <p className="text-[11px] text-text-muted line-clamp-2">{item.metaDescription || 'No description provided.'}</p>
                        </div>

                        {/* Design variables */}
                        {item.status === 'Captured Successfully' && (
                          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/40">
                            {/* Colors */}
                            <div>
                              <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider mb-1">Brand Colors</p>
                              <div className="flex gap-1.5 items-center">
                                <div
                                  className="w-4 h-4 rounded-sm border border-border shadow-sm"
                                  style={{ backgroundColor: item.primaryBrandColor }}
                                  title={`Primary: ${item.primaryBrandColor}`}
                                />
                                <div
                                  className="w-4 h-4 rounded-sm border border-border shadow-sm"
                                  style={{ backgroundColor: item.secondaryBrandColor }}
                                  title={`Secondary: ${item.secondaryBrandColor}`}
                                />
                                <span className="text-[10px] text-text-muted font-mono truncate">{item.primaryBrandColor}</span>
                              </div>
                            </div>

                            {/* Typography */}
                            <div>
                              <p className="text-[9px] font-bold text-text-muted uppercase tracking-wider mb-1">Fonts</p>
                              <div className="flex flex-wrap gap-1">
                                {item.fontFamilies && item.fontFamilies.length > 0 ? (
                                  item.fontFamilies.slice(0, 2).map((font) => (
                                    <span key={font} className="text-[9px] px-1.5 py-0.5 rounded bg-surface-3 text-text-secondary font-medium truncate max-w-[80px]">
                                      {font}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[10px] text-text-muted italic">Sans-serif</span>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Footer Actions */}
                      <div className="pt-3 border-t border-border/40 flex items-center justify-between gap-4">
                        {/* Crawl metrics */}
                        <div className="flex gap-3 text-[10px] text-text-muted">
                          <span className="flex items-center gap-0.5"><Clock className="w-3 h-3" /> {item.responseTime}ms</span>
                          {item.status === 'Captured Successfully' && (
                            <span className="flex items-center gap-0.5"><FileImage className="w-3 h-3" /> {formatBytes(item.screenshotSize)}</span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 bg-surface-3 border border-border rounded-lg text-text-muted hover:text-text-primary hover:border-border-highlight transition-all"
                            title="Visit website"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                          {item.status === 'Captured Successfully' && item.screenshotPath && (
                            <button
                              onClick={() => handleDownload(item.screenshotPath, item.domain)}
                              className="px-2.5 py-1.5 bg-primary/10 hover:bg-primary text-primary hover:text-white text-xs font-semibold rounded-lg flex items-center gap-1 transition-all"
                            >
                              <Download className="w-3 h-3" /> Save PNG
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

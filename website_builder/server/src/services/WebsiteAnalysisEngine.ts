import { v4 as uuidv4 } from 'uuid'
import { CrawlerService, CrawlResult } from './CrawlerService'
import { FeatureExtractionService, ExtractedFeatures } from './FeatureExtractionService'
import { WebsiteIntelligenceService, WebsiteIntelligenceData } from './WebsiteIntelligenceService'
import { SiteClassifier, SiteProfile } from './engine/SiteClassifier'
import { ScoreEngine, ScoreSheet, CategoryScore } from './engine/ScoreEngine'
import { RecommendationEngine } from './engine/RecommendationEngine'
import { CheckDefinition, CheckResult, Category } from './engine/CheckRegistry'

/**
 * UI-facing check item. Matches `CheckItem` in client/src/store/auditStore.tsx.
 */
interface UICheckItem {
  label: string
  status: 'pass' | 'fail' | 'warning'
  value?: string
  impact: 'high' | 'medium' | 'low'
  recommendation: string
  opportunityPoints: number
}

interface UICategoryBlock {
  score: number
  [checkKey: string]: number | UICheckItem
}

interface TimelineEvent {
  step: string
  status: 'success' | 'warning' | 'error' | 'info'
  message: string
  timestamp: string
  durationMs?: number
}

/**
 * The shape returned to the UI. Adds new fields for site-type transparency
 * while preserving the existing AuditResult contract.
 */
export interface AuditResponse {
  id: string
  url: string
  finalUrl: string
  createdAt: string
  categories: string[]
  aiSummary: string

  overallScore: number
  scoreBreakdown: Array<{ label: string; points: number; reason: string }>

  opportunityScore: {
    performance: number | null
    seo: number | null
    marketing: number | null
    conversion: number | null
    security: number | null
    overall: number
    level: string
    growthPotential: string
    businessImpact: string
    leadOpportunity: string
    priorityFixes: Array<{ title: string; points: number; impact: 'high' | 'medium' | 'low'; category: string }>
    scoreBreakdown: Array<{ label: string; points: number; reason: string; category: string }>
  }

  performance?: UICategoryBlock
  seo?: UICategoryBlock
  marketing?: UICategoryBlock
  conversion?: UICategoryBlock
  security?: UICategoryBlock

  techStack: {
    cms: string
    framework: string
    builderTool: string | null
    server: string
    poweredBy: string
    cdn: string
    hostingProvider: string
    libraries: string[]
  }

  // New: type-aware metadata
  siteType: string
  siteTypeConfidence: 'high' | 'medium' | 'low'
  siteSubtype: string | null
  siteSignals: string[]
  skippedChecks: Array<{ id: string; label: string; reason: string }>

  /**
   * Embedded intelligence — brand swatches, keyword density, conversion funnel,
   * USPs, navigation map. Computed inline so the UI gets everything in one call.
   */
  intelligence: WebsiteIntelligenceData

  recommendations: Array<{
    title: string
    problem: string
    reason: string
    businessImpact: string
    solution: string
    priority: 'high' | 'medium' | 'low'
    category: string
    confidenceScore: number
    points: number
  }>

  timeline: TimelineEvent[]

  crawl: {
    success: boolean
    statusCode: number
    protocol: string
    ttfbMs: number
    loadTimeMs: number
    htmlBytes: number
    redirectChain: string[]
    sslValid: boolean
    sslError: string | null
  }
}

export class WebsiteAnalysisEngine {
  /**
   * Main entry point used by the route handler and auditService.
   */
  static async analyzeWebsite(url: string, requestedCategories?: string[]): Promise<AuditResponse> {
    const id = uuidv4()
    const createdAt = new Date().toISOString()
    const timeline: TimelineEvent[] = []
    const pushTimeline = (step: string, status: TimelineEvent['status'], message: string, durationMs?: number) => {
      timeline.push({ step, status, message, durationMs, timestamp: new Date().toISOString() })
    }

    pushTimeline('Initialise', 'success', `Starting audit for ${url}`)

    // 1) Crawl
    const crawlStart = Date.now()
    let crawl: CrawlResult
    try {
      crawl = await CrawlerService.crawl(url)
      pushTimeline('Crawl', crawl.success ? 'success' : 'warning',
        crawl.success
          ? `Fetched ${crawl.finalUrl} (HTTP ${crawl.statusCode}, ${Math.round((crawl.htmlBytes || 0) / 1024)}KB, TTFB ${crawl.ttfbMs}ms)`
          : `Crawl failed: ${crawl.sslError || 'unreachable'}`,
        Date.now() - crawlStart
      )
    } catch (err) {
      pushTimeline('Crawl', 'error', `Crawl threw: ${err instanceof Error ? err.message : 'unknown error'}`, Date.now() - crawlStart)
      return this.buildDegradedResponse(id, url, url, createdAt, requestedCategories, timeline, 'Crawl threw an unhandled error.')
    }

    if (!crawl.success || !crawl.html) {
      return this.buildDegradedResponse(id, url, crawl.finalUrl || url, createdAt, requestedCategories, timeline,
        crawl.sslError || `Crawler returned status ${crawl.statusCode}`)
    }

    // 2) Feature extraction
    const extractStart = Date.now()
    const features = FeatureExtractionService.extract(crawl.html, crawl.finalUrl, crawl.headers, crawl.htmlBytes)
    pushTimeline('Extract Features', 'success',
      `Parsed DOM. H1=${features.headings.h1Count} • images=${features.images.contentImages} • CTAs=${features.conversion.ctaCount} • forms=${features.conversion.formCount} (${features.conversion.qualifiedFormCount} qualified)`,
      Date.now() - extractStart
    )

    // 3) Classify site type
    const classifyStart = Date.now()
    const profile = SiteClassifier.classify(crawl, features)
    pushTimeline('Classify Site', profile.confidence === 'low' ? 'warning' : 'success',
      `Classified as ${this.humaniseSiteType(profile.type)}${profile.subtype ? ` — ${profile.subtype}` : ''} (${profile.confidence} confidence)`,
      Date.now() - classifyStart
    )

    // 4) Score using the type-aware rubric
    const scoreStart = Date.now()
    const sheet = ScoreEngine.score(crawl, features, profile)
    pushTimeline('Score', 'success',
      `Overall ${sheet.overallScore}/100 • Opportunity ${sheet.opportunityScore} (${sheet.opportunityLevel})`,
      Date.now() - scoreStart
    )

    // 5) Generate recommendations
    const recStart = Date.now()
    const recs = RecommendationEngine.generate(profile, sheet, crawl, features)
    pushTimeline('Recommendations', 'success', `${recs.length} prioritised recommendation${recs.length === 1 ? '' : 's'}`, Date.now() - recStart)

    // 6) Compute intelligence (brand swatches, keywords, USPs, navigation, funnel)
    //    inline so the UI gets everything from one POST.
    const intelStart = Date.now()
    let intelligence: WebsiteIntelligenceData
    try {
      intelligence = WebsiteIntelligenceService.analyze(crawl.html, crawl.finalUrl, features, id)
      pushTimeline('Intelligence', 'success', `Brand + content intelligence computed`, Date.now() - intelStart)
    } catch (err) {
      console.warn('[engine] intelligence failed:', (err as Error).message)
      // Empty placeholder so UI rendering never breaks
      intelligence = {
        id, auditId: id, url: crawl.finalUrl, createdAt: new Date().toISOString(),
        primaryKeywords: [], secondaryKeywords: [], keywordDensity: [],
        seoStructure: { hasH1: false, h1Text: null, h2Count: 0, h3Count: 0, hasMetaDescription: false, metaDescriptionLength: 0, hasCanonical: false, hasOpenGraph: false, hasTwitterCards: false, hasStructuredData: false, structuredDataTypes: [] },
        contentStrategy: 'unknown',
        navigationStructure: { menuItems: [], hasFooter: false, footerLinks: [], hasSearchBar: false, breadcrumbs: false },
        brandPositioning: '', uniqueSellingProps: [],
        colorPalette: { primary: null, secondary: null, tertiary: null, accent: null, background: null, text: null, allColors: [] },
        typography: { primaryFont: null, secondaryFont: null, fontPairings: [], headingStyle: 'unknown' },
        trustSignals: { certifications: [], testimonialsPresent: false, testimonialCount: 0, hasReviews: false, hasCaseStudies: false, hasClientLogos: false, hasPressMentions: false, securityBadges: [] },
        conversionFunnel: { primaryCTA: null, secondaryCTAs: [], formCount: 0, ctaCount: 0, hasLiveChat: false, hasNewsletter: false, hasBooking: false, funnelStages: [] }
      } as any
    }

    // 6) Format for the UI
    const categories = this.buildCategoryBlocks(sheet)
    const techStack = this.buildTechStackBlock(features, crawl)
    const aiSummary = this.buildAiSummary(profile, sheet, features, crawl)
    const scoreBreakdownLight = sheet.breakdown.map(b => ({ label: b.label, points: b.points, reason: b.reason }))
    const priorityFixes = recs.filter(r => r.priority === 'high').slice(0, 5).map(r => ({
      title: r.title, points: r.points, impact: r.priority, category: r.category
    }))

    pushTimeline('Complete', 'success', `Audit finished in ${Date.now() - crawlStart}ms`)

    return {
      id,
      url,
      finalUrl: crawl.finalUrl,
      createdAt,
      categories: requestedCategories || ['performance', 'seo', 'marketing', 'conversion', 'security'],
      aiSummary,
      overallScore: sheet.overallScore,
      scoreBreakdown: scoreBreakdownLight,
      opportunityScore: {
        performance: sheet.categories.performance?.score ?? null,
        seo: sheet.categories.seo?.score ?? null,
        marketing: sheet.categories.marketing?.score ?? null,
        conversion: sheet.categories.conversion?.score ?? null,
        security: sheet.categories.security?.score ?? null,
        overall: sheet.opportunityScore,
        level: sheet.opportunityLevel,
        growthPotential: sheet.growthPotential,
        businessImpact: sheet.businessImpact,
        leadOpportunity: sheet.leadOpportunity,
        priorityFixes,
        scoreBreakdown: sheet.breakdown.map(b => ({ label: b.label, points: b.points, reason: b.reason, category: b.category }))
      },
      performance: categories.performance,
      seo: categories.seo,
      marketing: categories.marketing,
      conversion: categories.conversion,
      security: categories.security,
      techStack,
      siteType: profile.type,
      siteTypeConfidence: profile.confidence,
      siteSubtype: profile.subtype || null,
      siteSignals: profile.signals,
      skippedChecks: sheet.skippedChecks,
      intelligence,
      recommendations: recs,
      timeline,
      crawl: {
        success: crawl.success,
        statusCode: crawl.statusCode,
        protocol: crawl.protocol,
        ttfbMs: crawl.ttfbMs,
        loadTimeMs: crawl.loadTimeMs,
        htmlBytes: crawl.htmlBytes,
        redirectChain: crawl.redirectChain,
        sslValid: crawl.sslValid,
        sslError: crawl.sslError
      }
    }
  }

  /**
   * Convert ScoreSheet into the category-keyed shape the UI expects.
   * Only applicable checks appear; non-applicable ones are silently omitted
   * (and surfaced separately via skippedChecks for transparency).
   */
  private static buildCategoryBlocks(sheet: ScoreSheet): Record<Category, UICategoryBlock> {
    const out: Record<Category, UICategoryBlock> = {
      performance: { score: sheet.categories.performance.score },
      seo: { score: sheet.categories.seo.score },
      marketing: { score: sheet.categories.marketing.score },
      conversion: { score: sheet.categories.conversion.score },
      security: { score: sheet.categories.security.score }
    }

    for (const sc of sheet.scoredChecks) {
      const block = out[sc.category]
      const key = this.toCheckKey(sc.id)
      const impact = this.severityToImpact(sc.result.severity)
      block[key] = {
        label: sc.label,
        status: sc.result.status,
        value: sc.result.value,
        impact,
        recommendation: sc.result.recommendation,
        opportunityPoints: sc.opportunityPoints
      }
    }
    return out
  }

  /** Convert "lead-capture-form" → "leadCaptureForm" */
  private static toCheckKey(id: string): string {
    return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  }

  private static severityToImpact(sev: CheckResult['severity']): 'high' | 'medium' | 'low' {
    if (sev === 'critical' || sev === 'high') return 'high'
    if (sev === 'medium') return 'medium'
    return 'low'
  }

  private static buildTechStackBlock(features: ExtractedFeatures, crawl: CrawlResult) {
    return {
      cms: features.techStack.cms || 'Unknown',
      framework: features.techStack.framework || 'Not detected',
      builderTool: features.techStack.builderTool,
      server: crawl.headers['server'] || features.techStack.server || 'Unknown',
      poweredBy: crawl.headers['x-powered-by'] || features.techStack.poweredBy || 'Hidden',
      cdn: features.techStack.cdn || this.guessCdn(crawl) || 'None detected',
      hostingProvider: this.guessHosting(crawl, features) || 'Unknown',
      libraries: features.techStack.libraries
    }
  }

  private static guessCdn(crawl: CrawlResult): string | null {
    const via = (crawl.headers['via'] || '').toLowerCase()
    const cfRay = crawl.headers['cf-ray']
    const xCache = (crawl.headers['x-cache'] || '').toLowerCase()
    const server = (crawl.headers['server'] || '').toLowerCase()
    if (cfRay || server.includes('cloudflare')) return 'Cloudflare'
    if (via.includes('cloudfront') || xCache.includes('cloudfront')) return 'AWS CloudFront'
    if (server.includes('akamai') || via.includes('akamai')) return 'Akamai'
    if (server.includes('fastly') || via.includes('fastly')) return 'Fastly'
    if (via.includes('varnish')) return 'Varnish'
    if (server.includes('bunnycdn')) return 'BunnyCDN'
    if (server.includes('vercel')) return 'Vercel Edge'
    if (server.includes('netlify')) return 'Netlify Edge'
    return null
  }

  private static guessHosting(crawl: CrawlResult, features: ExtractedFeatures): string | null {
    const server = (crawl.headers['server'] || '').toLowerCase()
    const html = (crawl.html || '').toLowerCase().slice(0, 10000)
    if (server.includes('vercel') || html.includes('x-vercel')) return 'Vercel'
    if (server.includes('netlify')) return 'Netlify'
    if (server.includes('github.com') || crawl.headers['x-github-request-id']) return 'GitHub Pages'
    if (server.includes('cloudflare')) return 'Cloudflare Pages / Workers'
    if (html.includes('amazonaws.com')) return 'AWS'
    if (features.techStack.builderTool === 'Wix') return 'Wix'
    if (features.techStack.builderTool === 'Squarespace') return 'Squarespace'
    if (features.techStack.builderTool === 'Webflow') return 'Webflow'
    if (features.techStack.builderTool === 'Framer') return 'Framer'
    if (features.techStack.cms?.startsWith('Shopify')) return 'Shopify'
    return null
  }

  /**
   * One-paragraph plain-text summary used as the audit headline.
   * Always grounded in real findings — no marketing fluff.
   */
  private static buildAiSummary(profile: SiteProfile, sheet: ScoreSheet, features: ExtractedFeatures, crawl: CrawlResult): string {
    const typeLabel = profile.subtype || this.humaniseSiteType(profile.type)
    const score = sheet.overallScore
    const topIssues = sheet.breakdown.slice(0, 3).map(b => b.label.toLowerCase())
    const totalChecks = sheet.scoredChecks.length
    const failed = sheet.scoredChecks.filter(c => c.result.status === 'fail').length
    const warned = sheet.scoredChecks.filter(c => c.result.status === 'warning').length

    const verdict =
      score >= 85 ? 'in strong shape' :
      score >= 70 ? 'in fair shape' :
      score >= 50 ? 'underperforming' :
      'critically underperforming'

    const issuesLine = topIssues.length > 0
      ? `Top items to address: ${topIssues.join(', ')}.`
      : 'No major issues detected — minor polish remaining.'

    return `Audit identified this as a ${typeLabel} site (${profile.confidence} confidence). ` +
      `Overall score ${score}/100 — ${verdict} against the ${totalChecks} checks that apply to this site type. ` +
      `${failed} failing, ${warned} warning. ${issuesLine}`
  }

  private static humaniseSiteType(t: string): string {
    return t.replace(/_/g, ' ')
  }

  /**
   * Build a minimal response when crawling failed entirely.
   * The UI shows degraded state cleanly rather than crashing.
   */
  private static buildDegradedResponse(
    id: string,
    url: string,
    finalUrl: string,
    createdAt: string,
    requestedCategories: string[] | undefined,
    timeline: TimelineEvent[],
    reason: string
  ): AuditResponse {
    timeline.push({ step: 'Audit Aborted', status: 'error', message: reason, timestamp: new Date().toISOString() })
    const summary = `Could not complete audit — ${reason}. Re-run after restoring site connectivity.`
    const empty: UICategoryBlock = { score: 0 }
    return {
      id, url, finalUrl, createdAt,
      categories: requestedCategories || ['performance', 'seo', 'marketing', 'conversion', 'security'],
      aiSummary: summary,
      overallScore: 0,
      scoreBreakdown: [],
      opportunityScore: {
        performance: null, seo: null, marketing: null, conversion: null, security: null,
        overall: 0, level: 'low',
        growthPotential: 'Cannot evaluate — site is unreachable.',
        businessImpact: 'Restore site uptime before assessing growth potential.',
        leadOpportunity: 'Cannot estimate without a successful crawl.',
        priorityFixes: [],
        scoreBreakdown: []
      },
      performance: empty, seo: empty, marketing: empty, conversion: empty, security: empty,
      techStack: { cms: 'Unknown', framework: 'Unknown', builderTool: null, server: 'Unknown', poweredBy: 'Unknown', cdn: 'Unknown', hostingProvider: 'Unknown', libraries: [] },
      siteType: 'unknown',
      siteTypeConfidence: 'low',
      siteSubtype: null,
      siteSignals: [],
      skippedChecks: [],
      intelligence: {
        id, auditId: id, url: finalUrl, createdAt: new Date().toISOString(),
        primaryKeywords: [], secondaryKeywords: [], keywordDensity: [],
        seoStructure: { hasH1: false, h1Text: null, h2Count: 0, h3Count: 0, hasMetaDescription: false, metaDescriptionLength: 0, hasCanonical: false, hasOpenGraph: false, hasTwitterCards: false, hasStructuredData: false, structuredDataTypes: [] },
        contentStrategy: 'unknown',
        navigationStructure: { menuItems: [], hasFooter: false, footerLinks: [], hasSearchBar: false, breadcrumbs: false },
        brandPositioning: 'Cannot evaluate — site is unreachable.', uniqueSellingProps: [],
        colorPalette: [],
        typography: { primaryFont: 'Unknown', secondaryFont: 'Unknown', fontPairings: [], headingStyle: 'unknown' },
        trustSignals: { certifications: [], testimonialsPresent: false, testimonialCount: 0, hasReviews: false, hasCaseStudies: false, hasClientLogos: false, hasPressMentions: false, securityBadges: [] },
        conversionFunnel: []
      } as any,
      recommendations: [],
      timeline,
      crawl: { success: false, statusCode: 0, protocol: 'unknown', ttfbMs: 0, loadTimeMs: 0, htmlBytes: 0, redirectChain: [], sslValid: false, sslError: reason }
    }
  }
}

import { CrawlResult } from '../CrawlerService'
import { ExtractedFeatures } from '../FeatureExtractionService'

/**
 * Site type taxonomy. The audit engine scores each site against the rubric
 * specific to its type — a personal blog isn't penalised for missing a Meta
 * Pixel, a nonprofit isn't penalised for missing a Calendly, etc.
 */
export type SiteType =
  | 'local_business'      // Dentist, salon, plumber, lawyer, restaurant with physical location
  | 'ecommerce'           // Selling physical or digital products with a cart
  | 'saas_product'        // Software product with signup / pricing / demo
  | 'agency_services'     // Marketing/dev/design/consulting agencies
  | 'personal_portfolio'  // Individual freelancer/developer/artist showcase
  | 'informational'       // Blog, news, magazine, docs, encyclopedia, knowledge base
  | 'nonprofit'           // Charity, NGO, donation-driven
  | 'educational'         // School, course platform, training provider
  | 'corporate'           // Large company brochure site (no e-commerce, multi-product)
  | 'community'           // Forum, social platform, user-generated content
  | 'unknown'

export interface SiteProfile {
  type: SiteType
  confidence: 'high' | 'medium' | 'low'
  // The full score sheet for transparency
  scores: Partial<Record<SiteType, number>>
  // Signals that drove the classification (human-readable)
  signals: string[]
  // Subtype hint (e.g. "dental clinic", "fashion store") for narrative copy
  subtype?: string
}

interface TypeRubric {
  /**
   * Each signal-checker contributes to that type's score.
   * Positive values: matches this type.
   * Negative values: contradicts this type (rare).
   * Score scale: small wins ~3, strong wins ~6, lock-ins ~10+.
   */
  scoreSignals: (ctx: ClassifyContext) => number
}

interface ClassifyContext {
  crawl: CrawlResult
  features: ExtractedFeatures
  url: URL | null
  title: string
  description: string
  bodyLower: string
  navLabels: string[]
  schemaTypes: string[]
}

export class SiteClassifier {
  static classify(crawl: CrawlResult, features: ExtractedFeatures): SiteProfile {
    let url: URL | null = null
    try { url = new URL(crawl.finalUrl) } catch { /* fallback */ }

    const title = (features.title || '').toLowerCase()
    const description = (features.metaDescription || '').toLowerCase()
    // Use html lowercase for body matching; bodyText would require re-extraction
    const bodyLower = (crawl.html || '').toLowerCase().slice(0, 50000)
    const schemaTypes = features.structuredData.types.map(t => t.toLowerCase())

    // Approximate nav labels by scanning common patterns in HTML
    const navLabels = this.extractNavLabels(crawl.html || '')

    const ctx: ClassifyContext = { crawl, features, url, title, description, bodyLower, navLabels, schemaTypes }

    const rubrics: Record<SiteType, TypeRubric> = {
      local_business: { scoreSignals: this.scoreLocalBusiness },
      ecommerce: { scoreSignals: this.scoreEcommerce },
      saas_product: { scoreSignals: this.scoreSaas },
      agency_services: { scoreSignals: this.scoreAgency },
      personal_portfolio: { scoreSignals: this.scorePortfolio },
      informational: { scoreSignals: this.scoreInformational },
      nonprofit: { scoreSignals: this.scoreNonprofit },
      educational: { scoreSignals: this.scoreEducational },
      corporate: { scoreSignals: this.scoreCorporate },
      community: { scoreSignals: this.scoreCommunity },
      unknown: { scoreSignals: () => 0 }
    }

    const signals: string[] = []
    const scores: Partial<Record<SiteType, number>> = {}

    for (const [type, rubric] of Object.entries(rubrics) as Array<[SiteType, TypeRubric]>) {
      if (type === 'unknown') continue
      const s = rubric.scoreSignals(ctx)
      scores[type] = s
    }

    // Pick the winning type
    const sorted = (Object.entries(scores) as Array<[SiteType, number]>)
      .sort((a, b) => b[1] - a[1])

    const winner = sorted[0]
    const runnerUp = sorted[1]

    let type: SiteType = 'unknown'
    let confidence: 'high' | 'medium' | 'low' = 'low'

    if (winner && winner[1] >= 30) {
      type = winner[0]
      const gap = winner[1] - (runnerUp ? runnerUp[1] : 0)
      confidence = gap >= 10 ? 'high' : 'medium'
    } else if (winner && winner[1] >= 18) {
      type = winner[0]
      confidence = 'medium'
    } else if (winner && winner[1] >= 8) {
      type = winner[0]
      confidence = 'low'
    } else if (winner && winner[1] >= 4) {
      // Marginal signals — accept the winner but flag low confidence.
      // Better to apply a slightly wrong rubric than to skip all type-specific
      // checks because nothing scored a clean majority.
      type = winner[0]
      confidence = 'low'
    } else {
      // Truly no commercial signals. Fall back to 'informational' since that's
      // the most permissive rubric (skips type-specific checks; only universal
      // checks apply). Anything else risks penalising the wrong things.
      type = 'informational'
      confidence = 'low'
    }

    // Build human-readable signals for the winning type
    this.appendSignals(type, ctx, signals)

    const subtype = this.deriveSubtype(type, ctx)

    return { type, confidence, scores, signals, subtype }
  }

  // ─── SIGNAL EXTRACTION ────────────────────────────────────────────────────

  private static extractNavLabels(html: string): string[] {
    const labels: string[] = []
    // Cheap: grab text from common nav patterns
    const navRegex = /<(?:nav|header)[^>]*>([\s\S]*?)<\/(?:nav|header)>/gi
    const linkText = /<a[^>]*>([^<]+)<\/a>/gi
    const navBlocks: string[] = []
    let m: RegExpExecArray | null
    while ((m = navRegex.exec(html)) !== null && navBlocks.length < 4) {
      navBlocks.push(m[1])
    }
    for (const block of navBlocks) {
      let lm: RegExpExecArray | null
      while ((lm = linkText.exec(block)) !== null) {
        const text = lm[1].replace(/\s+/g, ' ').trim().toLowerCase()
        if (text && text.length < 25) labels.push(text)
      }
    }
    return [...new Set(labels)].slice(0, 30)
  }

  // ─── TYPE SCORERS ─────────────────────────────────────────────────────────

  private static scoreLocalBusiness = (ctx: ClassifyContext): number => {
    let score = 0
    const { features, schemaTypes, bodyLower, navLabels, title, description, url } = ctx

    // Schema.org signals are the strongest tell
    if (schemaTypes.some(t => /localbusiness|restaurant|dentist|physician|medicalbusiness|hairsalon|automotivebusiness|professionalservice|lawfirm|attorney|healthandbeautybusiness|store$|homeandconstructionbusiness/.test(t))) score += 25

    // NAP signals (Name, Address, Phone)
    if (features.conversion.hasPhoneNumber) score += 6
    if (features.conversion.hasAddress) score += 6
    if (features.conversion.hasWhatsApp) score += 3

    // Hours of operation patterns
    if (/(monday|mon[a-z]*\s*[-:to]|hours\s*of\s*operation|opening\s*hours|business\s*hours|open\s*(?:from|until|today))/i.test(bodyLower.slice(0, 30000))) score += 5

    // Map embed
    if (/google\.com\/maps|maps\.google|openstreetmap|leaflet|mapbox/i.test(bodyLower)) score += 4

    // Booking widgets (Calendly/Cal/Squarespace/Setmore/Acuity)
    if (features.conversion.hasBookingSystem) score += 6

    // Service-oriented language
    const localKeywords = [
      'book an appointment', 'schedule a visit', 'visit us', 'call us today',
      'directions', 'find us', 'our location', 'serving [a-z]+ since',
      'walk-ins welcome', 'drop in', 'get directions', 'near you', 'in your area'
    ]
    let kwHits = 0
    for (const kw of localKeywords) {
      if (new RegExp(kw, 'i').test(bodyLower)) { kwHits++; if (kwHits >= 4) break }
    }
    score += kwHits * 2

    // Nav labels signaling local-biz nav
    const localNavHits = navLabels.filter(l =>
      ['contact', 'about', 'services', 'gallery', 'reviews', 'team', 'location', 'directions', 'hours', 'menu', 'book', 'appointment', 'pricing'].some(kw => l.includes(kw))
    ).length
    score += Math.min(localNavHits * 1.5, 10)

    // Industry-specific keyword bursts (dentist, salon, restaurant, etc.)
    const verticalRegexes = [
      /\b(dentist|dental|orthodontist|implants)\b/i,
      /\b(restaurant|menu|cuisine|reservation|dine)\b/i,
      /\b(salon|stylist|haircut|manicure|spa)\b/i,
      /\b(plumber|plumbing|hvac|electrician|roofing)\b/i,
      /\b(law\s*firm|attorney|lawyer|legal\s*counsel)\b/i,
      /\b(physician|clinic|patient|medical\s*centre)\b/i,
      /\b(realtor|real\s*estate\s*agent|property\s*listing)\b/i,
      /\b(gym|fitness|personal\s*trainer|crossfit)\b/i,
      /\b(auto\s*repair|mechanic|car\s*service|workshop)\b/i,
      /\b(boutique|tailor|optician)\b/i
    ]
    if (verticalRegexes.some(r => r.test(bodyLower.slice(0, 20000)))) score += 6

    // Penalties: signals that contradict local business
    if (/add\s*to\s*cart|view\s*cart|checkout/i.test(bodyLower) && features.conversion.ctaCount > 5) score -= 8
    if (/sign\s*up\s*free|start\s*free\s*trial|free\s*tier/i.test(bodyLower)) score -= 5

    return score
  }

  private static scoreEcommerce = (ctx: ClassifyContext): number => {
    let score = 0
    const { features, schemaTypes, bodyLower, navLabels } = ctx

    // Schema.org Product / Offer / Store
    if (schemaTypes.some(t => /^product$|^offer$|^aggregateoffer$|^store$|^onlinestore$/.test(t))) score += 25

    // Tech stack: Shopify / WooCommerce / Magento / BigCommerce
    if (features.techStack.cms && /shopify|woocommerce|magento|bigcommerce/i.test(features.techStack.cms)) score += 25

    // Cart / checkout signals
    if (/add\s*to\s*cart|add\s*to\s*bag|add\s*to\s*basket/i.test(bodyLower)) score += 10
    if (/view\s*cart|shopping\s*cart|my\s*cart|\/cart\b/i.test(bodyLower)) score += 6
    if (/proceed\s*to\s*checkout|checkout\s*now|secure\s*checkout/i.test(bodyLower)) score += 8

    // Pricing/currency patterns
    const priceMatches = (bodyLower.match(/(?:[\$£€₹¥]\s?\d|usd\s\d|inr\s\d|\d+\.\d{2})/gi) || []).length
    if (priceMatches >= 5) score += 6
    else if (priceMatches >= 2) score += 3

    // Nav labels suggesting product catalog
    const ecomNav = navLabels.filter(l =>
      ['shop', 'store', 'collections', 'products', 'cart', 'bag', 'checkout', 'wishlist'].some(kw => l.includes(kw))
    ).length
    score += Math.min(ecomNav * 3, 12)

    // Product schema markup
    if (schemaTypes.some(t => /^product$/.test(t))) score += 8

    // URL hints
    if (ctx.url && /\/(?:shop|store|products?|collections?|cart|checkout)\b/i.test(ctx.url.pathname)) score += 5

    // Payment badges
    if (/visa|mastercard|paypal|stripe|razorpay|payu|amex|amazon\s*pay|google\s*pay/i.test(bodyLower)) score += 3

    return score
  }

  private static scoreSaas = (ctx: ClassifyContext): number => {
    let score = 0
    const { features, bodyLower, navLabels, schemaTypes } = ctx

    // Schema.org SoftwareApplication / WebApplication — strongest tell
    if (schemaTypes.some(t => /softwareapplication|webapplication|mobileapplication/.test(t))) score += 18

    // SaaS keywords
    const saasWords = ['saas', 'cloud-based', 'web app', 'platform', 'dashboard', 'integrations', 'api access', 'workspace', 'self-serve', 'developer', 'deploy', 'devops', 'devtool', 'sdk', 'cli', 'oauth', 'webhook']
    const saasHits = saasWords.filter(w => bodyLower.includes(w)).length
    score += Math.min(saasHits * 2, 14)

    // Pricing / trial CTAs (explicit free-trial wording)
    if (/start\s*free\s*trial|try\s*for\s*free|free\s*forever|sign\s*up\s*free/i.test(bodyLower)) score += 8
    if (/book\s*a\s*demo|request\s*a\s*demo|watch\s*demo|live\s*demo/i.test(bodyLower)) score += 6
    if (/per\s*month|\/mo\b|per\s*user|monthly|annually|billed\s*annually/i.test(bodyLower)) score += 5

    // Modern SaaS CTA signals — many landing pages use just "Sign up" / "Get started"
    // not "free trial". Detect these via CTA text scan.
    const ctaTextLower = (features.conversion.ctaTexts || []).map(t => t.toLowerCase())
    if (ctaTextLower.some(t => /^sign\s*up$|^sign\s*in$|^get\s*started$|^start\s*free$|^start\s*now$/.test(t.trim()))) score += 6
    if (ctaTextLower.some(t => /\bsign\s*up\b|\bget\s*started\b|\bstart\s*free\b/.test(t))) score += 4

    // Login form present is a strong SaaS signal (but also could be community)
    if (features.conversion.hasLoginForm) score += 5

    // Nav labels: Pricing, Features, Integrations, Docs, Login, Platform, Solutions
    const saasNav = navLabels.filter(l =>
      ['pricing', 'features', 'integrations', 'product', 'platform', 'solutions', 'docs', 'login', 'sign in', 'sign up', 'sign-in', 'sign-up', 'changelog', 'api', 'developers', 'enterprise', 'security', 'open source'].some(kw => l.includes(kw))
    ).length
    score += Math.min(saasNav * 2, 14)

    // Trust signals specific to B2B SaaS
    if (/soc\s*2|iso\s*27001|gdpr\s*compliant|hipaa\s*compliant|ccpa/i.test(bodyLower)) score += 5
    if (/trusted\s*by|used\s*by\s*\d|customers\s*include|enterprise\s*customers|million.*(?:teams|users|developers)/i.test(bodyLower)) score += 4

    // Customer logo bars / "as seen in"
    if (/<img[^>]+alt=["'][^"']*(?:trusted by|customer logo|partner)/i.test(ctx.crawl.html || '')) score += 4

    // Feature grid patterns
    if (/<(?:section|div)[^>]+class=["'][^"']*(?:feature|capabilit)/i.test(ctx.crawl.html || '')) score += 3

    // Rich navigation + many CTAs + 500+ words is a strong product-marketing pattern
    if (features.conversion.ctaCount >= 15 && features.wordCount >= 400 && features.conversion.hasLoginForm) score += 6

    return score
  }

  private static scoreAgency = (ctx: ClassifyContext): number => {
    let score = 0
    const { bodyLower, navLabels, title, description } = ctx

    // Agency keyword density
    const agencyWords = [
      'we are a', 'our agency', 'our studio', 'creative agency', 'digital agency',
      'marketing agency', 'design studio', 'we help brands', 'we help businesses',
      'web design', 'web development', 'branding', 'consulting'
    ]
    const agencyHits = agencyWords.filter(w => bodyLower.includes(w)).length
    score += agencyHits * 3

    // Portfolio/case-studies/clients nav
    const agencyNav = navLabels.filter(l =>
      ['work', 'portfolio', 'projects', 'case studies', 'clients', 'services', 'studio', 'capabilities'].some(kw => l.includes(kw))
    ).length
    score += Math.min(agencyNav * 2.5, 10)

    // Service listings ("We offer...", "Our services include...")
    if (/our\s*(?:services|capabilities|offerings)/i.test(bodyLower)) score += 4
    if (/case\s*stud(?:y|ies)|selected\s*work|recent\s*projects/i.test(bodyLower)) score += 5

    // Client roster / testimonials common in agency sites
    if (ctx.features.conversion.hasTestimonials && agencyHits >= 1) score += 3

    // URL patterns
    if (ctx.url && /\/(?:work|portfolio|case-stud|projects?|services?|studio|agency)/i.test(ctx.url.pathname)) score += 4

    return score
  }

  private static scorePortfolio = (ctx: ClassifyContext): number => {
    let score = 0
    const { bodyLower, navLabels, title, description, features } = ctx

    // Personal pronouns and first-person identity
    const firstPersonRegexes = [
      /\b(?:i'?m|i\s*am)\s+(?:a|an)\s+(?:designer|developer|engineer|writer|photographer|artist|consultant|freelancer|illustrator|architect|musician|filmmaker)/i,
      /\bhi[, ].*i'?m\s+\w+/i,
      /\bhello[, ].*my\s+name\s+is/i,
      /\babout\s*me\b/i,
      /\bmy\s*work\b/i,
      /\bcontact\s*me\b/i
    ]
    const fpHits = firstPersonRegexes.filter(r => r.test(bodyLower.slice(0, 10000))).length
    score += fpHits * 5

    // Portfolio-style nav
    const portfolioNav = navLabels.filter(l =>
      ['about me', 'about', 'work', 'projects', 'portfolio', 'resume', 'cv', 'contact me', 'writing', 'blog', 'now'].some(kw => l.includes(kw))
    ).length
    if (portfolioNav >= 2) score += portfolioNav * 2

    // Small body footprint hint
    if (features.wordCount > 0 && features.wordCount < 800 && features.conversion.formCount <= 2) score += 3

    // Schema.org Person (rare but strongest tell)
    if (ctx.schemaTypes.some(t => /^person$/.test(t))) score += 12

    // Penalties: corporate "we" voice contradicts portfolio
    const corporateWeCount = (bodyLower.match(/\bwe\s+(?:are|offer|build|help|provide)\b/g) || []).length
    if (corporateWeCount > 4) score -= 4

    return score
  }

  private static scoreInformational = (ctx: ClassifyContext): number => {
    let score = 0
    const { features, schemaTypes, bodyLower, navLabels, title, url } = ctx

    // Strong schema signals
    if (schemaTypes.some(t => /^article$|^newsarticle$|^blogposting$|^techarticle$|^scholarlyarticle$/.test(t))) score += 15
    if (schemaTypes.some(t => /^blog$|^website$/.test(t)) && schemaTypes.some(t => /^article|posting$/.test(t))) score += 5

    // Title hints
    if (/wikipedia|encyclopedia|wiki/i.test(title)) score += 20
    if (/blog|news|magazine|journal|docs?\b|documentation|handbook|guide|knowledge\s*base|reference|tutorial|article/i.test(title)) score += 7

    // URL hints
    if (ctx.url && /\/(?:blog|article|news|posts?|docs?|wiki|read|stories|reference|guide|tutorial)\b/i.test(ctx.url.pathname)) score += 5

    // Body text patterns
    if (/published\s*on|posted\s*on|by\s*\w+\s+\w+\s*\|\s*\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(bodyLower.slice(0, 10000))) score += 5
    if (/table\s*of\s*contents|read\s*more|continue\s*reading|next\s*article|related\s*posts/i.test(bodyLower)) score += 4

    // Article body length — informational sites typically have long articles
    if (features.wordCount > 800) score += 5
    if (features.wordCount > 2000) score += 4

    // Many internal links suggest content site
    if (features.links.internal > 30) score += 5

    // Penalties: no commerce signals
    if (/add\s*to\s*cart|book\s*a\s*demo|free\s*trial|donate/i.test(bodyLower)) score -= 6

    // Doc-site signals
    if (/<aside|<nav.*side|table\s*of\s*contents|version\s*\d/i.test(ctx.crawl.html || '')) score += 3

    return score
  }

  private static scoreNonprofit = (ctx: ClassifyContext): number => {
    let score = 0
    const { features, schemaTypes, bodyLower, url } = ctx

    // .org TLD is a soft hint (not definitive)
    if (url && url.hostname.endsWith('.org')) score += 4

    // Donate CTAs / language
    const donateRegex = /\b(?:donate(?:\s*now)?|make\s*a\s*donation|give\s*today|support\s*our\s*(?:mission|cause)|sponsor\s*a)\b/i
    if (donateRegex.test(bodyLower)) score += 14

    // Mission / impact / volunteer keywords
    const ngoKeywords = ['our mission', 'our cause', 'volunteer with us', 'fundraising', 'campaign', 'beneficiar', 'philanthrop', 'charitable', 'tax-deductible', '501(c)', 'registered charity']
    const ngoHits = ngoKeywords.filter(k => bodyLower.includes(k)).length
    score += ngoHits * 3

    // Schema.org NGO
    if (schemaTypes.some(t => /ngo|nonprofit|charitableorganization/.test(t))) score += 18

    // Penalties: commercial signals
    if (/add\s*to\s*cart|free\s*trial|pricing\s*plans/i.test(bodyLower)) score -= 6

    return score
  }

  private static scoreEducational = (ctx: ClassifyContext): number => {
    let score = 0
    const { schemaTypes, bodyLower, url, navLabels } = ctx

    if (url && (url.hostname.endsWith('.edu') || url.hostname.endsWith('.ac.in') || url.hostname.endsWith('.ac.uk'))) score += 12

    if (schemaTypes.some(t => /educationalorganization|collegeorruniversity|school|course$|onlinecourse/.test(t))) score += 15

    // Course / curriculum language
    const eduKeywords = ['enrollment', 'curriculum', 'syllabus', 'admissions', 'tuition', 'cohort', 'instructor', 'lessons', 'modules', 'students learn', 'course content', 'certificate', 'diploma', 'bachelor', 'master\'s', 'phd', 'apply now', 'open house']
    const eduHits = eduKeywords.filter(k => bodyLower.includes(k)).length
    score += eduHits * 3

    // Nav patterns
    const eduNav = navLabels.filter(l =>
      ['courses', 'programs', 'admissions', 'students', 'faculty', 'academics', 'campus', 'enroll', 'curriculum'].some(kw => l.includes(kw))
    ).length
    score += Math.min(eduNav * 2.5, 10)

    return score
  }

  private static scoreCorporate = (ctx: ClassifyContext): number => {
    let score = 0
    const { features, bodyLower, navLabels } = ctx

    // "About us", "investors", "press", "careers" all signal corporate
    const corpKeywords = ['investor relations', 'press release', 'corporate social responsibility', 'annual report', 'leadership team', 'board of directors', 'global operations', 'fortune', 'nasdaq', 'nyse', 'lse', 'bse', 'subsidiaries']
    const corpHits = corpKeywords.filter(k => bodyLower.includes(k)).length
    score += corpHits * 4

    // Nav
    const corpNav = navLabels.filter(l =>
      ['careers', 'investors', 'press', 'newsroom', 'sustainability', 'csr', 'leadership', 'company', 'global', 'about us'].some(kw => l.includes(kw))
    ).length
    score += Math.min(corpNav * 2, 10)

    // Large company language
    if (/employees\s*worldwide|across\s*\d+\s*countries|founded\s*in\s*\d{4}|fortune\s*\d+/i.test(bodyLower)) score += 5

    return score
  }

  private static scoreCommunity = (ctx: ClassifyContext): number => {
    let score = 0
    const { schemaTypes, bodyLower, navLabels, title, features } = ctx

    if (schemaTypes.some(t => /discussionforum|webpage.*discussion/.test(t))) score += 15

    // Forum / community keywords
    const commKeywords = ['comments', 'replies', 'discussion', 'forum', 'community', 'thread', 'post comments', 'sign up to comment', 'upvote', 'downvote', 'subscribe to', 'leaderboard']
    const cHits = commKeywords.filter(k => bodyLower.includes(k)).length
    score += cHits * 2

    if (/hacker\s*news|reddit|stack\s*overflow|forum|discourse/i.test(title)) score += 12

    // High link density + low conversion intent suggests community
    if (features.links.internal > 50 && features.conversion.ctaCount < 5) score += 4

    return score
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  private static appendSignals(type: SiteType, ctx: ClassifyContext, out: string[]) {
    const { features, schemaTypes, navLabels } = ctx
    switch (type) {
      case 'local_business':
        if (features.conversion.hasPhoneNumber) out.push('Visible phone number')
        if (features.conversion.hasAddress) out.push('Physical address present')
        if (features.conversion.hasBookingSystem) out.push(`Booking widget (${features.conversion.bookingProvider || 'detected'})`)
        if (schemaTypes.some(t => /localbusiness|dentist|restaurant|salon/.test(t))) out.push('LocalBusiness schema markup')
        if (features.conversion.hasWhatsApp) out.push('WhatsApp contact link')
        if (out.length === 0) out.push('Local-business keyword patterns')
        break
      case 'ecommerce':
        if (features.techStack.cms && /shopify|woo|magento|bigcommerce/i.test(features.techStack.cms)) out.push(`E-commerce platform: ${features.techStack.cms}`)
        if (schemaTypes.some(t => /product|offer/.test(t))) out.push('Product schema markup')
        out.push('Cart / checkout patterns detected')
        break
      case 'saas_product':
        if (schemaTypes.some(t => /softwareapplication|webapplication/.test(t))) out.push('SoftwareApplication schema')
        if (/free\s*trial|book\s*a\s*demo/i.test(ctx.bodyLower)) out.push('Trial / demo CTAs')
        if (/pricing|per\s*month|per\s*user/i.test(ctx.bodyLower)) out.push('Pricing plans')
        const saasNavHits = navLabels.filter(l => ['pricing', 'features', 'platform', 'docs', 'login', 'sign in', 'sign up'].some(kw => l.includes(kw)))
        if (saasNavHits.length > 0) out.push(`Product nav labels: ${saasNavHits.slice(0, 3).join(', ')}`)
        if (features.conversion.hasLoginForm) out.push('Login form present')
        if (out.length === 0) out.push('SaaS keyword density')
        break
      case 'agency_services':
        out.push('Agency-style positioning and case-study patterns')
        if (features.conversion.hasTestimonials) out.push(`${features.conversion.testimonialsCount} client testimonials`)
        break
      case 'personal_portfolio':
        out.push('First-person voice and portfolio-style navigation')
        if (schemaTypes.includes('person')) out.push('Person schema markup')
        break
      case 'informational':
        if (features.wordCount > 800) out.push(`Long-form content (${features.wordCount} words)`)
        if (schemaTypes.some(t => /article|posting/.test(t))) out.push('Article schema markup')
        if (features.links.internal > 30) out.push(`Heavy internal linking (${features.links.internal} links)`)
        if (out.length === 0) out.push('Content-site characteristics')
        break
      case 'nonprofit':
        out.push('Donate CTAs and mission-driven language')
        if (schemaTypes.some(t => /ngo|nonprofit/.test(t))) out.push('NGO schema markup')
        break
      case 'educational':
        out.push('Course / curriculum language detected')
        break
      case 'corporate':
        out.push('Corporate brochure structure (investors, careers, press)')
        break
      case 'community':
        out.push('Community / forum patterns')
        break
    }
  }

  private static deriveSubtype(type: SiteType, ctx: ClassifyContext): string | undefined {
    const { bodyLower, schemaTypes } = ctx

    if (type === 'local_business') {
      if (schemaTypes.some(t => /dentist/.test(t)) || /\bdentist|dental\s*clinic\b/i.test(bodyLower)) return 'dental clinic'
      if (schemaTypes.some(t => /restaurant/.test(t)) || /\brestaurant|cafe|bistro\b/i.test(bodyLower)) return 'restaurant'
      if (schemaTypes.some(t => /hairsalon|beautysalon/.test(t)) || /\bsalon|stylist|spa\b/i.test(bodyLower)) return 'beauty / salon'
      if (schemaTypes.some(t => /lawfirm|attorney/.test(t)) || /\blaw\s*firm|attorney|lawyer\b/i.test(bodyLower)) return 'law firm'
      if (/\bclinic|patient|physician|medical\s*centre\b/i.test(bodyLower)) return 'medical clinic'
      if (/\bplumber|plumbing\b/i.test(bodyLower)) return 'plumbing'
      if (/\bauto\s*repair|mechanic\b/i.test(bodyLower)) return 'auto repair'
      if (/\bgym|fitness|personal\s*trainer\b/i.test(bodyLower)) return 'fitness'
      return 'local services'
    }
    if (type === 'ecommerce') {
      if (/\b(clothing|apparel|fashion|t-shirt|dress)\b/i.test(bodyLower)) return 'fashion / apparel'
      if (/\b(jewel|ring|necklace|bracelet)\b/i.test(bodyLower)) return 'jewellery'
      if (/\b(furniture|sofa|table|chair)\b/i.test(bodyLower)) return 'furniture'
      if (/\b(food|coffee|tea|grocery|snack)\b/i.test(bodyLower)) return 'food / beverage'
      return 'online store'
    }
    if (type === 'saas_product') return 'software product'
    if (type === 'agency_services') {
      if (/\b(marketing|seo|ads|growth)\b/i.test(bodyLower)) return 'marketing agency'
      if (/\b(design|brand|creative)\b/i.test(bodyLower)) return 'design agency'
      if (/\b(developer|software|engineering)\b/i.test(bodyLower)) return 'dev agency'
      return 'services agency'
    }
    return undefined
  }
}

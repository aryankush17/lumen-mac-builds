import { ExtractedFeatures } from './FeatureExtractionService'
import { getDb } from '../database/init'
import * as cheerio from 'cheerio'
import { v4 as uuidv4 } from 'uuid'

export interface KeywordDensityItem {
  keyword: string
  count: number
  density: number
}

export interface WebsiteIntelligenceData {
  id: string
  auditId: string | null
  url: string
  createdAt: string
  primaryKeywords: string[]
  secondaryKeywords: string[]
  keywordDensity: KeywordDensityItem[]
  seoStructure: {
    hasH1: boolean
    h1Text: string | null
    headingCount: number
    metaTitle: string | null
    metaDesc: string | null
  }
  contentStrategy: string
  internalLinking: string
  navigationStructure: string[]
  brandPositioning: string
  uniqueSellingProps: string[]
  colorPalette: { hex: string; name: string; usage: string }[]
  typography: {
    primaryFont: string
    secondaryFont: string
    headingSize: string
    bodySize: string
  }
  trustSignals: string[]
  conversionFunnel: string[]
}

const STOP_WORDS = new Set([
  'the', 'and', 'a', 'an', 'to', 'of', 'in', 'is', 'it', 'on', 'for', 'you', 'was', 'with', 'as',
  'our', 'we', 'your', 'us', 'are', 'this', 'be', 'at', 'or', 'by', 'from', 'about', 'but',
  'not', 'will', 'can', 'has', 'have', 'had', 'more', 'new', 'all', 'how', 'one', 'what', 'their', 'they',
  'if', 'so', 'up', 'out', 'my', 'me', 'who', 'which', 'get', 'would', 'make', 'like',
  'him', 'her', 'his', 'them', 'these', 'those', 'into', 'just', 'only', 'also', 'some',
  'no', 'go', 'over', 'now', 'then', 'any', 'first', 'look', 'find',
  'that', 'than', 'were', 'been', 'when', 'where', 'while', 'such', 'each', 'other',
  'after', 'before', 'because', 'between', 'through', 'during', 'against', 'under', 'within',
  'should', 'could', 'might', 'must', 'shall', 'does', 'doing', 'done', 'being',
  'here', 'there', 'very', 'much', 'many', 'most', 'less', 'still', 'even', 'ever', 'never',
  'home', 'page', 'site', 'website', 'click', 'read', 'menu', 'main', 'back', 'next', 'previous',
  'view', 'open', 'close', 'show', 'hide', 'toggle', 'select', 'load', 'loading',
  'copyright', 'reserved', 'rights', 'terms', 'privacy', 'policy', 'cookie', 'cookies', 'login', 'logout',
  'signup', 'register', 'account', 'profile', 'settings', 'help', 'support', 'faq', 'contact'
])

export class WebsiteIntelligenceService {
  /**
   * Extract keywords and compute density from body text.
   * Strips nav/header/footer/aside/script/style so navigation and boilerplate
   * don't dominate the keyword list.
   */
  static computeKeywordDensity(html: string): KeywordDensityItem[] {
    const $ = cheerio.load(html)
    $('script, style, noscript, iframe, head, nav, header, footer, aside, [role="navigation"]').remove()
    const bodyText = $('body').text() || $.root().text() || ''

    // Tokenise: keep words 4+ chars, drop stop words and pure-digit tokens
    const words = bodyText
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))

    const totalWords = words.length || 1
    const frequencies: Record<string, number> = {}

    words.forEach(w => {
      frequencies[w] = (frequencies[w] || 0) + 1
    })

    const sorted = Object.entries(frequencies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)

    return sorted.map(([keyword, count]) => ({
      keyword,
      count,
      density: parseFloat(((count / totalWords) * 100).toFixed(2))
    }))
  }

  /**
   * Weighted industry classifier. Title/description hits weigh more than body
   * hits because owners deliberately put their value prop there.
   */
  private static classifyIndustry(
    contentText: string,
    titleText: string,
    descText: string,
    features: ExtractedFeatures
  ): string {
    const titleLow = titleText.toLowerCase()
    const descLow = descText.toLowerCase()

    const buckets: { name: string; keywords: { word: string; weight: number }[] }[] = [
      {
        name: 'Retail / E-Commerce',
        keywords: [
          { word: 'add to cart', weight: 8 },
          { word: 'checkout', weight: 6 },
          { word: 'shipping', weight: 4 },
          { word: 'product', weight: 2 },
          { word: 'shop', weight: 2 },
          { word: 'store', weight: 2 },
          { word: 'price', weight: 1 },
          { word: 'sale', weight: 1 }
        ]
      },
      {
        name: 'Legal Services',
        keywords: [
          { word: 'attorney', weight: 8 },
          { word: 'lawyer', weight: 8 },
          { word: 'law firm', weight: 8 },
          { word: 'litigation', weight: 6 },
          { word: 'legal services', weight: 5 },
          { word: 'plaintiff', weight: 4 },
          { word: 'counsel', weight: 3 },
          { word: 'court', weight: 2 }
        ]
      },
      {
        name: 'Healthcare & Medicine',
        keywords: [
          { word: 'patient', weight: 6 },
          { word: 'clinic', weight: 6 },
          { word: 'doctor', weight: 5 },
          { word: 'medical', weight: 5 },
          { word: 'dentist', weight: 6 },
          { word: 'dental', weight: 5 },
          { word: 'hospital', weight: 5 },
          { word: 'treatment', weight: 3 },
          { word: 'diagnosis', weight: 4 },
          { word: 'pediatric', weight: 6 }
        ]
      },
      {
        name: 'Technology / Software',
        keywords: [
          { word: 'saas', weight: 8 },
          { word: 'api', weight: 5 },
          { word: 'platform', weight: 3 },
          { word: 'software', weight: 4 },
          { word: 'developer', weight: 4 },
          { word: 'integration', weight: 3 },
          { word: 'cloud', weight: 3 },
          { word: 'open source', weight: 4 }
        ]
      },
      {
        name: 'Home Services',
        keywords: [
          { word: 'plumbing', weight: 7 },
          { word: 'roofing', weight: 7 },
          { word: 'hvac', weight: 7 },
          { word: 'electrician', weight: 7 },
          { word: 'renovation', weight: 5 },
          { word: 'remodel', weight: 5 },
          { word: 'cleaning service', weight: 5 },
          { word: 'pest control', weight: 6 },
          { word: 'landscaping', weight: 5 }
        ]
      },
      {
        name: 'Finance & Accounting',
        keywords: [
          { word: 'tax', weight: 5 },
          { word: 'accounting', weight: 7 },
          { word: 'bookkeeping', weight: 7 },
          { word: 'cpa', weight: 7 },
          { word: 'loan', weight: 5 },
          { word: 'mortgage', weight: 6 },
          { word: 'investment', weight: 4 },
          { word: 'financial advisor', weight: 7 },
          { word: 'wealth management', weight: 7 }
        ]
      },
      {
        name: 'Beauty & Salon',
        keywords: [
          { word: 'salon', weight: 7 },
          { word: 'haircut', weight: 6 },
          { word: 'manicure', weight: 6 },
          { word: 'spa', weight: 6 },
          { word: 'beauty', weight: 4 },
          { word: 'stylist', weight: 5 },
          { word: 'cosmetic', weight: 4 }
        ]
      },
      {
        name: 'Food & Hospitality',
        keywords: [
          { word: 'restaurant', weight: 7 },
          { word: 'menu', weight: 4 },
          { word: 'reservation', weight: 6 },
          { word: 'cafe', weight: 6 },
          { word: 'cuisine', weight: 5 },
          { word: 'hotel', weight: 7 },
          { word: 'booking', weight: 3 },
          { word: 'dining', weight: 4 }
        ]
      },
      {
        name: 'Real Estate',
        keywords: [
          { word: 'realtor', weight: 8 },
          { word: 'real estate', weight: 7 },
          { word: 'mls', weight: 6 },
          { word: 'listing', weight: 4 },
          { word: 'property', weight: 3 },
          { word: 'broker', weight: 4 },
          { word: 'apartment', weight: 3 }
        ]
      },
      {
        name: 'Education & Training',
        keywords: [
          { word: 'course', weight: 5 },
          { word: 'student', weight: 4 },
          { word: 'enroll', weight: 6 },
          { word: 'curriculum', weight: 6 },
          { word: 'training', weight: 4 },
          { word: 'certification', weight: 4 },
          { word: 'tuition', weight: 6 }
        ]
      },
      {
        name: 'Marketing & Agency',
        keywords: [
          { word: 'digital marketing', weight: 7 },
          { word: 'seo', weight: 4 },
          { word: 'ppc', weight: 5 },
          { word: 'advertising agency', weight: 7 },
          { word: 'lead generation', weight: 5 },
          { word: 'creative agency', weight: 6 },
          { word: 'branding agency', weight: 6 }
        ]
      },
      {
        name: 'Manufacturing & Industrial',
        keywords: [
          { word: 'manufacturer', weight: 7 },
          { word: 'manufacturing', weight: 6 },
          { word: 'fabrication', weight: 7 },
          { word: 'industrial', weight: 4 },
          { word: 'precision', weight: 3 },
          { word: 'cnc', weight: 6 },
          { word: 'machining', weight: 6 },
          { word: 'tolerance', weight: 4 },
          { word: 'steel', weight: 3 },
          { word: 'fabricator', weight: 6 },
          { word: 'iso 9001', weight: 5 }
        ]
      },
      {
        name: 'Automotive',
        keywords: [
          { word: 'auto repair', weight: 7 },
          { word: 'mechanic', weight: 6 },
          { word: 'car service', weight: 5 },
          { word: 'dealership', weight: 7 },
          { word: 'vehicle', weight: 3 },
          { word: 'mot', weight: 4 },
          { word: 'tyre', weight: 5 },
          { word: 'tire', weight: 5 },
          { word: 'workshop', weight: 3 }
        ]
      },
      {
        name: 'Nonprofit & NGO',
        keywords: [
          { word: 'donate', weight: 6 },
          { word: 'donation', weight: 6 },
          { word: 'nonprofit', weight: 8 },
          { word: 'non-profit', weight: 8 },
          { word: 'charity', weight: 7 },
          { word: 'fundraising', weight: 6 },
          { word: 'volunteer', weight: 4 },
          { word: 'mission', weight: 2 },
          { word: 'ngo', weight: 7 },
          { word: '501(c)', weight: 8 }
        ]
      },
      {
        name: 'Fitness & Wellness',
        keywords: [
          { word: 'gym', weight: 6 },
          { word: 'personal trainer', weight: 7 },
          { word: 'yoga', weight: 6 },
          { word: 'pilates', weight: 6 },
          { word: 'fitness', weight: 4 },
          { word: 'wellness', weight: 4 },
          { word: 'workout', weight: 4 },
          { word: 'crossfit', weight: 7 }
        ]
      }
    ]

    const scores: Record<string, number> = {}
    for (const bucket of buckets) {
      let s = 0
      for (const kw of bucket.keywords) {
        // Count occurrences cheaply, capped to avoid runaway from one repeated word
        let idx = 0
        let count = 0
        while ((idx = contentText.indexOf(kw.word, idx)) !== -1 && count < 8) {
          count++
          idx += kw.word.length
        }
        if (count > 0) s += count * kw.weight
        // Title and description hits get a hefty bonus
        if (titleLow.includes(kw.word)) s += kw.weight * 4
        if (descLow.includes(kw.word)) s += kw.weight * 3
      }
      scores[bucket.name] = s
    }

    // E-commerce schema bonus
    if (features.structuredData.types.some(t => /Product|Offer/i.test(t))) {
      scores['Retail / E-Commerce'] = (scores['Retail / E-Commerce'] || 0) + 20
    }
    // LocalBusiness schema lifts services
    if (features.structuredData.types.some(t => /LocalBusiness|MedicalBusiness|Dentist|HomeAndConstructionBusiness/i.test(t))) {
      scores['Home Services'] = (scores['Home Services'] || 0) + 8
      scores['Healthcare & Medicine'] = (scores['Healthcare & Medicine'] || 0) + 8
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
    if (!sorted.length || sorted[0][1] < 6) return 'Professional Services'
    return sorted[0][0]
  }

  /**
   * Deterministically analyze features and classify the site
   */
  static analyze(html: string, url: string, features: ExtractedFeatures, auditId: string | null = null): WebsiteIntelligenceData {
    const domain = (() => {
      try {
        return new URL(url).hostname
      } catch {
        return url
      }
    })()
    
    const domainPart = domain.split('.')[0]
    const titleText = features.title || ''
    const descText = features.metaDescription || ''
    const contentText = (html + ' ' + titleText + ' ' + descText).toLowerCase()

    // 1. Keyword density
    const keywordDensity = this.computeKeywordDensity(html)
    const primaryKeywords = keywordDensity.slice(0, 3).map(k => k.keyword)
    const secondaryKeywords = keywordDensity.slice(3, 8).map(k => k.keyword)

    if (primaryKeywords.length === 0) {
      primaryKeywords.push(domainPart, 'website')
    }

    // 2. Classify Industry — weighted multi-signal scoring
    const industry = this.classifyIndustry(contentText, titleText, descText, features)

    // 3. Classify Business Category & Brand Positioning from industry signal
    // Old logic over-triggered "E-Commerce" any time the word "product" appeared.
    // Tie category and positioning to the already-scored industry instead.
    const lower = (s: string) => s.toLowerCase()
    let category = 'B2B Services'
    if (industry === 'Retail / E-Commerce') category = 'E-Commerce'
    else if (industry === 'Technology / Software') category = 'SaaS / Product'
    else if (
      industry === 'Healthcare & Medicine' ||
      industry === 'Home Services' ||
      industry === 'Beauty & Salon' ||
      industry === 'Food & Hospitality' ||
      industry === 'Real Estate' ||
      industry === 'Automotive' ||
      industry === 'Fitness & Wellness'
    ) category = 'Local Business'
    else if (industry === 'Marketing & Agency') category = 'Service Agency'
    else if (industry === 'Education & Training') category = 'Education'
    else if (industry === 'Legal Services' || industry === 'Finance & Accounting') category = 'Professional Firm'
    else if (industry === 'Manufacturing & Industrial') category = 'Industrial / B2B'
    else if (industry === 'Nonprofit & NGO') category = 'Nonprofit'
    // Knowledge / encyclopedia / publishing override
    if (
      lower(titleText).includes('wikipedia') ||
      lower(titleText).includes('encyclopedia') ||
      lower(titleText).includes('blog') ||
      lower(titleText).includes('news') ||
      lower(titleText).includes('article') ||
      features.structuredData.types.some(t => /Article|NewsArticle|BlogPosting/i.test(t))
    ) {
      category = 'Publishing / Media'
    }

    // 4. Unique Selling Propositions (USPs)
    // Strategy:
    //   a) Scan H2/H3 in the first ~3000 chars of body (above-the-fold zone)
    //      for benefit-shaped headings.
    //   b) Then look at h1 sub-headlines and lead paragraphs.
    //   c) Fall back to industry-derived generic USPs if nothing concrete.
    const uniqueSellingProps: string[] = []
    const $ = cheerio.load(html)
    const seenUsps = new Set<string>()
    const pushUsp = (text: string) => {
      const trimmed = text.trim()
      const key = trimmed.toLowerCase()
      if (trimmed.length < 8 || trimmed.length > 110) return
      if (seenUsps.has(key)) return
      seenUsps.add(key)
      uniqueSellingProps.push(trimmed)
    }

    const benefitRegex = /\b(why\s|our\s+(?:promise|advantage|approach|values|why)|guarantee|trusted\s+by|backed\s+by|results\s+driven|delivered|certified|award.winning|since\s+\d{4}|years?\s+of\s+experience|no\s+contracts?|risk.free|money.back|free\s+(?:consultation|trial|quote)|fast\s+(?:delivery|turnaround|response)|on.time|24[\/-]?7|same.day)\b/i

    $('h1 + p, h1 ~ p, h2, h3').slice(0, 25).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim()
      if (benefitRegex.test(text)) pushUsp(text)
    })

    // Specific shapes: "X without Y", "Get X in Y" — common SMB landing-page patterns
    $('h2, h3').slice(0, 40).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim()
      if (uniqueSellingProps.length >= 6) return
      if (/\bwithout\b|\bin\s+as\s+little\s+as\b|\bguaranteed\b|\bin\s+\d+\s+(days?|hours?|minutes?)\b/i.test(text)) {
        pushUsp(text)
      }
    })

    // Fallback for sites that have no benefit-shaped headings
    if (uniqueSellingProps.length === 0) {
      uniqueSellingProps.push(
        `Specialised ${industry.toLowerCase()} expertise tailored to client needs`,
        'Direct communication and reliable delivery timelines',
        'Outcomes measured by client business results, not vanity metrics'
      )
    }

    // 5. Brand Positioning — derived from industry/category combination
    let brandPositioning: string
    switch (industry) {
      case 'Retail / E-Commerce':
        brandPositioning = 'Digital storefront focused on product discovery, secure checkout, and fast fulfilment.'
        break
      case 'Technology / Software':
        brandPositioning = 'Technology platform offering scalable, secure, integration-friendly solutions to modern teams.'
        break
      case 'Legal Services':
        brandPositioning = 'Reputable legal firm delivering compliant, outcome-focused counsel to clients.'
        break
      case 'Healthcare & Medicine':
        brandPositioning = 'Patient-first clinical provider focused on accessibility, safety, and modern care.'
        break
      case 'Home Services':
        brandPositioning = 'Trusted local service provider offering reliable on-site work and clear pricing.'
        break
      case 'Finance & Accounting':
        brandPositioning = 'Trusted financial services firm prioritising compliance, accuracy, and client outcomes.'
        break
      case 'Beauty & Salon':
        brandPositioning = 'Lifestyle brand built around personal care, expert stylists, and a curated client experience.'
        break
      case 'Food & Hospitality':
        brandPositioning = 'Hospitality brand focused on guest experience, menu quality, and easy booking.'
        break
      case 'Real Estate':
        brandPositioning = 'Real estate practice connecting buyers, sellers, and properties through local market expertise.'
        break
      case 'Education & Training':
        brandPositioning = 'Education provider offering structured curriculum, mentorship, and measurable outcomes.'
        break
      case 'Marketing & Agency':
        brandPositioning = 'Creative and performance agency delivering measurable growth for client brands.'
        break
      case 'Manufacturing & Industrial':
        brandPositioning = 'Manufacturing partner offering precision production, technical depth, and dependable lead times for industrial buyers.'
        break
      case 'Automotive':
        brandPositioning = 'Automotive service provider focused on transparent pricing, skilled diagnostics, and quick turnaround.'
        break
      case 'Nonprofit & NGO':
        brandPositioning = 'Mission-driven organisation channelling donor support into measurable community impact.'
        break
      case 'Fitness & Wellness':
        brandPositioning = 'Wellness brand focused on coaching, programming, and member transformation over time.'
        break
      default:
        if (category === 'Publishing / Media') {
          brandPositioning = 'Content and knowledge platform serving readers with curated, accessible information.'
        } else {
          brandPositioning = `Professional services provider operating in the ${industry.toLowerCase()} space, prioritising client outcomes and reliability.`
        }
    }

    // 6. Navigation structure (scrape header links, menu or fallback)
    const navigationStructure: string[] = []
    $('nav a, header a, .menu a, [class*="nav"] a').each((_, el) => {
      const text = $(el).text().trim()
      if (text.length > 2 && text.length < 15 && !navigationStructure.includes(text)) {
        navigationStructure.push(text)
      }
    })

    const finalNav = navigationStructure.slice(0, 6)
    if (finalNav.length < 3) {
      finalNav.push('Home', 'Services', 'About Us', 'Contact')
    }

    // 7. Design Analysis (Colors & Typography)
    // Scan inline style="color:..." AND <style> blocks AND CSS custom properties
    const hexFrequencies: Record<string, number> = {}
    const bumpHex = (hex: string) => {
      const norm = hex.toUpperCase()
      // Reject pure black/white/very dark/very light defaults — those are body text, not brand
      if (norm === '#FFFFFF' || norm === '#FFF' || norm === '#000000' || norm === '#000') return
      hexFrequencies[norm] = (hexFrequencies[norm] || 0) + 1
    }

    // Inline color attributes
    $('[style*="color"], [style*="background"]').each((_, el) => {
      const style = $(el).attr('style') || ''
      const hexMatches = style.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)
      if (hexMatches) hexMatches.forEach(bumpHex)
    })

    // <style> blocks
    $('style').each((_, el) => {
      const css = $(el).html() || ''
      const hexMatches = css.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)
      if (hexMatches) hexMatches.forEach(bumpHex)
    })

    const sortedHexes = Object.entries(hexFrequencies)
      .sort((a, b) => b[1] - a[1])
      .map(([h]) => h)

    const colorPalette = [
      { hex: sortedHexes[0] || '#6C47FF', name: 'Primary Color', usage: 'Most-used brand color across the page.' },
      { hex: sortedHexes[1] || '#10B981', name: 'Secondary / Accent', usage: 'Secondary highlights and call-to-action backgrounds.' },
      { hex: sortedHexes[2] || '#1E293B', name: 'Tertiary', usage: 'Supporting tones used for cards, dividers, and text.' }
    ]

    // Typography: scan Google Fonts links + <style> font-family + inline font-family
    const GENERIC_CSS_VALUES = new Set([
      'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'currentcolor',
      'none', 'normal', 'auto',
      'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
      'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
      'emoji', 'math', 'fangsong'
    ])
    const fontCandidates: string[] = []
    const pushFont = (raw: string) => {
      // A font-family can have multiple comma-separated fallbacks; check each
      // and pick the first non-generic, non-keyword option as a candidate.
      const parts = raw.split(',').map(p => p.replace(/['"]/g, '').trim()).filter(Boolean)
      for (const part of parts) {
        if (part.length === 0 || part.length > 60) continue
        if (GENERIC_CSS_VALUES.has(part.toLowerCase())) continue
        if (/^var\(/i.test(part)) continue          // CSS custom-property fallbacks
        if (!fontCandidates.includes(part)) fontCandidates.push(part)
        break  // First real name from this declaration is enough
      }
    }

    // Google Fonts <link>
    $('link[rel="stylesheet"][href*="fonts.googleapis.com"], link[rel="preload"][href*="fonts.googleapis.com"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      // family=Inter:wght@400;700&family=Playfair+Display
      const familyMatches = href.matchAll(/family=([^&:]+)/g)
      for (const m of familyMatches) {
        const fam = decodeURIComponent(m[1]).replace(/\+/g, ' ')
        pushFont(fam)
      }
    })

    // <style> font-family declarations
    $('style').each((_, el) => {
      const css = $(el).html() || ''
      const fontMatches = css.matchAll(/font-family\s*:\s*([^;{}]+)[;}]/gi)
      for (const m of fontMatches) {
        pushFont(m[1])
      }
    })

    // Inline style font-family
    $('[style*="font-family"]').each((_, el) => {
      const style = $(el).attr('style') || ''
      const m = style.match(/font-family\s*:\s*([^;]+)/i)
      if (m) pushFont(m[1])
    })

    const primaryFont = fontCandidates[0] || 'Inter, sans-serif'
    const secondaryFont = fontCandidates[1] || fontCandidates[0] || 'system-ui, sans-serif'

    const typography = {
      primaryFont,
      secondaryFont,
      headingSize: '32px / 2.0rem',
      bodySize: '16px / 1.0rem'
    }

    // 8. Trust signals — derive from the extracted features instead of re-scraping
    const trustSignals: string[] = []
    if (url.startsWith('https://')) trustSignals.push('SSL Certificate (HTTPS)')
    if (features.structuredData.hasJsonLd) trustSignals.push(`Schema markup (${features.structuredData.types.slice(0, 2).join(', ') || 'structured data'})`)
    if (features.conversion.hasTestimonials) trustSignals.push(`${features.conversion.testimonialsCount} customer testimonial(s)`)
    if (features.trust.hasPrivacyPolicy) trustSignals.push('Privacy Policy link')
    if (features.trust.hasTermsOfService) trustSignals.push('Terms of Service link')
    if (features.trust.hasCertificationBadges) trustSignals.push('Certification badges (ISO/GDPR/HIPAA/SOC2/PCI)')
    if (features.trust.hasAwardMentions) trustSignals.push('Awards or recognition mentioned')
    if (features.trust.hasSocialLinks && features.trust.socialPlatforms.length > 0) {
      trustSignals.push(`Social presence: ${features.trust.socialPlatforms.slice(0, 4).join(', ')}`)
    }
    if (features.conversion.hasAddress) trustSignals.push('Physical address visible')
    if (features.conversion.hasPhoneNumber) trustSignals.push('Phone number visible')

    if (trustSignals.length === 0) {
      trustSignals.push('No notable trust signals detected — add at least a privacy policy and social profile links.')
    }

    // 9. Conversion funnel — describes the actual path detected on this page,
    // not a generic 4-step boilerplate.
    const conversionFunnel: string[] = []
    conversionFunnel.push(
      industry === 'Retail / E-Commerce'
        ? 'Visitor lands from search, ads, or social and starts browsing products.'
        : industry === 'Nonprofit & NGO'
          ? 'Visitor arrives from search or social, exploring mission and impact stories.'
          : 'Visitor lands on the page from search, ads, social, or referral traffic.'
    )

    if (features.conversion.ctaCount > 0) {
      const sample = features.conversion.ctaTexts[0] || 'Get Started'
      conversionFunnel.push(`Visitor scans for a next action and finds CTA "${sample}" (${features.conversion.ctaCount} CTA${features.conversion.ctaCount === 1 ? '' : 's'} on the page).`)
    } else {
      conversionFunnel.push('Visitor scans for a next action but finds no high-contrast CTA — many bounce here.')
    }

    if (features.conversion.hasTestimonials) {
      conversionFunnel.push(`Visitor reads ${features.conversion.testimonialsCount} customer testimonial${features.conversion.testimonialsCount === 1 ? '' : 's'} and trust signals to validate the offer.`)
    } else if (features.trust.hasCertificationBadges || features.trust.hasAwardMentions) {
      conversionFunnel.push('Visitor scans for credibility signals and finds certifications or awards, but no first-person testimonials.')
    }

    if (features.conversion.hasContactForm) {
      conversionFunnel.push('Visitor submits the contact form to start a conversation.')
    } else if (features.conversion.hasBookingSystem) {
      conversionFunnel.push(`Visitor opens the ${features.conversion.bookingProvider || 'booking'} widget and self-schedules a session.`)
    } else if (features.conversion.hasWhatsApp) {
      conversionFunnel.push('Visitor taps the WhatsApp button and starts a direct chat.')
    } else if (features.conversion.hasPhoneNumber) {
      conversionFunnel.push('Visitor hunts for the phone number in the footer and dials manually.')
    } else if (features.conversion.hasEmailAddress) {
      conversionFunnel.push('Visitor copies the email address and switches to their email client — high friction.')
    } else {
      conversionFunnel.push('Visitor finds no contact channel and leaves the site without converting.')
    }

    if (features.conversion.hasNewsletterSignup) {
      conversionFunnel.push('Unconvinced visitors are captured by the newsletter signup for later remarketing.')
    }

    conversionFunnel.push('Lead enters the sales pipeline (or drops off if no follow-up channel is in place).')

    const id = uuidv4()
    const now = new Date().toISOString()

    const intelligenceData: WebsiteIntelligenceData = {
      id,
      auditId,
      url,
      createdAt: now,
      primaryKeywords,
      secondaryKeywords,
      keywordDensity,
      seoStructure: {
        hasH1: features.headings.h1Count > 0,
        h1Text: features.headings.h1[0] || null,
        headingCount: Object.values(features.headings).reduce((a: number, b) => (typeof b === 'number' ? a + b : a), 0),
        metaTitle: features.title,
        metaDesc: features.metaDescription
      },
      contentStrategy: `Focus on expanding copy for your primary keywords (${primaryKeywords.join(', ')}). Optimize h1 heading alignment and write structured blog pages targeting ${secondaryKeywords.join(', ')}.`,
      internalLinking: `Audit your menu pages (${finalNav.join(', ')}) and link articles together to boost internal PageRank distribution.`,
      navigationStructure: finalNav,
      brandPositioning,
      uniqueSellingProps,
      colorPalette,
      typography,
      trustSignals,
      conversionFunnel
    }

    return intelligenceData
  }

  /**
   * Persistence is no longer separate — intelligence data is embedded inside
   * the parent audit's raw_data blob and persisted with the audit. These
   * methods remain as no-ops for any lingering call sites.
   */
  static saveToDb(_data: WebsiteIntelligenceData): void {
    /* no-op: intelligence is now inlined in the audit response */
  }

  static getByAuditId(_auditId: string): WebsiteIntelligenceData | null {
    /* no-op: callers should read audit.intelligence from the audit response */
    return null
  }
}

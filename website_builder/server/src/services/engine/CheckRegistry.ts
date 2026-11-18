import { CrawlResult } from '../CrawlerService'
import { ExtractedFeatures } from '../FeatureExtractionService'
import { SiteType, SiteProfile } from './SiteClassifier'

export type Category = 'performance' | 'seo' | 'marketing' | 'conversion' | 'security'
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface CheckResult {
  /** True if the check passed (no issue). */
  passed: boolean
  /** Status code consumed by the UI. */
  status: 'pass' | 'fail' | 'warning'
  /** Severity drives the opportunity-point multiplier. */
  severity: Severity
  /** One-line display value e.g. "TTFB 312ms" or "Not detected". */
  value: string
  /** Optional supporting detail. */
  detail?: string
  /** Recommendation specific to this finding. May be overridden by site-type. */
  recommendation: string
}

export interface CheckDefinition {
  id: string
  label: string
  category: Category
  /** Base weight (0-30). Heavier weights matter more for the category score. */
  weight: number
  /** Pure function from inputs to a check outcome. */
  evaluator: (crawl: CrawlResult, features: ExtractedFeatures, profile: SiteProfile) => CheckResult
  applicability: Applicability
}

export interface Applicability {
  /** Site types where this check applies normally. '*' = all. */
  appliesTo: SiteType[] | '*'
  /** Site types where this check is critical — weight gets boosted ×1.5. */
  criticalFor?: SiteType[]
  /** Site types where this check is optional — weight gets cut to ×0.5. */
  optionalFor?: SiteType[]
  /** Site types where this check is N/A — skip entirely. */
  excludedFor?: SiteType[]
}

/**
 * Resolve effective weight for a check given the site type.
 * Returns 0 if the check is excluded for that type.
 */
export function effectiveWeight(check: CheckDefinition, type: SiteType): number {
  const app = check.applicability
  if (app.excludedFor?.includes(type)) return 0
  const appliesAll = app.appliesTo === '*'
  if (!appliesAll && !app.appliesTo.includes(type)) return 0
  let w = check.weight
  if (app.criticalFor?.includes(type)) w *= 1.5
  if (app.optionalFor?.includes(type)) w *= 0.5
  return w
}

/**
 * Helper: build a basic CheckResult.
 */
const pass = (value: string, recommendation: string): CheckResult => ({
  passed: true, status: 'pass', severity: 'info', value, recommendation
})
const fail = (value: string, recommendation: string, severity: Severity = 'high'): CheckResult => ({
  passed: false, status: 'fail', severity, value, recommendation
})
const warn = (value: string, recommendation: string, severity: Severity = 'medium'): CheckResult => ({
  passed: false, status: 'warning', severity, value, recommendation
})

/**
 * The complete check registry.
 *
 * Organisation:
 *   - Universal checks (applies to all)        — performance, security, core SEO
 *   - Commercial-only checks                   — pixels, contact forms, CTAs
 *   - Local-business specific                  — NAP, hours, booking, map
 *   - E-commerce specific                      — cart, checkout, payment trust
 *   - SaaS specific                            — pricing, trial CTA, demo
 *   - Content/info specific                    — article schema, reading time
 */
export const CHECKS: CheckDefinition[] = [
  // ════════════════════════════════════════════════════════════════════════
  // PERFORMANCE — Universal
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'ttfb',
    label: 'Server Response Time',
    category: 'performance',
    weight: 14,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      const ttfb = crawl.ttfbMs || 0
      if (!crawl.success) return fail('Server unreachable', 'Restore server connectivity before re-running the audit.', 'critical')
      if (ttfb === 0) return pass('Sub-millisecond response', 'Server is very fast.')
      if (ttfb <= 300) return pass(`${ttfb}ms time-to-first-byte`, 'Excellent server response time.')
      if (ttfb <= 600) return warn(`${ttfb}ms time-to-first-byte`, 'Acceptable, but moving below 300ms via caching or a CDN would improve Core Web Vitals.', 'low')
      if (ttfb <= 1500) return fail(`${ttfb}ms time-to-first-byte`, 'Enable HTTP caching, optimise backend queries, or move to a faster host. Target under 600ms.', 'high')
      return fail(`${ttfb}ms time-to-first-byte`, 'Server response is critically slow. Move to a better host, enable a CDN, and aggressively cache HTML.', 'critical')
    }
  },
  {
    id: 'compression',
    label: 'Response Compression',
    category: 'performance',
    weight: 6,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      if (crawl.compressionEnabled) return pass(crawl.headers['content-encoding'] || 'enabled', 'Compression is active.')
      return fail('No gzip / brotli / zstd detected', 'Enable gzip or brotli compression at the web server. Typical 60-80% reduction in HTML payload.', 'high')
    }
  },
  {
    id: 'caching',
    label: 'Browser Caching',
    category: 'performance',
    weight: 5,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      const cc = crawl.cacheHeaders.cacheControl
      if (crawl.cacheHeaders.hasCaching) {
        return pass(cc || 'Cache headers present', 'Caching is configured.')
      }
      if (cc && /no-store|no-cache|max-age=0/.test(cc.toLowerCase())) {
        return warn(`Cache-Control: ${cc}`, 'Caching is explicitly disabled. Lift this unless you specifically need always-fresh HTML.', 'low')
      }
      return warn('No Cache-Control / ETag / Last-Modified headers', 'Add Cache-Control: public, max-age=3600 for HTML and max-age=31536000, immutable for hashed assets.', 'medium')
    }
  },
  {
    id: 'page-weight',
    label: 'HTML Page Weight',
    category: 'performance',
    weight: 5,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      const kb = features.htmlSizeKb
      if (kb <= 200) return pass(`${kb}KB HTML`, 'Page weight is healthy.')
      if (kb <= 500) return warn(`${kb}KB HTML`, 'Trim inline content; move CSS/JS to external files.', 'low')
      return fail(`${kb}KB HTML`, 'HTML is heavy. Move inline CSS/JS to external files, remove hidden modals, lazy-load below-fold sections.', 'medium')
    }
  },
  {
    id: 'render-blocking',
    label: 'Render-Blocking Scripts',
    category: 'performance',
    weight: 5,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      const b = features.scripts.blocking
      if (b <= 2) return pass(`${b} blocking script(s)`, 'Script loading is efficient.')
      if (b <= 5) return warn(`${b} blocking script(s)`, 'Add async or defer to non-critical external scripts.', 'low')
      return fail(`${b} blocking scripts`, `${b} external scripts have no async/defer attribute. Defer them to unblock first paint.`, 'medium')
    }
  },
  {
    id: 'image-formats',
    label: 'Modern Image Formats',
    category: 'performance',
    weight: 3,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (features.images.contentImages === 0) return pass('No content images', 'Not applicable.')
      if (features.images.contentImages < 5) return pass(`Only ${features.images.contentImages} images on page`, 'Image format optimisation is a low priority here.')
      if (features.images.hasModernFormats) return pass('WebP/AVIF detected', 'Modern image formats are in use.')
      return warn('No WebP / AVIF detected', 'Convert JPG/PNG images to WebP. Typical 25-35% file-size reduction at equivalent visual quality.', 'low')
    }
  },
  {
    id: 'lazy-loading',
    label: 'Image Lazy Loading',
    category: 'performance',
    weight: 3,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      const total = features.images.contentImages
      if (total <= 5) return pass('Too few images to require lazy loading', 'Not applicable.')
      const lazyRatio = total > 0 ? features.images.lazyLoaded / total : 0
      if (lazyRatio >= 0.5) return pass(`${features.images.lazyLoaded} of ${total} lazy-loaded`, 'Image loading strategy is good.')
      if (lazyRatio > 0) return warn(`${features.images.lazyLoaded} of ${total} lazy-loaded`, 'Add loading="lazy" to below-fold images.', 'low')
      return warn(`${total} images load eagerly`, 'Add loading="lazy" to <img> elements below the fold. Hero images should keep loading="eager" for LCP.', 'low')
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // SEO — Universal core
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'title-tag',
    label: 'Title Tag',
    category: 'seo',
    weight: 14,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (!features.title) {
        return fail(
          'Missing element: <title> tag not found inside document <head>.',
          'Add a <title> with the primary keyword + brand. 40-60 characters is ideal.',
          'critical'
        )
      }
      const len = features.titleLength
      const txt = features.title
      const snippet = `<title>${txt}</title>`
      if (len < 10) {
        return warn(
          `Detected value: "${txt}" (${len} chars) is too short. Snippet: "${snippet}". Location: <head>`,
          'Expand the title to 40-60 chars. Lead with the primary keyword.',
          'medium'
        )
      }
      if (len > 70) {
        return warn(
          `Detected value: "${txt}" (${len} chars) is too long (truncates in SERP). Snippet: "${snippet}". Location: <head>`,
          'Trim to 40-60 characters.',
          'low'
        )
      }
      return pass(`Detected: "${txt}" (${len} chars). Snippet: "${snippet}". Location: <head>`, 'Title length is optimal.')
    }
  },
  {
    id: 'meta-description',
    label: 'Meta Description',
    category: 'seo',
    weight: 9,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (!features.metaDescription) {
        return fail(
          'Missing tag: <meta name="description"> not found inside document <head>.',
          'Add a meta description (120-160 chars) that summarises the page and ends with a soft CTA.',
          'high'
        )
      }
      const len = features.metaDescriptionLength
      const desc = features.metaDescription
      const snippet = `<meta name="description" content="${desc.length > 60 ? desc.slice(0, 57) + '...' : desc}">`
      if (len < 50) {
        return warn(
          `Detected value: "${desc.length > 50 ? desc.slice(0, 47) + '...' : desc}" (${len} chars) is too short. Snippet: "${snippet}". Location: <head>`,
          'Expand to 120-160 chars to use the full SERP width.',
          'low'
        )
      }
      if (len > 170) {
        return warn(
          `Detected value: "${desc.length > 50 ? desc.slice(0, 47) + '...' : desc}" (${len} chars) is too long (truncates in SERP). Snippet: "${snippet}". Location: <head>`,
          'Trim to 150-160 chars.',
          'low'
        )
      }
      return pass(`Detected: "${desc.length > 50 ? desc.slice(0, 47) + '...' : desc}" (${len} chars). Snippet: "${snippet}". Location: <head>`, 'Meta description length is optimal.')
    }
  },
  {
    id: 'h1-tag',
    label: 'H1 Heading',
    category: 'seo',
    weight: 11,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      const count = features.headings.h1Count
      if (count === 0) {
        return fail(
          'Missing element: <h1> heading tag not found inside document <body>.',
          'Add exactly one H1 containing your primary keyword. It signals page topic to crawlers and screen readers.',
          'high'
        )
      }
      if (count > 1) {
        return warn(
          `Detected value: Multiple (${count}) <h1> tags found. Snippets: ${features.headings.h1.map(h => `<h1>${h}</h1>`).join(', ')}. Location: <body>`,
          'Use one H1 per page. Demote secondary H1s to H2.',
          'low'
        )
      }
      const txt = features.headings.h1[0] || ''
      const snippet = `<h1>${txt}</h1>`
      return pass(`Detected: 1 <h1> tag: "${txt}". Snippet: "${snippet}". Location: <body>`, 'H1 structure is correct.')
    }
  },
  {
    id: 'heading-hierarchy',
    label: 'Heading Hierarchy',
    category: 'seo',
    weight: 3,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      const issues = features.headings.headingOrderIssues
      if (issues === 0) {
        return pass('Detected: Continuous heading hierarchy (H1 -> H2 -> H3 order) with no skipped levels.', 'Heading hierarchy is clean.')
      }
      return warn(
        `Detected value: ${issues} skipped level(s) in heading order (e.g. H1 to H3 without H2). Location: <body>`,
        'Avoid skipping heading levels (e.g. H1 → H3). Keep the hierarchy continuous for accessibility.',
        'low'
      )
    }
  },
  {
    id: 'noindex',
    label: 'Meta Robots',
    category: 'seo',
    weight: 25,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (features.metaRobotsBlocksIndex) {
        return fail(
          `Detected value: noindex directive present. Snippet: "<meta name="robots" content="${features.metaRobots}">". Location: <head>`,
          'Remove "noindex" unless you intentionally want this page excluded from Google.',
          'critical'
        )
      }
      const robotsVal = features.metaRobots || 'index, follow (default)'
      const snippet = features.metaRobots ? `<meta name="robots" content="${features.metaRobots}">` : 'None (Default indexable)'
      return pass(`Detected: "${robotsVal}". Snippet: "${snippet}". Location: <head>`, 'Page is indexable.')
    }
  },
  {
    id: 'html-lang',
    label: 'HTML Language Attribute',
    category: 'seo',
    weight: 2,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (features.hasLang) {
        return pass(`Detected: lang="${features.htmlLang}". Snippet: "<html lang="${features.htmlLang}">". Location: html`, 'Lang attribute is set.')
      }
      return warn(
        'Missing attribute: lang attribute is missing from the main <html> tag.',
        'Add lang="en" (or your locale) to <html>. Helps search engines and screen readers.',
        'low'
      )
    }
  },
  {
    id: 'canonical',
    label: 'Canonical Tag',
    category: 'seo',
    weight: 4,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (features.canonicalUrl) {
        const snippet = `<link rel="canonical" href="${features.canonicalUrl}">`
        return pass(`Detected: "${features.canonicalUrl}". Snippet: "${snippet}". Location: <head>`, 'Canonical URL is set.')
      }
      return warn(
        'Missing tag: <link rel="canonical"> not found inside document <head>.',
        'Add <link rel="canonical" href="..."> to prevent duplicate-content issues across URL variants.',
        'low'
      )
    }
  },
  {
    id: 'image-alt-text',
    label: 'Image Alt Text',
    category: 'seo',
    weight: 5,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      const total = features.images.contentImages
      const missing = features.images.missingAlt
      if (total === 0) return pass('Detected: 0 content images found on page.', 'Not applicable.')
      if (missing === 0) return pass(`Detected: All ${total} content images have Alt text set.`, 'Image accessibility is good.')
      const ratio = missing / total
      const samples = features.images.missingAltUrls.slice(0, 3).map(src => `"${src}"`).join(', ')
      const msg = `Detected value: ${missing} of ${total} content images missing alt text (${Math.round(ratio * 100)}%). Missing elements: <img> tags without alt attribute. Sample sources: ${samples}`
      if (ratio >= 0.5) {
        return fail(msg, 'Add descriptive alt attributes. Helps image SEO and WCAG accessibility.', 'medium')
      }
      return warn(msg, 'Add alt text to the remaining images.', 'low')
    }
  },
  {
    id: 'crawlable-content',
    label: 'Crawlable Content',
    category: 'seo',
    weight: 10,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (features.wordCount === 0 && features.htmlSizeKb > 0) {
        return fail(
          `Detected value: 0 visible words to non-JS crawler (HTML size: ${features.htmlSizeKb}KB). This indicates a client-side JavaScript rendering dependency.`,
          'The page renders entirely with JavaScript. Add server-side rendering (Next.js, Nuxt) or pre-render the page as static HTML so Google can index it without running JavaScript.',
          'high'
        )
      }
      if (features.wordCount === 0) {
        return warn('Detected value: 0 visible words on page. Page is empty.', 'Add meaningful content.', 'medium')
      }
      if (features.wordCount < 150) {
        return warn(
          `Detected value: Only ${features.wordCount} visible words on page.`,
          'Pages under 300 words rarely rank competitively. Expand with FAQs, customer use-cases, and detailed feature descriptions.',
          'low'
        )
      }
      return pass(`Detected: ${features.wordCount} visible words on page.`, 'Content length is sufficient.')
    }
  },
  {
    id: 'robots-txt',
    label: 'Robots.txt',
    category: 'seo',
    weight: 3,
    applicability: { appliesTo: '*', optionalFor: ['personal_portfolio'] },
    evaluator: (crawl) => {
      if (crawl.robotsTxtValid) {
        return pass('Detected: Valid robots.txt file retrieved successfully from root.', 'Robots.txt is in place.')
      }
      return warn(
        'Missing/Invalid file: robots.txt could not be found or fetched at domain root.',
        'Add /robots.txt with at minimum a Sitemap: directive.',
        'low'
      )
    }
  },
  {
    id: 'xml-sitemap',
    label: 'XML Sitemap',
    category: 'seo',
    weight: 6,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      if (crawl.sitemapXmlValid) {
        return pass('Detected: Valid sitemap.xml file retrieved successfully from root.', 'Sitemap is published.')
      }
      return warn(
        'Missing/Invalid file: sitemap.xml could not be found or fetched at domain root.',
        'Generate /sitemap.xml and submit it in Google Search Console.',
        'medium'
      )
    }
  },
  {
    id: 'open-graph',
    label: 'Open Graph Tags',
    category: 'seo',
    weight: 4,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      const pct = Math.round(features.openGraphCompleteness * 100)
      const ogRequired = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']
      const missing = ogRequired.filter(k => !features.openGraph[k]).join(', ')
      if (features.openGraphCompleteness >= 0.8) {
        return pass(`Detected: OG tags are ${pct}% complete. Location: <head>`, 'Open Graph tags are well-configured.')
      }
      const msg = `Detected value: Open Graph tags are only ${pct}% complete. Missing tags: ${missing}. Location: <head>`
      if (features.openGraphCompleteness >= 0.4) {
        return warn(msg, 'Add the missing og:title / og:description / og:image / og:url / og:type tags.', 'low')
      }
      return fail(msg, 'Add Open Graph tags. Controls how the page previews on social media and chat clients.', 'medium')
    }
  },
  {
    id: 'structured-data',
    label: 'Structured Data',
    category: 'seo',
    weight: 6,
    applicability: { appliesTo: '*' },
    // Critical for local biz (LocalBusiness schema), e-commerce (Product), info (Article)
    evaluator: (_, features) => {
      if (features.structuredData.types.length > 0) {
        const typesStr = features.structuredData.types.slice(0, 4).join(', ')
        return pass(`Detected: ${features.structuredData.items} structured schema type(s) (${typesStr}).`, 'Structured data is present.')
      }
      return warn(
        'Missing element: No JSON-LD, Microdata, or RDFa structured data tags detected on the website.',
        'Add JSON-LD schema. Enables rich SERP results (star ratings, FAQ accordions, business hours, breadcrumbs).',
        'medium'
      )
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // SECURITY — Universal
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'https',
    label: 'HTTPS / SSL',
    category: 'security',
    weight: 30,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      if (crawl.sslValid) {
        const label = crawl.upgradedToHttps ? 'Valid TLS (HTTP → HTTPS redirect)' : 'Valid TLS'
        return pass(label, 'TLS is configured correctly.')
      }
      return fail(crawl.sslError || 'No valid SSL', 'Install a free Let\'s Encrypt certificate. Force HTTPS with a 301 redirect.', 'critical')
    }
  },
  {
    id: 'security-headers',
    label: 'Security Headers',
    category: 'security',
    weight: 10,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      const required = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy']
      const present = required.filter(h => crawl.headers[h])
      const missing = required.filter(h => !crawl.headers[h])
      if (missing.length === 0) return pass(`All 5 present (${present.join(', ')})`, 'All recommended security headers are present.')
      if (missing.length <= 2) return warn(`${present.length} of 5 present — missing: ${missing.join(', ')}`, `Add the missing headers: ${missing.join(', ')}.`, 'medium')
      return fail(`Only ${present.length} of 5 present — missing: ${missing.join(', ')}`, `Add the missing headers: ${missing.join(', ')}. Prevents clickjacking, MIME-sniffing, XSS, and downgrade attacks.`, 'medium')
    }
  },
  {
    id: 'admin-exposure',
    label: 'Exposed Admin Paths',
    category: 'security',
    weight: 9,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      const exposed = crawl.adminProbes.filter(p => p.exposed)
      if (exposed.length === 0) return pass(`Probed ${crawl.adminProbes.length} paths — none exposed`, 'No common admin paths exposed.')
      return fail(`Exposed: ${exposed.map(p => p.path).join(', ')}`, 'Restrict admin paths by IP allowlist, move them to non-default URLs, or block at the WAF level.', 'critical')
    }
  },
  {
    id: 'mixed-content',
    label: 'Mixed Content',
    category: 'security',
    weight: 5,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (features.security.mixedContent === 0) return pass('None detected', 'No mixed content issues.')
      return fail(`${features.security.mixedContent} HTTP resource(s) on HTTPS page`, 'Replace http:// asset URLs with https://. Browsers block insecure resources on secure pages.', 'medium')
    }
  },
  {
    id: 'server-fingerprint',
    label: 'Server Fingerprint',
    category: 'security',
    weight: 2,
    applicability: { appliesTo: '*' },
    evaluator: (crawl) => {
      if (!crawl.headers['x-powered-by']) return pass('Hidden', 'Server fingerprint is hidden.')
      return warn(`Exposes: ${crawl.headers['x-powered-by']}`, 'Hide the X-Powered-By header. Reveals server version which aids reconnaissance.', 'low')
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // CONVERSION — Type-aware
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'mobile-viewport',
    label: 'Mobile Responsive',
    category: 'conversion',
    weight: 12,
    applicability: { appliesTo: '*' },
    evaluator: (_, features) => {
      if (features.hasViewport) return pass(`viewport meta set: ${features.metaViewport}`, 'Viewport is configured.')
      return fail('No viewport meta tag', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">. Without it, mobile rendering is broken.', 'critical')
    }
  },
  {
    id: 'cta-visibility',
    label: 'Calls-to-Action',
    category: 'conversion',
    weight: 10,
    applicability: {
      appliesTo: ['local_business', 'ecommerce', 'saas_product', 'agency_services', 'educational', 'nonprofit'],
      criticalFor: ['ecommerce', 'saas_product', 'agency_services'],
      excludedFor: ['informational', 'community', 'personal_portfolio']
    },
    evaluator: (_, features) => {
      const c = features.conversion.ctaCount
      if (c === 0) return fail('No actionable CTAs detected', 'Add high-contrast CTA buttons ("Get a Quote", "Book a Demo", "Add to Cart") above the fold, repeated through the page.', 'critical')
      if (c < 3) return warn(`Only ${c} CTA${c === 1 ? '' : 's'}`, 'Add at least one CTA above the fold, one mid-page, and one near the bottom of the page.', 'medium')
      return pass(`${c} CTAs (${features.conversion.ctaTexts.slice(0, 3).join(', ')})`, 'CTA coverage is healthy.')
    }
  },
  {
    id: 'contact-mechanism',
    label: 'Contact Mechanism',
    category: 'conversion',
    weight: 12,
    applicability: { appliesTo: '*', criticalFor: ['local_business', 'agency_services', 'saas_product'] },
    evaluator: (_, features, profile) => {
      // A "contact mechanism" can be: contact form, phone number, email,
      // WhatsApp, booking widget, or live chat. What COUNTS as sufficient
      // depends on the site type.
      const hasForm = features.conversion.hasContactForm
      const hasBooking = features.conversion.hasBookingSystem
      const hasPhone = features.conversion.hasPhoneNumber
      const hasEmail = features.conversion.hasEmailAddress
      const hasWa = features.conversion.hasWhatsApp
      const hasChat = features.liveChat.detected

      const channels: string[] = []
      if (hasForm) channels.push(`contact form${features.conversion.qualifiedFormCount > 1 ? ` (${features.conversion.qualifiedFormCount})` : ''}`)
      if (hasBooking) channels.push(`${features.conversion.bookingProvider || 'booking widget'}`)
      if (hasWa) channels.push('WhatsApp')
      if (hasPhone) channels.push(`phone${features.conversion.phoneNumber ? ` (${features.conversion.phoneNumber})` : ''}`)
      if (hasEmail) channels.push('email')
      if (hasChat) channels.push(`live chat (${features.liveChat.providers[0] || 'detected'})`)

      // Severity by site type — primary conversion path differs:
      //   - local_business / agency_services / saas_product: contact channel IS the conversion → critical
      //   - ecommerce: cart/checkout is the conversion, contact is secondary → medium
      //   - nonprofit: donate is the conversion → medium
      //   - informational / personal_portfolio / community: contact is optional → low
      //   - corporate / educational: medium
      const t = profile.type
      let severityIfFailing: Severity = 'medium'
      if (t === 'local_business' || t === 'agency_services' || t === 'saas_product') severityIfFailing = 'critical'
      else if (t === 'corporate' || t === 'educational') severityIfFailing = 'medium'
      else if (t === 'informational' || t === 'personal_portfolio' || t === 'community') severityIfFailing = 'low'

      // What counts as "enough" depends on site type:
      //   - portfolio: a visible mailto: link alone is enough
      //   - informational: email OR live chat OR newsletter signup is enough
      //   - everyone else: needs at least one bidirectional channel (form/booking/phone/WhatsApp/chat)
      const portfolioAcceptable = (t === 'personal_portfolio' || t === 'community') && hasEmail
      const informationalAcceptable = t === 'informational' && (hasEmail || hasChat || features.conversion.hasNewsletterSignup)
      const standardAcceptable = hasForm || hasBooking || hasPhone || hasWa || hasChat

      if (channels.length === 0) {
        return fail('No contact channel detected', 'Add at least one way for visitors to reach you: contact form, visible phone number, mailto link, or live chat.', severityIfFailing)
      }

      if (portfolioAcceptable || informationalAcceptable || standardAcceptable) {
        return pass(channels.join(', '), 'Contact channel is in place.')
      }

      // Email-only on non-portfolio sites — flag but at low/medium severity
      return warn(`Only: ${channels[0]}`, 'Add a second contact channel — a form for general enquiries and an instant channel (live chat OR phone OR WhatsApp) for warm visitors.', severityIfFailing === 'critical' ? 'medium' : 'low')
    }
  },
  {
    id: 'lead-capture-form',
    label: 'Lead Capture Form',
    category: 'conversion',
    weight: 9,
    applicability: {
      appliesTo: ['local_business', 'saas_product', 'agency_services', 'educational'],
      criticalFor: ['agency_services', 'saas_product'],
      excludedFor: ['ecommerce', 'informational', 'community', 'personal_portfolio', 'corporate', 'nonprofit']
    },
    evaluator: (_, features) => {
      if (features.conversion.hasContactForm) {
        return pass(`${features.conversion.qualifiedFormCount} lead-capture form(s)`, 'Lead form is in place.')
      }
      if (features.conversion.hasBookingSystem) {
        return pass(`Booking widget (${features.conversion.bookingProvider}) acts as lead capture`, 'Booking widget captures leads.')
      }
      if (features.conversion.formCount > 0) {
        // Has forms but none qualify (search/login only)
        const issues: string[] = []
        if (features.conversion.hasSearchForm) issues.push('search')
        if (features.conversion.hasLoginForm) issues.push('login')
        return fail(`${features.conversion.formCount} form(s), none qualify as lead capture${issues.length ? ` (${issues.join(' + ')} only)` : ''}`, 'Add a real lead form with at least name + email + message fields and a clear submit button.', 'high')
      }
      return fail('No lead-capture form found', 'Add a 3-field contact form (name, email, message) on the homepage and on a dedicated /contact page.', 'high')
    }
  },
  {
    id: 'booking-system',
    label: 'Booking / Scheduling',
    category: 'conversion',
    weight: 8,
    applicability: {
      appliesTo: ['local_business', 'agency_services', 'educational', 'saas_product'],
      criticalFor: ['local_business'],
      optionalFor: ['saas_product'],
      excludedFor: ['ecommerce', 'informational', 'community', 'personal_portfolio', 'corporate', 'nonprofit']
    },
    evaluator: (_, features) => {
      if (features.conversion.hasBookingSystem) {
        return pass(`${features.conversion.bookingProvider || 'Booking widget'} detected`, 'Booking system is integrated.')
      }
      return warn('Not detected', 'Embed a self-service booking widget (Calendly, Cal.com, HubSpot Meetings). Increases meeting bookings 20-40% vs email coordination.', 'medium')
    }
  },
  {
    id: 'phone-visible',
    label: 'Phone Number Visible',
    category: 'conversion',
    weight: 7,
    applicability: {
      appliesTo: ['local_business', 'agency_services', 'corporate'],
      criticalFor: ['local_business'],
      excludedFor: ['ecommerce', 'saas_product', 'informational', 'community', 'personal_portfolio', 'nonprofit', 'educational']
    },
    evaluator: (_, features) => {
      if (features.conversion.hasPhoneNumber) return pass(`Visible${features.conversion.phoneNumber ? `: ${features.conversion.phoneNumber}` : ''}`, 'Phone number is visible.')
      return fail('Not visible', 'Add a click-to-call phone number in the header and footer. Use <a href="tel:..."> on mobile.', 'high')
    }
  },
  {
    id: 'physical-address',
    label: 'Physical Address',
    category: 'conversion',
    weight: 6,
    applicability: {
      appliesTo: ['local_business', 'corporate'],
      criticalFor: ['local_business'],
      excludedFor: ['saas_product', 'ecommerce', 'informational', 'community', 'personal_portfolio', 'agency_services', 'nonprofit', 'educational']
    },
    evaluator: (_, features) => {
      if (features.conversion.hasAddress) return pass('Address visible on page', 'Physical address is shown.')
      return fail('No address detected', 'Display your full street address. Helps with local SEO and visitor trust. Add it in the footer at minimum.', 'high')
    }
  },
  {
    id: 'whatsapp-button',
    label: 'WhatsApp Contact',
    category: 'conversion',
    weight: 4,
    applicability: {
      appliesTo: ['local_business', 'ecommerce'],
      optionalFor: ['ecommerce'],
      excludedFor: ['saas_product', 'informational', 'community', 'personal_portfolio', 'corporate', 'agency_services', 'educational', 'nonprofit']
    },
    evaluator: (_, features) => {
      if (features.conversion.hasWhatsApp) return pass(`WhatsApp${features.conversion.whatsAppNumber ? `: ${features.conversion.whatsAppNumber}` : ''}`, 'WhatsApp contact is in place.')
      return warn('Not detected', 'Add a click-to-WhatsApp button (wa.me/your-number). For audiences in regions where WhatsApp dominates messaging, it converts higher than email forms.', 'low')
    }
  },
  {
    id: 'testimonials',
    label: 'Testimonials / Social Proof',
    category: 'conversion',
    weight: 7,
    applicability: {
      appliesTo: ['local_business', 'ecommerce', 'saas_product', 'agency_services', 'educational'],
      criticalFor: ['saas_product', 'agency_services'],
      excludedFor: ['informational', 'community', 'personal_portfolio', 'corporate', 'nonprofit']
    },
    evaluator: (_, features) => {
      if (features.conversion.testimonialsCount >= 3) return pass(`${features.conversion.testimonialsCount} testimonials detected`, 'Strong social proof.')
      if (features.conversion.testimonialsCount > 0) return warn(`Only ${features.conversion.testimonialsCount} testimonial(s)`, 'Add 3-5 testimonials with photos, names, and company affiliations.', 'medium')
      return fail('No testimonials detected', 'Add 3-5 customer testimonials with photos and full attribution. Social proof typically lifts conversion 15-25%.', 'high')
    }
  },
  {
    id: 'trust-signals',
    label: 'Trust Signals',
    category: 'conversion',
    weight: 6,
    applicability: { appliesTo: '*', criticalFor: ['ecommerce'] },
    evaluator: (_, features) => {
      // Count trust signals: privacy policy, terms, certifications, social links, address
      let n = 0
      const found: string[] = []
      if (features.trust.hasPrivacyPolicy) { n++; found.push('privacy policy') }
      if (features.trust.hasTermsOfService) { n++; found.push('terms') }
      if (features.trust.hasCertificationBadges) { n++; found.push('certifications') }
      if (features.trust.hasSocialLinks) { n++; found.push(`social (${features.trust.socialPlatforms.slice(0, 3).join('/')})`) }
      if (features.conversion.hasAddress) { n++; found.push('address') }
      if (features.trust.hasAwardMentions) { n++; found.push('awards') }

      if (n >= 4) return pass(`${n} signals: ${found.join(', ')}`, 'Trust signals are strong.')
      if (n >= 2) return warn(`${n} signals: ${found.join(', ')}`, 'Add the missing items (privacy policy, terms, certifications, social links, address, awards).', 'low')
      return fail(`Only ${n} trust signal${n === 1 ? '' : 's'}${found.length ? ` (${found.join(', ')})` : ''}`, 'Add at least a privacy policy and social links. They reduce purchase hesitation.', 'medium')
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // E-COMMERCE specific
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'product-schema',
    label: 'Product Schema',
    category: 'seo',
    weight: 10,
    applicability: { appliesTo: ['ecommerce'], criticalFor: ['ecommerce'], excludedFor: ['local_business', 'saas_product', 'informational', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (_, features) => {
      const hasProduct = features.structuredData.types.some(t => /^Product$/i.test(t))
      if (hasProduct) return pass('Product schema detected', 'Product schema is in place.')
      return fail('No Product schema markup', 'Add JSON-LD Product schema with name, image, price, currency, availability, and aggregateRating. Required for rich results in Google Shopping and SERP.', 'high')
    }
  },
  {
    id: 'cart-checkout-flow',
    label: 'Cart & Checkout Flow',
    category: 'conversion',
    weight: 12,
    applicability: { appliesTo: ['ecommerce'], criticalFor: ['ecommerce'] },
    evaluator: (crawl) => {
      const lower = (crawl.html || '').toLowerCase()
      const hasCart = /add\s*to\s*cart|add\s*to\s*bag|add\s*to\s*basket/i.test(lower)
      const hasCheckout = /checkout|proceed\s*to\s*payment|secure\s*checkout/i.test(lower)
      if (hasCart && hasCheckout) return pass('Cart + checkout patterns present', 'Purchase flow is in place.')
      if (hasCart) return warn('Cart present, checkout not detected', 'Make sure the checkout CTA is visible and consistent across product pages.', 'medium')
      return fail('No cart / checkout pattern detected', 'Add visible "Add to Cart" buttons on every product page and a persistent cart icon in the header.', 'high')
    }
  },
  {
    id: 'payment-trust',
    label: 'Payment Trust Badges',
    category: 'conversion',
    weight: 5,
    applicability: { appliesTo: ['ecommerce'], excludedFor: ['local_business', 'saas_product', 'informational', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (crawl) => {
      const lower = (crawl.html || '').toLowerCase()
      const hasPaymentBadge = /visa|mastercard|paypal|stripe|razorpay|payu|amex|amazon\s*pay|google\s*pay|apple\s*pay|secure\s*checkout|ssl\s*secured/i.test(lower)
      if (hasPaymentBadge) return pass('Payment trust badges detected', 'Payment trust elements are visible.')
      return warn('No payment trust elements detected', 'Display payment-provider badges (Visa, Mastercard, PayPal, etc.) and an "SSL secured" badge near checkout to reduce cart abandonment.', 'low')
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // LOCAL BUSINESS specific
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'local-business-schema',
    label: 'LocalBusiness Schema',
    category: 'seo',
    weight: 10,
    applicability: { appliesTo: ['local_business'], criticalFor: ['local_business'], excludedFor: ['ecommerce', 'saas_product', 'informational', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (_, features) => {
      const hasLocal = features.structuredData.types.some(t => /localbusiness|restaurant|dentist|hairsalon|physician|lawfirm|medicalbusiness|automotivebusiness|professionalservice|homeandconstructionbusiness/i.test(t))
      if (hasLocal) return pass(`Detected: ${features.structuredData.types.find(t => /localbusiness|restaurant|dentist|hairsalon/i.test(t)) || 'LocalBusiness'}`, 'LocalBusiness schema is in place.')
      return fail('No LocalBusiness schema', 'Add JSON-LD LocalBusiness schema with name, address, phone, geo coordinates, openingHours, and aggregateRating. This drives Google Maps and Knowledge Panel results.', 'high')
    }
  },
  {
    id: 'hours-of-operation',
    label: 'Business Hours',
    category: 'conversion',
    weight: 5,
    applicability: { appliesTo: ['local_business'], excludedFor: ['ecommerce', 'saas_product', 'informational', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (crawl) => {
      const lower = (crawl.html || '').toLowerCase().slice(0, 30000)
      const hasHours = /(monday|mon[a-z]*\s*[-:to]|hours\s*of\s*operation|opening\s*hours|business\s*hours|open\s*(?:from|until|today))/i.test(lower)
      if (hasHours) return pass('Hours of operation visible', 'Operating hours are shown.')
      return warn('No business hours detected', 'Display your hours of operation visibly. Critical for "is this place open right now" intent searches.', 'medium')
    }
  },
  {
    id: 'map-embed',
    label: 'Map / Location',
    category: 'conversion',
    weight: 4,
    applicability: { appliesTo: ['local_business'], excludedFor: ['ecommerce', 'saas_product', 'informational', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (crawl) => {
      const lower = (crawl.html || '').toLowerCase()
      const hasMap = /google\.com\/maps|maps\.google|openstreetmap|leaflet|mapbox|<iframe[^>]+maps?\./i.test(lower)
      if (hasMap) return pass('Map embed detected', 'Location map is shown.')
      return warn('No map embed', 'Embed a Google Maps iframe pointing to your location. Helps walk-in customers and improves local SEO.', 'low')
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // SAAS / AGENCY specific
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'pricing-page',
    label: 'Pricing Visible',
    category: 'conversion',
    weight: 8,
    applicability: { appliesTo: ['saas_product', 'agency_services', 'educational'], optionalFor: ['agency_services'], excludedFor: ['local_business', 'ecommerce', 'informational', 'personal_portfolio', 'community', 'corporate', 'nonprofit'] },
    evaluator: (crawl) => {
      const lower = (crawl.html || '').toLowerCase()
      const hasPricing = /pricing|per\s*month|\/mo\b|per\s*user|monthly|annually|billed\s*annually|starts?\s*at\s*[\$£€₹]|free\s*plan|free\s*tier/i.test(lower) ||
                         /href=["'][^"']*\/?(?:pricing|plans|cost)/i.test(lower)
      if (hasPricing) return pass('Pricing or plans visible', 'Pricing is shown.')
      return warn('No pricing or plans page detected', 'Make pricing visible (or at least a "Talk to Sales" CTA for enterprise pricing). Hiding pricing increases bounce.', 'medium')
    }
  },
  {
    id: 'demo-or-trial-cta',
    label: 'Demo / Trial CTA',
    category: 'conversion',
    weight: 8,
    applicability: { appliesTo: ['saas_product'], criticalFor: ['saas_product'], excludedFor: ['local_business', 'ecommerce', 'informational', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (crawl, features) => {
      const lower = (crawl.html || '').toLowerCase()
      const hasExplicit = /start\s*free\s*trial|try\s*for\s*free|free\s*forever|sign\s*up\s*free|book\s*a\s*demo|request\s*a\s*demo|watch\s*demo|see\s*it\s*in\s*action|try\s*it\s*free/i.test(lower)
      // Modern self-serve signup pattern — "Sign up", "Get started", "Start now" with no friction
      // (these CTAs exist alongside a free tier and effectively are a trial entry)
      const ctaTexts = (features.conversion.ctaTexts || []).map(t => t.toLowerCase().trim())
      const hasSelfServe = ctaTexts.some(t =>
        /^(?:sign|get)\s*up(?:\s*for\s*\w+)?$/.test(t) ||
        /^get\s*started(?:\s*for\s*free)?$/.test(t) ||
        /^start\s*(?:now|free|building)$/.test(t) ||
        /^create\s*(?:a\s*)?(?:free\s*)?account$/.test(t)
      )
      const hasSignupForm = features.conversion.hasLoginForm   // Login implies signup exists
      if (hasExplicit) return pass('Trial / demo CTA detected', 'Trial or demo entry-point is in place.')
      if (hasSelfServe) return pass(`Self-serve signup detected (${ctaTexts.find(t => /sign|get\s*started|start/.test(t)) || 'CTA'})`, 'Self-serve signup is in place.')
      if (hasSignupForm) return warn('Login form present but no explicit signup CTA above the fold', 'Promote the signup path more visibly. "Start Free" or "Sign up" should be the primary CTA in the hero.', 'medium')
      return fail('No trial or demo CTA', 'Add either "Start Free Trial" or "Book a Demo" as the primary above-the-fold CTA. SaaS sites without these convert near-zero on cold traffic.', 'high')
    }
  },
  {
    id: 'case-studies',
    label: 'Case Studies / Portfolio',
    category: 'conversion',
    weight: 5,
    applicability: { appliesTo: ['agency_services'], criticalFor: ['agency_services'], excludedFor: ['local_business', 'ecommerce', 'saas_product', 'informational', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (crawl) => {
      const lower = (crawl.html || '').toLowerCase()
      const hasWork = /case\s*stud(?:y|ies)|selected\s*work|recent\s*projects|portfolio|our\s*work\b|client\s*stories|featured\s*work/i.test(lower)
      if (hasWork) return pass('Case study / portfolio section detected', 'Portfolio coverage is present.')
      return fail('No portfolio / case studies visible', 'Show real client work. Agencies without visible work appear unproven.', 'high')
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // NONPROFIT specific
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'donate-cta',
    label: 'Donate CTA',
    category: 'conversion',
    weight: 14,
    applicability: { appliesTo: ['nonprofit'], criticalFor: ['nonprofit'], excludedFor: ['local_business', 'ecommerce', 'saas_product', 'informational', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'educational'] },
    evaluator: (crawl) => {
      const lower = (crawl.html || '').toLowerCase()
      const hasDonate = /\b(?:donate(?:\s*now)?|make\s*a\s*donation|give\s*today|support\s*our\s*(?:mission|cause))\b/i.test(lower)
      if (hasDonate) return pass('Donate CTA detected', 'Donation pathway is in place.')
      return fail('No donate CTA', 'Add a prominent "Donate Now" button in the header and at multiple points on the homepage. This is the primary conversion for nonprofits.', 'critical')
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // INFORMATIONAL specific
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'article-schema',
    label: 'Article Schema',
    category: 'seo',
    weight: 7,
    applicability: { appliesTo: ['informational'], criticalFor: ['informational'], excludedFor: ['local_business', 'ecommerce', 'saas_product', 'agency_services', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational'] },
    evaluator: (_, features) => {
      const hasArticle = features.structuredData.types.some(t => /^Article$|^NewsArticle$|^BlogPosting$|^TechArticle$/i.test(t))
      if (hasArticle) {
        const detectedType = features.structuredData.types.find(t => /Article|Posting/i.test(t))
        return pass(`Detected: ${detectedType} schema present on informational page.`, 'Article schema is in place.')
      }
      return warn(
        'Missing element: No JSON-LD Article, NewsArticle, or BlogPosting schema found on this informational page.',
        'Add JSON-LD Article / NewsArticle / BlogPosting schema. Drives Google Discover and rich results.',
        'medium'
      )
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // MARKETING — Type-aware (the BIG fix vs original engine)
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'web-analytics',
    label: 'Web Analytics',
    category: 'marketing',
    weight: 12,
    // Analytics matters for everyone except pure personal sites
    applicability: {
      appliesTo: ['local_business', 'ecommerce', 'saas_product', 'agency_services', 'educational', 'corporate', 'nonprofit', 'informational'],
      optionalFor: ['nonprofit', 'informational', 'personal_portfolio'],
      excludedFor: ['personal_portfolio', 'community']
    },
    evaluator: (_, features) => {
      if (features.trackers.googleAnalytics) {
        const gaId = features.trackers.googleAnalyticsId ? ` (${features.trackers.googleAnalyticsId})` : ''
        return pass(`Detected: Google Analytics${gaId} installed on page.`, 'Analytics is installed.')
      }
      if (features.trackers.googleTagManager) {
        const gtmId = features.trackers.googleTagManagerId ? ` (${features.trackers.googleTagManagerId})` : ''
        return pass(`Detected: Google Tag Manager${gtmId} container. Google Analytics may load dynamically via GTM.`, 'Web analytics configured via GTM container.')
      }
      if (features.trackers.mixpanel) {
        return pass('Detected: Mixpanel analytics script found.', 'Product analytics is in place.')
      }
      if (features.trackers.segment) {
        return pass('Detected: Segment analytics script found.', 'Customer data layer is in place.')
      }
      return fail(
        'Missing element: No Google Analytics (GA4), GTM, Mixpanel, or Segment analytics script detected in the HTML.',
        'Install Google Analytics 4 (free). Without analytics there is no visibility into traffic, sources, or conversion funnels.',
        'high'
      )
    }
  },
  {
    id: 'tag-manager',
    label: 'Tag Manager',
    category: 'marketing',
    weight: 4,
    applicability: { appliesTo: ['local_business', 'ecommerce', 'saas_product', 'agency_services', 'corporate'], optionalFor: ['local_business', 'corporate'], excludedFor: ['informational', 'personal_portfolio', 'community', 'nonprofit', 'educational'] },
    evaluator: (_, features) => {
      if (features.trackers.googleTagManager) return pass(`GTM${features.trackers.googleTagManagerId ? ` (${features.trackers.googleTagManagerId})` : ''}`, 'GTM is installed.')
      return warn('Not installed', 'Install Google Tag Manager. Centralises all marketing tags and lets non-developers update tracking.', 'low')
    }
  },
  {
    id: 'retargeting-pixel',
    label: 'Retargeting Pixel',
    category: 'marketing',
    weight: 10,
    // ONLY applies to sites that actually run paid ads — e-commerce + SaaS + agency.
    // Excluded for local biz (most don't run Meta ads), nonprofits, info sites, portfolios, community.
    applicability: {
      appliesTo: ['ecommerce', 'saas_product', 'agency_services'],
      criticalFor: ['ecommerce', 'saas_product'],
      excludedFor: ['local_business', 'informational', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational']
    },
    evaluator: (_, features) => {
      const pixels: string[] = []
      if (features.trackers.metaPixel) pixels.push('Meta Pixel')
      if (features.trackers.linkedinInsight) pixels.push('LinkedIn Insight')
      if (features.trackers.tiktokPixel) pixels.push('TikTok Pixel')
      if (pixels.length > 0) return pass(`Active: ${pixels.join(', ')}`, 'Retargeting infrastructure is in place.')
      return fail('No retargeting pixels detected', 'Install at least the Meta Pixel. Building a retargeting audience now is essential before any paid acquisition campaign.', 'high')
    }
  },
  {
    id: 'linkedin-tag',
    label: 'LinkedIn Insight Tag',
    category: 'marketing',
    weight: 4,
    // ONLY B2B-oriented sites
    applicability: {
      appliesTo: ['saas_product', 'agency_services', 'corporate'],
      optionalFor: ['corporate'],
      excludedFor: ['local_business', 'ecommerce', 'informational', 'personal_portfolio', 'community', 'nonprofit', 'educational']
    },
    evaluator: (_, features) => {
      if (features.trackers.linkedinInsight) return pass('Installed', 'LinkedIn Insight tag is installed.')
      return warn('Not installed', 'Add the LinkedIn Insight tag for B2B retargeting. Most precise professional targeting available.', 'low')
    }
  },
  {
    id: 'newsletter-capture',
    label: 'Newsletter Signup',
    category: 'marketing',
    weight: 5,
    applicability: {
      appliesTo: ['informational', 'ecommerce', 'saas_product', 'agency_services', 'educational', 'nonprofit'],
      optionalFor: ['saas_product', 'agency_services'],
      excludedFor: ['local_business', 'community', 'personal_portfolio', 'corporate']
    },
    evaluator: (_, features) => {
      if (features.conversion.hasNewsletterSignup) return pass('Newsletter signup detected', 'Email capture is in place.')
      return warn('Not detected', 'Add a dedicated newsletter signup (email-only form). Email is the highest-ROI marketing channel and you own the list.', 'low')
    }
  },
  {
    id: 'live-chat',
    label: 'Live Chat',
    category: 'marketing',
    weight: 4,
    applicability: {
      appliesTo: ['saas_product', 'ecommerce', 'agency_services'],
      optionalFor: ['agency_services'],
      excludedFor: ['local_business', 'informational', 'personal_portfolio', 'community', 'corporate', 'nonprofit', 'educational']
    },
    evaluator: (_, features) => {
      if (features.liveChat.detected) return pass(features.liveChat.providers.join(', '), 'Live chat is active.')
      return warn('Not detected', 'Install live chat (Intercom, Crisp free tier, or Tawk.to). Captures 10-15% of warm visitors with one unanswered question.', 'low')
    }
  },
  {
    id: 'social-presence',
    label: 'Social Media Presence',
    category: 'marketing',
    weight: 3,
    applicability: { appliesTo: '*', optionalFor: ['informational', 'community', 'corporate'] },
    evaluator: (_, features) => {
      if (features.trust.hasSocialLinks && features.trust.socialPlatforms.length >= 2) {
        return pass(`${features.trust.socialPlatforms.length} platforms: ${features.trust.socialPlatforms.slice(0, 4).join(', ')}`, 'Social presence is established.')
      }
      if (features.trust.hasSocialLinks) {
        return warn(`Only 1 platform: ${features.trust.socialPlatforms.join(', ')}`, 'Add links to at least 3 platforms (e.g. Instagram, Facebook, LinkedIn).', 'low')
      }
      return warn('No social media links', 'Link your active social profiles in the footer.', 'low')
    }
  },
  {
    id: 'cookie-consent',
    label: 'Cookie Consent Banner',
    category: 'marketing',
    weight: 2,
    applicability: { appliesTo: '*', optionalFor: ['personal_portfolio', 'community'] },
    evaluator: (_, features) => {
      if (features.cookieConsent.detected) return pass(`Detected: ${features.cookieConsent.provider}`, 'Cookie consent is configured.')
      // Not a hard fail — only required if site uses tracking + serves a privacy-regulated region
      return warn('Not detected', 'If targeting EU / UK / India audiences with tracking installed, add a cookie consent banner (OneTrust, Cookiebot, free open-source alternatives).', 'low')
    }
  }
]

/**
 * Run every applicable check for the given site profile.
 * Returns the result of each check alongside its effective weight.
 */
export function runAllChecks(
  crawl: CrawlResult,
  features: ExtractedFeatures,
  profile: SiteProfile
): Array<{ check: CheckDefinition; result: CheckResult; effectiveWeight: number }> {
  const out: Array<{ check: CheckDefinition; result: CheckResult; effectiveWeight: number }> = []
  for (const check of CHECKS) {
    const w = effectiveWeight(check, profile.type)
    if (w === 0) continue   // N/A for this site type — skip entirely
    let result: CheckResult
    try {
      result = check.evaluator(crawl, features, profile)
    } catch (err) {
      result = {
        passed: false, status: 'warning', severity: 'info',
        value: 'Check error', recommendation: 'Internal check failed — please report.'
      }
    }
    out.push({ check, result, effectiveWeight: w })
  }
  return out
}

import * as cheerio from 'cheerio'
import { URL } from 'url'

export interface ExtractedFeatures {
  // — META —
  title: string | null
  titleLength: number
  metaDescription: string | null
  metaDescriptionLength: number
  canonicalUrl: string | null
  metaRobots: string | null
  metaRobotsBlocksIndex: boolean
  metaCharset: string | null
  metaViewport: string | null
  hasViewport: boolean
  htmlLang: string | null
  hasLang: boolean
  hasFavicon: boolean
  openGraph: Record<string, string>
  openGraphCompleteness: number  // 0-1 score based on presence of og:title, og:description, og:image, og:url, og:type
  twitterCard: string | null

  // — STRUCTURE —
  headings: {
    h1: string[]
    h1Count: number
    h2Count: number
    h3Count: number
    h4Count: number
    h5Count: number
    h6Count: number
    headingOrderIssues: number   // Skipped heading levels (e.g. H1 → H3)
  }
  images: {
    total: number
    contentImages: number        // Excluding tracking pixels and decorative tiny images
    missingAlt: number
    missingAltUrls: string[]
    lazyLoaded: number
    hasModernFormats: boolean    // WebP / AVIF detected
  }
  links: {
    total: number
    internal: number
    external: number
    nofollow: number
    brokenAnchors: number        // <a> without href or with javascript:void
  }
  scripts: {
    total: number
    inline: number
    external: number
    async: number
    defer: number
    blocking: number             // External, no async/defer
  }
  stylesheets: {
    total: number
    external: number
    inline: number               // <style> tag count
  }
  htmlSizeKb: number             // HTML byte size in KB
  wordCount: number              // Approximate visible body word count

  // — TRACKING & ANALYTICS —
  trackers: {
    googleAnalytics: boolean
    googleAnalyticsId: string | null
    googleTagManager: boolean
    googleTagManagerId: string | null
    metaPixel: boolean
    linkedinInsight: boolean
    tiktokPixel: boolean
    hotjar: boolean
    mixpanel: boolean
    segment: boolean
  }
  liveChat: {
    detected: boolean
    providers: string[]          // e.g. ['Intercom', 'Drift']
  }
  cookieConsent: {
    detected: boolean
    provider: string | null      // e.g. 'OneTrust', 'Cookiebot', 'Generic'
  }

  // — CONVERSION —
  conversion: {
    hasContactForm: boolean
    formCount: number
    formsWithEmailField: number
    formsWithSubmitButton: number
    hasSearchForm: boolean          // <form role="search"> or <input type="search">
    hasLoginForm: boolean           // Form with password input
    hasNewsletterSignup: boolean    // Email-only / minimal field form with subscribe context
    qualifiedFormCount: number      // Forms that look like real lead-capture (not search/login)
    hasBookingSystem: boolean
    bookingProvider: string | null
    hasTestimonials: boolean
    testimonialsCount: number
    hasWhatsApp: boolean
    whatsAppNumber: string | null
    ctaCount: number
    ctaTexts: string[]
    hasPhoneNumber: boolean
    phoneNumber: string | null      // First detected number
    hasEmailAddress: boolean
    hasAddress: boolean
  }

  // — TRUST SIGNALS —
  trust: {
    hasPrivacyPolicy: boolean
    hasTermsOfService: boolean
    hasCertificationBadges: boolean
    hasAwardMentions: boolean
    hasSocialLinks: boolean
    socialPlatforms: string[]
  }

  // — STRUCTURED DATA —
  structuredData: {
    hasJsonLd: boolean
    types: string[]
    items: number
  }

  // — TECH STACK —
  techStack: {
    cms: string | null
    cmsConfidence: 'high' | 'medium' | 'low' | 'none'
    framework: string | null
    builderTool: string | null   // E.g. Wix, Squarespace, Webflow
    server: string | null
    poweredBy: string | null
    cdn: string | null
    hostingHints: string[]
    libraries: string[]          // jQuery, Bootstrap, Tailwind, etc.
  }

  // — SECURITY —
  security: {
    hasHttpsLinks: boolean       // True if outbound links use HTTPS
    mixedContent: number         // http:// resources on an https:// page
    hasIntegrityAttrs: boolean   // SRI on external scripts
  }
}

const TRACKING_PIXEL_HINTS = [
  'facebook.com/tr',
  'doubleclick.net',
  'google-analytics.com/collect',
  'googletagmanager.com',
  'pixel.gif',
  '1x1.gif',
  'transparent.gif'
]

export class FeatureExtractionService {
  static extract(html: string, url: string, headers: Record<string, string> = {}, htmlByteSize?: number): ExtractedFeatures {
    const $ = cheerio.load(html || '')
    const lowerHtml = (html || '').toLowerCase()

    let pageOrigin: URL | null = null
    try { pageOrigin = new URL(url) } catch { /* ignore */ }

    // === META ===
    const titleVal = $('head > title').first().text().trim() || $('title').first().text().trim() || null
    const titleLength = titleVal ? titleVal.length : 0

    const metaDescVal = $('meta[name="description" i]').first().attr('content')?.trim() || null
    const metaDescLength = metaDescVal ? metaDescVal.length : 0

    const canonicalUrl = $('link[rel="canonical" i]').first().attr('href')?.trim() || null

    const metaRobots = $('meta[name="robots" i]').first().attr('content')?.trim() || null
    const metaRobotsBlocksIndex = !!(metaRobots && /noindex/i.test(metaRobots))

    const metaCharset =
      $('meta[charset]').first().attr('charset') ||
      $('meta[http-equiv="content-type" i]').first().attr('content') ||
      null

    const metaViewport = $('meta[name="viewport" i]').first().attr('content')?.trim() || null
    const hasViewport = !!metaViewport && /width\s*=/i.test(metaViewport)

    const htmlLang = $('html').first().attr('lang')?.trim() || null
    const hasLang = !!htmlLang && htmlLang.length >= 2

    // Favicon: <link rel="icon">, <link rel="shortcut icon">, <link rel="apple-touch-icon">
    const hasFavicon = $(
      'link[rel="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i], link[rel*="icon" i]'
    ).length > 0

    const openGraph: Record<string, string> = {}
    $('meta[property^="og:" i], meta[name^="og:" i]').each((_, el) => {
      const property = ($(el).attr('property') || $(el).attr('name') || '').toLowerCase()
      const content = $(el).attr('content')?.trim()
      if (property && content) openGraph[property] = content
    })
    $('meta[name^="twitter:" i]').each((_, el) => {
      const property = ($(el).attr('name') || '').toLowerCase()
      const content = $(el).attr('content')?.trim()
      if (property && content) openGraph[property] = content
    })

    const ogRequired = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']
    const ogPresent = ogRequired.filter(k => !!openGraph[k]).length
    const openGraphCompleteness = ogPresent / ogRequired.length

    const twitterCard = openGraph['twitter:card'] || null

    // === HEADINGS ===
    const h1s: string[] = []
    $('h1').each((_, el) => {
      const t = $(el).text().trim()
      if (t) h1s.push(t)
    })

    // Heading order: scan H1-H6 in document order; flag skipped levels
    let lastLevel = 0
    let headingOrderIssues = 0
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const level = parseInt((el as any).tagName.replace(/h/i, ''), 10)
      if (lastLevel > 0 && level > lastLevel + 1) {
        headingOrderIssues++
      }
      lastLevel = level
    })

    const headings = {
      h1: h1s,
      h1Count: h1s.length,
      h2Count: $('h2').length,
      h3Count: $('h3').length,
      h4Count: $('h4').length,
      h5Count: $('h5').length,
      h6Count: $('h6').length,
      headingOrderIssues
    }

    // === IMAGES ===
    let imgTotal = 0
    let imgContent = 0
    let missingAlt = 0
    const missingAltUrls: string[] = []
    let lazyLoaded = 0
    let hasModernFormats = false

    $('img').each((_, el) => {
      imgTotal++
      const $el = $(el)
      const alt = $el.attr('alt')
      const src = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || ''
      const srcset = $el.attr('srcset') || ''
      const widthAttr = parseInt($el.attr('width') || '0', 10)
      const heightAttr = parseInt($el.attr('height') || '0', 10)
      const loading = ($el.attr('loading') || '').toLowerCase()
      const isLazy = loading === 'lazy' || !!$el.attr('data-src') || !!$el.attr('data-lazy-src')

      const looksLikeTrackingPixel =
        (widthAttr > 0 && widthAttr <= 2 && heightAttr > 0 && heightAttr <= 2) ||
        TRACKING_PIXEL_HINTS.some(h => src.toLowerCase().includes(h))

      if (!looksLikeTrackingPixel) {
        imgContent++
        if (!alt || !alt.trim()) {
          missingAlt++
          if (src && missingAltUrls.length < 10) missingAltUrls.push(src)
        }
        if (/\.(webp|avif)(\?|#|$)/i.test(src) || /\.(webp|avif)/i.test(srcset)) {
          hasModernFormats = true
        }
      }
      if (isLazy) lazyLoaded++
    })

    // Also detect modern image formats in <picture><source>
    $('picture source').each((_, el) => {
      const type = ($(el).attr('type') || '').toLowerCase()
      if (type.includes('webp') || type.includes('avif')) hasModernFormats = true
    })

    const images = {
      total: imgTotal,
      contentImages: imgContent,
      missingAlt,
      missingAltUrls,
      lazyLoaded,
      hasModernFormats
    }

    // === LINKS ===
    let linkTotal = 0
    let internalLinks = 0
    let externalLinks = 0
    let nofollowLinks = 0
    let brokenAnchors = 0
    const pageHostname = pageOrigin?.hostname.toLowerCase().replace(/^www\./, '') || ''

    $('a').each((_, el) => {
      linkTotal++
      const $el = $(el)
      const href = ($el.attr('href') || '').trim()
      const rel = ($el.attr('rel') || '').toLowerCase()
      if (!href || /^javascript:/i.test(href) || href === '#') {
        brokenAnchors++
        return
      }
      if (rel.includes('nofollow')) nofollowLinks++
      if (href.startsWith('#') || href.startsWith('?') || href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) {
        internalLinks++
        return
      }
      if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('whatsapp:') || href.startsWith('sms:')) {
        return
      }
      try {
        const parsedHref = new URL(href, url)
        const targetHost = parsedHref.hostname.toLowerCase().replace(/^www\./, '')
        if (targetHost === pageHostname) {
          internalLinks++
        } else if (pageHostname && (targetHost.endsWith('.' + pageHostname))) {
          internalLinks++
        } else {
          externalLinks++
        }
      } catch {
        brokenAnchors++
      }
    })

    const links = {
      total: linkTotal,
      internal: internalLinks,
      external: externalLinks,
      nofollow: nofollowLinks,
      brokenAnchors
    }

    // === SCRIPTS ===
    let scriptTotal = 0
    let scriptInline = 0
    let scriptExternal = 0
    let scriptAsync = 0
    let scriptDefer = 0
    let scriptBlocking = 0
    $('script').each((_, el) => {
      scriptTotal++
      const $el = $(el)
      const src = $el.attr('src')
      if (src) {
        scriptExternal++
        const isAsync = $el.attr('async') !== undefined
        const isDefer = $el.attr('defer') !== undefined
        const isModule = ($el.attr('type') || '').toLowerCase() === 'module'
        if (isAsync) scriptAsync++
        if (isDefer) scriptDefer++
        if (!isAsync && !isDefer && !isModule) scriptBlocking++
      } else {
        scriptInline++
      }
    })

    const scripts = {
      total: scriptTotal,
      inline: scriptInline,
      external: scriptExternal,
      async: scriptAsync,
      defer: scriptDefer,
      blocking: scriptBlocking
    }

    // === STYLESHEETS ===
    let stylesheetExternal = 0
    let stylesheetInline = 0
    $('link[rel="stylesheet" i], link[rel="preload"][as="style"]').each((_, el) => {
      if ($(el).attr('href')) stylesheetExternal++
    })
    $('style').each(() => { stylesheetInline++ })

    const stylesheets = {
      total: stylesheetExternal + stylesheetInline,
      external: stylesheetExternal,
      inline: stylesheetInline
    }

    const htmlSizeKb = Math.round((htmlByteSize || Buffer.byteLength(html || '', 'utf8')) / 1024)

    // Visible body word count (rough)
    const $body = cheerio.load(html || '')
    $body('script, style, noscript, iframe, head, nav, header, footer').remove()
    const bodyText = $body('body').text().replace(/\s+/g, ' ').trim()
    const wordCount = bodyText ? bodyText.split(/\s+/).length : 0

    // === TRACKERS ===
    // Property IDs are extracted from the original (not lower-cased) HTML so
    // tag-manager IDs preserve their case.
    const gaIdMatch =
      html.match(/G-[A-Z0-9]{6,12}/) ||
      html.match(/UA-\d{4,9}-\d{1,4}/)
    const gtmIdMatch = html.match(/GTM-[A-Z0-9]{4,10}/)
    const fbPixelIdMatch = html.match(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/)

    const hasGtagJs = lowerHtml.includes('googletagmanager.com/gtag/js')
    const hasAnalyticsJs = lowerHtml.includes('google-analytics.com/analytics.js') || lowerHtml.includes('www.google-analytics.com')
    const hasGtagCall = /\bgtag\s*\(\s*['"](?:js|config|event|set)/.test(html)
    const hasGaq = /_gaq\.push\s*\(/.test(html)

    const hasGtmScript = lowerHtml.includes('googletagmanager.com/gtm.js')

    const hasFbevents = lowerHtml.includes('connect.facebook.net') &&
      (lowerHtml.includes('fbevents.js') || /\bfbq\s*\(/.test(html))

    const hasHotjarScript = lowerHtml.includes('static.hotjar.com') ||
      (lowerHtml.includes('script.hotjar.com')) ||
      (/\bhj\s*\(/.test(html) && /\bhjid\s*[:=]/.test(html))

    const trackers = {
      googleAnalytics: hasGtagJs || hasAnalyticsJs || hasGtagCall || hasGaq || !!gaIdMatch,
      googleAnalyticsId: gaIdMatch ? gaIdMatch[0] : null,
      googleTagManager: hasGtmScript || !!gtmIdMatch,
      googleTagManagerId: gtmIdMatch ? gtmIdMatch[0] : null,
      metaPixel: hasFbevents || !!fbPixelIdMatch,
      linkedinInsight:
        lowerHtml.includes('snap.licdn.com/li.lms-analytics/insight.min.js') ||
        /\b_linkedin_data_partner_ids?\b/.test(html) ||
        lowerHtml.includes('px.ads.linkedin.com'),
      tiktokPixel:
        lowerHtml.includes('analytics.tiktok.com') ||
        /\bttq\.load\s*\(/.test(html) ||
        /\bttq\s*=\s*window\.ttq/.test(html),
      hotjar: hasHotjarScript,
      mixpanel: lowerHtml.includes('cdn.mxpnl.com') || /mixpanel\.init\s*\(/.test(html),
      segment: lowerHtml.includes('cdn.segment.com/analytics.js') || /analytics\.load\s*\(/.test(html)
    }

    // === LIVE CHAT ===
    // Require provider-specific script URLs / globals. Avoid matching mere
    // text mentions ("we have a Zendesk ticket" shouldn't fire Zendesk Chat).
    const liveChatProviders: string[] = []
    if (lowerHtml.includes('widget.intercom.io') || /intercomsettings\s*=/.test(lowerHtml) || lowerHtml.includes('js.intercomcdn.com')) liveChatProviders.push('Intercom')
    if (lowerHtml.includes('js.driftt.com') || lowerHtml.includes('js.drift.com') || /drift\.load\s*\(/.test(lowerHtml)) liveChatProviders.push('Drift')
    if (lowerHtml.includes('embed.tawk.to')) liveChatProviders.push('Tawk.to')
    if (lowerHtml.includes('client.crisp.chat') || /\$crisp\s*=/.test(lowerHtml)) liveChatProviders.push('Crisp')
    if (lowerHtml.includes('cdn.livechatinc.com') || /__lc\s*=/.test(lowerHtml)) liveChatProviders.push('LiveChat')
    if (
      lowerHtml.includes('static.zdassets.com') ||
      lowerHtml.includes('assets.zendesk.com/embeddable_framework') ||
      lowerHtml.includes('ekr.zdassets.com')
    ) liveChatProviders.push('Zendesk Chat')
    if (lowerHtml.includes('code.tidio.co') || lowerHtml.includes('widget-srv.tidio')) liveChatProviders.push('Tidio')
    if (
      lowerHtml.includes('js.hs-scripts.com') ||
      lowerHtml.includes('js.usemessages.com') ||
      lowerHtml.includes('js.hsforms.net') && /hbspt\.messages/.test(lowerHtml)
    ) liveChatProviders.push('HubSpot Chat')
    if (lowerHtml.includes('connect.facebook.net') && lowerHtml.includes('fb-customerchat')) liveChatProviders.push('Facebook Messenger')
    if (lowerHtml.includes('chatra.io') || lowerHtml.includes('call.chatra.io')) liveChatProviders.push('Chatra')
    if (lowerHtml.includes('embed.smartsupp.com')) liveChatProviders.push('Smartsupp')
    if (lowerHtml.includes('cdn.purechat.com')) liveChatProviders.push('PureChat')
    if (lowerHtml.includes('widget.freshchat.com') || lowerHtml.includes('fchat.freshchat.com')) liveChatProviders.push('Freshchat')

    const liveChat = {
      detected: liveChatProviders.length > 0,
      providers: liveChatProviders
    }

    // === COOKIE CONSENT ===
    let cookieProvider: string | null = null
    if (lowerHtml.includes('cdn.cookielaw.org') || lowerHtml.includes('onetrust')) cookieProvider = 'OneTrust'
    else if (lowerHtml.includes('consent.cookiebot.com')) cookieProvider = 'Cookiebot'
    else if (lowerHtml.includes('cdn.iubenda.com')) cookieProvider = 'Iubenda'
    else if (lowerHtml.includes('app.termly.io')) cookieProvider = 'Termly'
    else if (lowerHtml.includes('cdn.usercentrics.eu')) cookieProvider = 'Usercentrics'
    else if (
      /\bcookie[\s-]?consent\b/i.test(html) ||
      $('[id*="cookie" i], [class*="cookie" i]').filter((_, el) =>
        /accept|consent|agree/i.test($(el).text())
      ).length > 0
    ) {
      cookieProvider = 'Generic'
    }

    const cookieConsent = {
      detected: cookieProvider !== null,
      provider: cookieProvider
    }

    // === STRUCTURED DATA ===
    // Hoisted earlier in the pipeline because testimonial detection (further
    // below) cross-references Review / Rating types.
    const structuredTypes: string[] = []
    let structuredItems = 0
    $('script[type="application/ld+json" i]').each((_, el) => {
      const content = $(el).html()
      if (!content) return
      try {
        // Clean up JSON content (remove comments, trailing commas)
        const cleanContent = content
          .replace(/\/\*[\s\S]*?\*\//g, '') // remove multi-line comments
          .replace(/\/\/.*/g, '')           // remove single-line comments
          .replace(/,\s*([\]}])/g, '$1')     // remove trailing commas
          .trim()
        const parsed = JSON.parse(cleanContent)
        const extractTypes = (obj: any) => {
          if (!obj || typeof obj !== 'object') return
          structuredItems++
          if (obj['@type']) {
            const t = obj['@type']
            if (Array.isArray(t)) structuredTypes.push(...t)
            else structuredTypes.push(String(t))
          }
          if (obj['@graph'] && Array.isArray(obj['@graph'])) {
            obj['@graph'].forEach(extractTypes)
          }
        }
        if (Array.isArray(parsed)) parsed.forEach(extractTypes)
        else extractTypes(parsed)
      } catch {
        // Fallback: simple regex for @type matching if JSON parsing fails
        const typeRegex = /"@type"\s*:\s*"([^"]+)"/g
        let match
        while ((match = typeRegex.exec(content)) !== null) {
          structuredTypes.push(match[1])
          structuredItems++
        }
      }
    })

    // Detect Microdata
    $('[itemtype]').each((_, el) => {
      const type = $(el).attr('itemtype')
      if (type) {
        const typeName = type.split('/').pop()
        if (typeName) {
          structuredTypes.push(typeName)
          structuredItems++
        }
      }
    })

    // Detect RDFa
    $('[typeof]').each((_, el) => {
      const type = $(el).attr('typeof')
      if (type) {
        structuredTypes.push(type)
        structuredItems++
      }
    })

    const structuredData = {
      hasJsonLd: structuredTypes.length > 0,
      types: [...new Set(structuredTypes)],
      items: structuredItems
    }

    // === CONVERSION ===
    // Form classification: distinguish search / login / newsletter / contact.
    // Generic email+submit forms used to all count as "contact form" — that
    // promoted login pages and newsletter widgets into contact form territory.
    let formCount = 0
    let formsWithEmail = 0
    let formsWithSubmit = 0
    let hasContactForm = false
    let hasSearchForm = false
    let hasLoginForm = false
    let hasNewsletterSignup = false
    let qualifiedFormCount = 0

    const contactFormHints = /contact|enquir|inquir|lead|get.in.touch|reach.us|request.*quote|book.*demo|message.us|get.a.quote|free.consultation/i
    const newsletterHints = /newsletter|subscribe|sign.?up.*updates|join.*list|stay.in.the.loop|email.updates/i
    const loginHints = /sign.?in|log.?in|forgot.password|create.account|register.now/i
    const searchHints = /^search$|search.the.site|find.*on.*site/i

    $('form').each((_, el) => {
      formCount++
      const $form = $(el)
      const id = ($form.attr('id') || '').toLowerCase()
      const cls = ($form.attr('class') || '').toLowerCase()
      const name = ($form.attr('name') || '').toLowerCase()
      const action = ($form.attr('action') || '').toLowerCase()
      const role = ($form.attr('role') || '').toLowerCase()
      const formText = $form.text().toLowerCase().slice(0, 800)

      const inputCount = $form.find('input:not([type="hidden"]):not([type="submit"]), textarea, select').length
      const hasEmailField = $form.find('input[type="email" i]').length > 0 ||
        $form.find('input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]').length > 0
      const hasSubmit = $form.find('input[type="submit" i], button[type="submit" i], button:not([type]), button[type="button"]:has(svg)').length > 0
      const hasPasswordField = $form.find('input[type="password" i]').length > 0
      const hasSearchField = $form.find('input[type="search" i]').length > 0
      const hasNameField = $form.find('input[name*="name" i], input[id*="name" i], input[placeholder*="name" i]').length > 0
      const hasMessageField = $form.find('textarea, input[name*="message" i], input[name*="comment" i], input[name*="enquir" i]').length > 0
      const hasPhoneField = $form.find('input[type="tel" i], input[name*="phone" i], input[name*="mobile" i]').length > 0

      if (hasEmailField) formsWithEmail++
      if (hasSubmit) formsWithSubmit++

      // 1) LOGIN form (password input is the strongest tell)
      if (hasPasswordField || loginHints.test(id) || loginHints.test(cls) || loginHints.test(action)) {
        hasLoginForm = true
        return
      }

      // 2) SEARCH form
      if (
        role === 'search' ||
        hasSearchField ||
        searchHints.test(id) || searchHints.test(cls) || searchHints.test(name) ||
        searchHints.test(action) ||
        (inputCount === 1 && /search/i.test(formText))
      ) {
        hasSearchForm = true
        return
      }

      // 3) NEWSLETTER signup — email-only or email+name with subscribe context
      const newsletterContext =
        newsletterHints.test(id) || newsletterHints.test(cls) || newsletterHints.test(action) ||
        newsletterHints.test(formText)
      const minimalEmailOnly = hasEmailField && hasSubmit && inputCount <= 2 && !hasMessageField
      if (newsletterContext && hasEmailField) {
        hasNewsletterSignup = true
        // Newsletter forms aren't contact forms but they ARE a qualified lead capture
        qualifiedFormCount++
        return
      }
      if (minimalEmailOnly && !hasMessageField && !hasPhoneField && !hasNameField) {
        // Pure email-only with submit — almost always a newsletter
        hasNewsletterSignup = true
        qualifiedFormCount++
        return
      }

      // 4) CONTACT / LEAD form
      const contactContext =
        contactFormHints.test(id) || contactFormHints.test(cls) || contactFormHints.test(name) ||
        contactFormHints.test(action) || contactFormHints.test(formText)
      const looksLikeRealContactForm = hasEmailField && hasSubmit && (hasMessageField || hasNameField || hasPhoneField)

      if (contactContext || looksLikeRealContactForm) {
        hasContactForm = true
        qualifiedFormCount++
      }
    })

    // === EMBEDDED / NON-STANDARD LEAD FORM DETECTION ===
    // The bare <form> scan above misses several common patterns that absolutely
    // ARE lead capture in practice. Each detector below confirms a real lead
    // path and bumps qualifiedFormCount + hasContactForm.

    // (a) Embedded iframe form widgets
    const iframeProviders: Array<{ pattern: RegExp; name: string }> = [
      { pattern: /<iframe[^>]+src=["'][^"']*calendly\.com/i, name: 'Calendly' },
      { pattern: /<iframe[^>]+src=["'][^"']*(?:tally\.so|form\.tally)/i, name: 'Tally' },
      { pattern: /<iframe[^>]+src=["'][^"']*typeform\.com/i, name: 'Typeform' },
      { pattern: /<iframe[^>]+src=["'][^"']*(?:hsforms\.com|hsforms\.net|forms\.hubspot)/i, name: 'HubSpot Forms' },
      { pattern: /<iframe[^>]+src=["'][^"']*(?:jotform\.com|form\.jotform)/i, name: 'JotForm' },
      { pattern: /<iframe[^>]+src=["'][^"']*(?:formstack\.com|forms\.formstack)/i, name: 'Formstack' },
      { pattern: /<iframe[^>]+src=["'][^"']*paperform\.co/i, name: 'Paperform' },
      { pattern: /<iframe[^>]+src=["'][^"']*wufoo\.com/i, name: 'Wufoo' },
      { pattern: /<iframe[^>]+src=["'][^"']*formaloo\.com/i, name: 'Formaloo' },
      { pattern: /<iframe[^>]+src=["'][^"']*(?:airtable\.com\/embed|airtable\.com\/shr)/i, name: 'Airtable Form' },
      { pattern: /<iframe[^>]+src=["'][^"']*forms\.google\.com/i, name: 'Google Forms' },
      { pattern: /<iframe[^>]+src=["'][^"']*formspree\.io/i, name: 'Formspree' }
    ]
    for (const provider of iframeProviders) {
      if (provider.pattern.test(html)) {
        hasContactForm = true
        qualifiedFormCount++
        break  // One detection is enough; we count it as one form
      }
    }

    // (b) Script-loaded form widgets (no iframe, embed via JS)
    if (
      /hbspt\.forms\.create\s*\(/i.test(html) ||
      /js\.hsforms\.net\/forms\/embed/i.test(lowerHtml) ||
      lowerHtml.includes('js.hsforms.net/forms') ||
      lowerHtml.includes('embed.typeform.com/next/embed.js') ||
      /typef_orm/.test(lowerHtml) ||
      lowerHtml.includes('assets.calendly.com/assets/external/widget.js') ||
      /calendly\.initpopupwidget\s*\(/i.test(html) ||
      /tally\.loadembeds\s*\(/i.test(html) ||
      lowerHtml.includes('tally.so/widgets/embed.js')
    ) {
      if (!hasContactForm) {
        hasContactForm = true
        qualifiedFormCount++
      }
    }

    // (c) WordPress contact-form plugin signatures
    const wpFormSignatures = [
      'class="wpcf7',         // Contact Form 7
      'class="wpcf7-form',
      'class="gform_',         // Gravity Forms
      'gform_wrapper',
      'class="wpforms-',       // WPForms
      'wpforms-container',
      'class="nf-form',        // Ninja Forms
      'ninja_forms_display_form',
      'fluentform',            // Fluent Forms
      'class="ff-el',          // Fluent Forms element
      'class="frm_forms',      // Formidable Forms
      'class="elementor-form', // Elementor Pro Forms
      'class="wpcf-form',
      'class="forminator-'     // Forminator
    ]
    for (const sig of wpFormSignatures) {
      if (lowerHtml.includes(sig)) {
        if (!hasContactForm) {
          hasContactForm = true
          qualifiedFormCount++
        }
        break
      }
    }

    // (d) Modal-triggered contact forms
    // Heuristic: a button/link with data-bs-toggle="modal" (Bootstrap) or
    // data-modal-target / aria-haspopup="dialog" pointing to something with
    // "contact"/"enquir"/"book"/"demo" in the target id or label.
    $('[data-bs-toggle="modal"], [data-toggle="modal"], [data-modal-target], [aria-haspopup="dialog"]').each((_, el) => {
      const $el = $(el)
      const target = ($el.attr('data-bs-target') || $el.attr('data-target') || $el.attr('data-modal-target') || $el.attr('href') || '').toLowerCase()
      const label = ($el.text() || $el.attr('aria-label') || '').toLowerCase()
      if (
        /\b(contact|enquir|inquir|get.in.touch|book|demo|quote|consultation|appointment|start.a.project|message.us)\b/.test(target) ||
        /\b(contact|enquir|inquir|get.in.touch|book.*(?:demo|call|now)|request.*(?:quote|demo|callback)|start.a.project|message.us|talk.to.us|reach.out)\b/.test(label)
      ) {
        if (!hasContactForm) {
          hasContactForm = true
          qualifiedFormCount++
        }
        return false  // Stop iterating after first match
      }
    })

    // (e) Jump-to-contact navigation links (#contact, /contact, /get-in-touch)
    //     These don't prove a form exists, but they signal a contact section.
    //     We only count this if a phone or email is also visible (otherwise
    //     "Contact us" might just go to a 404).
    let hasJumpToContact = false
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').toLowerCase()
      const label = ($(el).text() || '').toLowerCase().trim()
      if (
        (href === '#contact' || href.endsWith('/contact') || href.endsWith('/contact/') ||
         href.includes('/contact-us') || href.includes('/get-in-touch') || href.includes('/enquir') ||
         href.includes('/inquir') || href.includes('/get-a-quote') || href.includes('/book-a-')) &&
        (label.includes('contact') || label.includes('enquir') || label.includes('quote') ||
         label.includes('book') || label.includes('reach') || label.includes('get in touch'))
      ) {
        hasJumpToContact = true
        return false  // Stop after first match
      }
    })

    // (f) Netlify Forms attribute — site is hosted on Netlify with built-in
    //     form handling. Common modern landing-page pattern.
    if (
      /data-netlify\s*=\s*["']?true/i.test(html) ||
      /\bnetlify\s+name=/i.test(html) ||
      /netlify-honeypot/i.test(html)
    ) {
      if (!hasContactForm) {
        hasContactForm = true
        qualifiedFormCount++
      }
    }

    // (g) Form-shaped input clusters WITHOUT a <form> wrapper.
    //     Modern React/Vue landing pages frequently manage form state in JS
    //     and submit via a button's onClick, with no <form> tag at all.
    //     Detection: find a container that has 2+ inputs (one resembling an
    //     email field) AND a submit-style button nearby, with contact-like
    //     context in its id/class/heading/text.
    //
    //     Only runs if we haven't already detected a form, so it doesn't
    //     double-count.
    if (!hasContactForm) {
      // Look at every section/div that contains 2+ inputs and 1+ button.
      $('section, div').each((_, el) => {
        const $section = $(el)
        // Skip if this section IS a form — already handled above.
        if ($section.is('form')) return
        if ($section.parents('form').length > 0) return

        // Bail out early on sections obviously not contact-related.
        // We do a cheap text check before counting inputs (cheaper).
        const sectionId = ($section.attr('id') || '').toLowerCase()
        const sectionCls = ($section.attr('class') || '').toLowerCase()
        const sectionHeadingText = ($section.find('h1, h2, h3, h4').first().text() || '').toLowerCase()

        const looksContactCoded =
          contactFormHints.test(sectionId) ||
          contactFormHints.test(sectionCls) ||
          /\b(contact|get\s*in\s*touch|reach\s*out|send.*message|enquir|inquir|book|consultation|quote|let'?s\s*talk|work\s*with|start\s*a\s*project|message.us|talk.to.us|drop\s*a\s*line)\b/.test(sectionHeadingText)

        if (!looksContactCoded) return

        // Count direct-descendant input controls (not nested forms).
        const inputs = $section.find('input:not([type="hidden"]):not([type="submit"]):not([type="search"]), textarea').filter((_, inp) => {
          return $(inp).parents('form').length === 0
        })
        if (inputs.length < 2) return

        // Check for email-shaped field
        const hasEmailLikeField = inputs.toArray().some(inp => {
          const $inp = $(inp)
          const type = ($inp.attr('type') || '').toLowerCase()
          const name = ($inp.attr('name') || '').toLowerCase()
          const id = ($inp.attr('id') || '').toLowerCase()
          const placeholder = ($inp.attr('placeholder') || '').toLowerCase()
          return type === 'email' ||
                 /email|e-mail|mail/.test(name) ||
                 /email|e-mail|mail/.test(id) ||
                 /email|e-mail|mail/.test(placeholder)
        })
        if (!hasEmailLikeField) return

        // Check for a submit-style button nearby
        const hasSubmitButton = $section.find('button, [role="button"], a.btn, a[class*="button" i], input[type="submit" i]').toArray().some(btn => {
          const $btn = $(btn)
          if ($btn.parents('form').length > 0) return false
          const btnText = ($btn.text() || $btn.attr('value') || '').toLowerCase().trim()
          const btnType = ($btn.attr('type') || '').toLowerCase()
          if (btnType === 'submit') return true
          return /\b(submit|send|book|request|quote|get\s*in\s*touch|get\s*a\s*quote|contact|enquir|inquir|reach.out|talk\s*to|message|schedule|sign\s*up|get\s*started|start\s*now|join|subscribe|consultation|discovery|let'?s\s*(?:talk|chat|connect|work)|tell\s*us|hire\s*us|work\s*with|start\s*(?:a\s*)?project|free\s*(?:consultation|audit|call|trial))\b/.test(btnText)
        })
        if (!hasSubmitButton) return

        // Survived all checks — counts as one contact form
        hasContactForm = true
        qualifiedFormCount++
        return false  // Stop iterating
      })
    }

    let bookingProvider: string | null = null
    if (lowerHtml.includes('calendly.com/') || /calendly\.(?:init|loadwidget|initpopupwidget)/i.test(html)) bookingProvider = 'Calendly'
    else if (lowerHtml.includes('acuityscheduling.com')) bookingProvider = 'Acuity'
    else if (lowerHtml.includes('hubspot.com/meetings') || lowerHtml.includes('meetings.hubspot') || lowerHtml.includes('meetings-eu1.hubspot')) bookingProvider = 'HubSpot Meetings'
    else if (lowerHtml.includes('cal.com/') || /\bcal\.com\/api\b/i.test(lowerHtml)) bookingProvider = 'Cal.com'
    else if (lowerHtml.includes('appointlet.com')) bookingProvider = 'Appointlet'
    else if (lowerHtml.includes('squarespacescheduling.com') || lowerHtml.includes('squareup.com/appointments')) bookingProvider = 'Square Appointments'
    else if (lowerHtml.includes('book.openappointment')) bookingProvider = 'OpenAppointment'
    else if (lowerHtml.includes('setmore.com') || lowerHtml.includes('mobi.bookingbug')) bookingProvider = 'Setmore'
    else if (lowerHtml.includes('youcanbook.me') || lowerHtml.includes('ycb.me')) bookingProvider = 'YouCanBookMe'
    else if (lowerHtml.includes('simplybook.me') || lowerHtml.includes('simplybook.it')) bookingProvider = 'SimplyBook'
    else if (lowerHtml.includes('book.timify.com') || lowerHtml.includes('timify.com/booker')) bookingProvider = 'Timify'
    else if (lowerHtml.includes('cliniko.com') || lowerHtml.includes('clinikoapp.com')) bookingProvider = 'Cliniko'
    else if (lowerHtml.includes('book.zocdoc.com') || lowerHtml.includes('zocdoc.com/widget')) bookingProvider = 'Zocdoc'
    else if (lowerHtml.includes('practo.com') && /practo[._-](?:button|widget|book)/i.test(lowerHtml)) bookingProvider = 'Practo'
    else if (lowerHtml.includes('opentable.com') && /reserve|booking|widget/i.test(lowerHtml)) bookingProvider = 'OpenTable'
    else if (lowerHtml.includes('resy.com') && /widget|book/i.test(lowerHtml)) bookingProvider = 'Resy'
    else if (lowerHtml.includes('eatapp.co') || lowerHtml.includes('eatapp.co/widget')) bookingProvider = 'Eat App'
    else if (lowerHtml.includes('tablein.com')) bookingProvider = 'TableIn'
    else if (lowerHtml.includes('schedulista.com')) bookingProvider = 'Schedulista'
    else if (/zcal\.co\b/.test(lowerHtml)) bookingProvider = 'Zcal'
    else if (lowerHtml.includes('savvycal.com')) bookingProvider = 'SavvyCal'
    else if (lowerHtml.includes('book.bookwhen.com') || lowerHtml.includes('bookwhen.com/embed')) bookingProvider = 'Bookwhen'

    const hasBookingSystem = bookingProvider !== null

    // Booking systems are also valid lead-capture channels — count them if
    // we haven't already counted a qualified form.
    if (hasBookingSystem && qualifiedFormCount === 0) {
      qualifiedFormCount = 1
      // hasContactForm stays as-is: a booking widget isn't a contact form, it
      // IS a booking, but the contact-mechanism check picks up either signal.
    }

    // Testimonial detection: look for the smallest containers that actually
    // hold individual quotes/reviews. Counts these directly, never their
    // parent collection wrapper. Schema.org Review markup is the gold signal.
    let testimonialsCount = 0
    const countedTestimonialEls = new Set<unknown>()

    // 1) Schema.org Review/Rating items — most reliable
    const reviewSchemaCount = structuredTypes.filter(t =>
      /^Review$|^AggregateRating$|^TestimonialItem$/i.test(t)
    ).length

    // 2) Direct blockquote elements within a testimonial-coded ancestor
    $('blockquote').each((_, el) => {
      const $el = $(el)
      const hasTestimonialAncestor = $el.parents('[class*="testimonial" i], [id*="testimonial" i], [class*="review" i], [id*="review" i], [data-testid*="testimonial" i]').length > 0
      if (hasTestimonialAncestor && !countedTestimonialEls.has(el)) {
        countedTestimonialEls.add(el)
        testimonialsCount++
      }
    })

    // 3) For any testimonial CONTAINER that holds card-style items (not blockquotes),
    //    count its child cards — only if we haven't already counted blockquotes inside.
    $('[class*="testimonial" i], [id*="testimonial" i], [class*="review" i], [id*="review" i]').each((_, el) => {
      const $el = $(el)
      const hasParentTestimonial = $el.parents('[class*="testimonial" i], [id*="testimonial" i]').length > 0
      if (hasParentTestimonial) return  // Skip — its leaves are already handled

      // Skip containers whose blockquote children we already counted in step 2
      const childBlockquotes = $el.find('blockquote').length
      const allCardItems = $el.find('[class*="quote" i], [class*="card" i]:has(p), [class*="item" i]:has(p)')
      const uncountedCards = allCardItems.toArray().filter(c => !countedTestimonialEls.has(c))

      if (uncountedCards.length > 0) {
        uncountedCards.slice(0, 12).forEach(c => countedTestimonialEls.add(c))
        testimonialsCount += Math.min(uncountedCards.length, 12)
      } else if (childBlockquotes === 0 && /\b(said|customer|client|review|rating)\b/i.test($el.text().slice(0, 300))) {
        // Single-quote testimonial section, no individual cards or blockquotes
        testimonialsCount += 1
      }
    })

    testimonialsCount = Math.min(testimonialsCount, 20)
    const hasTestimonials = testimonialsCount > 0 || reviewSchemaCount > 0

    // WhatsApp: require an actual wa.me or api.whatsapp.com link
    let whatsAppNumber: string | null = null
    let hasWhatsApp = false
    $('a[href*="wa.me" i], a[href*="api.whatsapp.com" i], a[href*="whatsapp.com/send" i], a[href^="whatsapp:" i]').each((_, el) => {
      const href = $(el).attr('href') || ''
      hasWhatsApp = true
      const m = href.match(/\d{7,}/)
      if (m && !whatsAppNumber) whatsAppNumber = m[0]
    })

    // CTAs: a real CTA is either (a) styled as a prominent button OR (b) uses a
    // strong action verb that signals commitment. Generic links like "More
    // information", "Read more", "View all", "Back to top" don't count even if
    // they're inside <a> tags, because they don't drive conversion.
    const STRONG_CTA_PHRASES = [
      'get started', 'sign up', 'sign in', 'log in', 'try free', 'try now', 'try for free', 'start free', 'start trial',
      'book now', 'book a', 'book your', 'book demo', 'book a call', 'book a meeting', 'book consultation',
      'schedule a', 'schedule now', 'schedule call', 'schedule demo',
      'request demo', 'request a quote', 'request quote', 'get a quote', 'get quote', 'get my quote', 'free quote',
      'contact us', 'contact sales', 'talk to sales', 'talk to us', 'talk to an expert', 'get in touch',
      'buy now', 'shop now', 'order now', 'add to cart', 'add to bag', 'add to basket',
      'subscribe', 'sign me up',
      'download', 'download now', 'download free', 'install', 'install now', 'install free',
      'see plans', 'see pricing', 'view pricing', 'view plans', 'compare plans',
      'join now', 'join us', 'join free', 'join today',
      'apply now', 'reserve', 'reserve your', 'enroll', 'enroll now', 'register', 'register now',
      'claim', 'claim your', 'claim offer', 'claim discount',
      'enquire', 'enquire now', 'inquire', 'inquire now',
      'donate', 'donate now', 'pledge', 'support us',
      'whatsapp us', 'call us', 'call now', 'speak to', 'message us',
      'request a callback', 'request callback',
      'find a', 'find your',
      'try it free'
    ]
    const WEAK_DENYLIST_PHRASES = [
      'more information', 'read more', 'learn more about', 'view all', 'see all', 'show more',
      'back to top', 'skip to', 'home', 'menu', 'close', 'next', 'previous', 'continue reading'
    ]
    const ctaTexts: string[] = []
    const ctaCounted = new Set<string>()

    const looksLikeIconOnly = (text: string, $el: any): boolean => {
      // Empty text but has aria-label = could be a real icon CTA, but we don't count it without context
      return text.trim().length === 0 || /^[^a-zA-Z0-9]+$/.test(text.trim())
    }

    $('a, button, input[type="submit"], input[type="button"]').each((_, el) => {
      const $el = $(el)
      const text = ($el.text() || $el.attr('value') || $el.attr('aria-label') || '').trim()
      if (looksLikeIconOnly(text, $el)) return
      if (text.length < 2 || text.length > 60) return
      const lower = text.toLowerCase()

      // Denylist: ambient navigation/utility links that are never conversion CTAs
      if (WEAK_DENYLIST_PHRASES.some(p => lower === p || lower.startsWith(p + ' ') || lower.endsWith(' ' + p))) return

      const cls = ($el.attr('class') || '').toLowerCase()
      const id = ($el.attr('id') || '').toLowerCase()
      const role = ($el.attr('role') || '').toLowerCase()
      const tagName = String(((el as any).tagName || '')).toLowerCase()

      // "Button-shaped" = the element actually looks like a button to a user
      const looksLikeButton =
        tagName === 'button' ||
        $el.attr('type') === 'submit' ||
        $el.attr('type') === 'button' ||
        role === 'button' ||
        /\b(btn|button|cta|call-to-action|primary-action)\b/.test(cls) ||
        /\b(btn|button|cta)\b/.test(id)

      const matchesStrongPhrase = STRONG_CTA_PHRASES.some(p =>
        lower === p ||
        lower.startsWith(p + ' ') ||
        lower.endsWith(' ' + p) ||
        lower.includes(' ' + p + ' ') ||
        // Whole-phrase match for multi-word phrases anywhere
        (p.includes(' ') && lower.includes(p))
      )

      // Count if: button-shaped OR strong action phrase. Not enough to just be a link.
      if ((looksLikeButton || matchesStrongPhrase) && !ctaCounted.has(lower)) {
        ctaCounted.add(lower)
        ctaTexts.push(text)
      }
    })

    // Contact methods
    // Phone: prefer explicit tel: links; fall back to a context-sensitive
    // regex that requires either a +country prefix OR proximity to "phone"/
    // "call"/"tel" wording, AND at least 8 digits total. This filters out
    // dates, ISBNs, zip codes, and other coincidental digit runs.
    let phoneNumber: string | null = null
    let hasPhoneNumber = false
    $('a[href^="tel:" i]').first().each((_, el) => {
      const href = $(el).attr('href') || ''
      const num = href.replace(/^tel:/i, '').trim()
      if (num.length >= 7) {
        phoneNumber = num
        hasPhoneNumber = true
      }
    })
    if (!hasPhoneNumber) {
      // Scan first 8KB of body text for explicit phone context
      const txt = bodyText.slice(0, 8000)
      const phoneContextRegex = /(?:phone|call|tel(?:ephone)?|mobile|whatsapp|call.us|reach.us)[^a-z0-9]{0,20}((?:\+?\d{1,3}[\s().-]?)?\(?\d{2,4}\)?[\s().-]?\d{3,4}[\s().-]?\d{3,4}[\s().-]?\d{0,4})/i
      const m = txt.match(phoneContextRegex)
      if (m && m[1]) {
        const digitsOnly = m[1].replace(/\D/g, '')
        if (digitsOnly.length >= 8 && digitsOnly.length <= 15) {
          phoneNumber = m[1].trim()
          hasPhoneNumber = true
        }
      }
      // Or a strong international format like "+91 98765 43210"
      if (!hasPhoneNumber) {
        const intl = txt.match(/\+\d{1,3}[\s().-]?\d{2,4}[\s().-]?\d{3,4}[\s().-]?\d{3,4}/)
        if (intl) {
          const digitsOnly = intl[0].replace(/\D/g, '')
          if (digitsOnly.length >= 9 && digitsOnly.length <= 15) {
            phoneNumber = intl[0]
            hasPhoneNumber = true
          }
        }
      }
    }

    const hasEmailAddress =
      $('a[href^="mailto:" i]').length > 0 ||
      /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.test(bodyText.slice(0, 10000))
    const hasAddress =
      /\d+\s+[a-z][a-z\s]+(?:street|st\b|avenue|ave\b|road|rd\b|boulevard|blvd|lane|ln\b|way\b|drive|dr\b|highway|hwy|sector|block)/i.test(bodyText.slice(0, 10000)) ||
      $('[itemtype*="PostalAddress" i], address').length > 0

    const conversion = {
      hasContactForm,
      formCount,
      formsWithEmailField: formsWithEmail,
      formsWithSubmitButton: formsWithSubmit,
      hasSearchForm,
      hasLoginForm,
      hasNewsletterSignup,
      qualifiedFormCount,
      hasBookingSystem,
      bookingProvider,
      hasTestimonials,
      testimonialsCount,
      hasWhatsApp,
      whatsAppNumber,
      ctaCount: ctaTexts.length,
      ctaTexts: ctaTexts.slice(0, 10),
      hasPhoneNumber,
      phoneNumber,
      hasEmailAddress,
      hasAddress
    }

    // === TRUST ===
    const navAndFooterText = $('footer a, nav a, header a').map((_, el) => $(el).text().toLowerCase()).get().join(' ')
    const hasPrivacyPolicy = /privacy.policy|privacy.notice|data.protection/i.test(navAndFooterText) ||
      $('a[href*="privacy" i]').length > 0
    const hasTermsOfService = /terms.of.service|terms.of.use|terms.and.conditions|terms.&.conditions|\bt&c\b|\bt's.&.c's\b/i.test(navAndFooterText) ||
      $('a[href*="terms" i]').length > 0
    const hasCertificationBadges =
      /\bcertified\b|\biso.\d{4,}\b|\bgdpr\b|\bhipaa\b|\bsoc.?2\b|\bpci.?dss\b/i.test(lowerHtml) ||
      $('img[alt*="certif" i], img[alt*="badge" i], img[src*="badge" i], img[src*="trustpilot" i]').length > 0
    const hasAwardMentions =
      /\baward.winning\b|\bbest.of\b|\btop.rated\b|\bas.seen.on\b|\bfeatured.in\b/i.test(lowerHtml) ||
      $('img[alt*="award" i]').length > 0

    const socialPlatforms: string[] = []
    const socialPatterns: [string, RegExp][] = [
      ['Facebook', /facebook\.com\/(?!sharer|share|plugins)[a-z0-9.\-_]+/i],
      ['Instagram', /instagram\.com\/[a-z0-9.\-_]+/i],
      ['LinkedIn', /linkedin\.com\/(company|in|school)\/[a-z0-9.\-_]+/i],
      ['Twitter/X', /(twitter\.com|x\.com)\/(?!share|intent)[a-z0-9.\-_]+/i],
      ['YouTube', /youtube\.com\/(channel|user|c|@)[a-z0-9.\-_]+/i],
      ['TikTok', /tiktok\.com\/@[a-z0-9.\-_]+/i],
      ['Pinterest', /pinterest\.com\/[a-z0-9.\-_]+/i],
      ['GitHub', /github\.com\/[a-z0-9.\-_]+/i],
      ['Discord', /discord\.(gg|com\/invite)\/[a-z0-9.\-_]+/i],
      ['WhatsApp', /(wa\.me|api\.whatsapp\.com)/i]
    ]
    const allHrefs = $('a').map((_, el) => $(el).attr('href') || '').get().join(' ')
    for (const [name, pattern] of socialPatterns) {
      if (pattern.test(allHrefs)) socialPlatforms.push(name)
    }
    const hasSocialLinks = socialPlatforms.length > 0

    const trust = {
      hasPrivacyPolicy,
      hasTermsOfService,
      hasCertificationBadges,
      hasAwardMentions,
      hasSocialLinks,
      socialPlatforms
    }

    // (structuredData was computed earlier — before the CONVERSION section —
    // so testimonial detection could check for Review/Rating schema.)

    // === TECH STACK ===
    let cms: string | null = null
    let cmsConfidence: 'high' | 'medium' | 'low' | 'none' = 'none'
    let builderTool: string | null = null
    let framework: string | null = null
    const libraries: string[] = []
    const hostingHints: string[] = []

    const generator = $('meta[name="generator" i]').first().attr('content')?.toLowerCase() || ''

    // CMS detection
    if (lowerHtml.includes('wp-content/') || lowerHtml.includes('wp-includes/') || generator.includes('wordpress')) {
      cms = 'WordPress'
      cmsConfidence = 'high'
      // WooCommerce sub-detection
      if (lowerHtml.includes('woocommerce') || lowerHtml.includes('wc-block-') || lowerHtml.includes('add-to-cart')) {
        cms = 'WordPress + WooCommerce'
      }
    } else if (lowerHtml.includes('cdn.shopify.com') || lowerHtml.includes('shopify-features') || lowerHtml.includes('shopifycloud.com') || generator.includes('shopify')) {
      cms = 'Shopify'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('static.parastorage.com') || lowerHtml.includes('wix.com') || generator.includes('wix')) {
      builderTool = 'Wix'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('squarespace-cdn') || lowerHtml.includes('static1.squarespace.com') || generator.includes('squarespace')) {
      builderTool = 'Squarespace'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('webflow.com/') || generator.includes('webflow') || lowerHtml.includes('data-wf-page') || lowerHtml.includes('data-wf-site')) {
      builderTool = 'Webflow'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('drupal.js') || lowerHtml.includes('sites/all/themes/') || lowerHtml.includes('drupal-settings-json') || generator.includes('drupal')) {
      cms = 'Drupal'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('/components/com_') || generator.includes('joomla')) {
      cms = 'Joomla'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('mage/cookies.js') || lowerHtml.includes('/skin/frontend/') || lowerHtml.includes('mage-init') || generator.includes('magento')) {
      cms = 'Magento'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('/_ghost/') || generator.includes('ghost')) {
      cms = 'Ghost'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('hubspotusercontent') || lowerHtml.includes('hs-scripts.com') || lowerHtml.includes('hs-banner.com')) {
      cms = 'HubSpot CMS'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('cdn.bigcommerce.com') || lowerHtml.includes('bigcommerce.com/assets') || generator.includes('bigcommerce')) {
      cms = 'BigCommerce'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('framerusercontent.com') || (lowerHtml.includes('framer.com') && lowerHtml.includes('data-framer'))) {
      builderTool = 'Framer'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('cdn.sanity.io')) {
      cms = 'Sanity (headless)'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('strapi') && /strapi[._-]/.test(lowerHtml)) {
      cms = 'Strapi (headless)'
      cmsConfidence = 'medium'
    } else if (lowerHtml.includes('contentful.com') || lowerHtml.includes('ctfassets.net')) {
      cms = 'Contentful (headless)'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('cdn.prismic.io')) {
      cms = 'Prismic (headless)'
      cmsConfidence = 'high'
    } else if (lowerHtml.includes('wagtail') && /wagtail[._-]/.test(lowerHtml)) {
      cms = 'Wagtail'
      cmsConfidence = 'medium'
    }

    // Framework detection
    if (lowerHtml.includes('__next_data__') || lowerHtml.includes('/_next/static/')) {
      framework = 'Next.js'
    } else if (lowerHtml.includes('__remixcontext') || lowerHtml.includes('__remixmanifest') || lowerHtml.includes('remix-run')) {
      framework = 'Remix'
    } else if (lowerHtml.includes('__nuxt') || lowerHtml.includes('/_nuxt/')) {
      framework = 'Nuxt.js'
    } else if (lowerHtml.includes('ng-version=') || lowerHtml.includes('ng-app=') || lowerHtml.includes('_nghost-')) {
      framework = 'Angular'
    } else if (lowerHtml.includes('data-v-') && (lowerHtml.includes('vue') || /\bvuejs?\b/.test(lowerHtml))) {
      framework = 'Vue.js'
    } else if (lowerHtml.includes('data-sveltekit') || lowerHtml.includes('__sveltekit_') || lowerHtml.includes('sveltekit-')) {
      framework = 'SvelteKit'
    } else if (lowerHtml.includes('data-astro') || lowerHtml.includes('astro-island')) {
      framework = 'Astro'
    } else if (lowerHtml.includes('gatsby-') && (lowerHtml.includes('gatsby-script') || lowerHtml.includes('gatsby-image'))) {
      framework = 'Gatsby'
    } else if (lowerHtml.includes('q:container') || lowerHtml.includes('qwik/')) {
      framework = 'Qwik'
    } else if (lowerHtml.includes('_$hy(') || lowerHtml.includes('solid-js')) {
      framework = 'SolidJS'
    } else if (lowerHtml.includes('data-reactroot') || lowerHtml.includes('__react_devtools_global_hook__') || lowerHtml.includes('react-dom')) {
      framework = 'React'
    }

    // Libraries
    if (lowerHtml.includes('jquery')) libraries.push('jQuery')
    if (lowerHtml.includes('bootstrap')) libraries.push('Bootstrap')
    if (lowerHtml.includes('tailwind')) libraries.push('Tailwind CSS')
    if (lowerHtml.includes('alpinejs') || /\sx-data\s*=/.test(html)) libraries.push('Alpine.js')
    if (lowerHtml.includes('font-awesome') || lowerHtml.includes('fontawesome')) libraries.push('Font Awesome')
    if (lowerHtml.includes('cdn.jsdelivr.net')) libraries.push('jsDelivr CDN')
    if (lowerHtml.includes('aos.js') || lowerHtml.includes('data-aos')) libraries.push('AOS')

    // Server & CDN
    const serverHeader = headers['server'] || null
    const poweredBy = headers['x-powered-by'] || null

    let cdn: string | null = null
    if (headers['cf-ray'] || (serverHeader || '').toLowerCase().includes('cloudflare')) cdn = 'Cloudflare'
    else if (headers['x-amz-cf-id'] || headers['x-amz-cf-pop']) cdn = 'Amazon CloudFront'
    else if (headers['x-fastly-request-id'] || (serverHeader || '').toLowerCase().includes('fastly')) cdn = 'Fastly'
    else if (headers['x-akamai-transformed'] || (serverHeader || '').toLowerCase().includes('akamai')) cdn = 'Akamai'
    else if (headers['x-vercel-id'] || headers['x-vercel-cache']) cdn = 'Vercel Edge Network'
    else if (headers['x-nf-request-id'] || (serverHeader || '').toLowerCase().includes('netlify')) cdn = 'Netlify Edge'
    else if ((serverHeader || '').toLowerCase().includes('keycdn')) cdn = 'KeyCDN'

    if (headers['x-vercel-id']) hostingHints.push('Vercel')
    if (headers['x-nf-request-id']) hostingHints.push('Netlify')
    if ((serverHeader || '').toLowerCase().includes('github.com')) hostingHints.push('GitHub Pages')
    if (headers['x-azure-ref']) hostingHints.push('Azure')
    if (headers['x-served-by'] && headers['x-served-by'].toLowerCase().includes('cache-')) hostingHints.push('Fastly-fronted')

    const techStack = {
      cms,
      cmsConfidence,
      framework,
      builderTool,
      server: serverHeader,
      poweredBy,
      cdn,
      hostingHints,
      libraries
    }

    // === SECURITY (page content) ===
    const isHttps = (url || '').startsWith('https://')
    let mixedContent = 0
    if (isHttps) {
      $('img[src^="http:" i], script[src^="http:" i], link[href^="http:" i], iframe[src^="http:" i]').each(() => {
        mixedContent++
      })
    }
    const externalScriptsWithSri = $('script[src][integrity]').length
    const externalScriptsTotal = $('script[src]').filter((_, el) => {
      const src = $(el).attr('src') || ''
      try {
        const u = new URL(src, url)
        return u.hostname !== pageHostname
      } catch { return false }
    }).length

    const security = {
      hasHttpsLinks: externalLinks > 0 ? $('a[href^="https" i]').length >= $('a[href^="http" i]').length : true,
      mixedContent,
      hasIntegrityAttrs: externalScriptsTotal > 0 && externalScriptsWithSri > 0
    }

    return {
      title: titleVal,
      titleLength,
      metaDescription: metaDescVal,
      metaDescriptionLength: metaDescLength,
      canonicalUrl,
      metaRobots,
      metaRobotsBlocksIndex,
      metaCharset,
      metaViewport,
      hasViewport,
      htmlLang,
      hasLang,
      hasFavicon,
      openGraph,
      openGraphCompleteness,
      twitterCard,
      headings,
      images,
      links,
      scripts,
      stylesheets,
      htmlSizeKb,
      wordCount,
      trackers,
      liveChat,
      cookieConsent,
      conversion,
      trust,
      structuredData,
      techStack,
      security
    }
  }
}

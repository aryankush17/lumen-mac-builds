import { SiteProfile, SiteType } from './SiteClassifier'
import { ScoreSheet } from './ScoreEngine'
import { Severity } from './CheckRegistry'
import { CrawlResult } from '../CrawlerService'
import { ExtractedFeatures } from '../FeatureExtractionService'

export interface Recommendation {
  title: string
  /** What's wrong */
  problem: string
  /** Why it matters */
  reason: string
  /** What it costs the business */
  businessImpact: string
  /** The fix */
  solution: string
  priority: 'high' | 'medium' | 'low'
  category: string
  confidenceScore: number
  points: number
  /** The underlying check id, for traceability */
  checkId?: string
}

/**
 * Maps a finding (from the score breakdown) into a richer recommendation
 * tailored to the site type. The reason / business-impact / solution copy
 * varies by what kind of site this is — a saas product gets different
 * advice than a dental clinic.
 */
export class RecommendationEngine {
  static generate(profile: SiteProfile, scoreSheet: ScoreSheet, crawl: CrawlResult, features: ExtractedFeatures): Recommendation[] {
    const recs: Recommendation[] = []
    const type = profile.type

    // Calculate dynamic base confidence based on crawl success and parsing quality
    let baseConfidence = 100
    if (!crawl.success) {
      baseConfidence = 0
    } else {
      if (crawl.statusCode < 200 || crawl.statusCode >= 300) {
        baseConfidence -= 10
      }
      if (!crawl.sslValid) {
        baseConfidence -= 15
      }
      if (!crawl.html || crawl.html.trim().length === 0) {
        baseConfidence -= 20
      }
    }

    for (const item of scoreSheet.breakdown) {
      const priority: Recommendation['priority'] =
        item.severity === 'critical' ? 'high' :
        item.severity === 'high' ? 'high' :
        item.severity === 'medium' ? 'medium' : 'low'

      // Check specifically if this validator execution succeeded
      const matchingCheck = scoreSheet.scoredChecks.find(sc => sc.label === item.label)
      let itemConfidence = baseConfidence
      if (matchingCheck && matchingCheck.result.value === 'Check error') {
        itemConfidence -= 50
      }
      const confidenceScore = Math.max(10, Math.min(100, itemConfidence))

      // Map check label → contextual rec via the recipe library below
      const recipe = this.findRecipe(item.label, type)
      if (recipe) {
        recs.push({
          title: recipe.title,
          problem: item.reason,
          reason: recipe.reason,
          businessImpact: recipe.businessImpact,
          solution: recipe.solution,
          priority,
          category: item.category[0].toUpperCase() + item.category.slice(1),
          confidenceScore,
          points: item.points,
          checkId: undefined
        })
      } else {
        // Fallback — generate from the breakdown item directly
        recs.push({
          title: this.fixUpTitle(item.label),
          problem: item.reason,
          reason: `This check applies to ${type.replace(/_/g, ' ')} sites of your size.`,
          businessImpact: this.genericImpact(item.severity),
          solution: item.recommendation,
          priority,
          category: item.category[0].toUpperCase() + item.category.slice(1),
          confidenceScore,
          points: item.points
        })
      }
    }

    // Sort: priority first, then points
    const priOrder: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 1, low: 2 }
    recs.sort((a, b) => {
      if (priOrder[a.priority] !== priOrder[b.priority]) return priOrder[a.priority] - priOrder[b.priority]
      return b.points - a.points
    })

    return recs
  }

  private static fixUpTitle(label: string): string {
    // Take a check label like "Server Response Time" or "LocalBusiness Schema"
    // and turn it into an actionable title.
    if (/missing|no |not /i.test(label)) return label
    return `Improve ${label}`
  }

  private static genericImpact(severity: Severity): string {
    return {
      critical: 'Resolving this is essential — without it the page cannot perform its primary job.',
      high: 'High-leverage fix with measurable conversion / SEO impact.',
      medium: 'Meaningful improvement that compounds with other fixes.',
      low: 'Polish item — fix when other priorities are addressed.',
      info: 'Informational.'
    }[severity]
  }

  /**
   * Find a contextual recipe for a given check + site type.
   * Recipes are tuples of (matcher_pattern, site_type_filter, recipe_content).
   * The first matching recipe wins.
   */
  private static findRecipe(checkLabel: string, type: SiteType): Recipe | null {
    for (const r of RECIPE_LIBRARY) {
      if (!r.match.test(checkLabel)) continue
      if (r.types && !r.types.includes(type)) continue
      return r.recipe(type)
    }
    return null
  }
}

interface Recipe {
  title: string
  reason: string
  businessImpact: string
  solution: string
}

interface RecipeEntry {
  match: RegExp
  types?: SiteType[]
  recipe: (t: SiteType) => Recipe
}

const RECIPE_LIBRARY: RecipeEntry[] = [
  // ── HTTPS / SSL ──────────────────────────────────────────────────────────
  {
    match: /^HTTPS \/ SSL$/i,
    recipe: () => ({
      title: 'Install SSL Certificate (HTTPS)',
      reason: 'Chrome shows a prominent "Not Secure" warning on HTTP sites and may block form submissions. SSL is also a confirmed Google ranking factor.',
      businessImpact: 'HTTP sites bounce 60-80% of cold traffic immediately. Fixing this is the single highest-impact change available.',
      solution: 'Use Let\'s Encrypt (free) via your hosting panel, or enable SSL through Cloudflare (also free and adds CDN benefits). Configure a 301 redirect from HTTP to HTTPS so all traffic lands on the secure URL.'
    })
  },

  // ── Title Tag ────────────────────────────────────────────────────────────
  {
    match: /^Title Tag$/i,
    recipe: (t) => ({
      title: 'Optimise the Title Tag',
      reason: 'The title tag is the most heavily weighted on-page ranking factor and the clickable text in search results.',
      businessImpact: 'A well-written title lifts organic click-through-rate by 15-30% even at the same ranking position.',
      solution: t === 'ecommerce'
        ? 'Use the format "Product Name — Key Feature | Brand". Keep it 40-60 chars. Include a benefit hook ("Free Shipping", "Lifetime Warranty").'
        : t === 'local_business'
          ? 'Use the format "Service in City | Brand". Example: "Family Dentist in [City] | Acme Dental". 40-60 chars.'
          : t === 'saas_product'
            ? 'Lead with the value proposition. Example: "Build APIs in minutes — Toolname". Keep it 40-60 chars and avoid filler.'
            : 'Write a 40-60 char title leading with the primary keyword, then the brand. Avoid filler words like "Welcome to".'
    })
  },

  // ── Meta Description ─────────────────────────────────────────────────────
  {
    match: /^Meta Description$/i,
    recipe: () => ({
      title: 'Write a Meta Description',
      reason: 'Without one, Google scrapes a random snippet from the page — usually a poor match for the searcher\'s intent.',
      businessImpact: 'A persuasive 120-160 char description with a soft CTA lifts SERP click-through-rate by 10-20%.',
      solution: 'Add <meta name="description" content="..."> with 120-160 chars. Lead with the value, address the pain, end with a soft CTA ("Book a free consultation").'
    })
  },

  // ── H1 ───────────────────────────────────────────────────────────────────
  {
    match: /^H1 Heading$/i,
    recipe: (t) => ({
      title: 'Add a Clear H1',
      reason: 'H1 tells search engines and screen readers the primary topic of the page. Its absence weakens topical relevance.',
      businessImpact: 'Adding a keyword-rich H1 typically lifts the page\'s rank for its primary term by several positions.',
      solution: t === 'local_business'
        ? 'Make your H1 specific: "Trusted Family Dentist in [City Name]". Include city + service.'
        : t === 'saas_product'
          ? 'Lead with the outcome you deliver. Example: "Ship better code reviews in half the time."'
          : 'Wrap the main hero headline in <h1>…</h1>. Include the page\'s primary target keyword. Use exactly one H1 per page.'
    })
  },

  // ── Mobile Responsive ────────────────────────────────────────────────────
  {
    match: /Mobile Responsive/i,
    recipe: () => ({
      title: 'Add the Mobile Viewport Meta Tag',
      reason: 'Without <meta name="viewport">, the page renders at desktop width on phones. Text becomes microscopic and visitors must scroll sideways.',
      businessImpact: 'Over 60% of web traffic is mobile. A non-responsive site loses essentially all mobile conversions, no matter what else is on the page.',
      solution: 'Add <meta name="viewport" content="width=device-width, initial-scale=1.0"> in the <head>. Then audit your CSS breakpoints to confirm the layout actually adapts to mobile widths.'
    })
  },

  // ── Server Response (TTFB) ───────────────────────────────────────────────
  {
    match: /Server Response Time/i,
    recipe: (t) => ({
      title: 'Speed Up Server Response',
      reason: 'Slow TTFB delays every other rendering metric. Google flags TTFB over 1.5s as a critical issue and visitors abandon pages that take longer than 3s to start loading.',
      businessImpact: 'Cutting TTFB to under 600ms typically reduces bounce by 10-20% and lifts mobile conversion noticeably.',
      solution: t === 'ecommerce'
        ? 'Most slow Shopify / WooCommerce sites are slow because of bloated themes or apps. Audit installed apps, remove unused JS, enable Cloudflare in front of the store, and turn on full page caching.'
        : 'Enable gzip/brotli compression; add Cache-Control headers for HTML; put Cloudflare (free) in front of your origin; profile and fix slow backend queries.'
    })
  },

  // ── Web Analytics ────────────────────────────────────────────────────────
  {
    match: /Web Analytics/i,
    recipe: () => ({
      title: 'Install Google Analytics 4',
      reason: 'Without analytics, every marketing decision is blind — no data on traffic sources, conversion paths, or drop-off points.',
      businessImpact: 'GA4 is free. It pays back its setup cost the first week by revealing which channels actually convert.',
      solution: 'Create a GA4 property at analytics.google.com; install the gtag.js snippet in the <head> of every page or deploy via GTM. Set up conversion events for your primary action (purchase, form submit, booking).'
    })
  },

  // ── Retargeting Pixel — only for ecommerce/saas/agency (filtered above) ──
  {
    match: /Retargeting Pixel/i,
    recipe: (t) => ({
      title: 'Install Meta Pixel for Retargeting',
      reason: 'Without a Pixel, you cannot build retargeting audiences. Cold prospecting on Meta is 5-10× more expensive than retargeting warm visitors.',
      businessImpact: t === 'ecommerce'
        ? 'Cart abandoners typically convert at 8-15% with retargeting ads vs 0% if they\'re not in an audience. Adds up to thousands per month for any active store.'
        : 'Trial dropoffs typically re-convert at 5-10% with retargeting. The pixel needs to be installed BEFORE the campaign, not on launch day.',
      solution: 'In Meta Business Manager → Events Manager → create a Pixel; paste the base code in <head>; fire PageView automatically; add Purchase/Lead events tied to your conversion actions.'
    })
  },

  // ── Lead Capture Form (saas/local/agency/edu) ────────────────────────────
  {
    match: /Lead Capture Form/i,
    recipe: (t) => ({
      title: 'Add a Real Lead Capture Form',
      reason: 'Visitors who can\'t find a form will hunt for an email address — most won\'t bother and will leave silently.',
      businessImpact: 'A 3-field form (name, email, message) on the homepage typically doubles inbound enquiries vs just listing an email address.',
      solution: t === 'agency_services'
        ? 'Add a "Start a project" form with: name, company, project budget range, project description. Send to a CRM or a Slack channel for instant response.'
        : t === 'saas_product'
          ? 'Make the form a 2-field demo request (email + company size). Tie it to a Calendly link so visitors self-schedule immediately.'
          : 'Add a 3-field form (name, email, message) on the homepage hero and on a dedicated /contact page. The confirmation message should be specific — "We reply within 4 business hours."'
    })
  },

  // ── Contact Mechanism ────────────────────────────────────────────────────
  {
    match: /Contact Mechanism/i,
    recipe: (t) => ({
      title: 'Add a Visible Contact Channel',
      reason: 'High-intent visitors leave if they can\'t find any way to reach you within seconds. This is one of the highest-impact fixes available.',
      businessImpact: 'For local businesses, adding a visible phone number alone lifts mobile conversion by 20-40%.',
      solution: t === 'local_business'
        ? 'Put a phone number in the header that works as a tap-to-call link on mobile (<a href="tel:...">). Add a WhatsApp link too if your audience uses WhatsApp — in many regions it converts higher than forms.'
        : t === 'personal_portfolio'
          ? 'A visible mailto: email is enough for a portfolio. Add it in the header or footer and ensure it\'s clickable.'
          : 'Add at least two channels: a contact form for general enquiries and an instant channel (live chat OR phone OR WhatsApp) for warm visitors.'
    })
  },

  // ── CTAs ─────────────────────────────────────────────────────────────────
  {
    match: /Calls-to-Action/i,
    recipe: (t) => ({
      title: 'Add Clear Calls-to-Action',
      reason: 'Without high-contrast CTAs telling visitors what to do next, conversion collapses regardless of how compelling the content is.',
      businessImpact: 'Adding a single prominent above-the-fold CTA typically lifts conversion rate by 30-100%.',
      solution: t === 'saas_product'
        ? 'Add "Start Free Trial" or "Book a Demo" as the primary above-the-fold CTA. Repeat at the bottom of every feature section.'
        : t === 'ecommerce'
          ? 'Every product card needs a clear "Add to Cart". Every category page needs a "Shop the Collection". Make CTA buttons high-contrast (not white-on-white).'
          : t === 'local_business'
            ? 'Add "Book Appointment", "Call Now", or "Get Directions" above the fold. Repeat mid-page and in the footer.'
            : 'Add a high-contrast CTA above the fold. Repeat the CTA at the bottom of every section.'
    })
  },

  // ── Booking System ───────────────────────────────────────────────────────
  {
    match: /Booking \/ Scheduling/i,
    recipe: (t) => ({
      title: 'Add Self-Service Booking',
      reason: 'When a prospect emails back-and-forth to schedule a call, momentum dies and the competitor catches up.',
      businessImpact: 'Self-serve scheduling lifts meeting bookings by 20-40% vs email coordination.',
      solution: t === 'local_business'
        ? 'Install a booking tool that suits your business — Calendly for consultations, Setmore for appointments, or your industry vertical equivalent. Link it from the primary CTA button.'
        : 'Install Calendly (free), Cal.com, or HubSpot Meetings. Embed it on the homepage and pop it from a "Book a Demo" button.'
    })
  },

  // ── Phone Visible (local_business) ───────────────────────────────────────
  {
    match: /Phone Number Visible/i,
    recipe: () => ({
      title: 'Show a Click-to-Call Phone Number',
      reason: 'For local services, the phone is still the dominant conversion channel. High-intent visitors want to call, not fill a form.',
      businessImpact: 'A click-to-call link in the mobile header typically lifts call volume by 30-50%.',
      solution: 'Add the phone number prominently in the header. On mobile, wrap it in <a href="tel:+91..."> so it dials with one tap.'
    })
  },

  // ── Physical Address ─────────────────────────────────────────────────────
  {
    match: /Physical Address/i,
    recipe: () => ({
      title: 'Display Your Physical Address',
      reason: 'For local businesses, the address is core to local SEO. It also signals legitimacy — visitors trust addresses they can verify.',
      businessImpact: 'Sites with full NAP (Name, Address, Phone) consistency rank significantly higher in Google\'s "near me" results.',
      solution: 'Display your full street address in the footer at minimum. Embed a Google Maps iframe pointing to your location. Make sure the same address appears identically in Google My Business.'
    })
  },

  // ── Local Business Schema ────────────────────────────────────────────────
  {
    match: /LocalBusiness Schema/i,
    recipe: () => ({
      title: 'Add LocalBusiness JSON-LD Schema',
      reason: 'Schema markup is what powers Google\'s Knowledge Panel, Maps results, and "near me" rich results.',
      businessImpact: 'LocalBusiness schema directly drives the Knowledge Panel that appears for branded searches — major trust lift and click-through boost.',
      solution: 'Add a JSON-LD <script type="application/ld+json"> block with: @type (LocalBusiness or your specific vertical like Dentist/Restaurant), name, address, telephone, geo coordinates, openingHours, priceRange, image, and aggregateRating if you have reviews.'
    })
  },

  // ── Product Schema (ecommerce) ───────────────────────────────────────────
  {
    match: /Product Schema/i,
    recipe: () => ({
      title: 'Add Product JSON-LD Schema',
      reason: 'Product schema is required for Google Shopping rich results and price/rating SERP snippets.',
      businessImpact: 'Pages with rich product results see 20-40% higher CTR than plain text listings at the same rank.',
      solution: 'Add JSON-LD Product schema on every product page with: name, image (multiple), description, sku, brand, offers.price, offers.priceCurrency, offers.availability, and aggregateRating + review count if available.'
    })
  },

  // ── Article Schema (informational) ───────────────────────────────────────
  {
    match: /Article Schema/i,
    recipe: () => ({
      title: 'Add Article JSON-LD Schema',
      reason: 'Article schema drives Google Discover traffic and Top Stories results for news/blog content.',
      businessImpact: 'Sites without Article schema miss out on the discover/news traffic loop that compounds over time.',
      solution: 'Add JSON-LD Article (or NewsArticle / BlogPosting) schema on every article with: headline, image, datePublished, dateModified, author, publisher.'
    })
  },

  // ── Testimonials ─────────────────────────────────────────────────────────
  {
    match: /Testimonials \/ Social Proof/i,
    recipe: (t) => ({
      title: 'Add Customer Testimonials',
      reason: 'New visitors don\'t trust your brand yet. Social proof — real names, photos, company logos — is the fastest trust-builder.',
      businessImpact: 'Adding 3-5 testimonials with photos typically lifts conversion rate by 15-25%.',
      solution: t === 'saas_product'
        ? 'Add a logo bar of recognisable customer brands above the fold. Add 3-5 detailed quote-style testimonials (with company role + headshot) further down. Link to longer case studies for high-value enterprise pages.'
        : t === 'agency_services'
          ? 'Display selected client logos + quotes. For each major case study, include the outcome metric (e.g. "Drove $1.2M in pipeline in 6 months"). Real numbers beat adjectives.'
          : t === 'local_business'
            ? 'Embed a Google Reviews / Yelp / Trustpilot widget on the homepage. Add 3-5 written testimonials with the customer\'s first name and city.'
            : 'Add a "What our clients say" section with 3-5 quotes including the client\'s name, photo, role, and company.'
    })
  },

  // ── Trust Signals ────────────────────────────────────────────────────────
  {
    match: /Trust Signals/i,
    recipe: (t) => ({
      title: 'Strengthen Trust Signals',
      reason: 'Visitors look for trust signals subconsciously when deciding whether to engage. Their absence implies a fly-by-night operation.',
      businessImpact: 'Complete trust signals reduce purchase hesitation and typically lift conversion by 5-15%.',
      solution: t === 'ecommerce'
        ? 'Add: privacy policy link, return policy link, payment-provider badges (Visa, Mastercard, PayPal, regional gateways etc.) near checkout, customer support contact, secure-checkout badge near payment.'
        : 'Generate a privacy policy at termsfeed.com or iubenda.com (free); add terms of service; link your Instagram, LinkedIn, and other socials in the footer; display your address if possible.'
    })
  },

  // ── Pricing Page (saas/agency) ───────────────────────────────────────────
  {
    match: /Pricing Visible/i,
    recipe: (t) => ({
      title: 'Make Pricing Visible',
      reason: 'Hidden pricing increases bounce rate sharply because visitors assume you\'re expensive or untrustworthy.',
      businessImpact: 'Public pricing pre-qualifies leads and cuts unqualified discovery calls by 30-50%.',
      solution: t === 'saas_product'
        ? 'Build a /pricing page with 2-3 plan tiers. Show starting prices and what each plan includes. For enterprise, end with "Custom — Contact Sales".'
        : 'At minimum, publish starting prices or price bands. For agencies: "Projects start at $X". Even ranges qualify out price-sensitive buyers.'
    })
  },

  // ── Demo / Trial CTA (saas) ──────────────────────────────────────────────
  {
    match: /Demo \/ Trial CTA/i,
    recipe: () => ({
      title: 'Add a Trial or Demo Entry Point',
      reason: 'SaaS sites without a "Start Free Trial" or "Book a Demo" CTA convert near zero on cold traffic. There\'s no next step for an interested visitor.',
      businessImpact: 'A clear above-the-fold trial CTA typically lifts top-of-funnel signups by 2-3×.',
      solution: 'Add either "Start Free Trial" (for self-serve products) or "Book a Demo" (for higher-touch products) as the primary above-the-fold CTA in the hero. Repeat at the bottom of every feature section.'
    })
  },

  // ── Case Studies (agency) ────────────────────────────────────────────────
  {
    match: /Case Studies \/ Portfolio/i,
    recipe: () => ({
      title: 'Show Real Client Work',
      reason: 'Agencies without visible portfolio or case studies appear unproven. Prospects shortlist agencies based on demonstrated work.',
      businessImpact: 'A polished work showcase typically halves the time-to-shortlist for new prospect enquiries.',
      solution: 'Build a /work or /case-studies section with 3-6 detailed write-ups. Each should include: client name, project goal, the work delivered, and a clear outcome metric. Lead with logos visitors will recognise.'
    })
  },

  // ── Donate CTA (nonprofit) ───────────────────────────────────────────────
  {
    match: /Donate CTA/i,
    recipe: () => ({
      title: 'Add a Donate Call-to-Action',
      reason: 'For nonprofits, "Donate" is the primary conversion. Burying or omitting the donate CTA collapses donation rate.',
      businessImpact: 'Prominent donate buttons on the homepage and header typically triple online donation volume.',
      solution: 'Add a high-contrast "Donate Now" button in the header (visible across the entire site). Repeat in the hero, after the mission statement, and after impact stories. Connect to a payment processor (Stripe, GiveLively, DonorBox, or a regional gateway).'
    })
  },

  // ── Cart & Checkout (ecommerce) ──────────────────────────────────────────
  {
    match: /Cart & Checkout Flow/i,
    recipe: () => ({
      title: 'Build a Visible Cart & Checkout Path',
      reason: 'Without a clear cart and checkout flow, visitors can\'t complete a purchase. This is the fundamental e-commerce conversion gate.',
      businessImpact: 'Cart icon visibility in the header + a clear checkout CTA can lift conversion rate by 25-50% on e-commerce sites that lack them.',
      solution: 'Put a persistent cart icon (with item count) in the header. Make "Add to Cart" buttons visible on every product card. Build a streamlined checkout (guest checkout, minimal fields, address autofill, multiple payment options).'
    })
  },

  // ── Payment Trust Badges (ecommerce) ─────────────────────────────────────
  {
    match: /Payment Trust Badges/i,
    recipe: () => ({
      title: 'Display Payment Trust Badges',
      reason: 'New shoppers worry about giving payment info to unfamiliar stores. Visible payment-provider badges reassure them.',
      businessImpact: 'Adding payment trust badges near checkout typically reduces cart abandonment by 5-12%.',
      solution: 'Display Visa, Mastercard, Amex, PayPal, or whichever providers you use near the checkout button. Add an "SSL Secure Checkout" badge. Include money-back guarantee text if you offer one.'
    })
  },

  // ── Security Headers ─────────────────────────────────────────────────────
  {
    match: /Security Headers/i,
    recipe: () => ({
      title: 'Add Security Response Headers',
      reason: 'These headers protect against clickjacking, MIME-sniffing, XSS, and protocol downgrade attacks. Their absence shows up in security audits during procurement.',
      businessImpact: 'Closes attack surface that auditors and enterprise buyers check during procurement reviews.',
      solution: 'In Nginx: add_header Strict-Transport-Security "max-age=31536000"; add_header X-Frame-Options "SAMEORIGIN"; add_header X-Content-Type-Options "nosniff"; add_header Referrer-Policy "strict-origin-when-cross-origin". Cloudflare offers one-click header bundles.'
    })
  },

  // ── Admin Exposure ───────────────────────────────────────────────────────
  {
    match: /Exposed Admin Paths/i,
    recipe: () => ({
      title: 'Restrict Admin Path Access',
      reason: 'Publicly accessible admin URLs are the most common foothold for automated attacks. Even login pages on default paths get attacked thousands of times per day.',
      businessImpact: 'Closing these paths blocks the majority of opportunistic site compromises.',
      solution: 'For WP-Admin: install an IP allowlist plugin or block /wp-admin/ at the web-server level. For exposed .env/.git: block these paths at Nginx/Apache. Add a Web Application Firewall (Cloudflare WAF or Sucuri) for broader protection.'
    })
  },

  // ── Open Graph ───────────────────────────────────────────────────────────
  {
    match: /Open Graph Tags/i,
    recipe: () => ({
      title: 'Complete Open Graph Tags',
      reason: 'When the page is shared on social media, Open Graph tags control what the link preview looks like.',
      businessImpact: 'A polished social preview with image + headline gets 2-3× more clicks than a bare URL.',
      solution: 'Add to the head: <meta property="og:title">, og:description, og:image (1200×630px), og:url, og:type. Also add <meta name="twitter:card" content="summary_large_image"> for Twitter/X.'
    })
  },

  // ── Crawlable content ────────────────────────────────────────────────────
  {
    match: /Crawlable Content/i,
    recipe: (t) => ({
      title: 'Add Server-Side Rendering',
      reason: 'A non-JS crawler sees an empty page. Google can render JavaScript but it delays indexing by days-to-weeks and budgets crawl resources elsewhere.',
      businessImpact: 'SPAs without SSR rank significantly worse than their server-rendered competitors for new pages and content updates.',
      solution: t === 'saas_product'
        ? 'For marketing pages: move to Next.js or Astro with static generation. For app pages behind login: not relevant for SEO.'
        : 'Switch the framework to a server-rendering mode (Next.js getStaticProps, Nuxt asyncData) or pre-render the homepage and marketing pages as static HTML.'
    })
  },

  // ── Structured Data ──────────────────────────────────────────────────────
  {
    match: /^Structured Data$/i,
    recipe: (t) => ({
      title: 'Add JSON-LD Structured Data',
      reason: 'Structured data enables rich results in Google: star ratings, FAQ accordions, business hours, breadcrumbs, recipe cards.',
      businessImpact: 'Pages with rich results typically see 20-40% higher CTR at the same ranking position.',
      solution: t === 'local_business'
        ? 'Add LocalBusiness (or vertical-specific like Dentist/Restaurant) schema with name, address, phone, openingHours.'
        : t === 'ecommerce'
          ? 'Add Product schema with name, image, price, currency, availability, and aggregateRating.'
          : t === 'informational'
            ? 'Add Article (or NewsArticle/BlogPosting) schema with headline, image, datePublished, author.'
            : 'Add the schema type that best fits your business (Organization, LocalBusiness, Product, Article). Validate at schema.org/validator.'
    })
  },

  // ── Newsletter Signup ────────────────────────────────────────────────────
  {
    match: /Newsletter Signup/i,
    recipe: () => ({
      title: 'Add an Email Newsletter Signup',
      reason: 'Email is consistently the highest-ROI marketing channel. Without lead capture, you have no list to remarket to.',
      businessImpact: 'A modest newsletter with 1,000 engaged subscribers typically generates 5-15 qualified leads per month at near-zero cost.',
      solution: 'Add a dedicated newsletter signup (email-only form, NOT a full contact form). Place it in the footer at minimum, and ideally also as a sticky bar or modal. Offer a lead magnet (PDF guide, free template) to increase opt-in rates.'
    })
  },

  // ── Sitemap ──────────────────────────────────────────────────────────────
  {
    match: /XML Sitemap/i,
    recipe: () => ({
      title: 'Publish an XML Sitemap',
      reason: 'Sitemaps let search engines discover every URL on your site, including pages with few internal links.',
      businessImpact: 'Sitemaps accelerate indexing of new content from weeks to days — critical for sites publishing frequently.',
      solution: 'Generate /sitemap.xml — Yoast plugin for WordPress, next-sitemap for Next.js, or generate it manually. Submit the URL in Google Search Console.'
    })
  },

  // ── Image Alt Text ───────────────────────────────────────────────────────
  {
    match: /Image Alt Text/i,
    recipe: () => ({
      title: 'Add Image Alt Text',
      reason: 'Alt text helps Google Images understand and rank your images, and is required for WCAG accessibility compliance.',
      businessImpact: 'Properly tagged images can drive 5-15% additional organic traffic from Google Image Search.',
      solution: 'Add alt="descriptive text" to each <img> element — describe what the image shows, naturally including relevant keywords. Use empty alt="" for purely decorative images.'
    })
  },

  // ── Compression ──────────────────────────────────────────────────────────
  {
    match: /Response Compression/i,
    recipe: () => ({
      title: 'Enable Response Compression',
      reason: 'Without gzip or brotli, HTML/CSS/JS files are sent at full size — typically 3-4× larger than compressed.',
      businessImpact: 'Enabling compression cuts payload by 60-80% and improves first-paint time on every page load.',
      solution: 'On Nginx: gzip on; gzip_types text/plain text/css application/javascript application/json. On Apache: enable mod_deflate. Most CDNs (Cloudflare, Fastly, BunnyCDN) handle this automatically.'
    })
  },

  // ── Caching ──────────────────────────────────────────────────────────────
  {
    match: /Browser Caching/i,
    recipe: () => ({
      title: 'Configure HTTP Caching Headers',
      reason: 'Without caching directives, every visit re-downloads the full page including unchanged assets.',
      businessImpact: 'Caching reduces server load and makes repeat visits feel instant — directly lifts repeat-visitor conversion.',
      solution: 'Add Cache-Control: public, max-age=3600 for HTML; max-age=31536000, immutable for hashed asset filenames. Configure at your CDN or web server level.'
    })
  }
]

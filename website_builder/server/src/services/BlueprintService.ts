import { v4 as uuidv4 } from 'uuid'
import { classifyNiche, getNicheProfile, NicheProfile } from './NicheLibrary'
import { getDb } from '../database/init'

/**
 * The user-submitted form data. Every field is optional — the service
 * degrades gracefully on partial inputs but produces a richer prompt
 * with more context.
 */
export interface BlueprintInput {
  // — Business identity —
  businessName: string
  industry?: string                    // Free-text industry description
  businessModel?: string               // e.g. "subscription SaaS", "appointment-based services"
  productOrService?: string            // What you sell
  yearFounded?: string

  // — Audience —
  targetAudience?: string              // Who buys
  geographicMarket?: string            // Cities / regions / countries served
  language?: string                    // Primary language(s)

  // — Goals —
  primaryGoal?: 'leads' | 'sales' | 'bookings' | 'donations' | 'signups' | 'awareness' | 'other'
  primaryGoalOther?: string
  secondaryGoals?: string[]

  // — Content —
  services?: string                    // Multi-line list of services / products
  uniqueValueProp?: string             // What makes you different
  brandVoice?: string                  // e.g. "warm and approachable", "authoritative"
  existingCopy?: string                // Any draft copy the user has

  // — Brand assets —
  hasLogo?: boolean
  hasBrandColors?: boolean
  brandColors?: string                 // "Primary #6C47FF, Accent #FFD700"
  preferredFonts?: string

  // — References —
  inspirationSites?: string            // URLs of sites they like

  // — Must-haves —
  requiredFeatures?: string            // Specific functionality requested
  integrationsNeeded?: string          // Specific integrations needed

  // — Technical —
  budgetTier?: 'low' | 'mid' | 'high' | 'unknown'
  timeline?: string
  compliance?: string                  // GDPR, HIPAA, PCI, etc.
}

export interface Blueprint {
  id: string
  createdAt: string
  input: BlueprintInput
  /** The classified niche this blueprint targets */
  niche: string
  /** Resolved profile from the library */
  profile: NicheProfile
  /** AI summary of business + audience + goal */
  businessSummary: string
  /** Structured plan: pages, sections, components */
  plan: BlueprintPlan
  /** The final prompt — paste-ready into Claude / v0 / Lovable / Cursor */
  aiPrompt: string
}

export interface BlueprintPlan {
  pages: Array<{ path: string; label: string; purpose: string }>
  homeSections: Array<{ name: string; purpose: string; must: string[] }>
  primaryConversion: { type: string; label: string; notes: string }
  trustSignals: string[]
  schemaTypes: string[]
  tracking: {
    googleAnalytics: boolean
    metaPixel: boolean
    linkedinInsight: boolean
    tagManager: boolean
    notes: string
  }
  visualStyle: {
    palette: string
    typography: string
    imagery: string
    mood: string
  }
  technical: string[]
  integrations: string[]
}

export class BlueprintService {
  /**
   * Main entry: take user form input, return a finished Blueprint.
   * Pure function — no side effects except optional DB persistence.
   */
  static generate(input: BlueprintInput): Blueprint {
    const id = uuidv4()
    const createdAt = new Date().toISOString()

    // 1. Classify niche
    const niche = classifyNiche({
      industry: input.industry,
      businessModel: input.businessModel,
      services: input.services,
      targetAudience: input.targetAudience,
      productOrService: input.productOrService
    })

    // 2. Resolve profile from library
    const profile = getNicheProfile(niche)

    // 3. Build business summary
    const businessSummary = this.buildBusinessSummary(input, profile)

    // 4. Build structured plan (profile + user overrides)
    const plan = this.buildPlan(input, profile)

    // 5. Generate the AI builder prompt
    const aiPrompt = this.buildAiPrompt(input, profile, plan, businessSummary)

    return { id, createdAt, input, niche, profile, businessSummary, plan, aiPrompt }
  }

  /**
   * Persist the blueprint to SQLite so it's recoverable later.
   * Failures here are non-fatal — the caller still gets the blueprint back.
   */
  static save(blueprint: Blueprint): void {
    const db = getDb()
    db.prepare(`
      INSERT OR REPLACE INTO blueprints
      (id, created_at, business_name, niche, raw_data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      blueprint.id,
      blueprint.createdAt,
      blueprint.input.businessName,
      blueprint.niche,
      JSON.stringify(blueprint)
    )
  }

  static getById(id: string): Blueprint | null {
    const db = getDb()
    const row = db.prepare('SELECT raw_data FROM blueprints WHERE id = ?').get(id) as { raw_data: string } | undefined
    if (!row) return null
    return JSON.parse(row.raw_data)
  }

  static listAll(): Array<{ id: string; businessName: string; niche: string; createdAt: string }> {
    const db = getDb()
    return db.prepare(
      'SELECT id, business_name as businessName, niche, created_at as createdAt FROM blueprints ORDER BY created_at DESC'
    ).all() as any[]
  }

  // ─── INTERNAL BUILDERS ────────────────────────────────────────────────────

  private static buildBusinessSummary(input: BlueprintInput, profile: NicheProfile): string {
    const parts: string[] = []
    parts.push(`${input.businessName} is a ${profile.label.toLowerCase()}`)
    if (input.geographicMarket) parts.push(`serving ${input.geographicMarket}`)
    if (input.yearFounded) parts.push(`founded in ${input.yearFounded}`)

    let summary = parts.join(' ') + '.'

    if (input.targetAudience) {
      summary += ` Primary audience: ${input.targetAudience}.`
    }

    if (input.primaryGoal) {
      const goalLabel = this.goalLabel(input.primaryGoal, input.primaryGoalOther)
      summary += ` The website's primary goal is to generate ${goalLabel}.`
    }

    if (input.uniqueValueProp) {
      summary += ` Differentiator: ${input.uniqueValueProp}`
    }

    return summary
  }

  private static goalLabel(goal: BlueprintInput['primaryGoal'], other?: string): string {
    const map: Record<string, string> = {
      leads: 'qualified leads (form submissions or enquiries)',
      sales: 'product sales',
      bookings: 'appointment / consultation bookings',
      donations: 'donations',
      signups: 'trial signups',
      awareness: 'brand awareness and engagement',
      other: other || 'business outcomes'
    }
    return map[goal || 'leads']
  }

  private static buildPlan(input: BlueprintInput, profile: NicheProfile): BlueprintPlan {
    // Start from the niche profile (curated best-practice defaults)
    // and overlay user-specific requirements on top.
    const plan: BlueprintPlan = {
      pages: [...profile.pages],
      homeSections: [...profile.homeSections],
      primaryConversion: { ...profile.primaryConversion },
      trustSignals: [...profile.trustSignals],
      schemaTypes: [...profile.schemaTypes],
      tracking: { ...profile.tracking },
      visualStyle: { ...profile.visualStyle },
      technical: [...profile.technical],
      integrations: [...profile.integrations]
    }

    // User-requested features get appended to relevant lists
    if (input.requiredFeatures) {
      const userFeatures = this.splitMultiline(input.requiredFeatures)
      for (const feature of userFeatures) {
        if (!plan.technical.some(t => t.toLowerCase().includes(feature.toLowerCase()))) {
          plan.technical.push(feature)
        }
      }
    }

    if (input.integrationsNeeded) {
      const userIntegrations = this.splitMultiline(input.integrationsNeeded)
      for (const integration of userIntegrations) {
        if (!plan.integrations.some(i => i.toLowerCase().includes(integration.toLowerCase()))) {
          plan.integrations.push(integration)
        }
      }
    }

    // Override visual style if user supplied brand colors / fonts
    if (input.hasBrandColors && input.brandColors) {
      plan.visualStyle.palette = `${input.brandColors}. ${plan.visualStyle.palette}`
    }
    if (input.preferredFonts) {
      plan.visualStyle.typography = `${input.preferredFonts}. (Default niche guidance: ${plan.visualStyle.typography})`
    }

    // Compliance adds technical requirements
    if (input.compliance) {
      plan.technical.push(`Compliance: ${input.compliance}`)
    }

    return plan
  }

  /**
   * Build the AI builder prompt. Markdown-formatted, paste-ready into
   * Claude / v0 / Lovable / Cursor.
   *
   * Strategy: lead with business context, then required pages, then
   * homepage section-by-section, then technical/style/tracking guidance,
   * then build instructions.
   */
  private static buildAiPrompt(
    input: BlueprintInput,
    profile: NicheProfile,
    plan: BlueprintPlan,
    summary: string
  ): string {
    const lines: string[] = []

    // ── Preamble ─────────────────────────────────────────────────────────
    lines.push(`# Website Build Brief: ${input.businessName}`)
    lines.push('')
    lines.push(`You are building a complete, production-ready website. Read the entire brief before generating any code. The output should be a fully-styled, mobile-responsive site with real content scaffolded for the business described below — not a generic template.`)
    lines.push('')

    // ── Business context ────────────────────────────────────────────────
    lines.push('## Business Context')
    lines.push('')
    lines.push(summary)
    lines.push('')
    lines.push(`**Site type:** ${profile.label}`)
    lines.push('')
    lines.push(`**What this kind of site needs to do:** ${profile.positioning}`)
    lines.push('')

    if (input.brandVoice) {
      lines.push(`**Brand voice:** ${input.brandVoice}`)
      lines.push('')
    }

    if (input.uniqueValueProp) {
      lines.push(`**Unique differentiator:** ${input.uniqueValueProp}`)
      lines.push('')
    }

    if (input.services) {
      lines.push(`**Services / products offered:**`)
      for (const s of this.splitMultiline(input.services)) {
        lines.push(`- ${s}`)
      }
      lines.push('')
    }

    if (input.existingCopy) {
      lines.push('**Existing copy to use / adapt:**')
      lines.push('```')
      lines.push(input.existingCopy.trim())
      lines.push('```')
      lines.push('')
    }

    // ── Primary conversion ───────────────────────────────────────────────
    lines.push('## Primary Conversion Mechanism')
    lines.push('')
    lines.push(`The single most important action visitors should take: **${plan.primaryConversion.label}**`)
    lines.push('')
    lines.push(plan.primaryConversion.notes)
    lines.push('')

    // ── Required pages ──────────────────────────────────────────────────
    lines.push('## Required Pages')
    lines.push('')
    for (const page of plan.pages) {
      lines.push(`### ${page.label} (\`${page.path}\`)`)
      lines.push(page.purpose)
      lines.push('')
    }

    // ── Homepage section-by-section ─────────────────────────────────────
    lines.push('## Homepage Structure (top to bottom)')
    lines.push('')
    for (const section of plan.homeSections) {
      lines.push(`### ${section.name}`)
      lines.push(`*Purpose: ${section.purpose}*`)
      lines.push('')
      lines.push('Must include:')
      for (const item of section.must) {
        lines.push(`- ${item}`)
      }
      lines.push('')
    }

    // ── Trust signals ───────────────────────────────────────────────────
    lines.push('## Required Trust Signals')
    lines.push('')
    lines.push('Build these into the site (the specific implementation varies by section):')
    for (const t of plan.trustSignals) {
      lines.push(`- ${t}`)
    }
    lines.push('')

    // ── Visual direction ─────────────────────────────────────────────────
    lines.push('## Visual Style Direction')
    lines.push('')
    lines.push(`**Palette:** ${plan.visualStyle.palette}`)
    lines.push('')
    lines.push(`**Typography:** ${plan.visualStyle.typography}`)
    lines.push('')
    lines.push(`**Imagery:** ${plan.visualStyle.imagery}`)
    lines.push('')
    lines.push(`**Mood:** ${plan.visualStyle.mood}`)
    lines.push('')

    if (input.inspirationSites) {
      lines.push('**Reference sites the client likes:**')
      for (const url of this.splitMultiline(input.inspirationSites)) {
        lines.push(`- ${url}`)
      }
      lines.push('')
    }

    // ── Technical requirements ──────────────────────────────────────────
    lines.push('## Technical Requirements')
    lines.push('')
    for (const t of plan.technical) {
      lines.push(`- ${t}`)
    }
    lines.push('')

    // ── Schema markup ────────────────────────────────────────────────────
    if (plan.schemaTypes.length > 0) {
      lines.push('## Required Schema.org Markup')
      lines.push('')
      lines.push(`Embed JSON-LD blocks for these schema types so the site qualifies for rich SERP results:`)
      for (const s of plan.schemaTypes) {
        lines.push(`- \`${s}\``)
      }
      lines.push('')
      lines.push('Validate the final output at https://search.google.com/test/rich-results before launch.')
      lines.push('')
    }

    // ── Tracking ────────────────────────────────────────────────────────
    lines.push('## Marketing & Analytics Setup')
    lines.push('')
    const tr = plan.tracking
    if (tr.googleAnalytics) lines.push('- **Google Analytics 4** — install via GTM or direct script')
    if (tr.tagManager) lines.push('- **Google Tag Manager** — central tag layer')
    if (tr.metaPixel) lines.push('- **Meta Pixel** — for retargeting and social ad measurement')
    if (tr.linkedinInsight) lines.push('- **LinkedIn Insight Tag** — for B2B retargeting')
    if (!tr.googleAnalytics && !tr.metaPixel && !tr.linkedinInsight && !tr.tagManager) {
      lines.push('- *(No marketing pixels recommended for this niche)*')
    }
    lines.push('')
    lines.push(tr.notes)
    lines.push('')

    // ── Integrations ─────────────────────────────────────────────────────
    if (plan.integrations.length > 0) {
      lines.push('## Recommended Integrations')
      lines.push('')
      for (const i of plan.integrations) {
        lines.push(`- ${i}`)
      }
      lines.push('')
    }

    // ── Build instructions ──────────────────────────────────────────────
    lines.push('## Build Instructions')
    lines.push('')
    lines.push(this.buildInstructions(input, profile))
    lines.push('')

    // ── Final output format ─────────────────────────────────────────────
    lines.push('## Output Format')
    lines.push('')
    lines.push(`Produce a complete, working website. Provide:`)
    lines.push('')
    lines.push('1. A clear file/folder structure')
    lines.push('2. Full code for every page listed above')
    lines.push('3. Shared components (header, footer, CTA buttons, form, hero, testimonial card, etc.)')
    lines.push('4. Real placeholder content that matches the brand voice — never `Lorem ipsum`')
    lines.push('5. Image placeholders that describe what image should go there (e.g. `<img src="hero-dentist-clinic.jpg" alt="..." />` with a comment explaining the photo brief)')
    lines.push('6. All required schema.org JSON-LD blocks')
    lines.push('7. Working forms with client-side validation (no backend wiring needed for the prompt output; just well-formed forms)')
    lines.push('8. Mobile-responsive CSS')
    lines.push('')
    lines.push(`When you generate code, lead with the homepage and the primary conversion flow. Other pages can follow.`)

    return lines.join('\n')
  }

  private static buildInstructions(input: BlueprintInput, profile: NicheProfile): string {
    const stack = this.recommendStack(input, profile)
    const parts: string[] = []

    parts.push(`**Recommended stack:** ${stack}`)
    parts.push('')
    parts.push('- Mobile-first responsive layout — test at 360px, 768px, and 1280px widths')
    parts.push('- Semantic HTML — use proper section/article/aside/nav/header/footer')
    parts.push('- Accessibility: WCAG AA — colour contrast, focus states, alt text, ARIA labels where needed')
    parts.push('- Performance: lazy-load images, use modern formats (WebP/AVIF), defer non-critical JS')
    parts.push('- SEO: descriptive title tags, meta descriptions, semantic heading hierarchy, canonical URLs, Open Graph + Twitter Card tags')
    parts.push('- Forms: client-side validation, accessible labels, clear success/error states')

    if (input.compliance) {
      parts.push(`- Compliance: ${input.compliance} — include cookie consent banner if needed, privacy policy link in footer, data minimisation in forms`)
    }

    if (input.budgetTier === 'low') {
      parts.push('- Keep the dependency footprint minimal — prefer static HTML + vanilla CSS + small JS where possible')
    }

    return parts.join('\n')
  }

  private static recommendStack(input: BlueprintInput, profile: NicheProfile): string {
    // Default recommendations by niche; user budget can override
    const isEcommerce = profile.niche === 'ecommerce'
    if (isEcommerce) {
      return 'Shopify (if non-technical client) OR Next.js + Shopify Storefront API (if developer-driven). Stripe for payments.'
    }
    const isSaas = profile.niche === 'saas_b2b'
    if (isSaas) {
      return 'Next.js (App Router) with static generation for marketing pages, or Astro for content-heavy marketing sites'
    }
    if (input.budgetTier === 'low') {
      return 'Static HTML + Tailwind CSS, or Astro for slightly more structure. Host on Netlify or Vercel free tier.'
    }
    return 'Next.js (App Router) with static rendering, OR Astro for content-heavy sites. Tailwind CSS for styling. Host on Vercel or Netlify.'
  }

  private static splitMultiline(text: string): string[] {
    return text
      .split(/[\r\n,]+/)
      .map(s => s.trim().replace(/^[-•*]\s*/, ''))
      .filter(Boolean)
  }
}

import { CrawlResult } from '../CrawlerService'
import { ExtractedFeatures } from '../FeatureExtractionService'
import { SiteProfile } from './SiteClassifier'
import {
  CheckDefinition,
  CheckResult,
  Category,
  Severity,
  runAllChecks
} from './CheckRegistry'

export interface ScoredCheck {
  id: string
  label: string
  category: Category
  weight: number          // Effective weight after site-type adjustment
  result: CheckResult
  applicable: true
  opportunityPoints: number
}

export interface CategoryScore {
  category: Category
  score: number           // 0-100 percentage of applicable weight passing
  applicableChecks: number
  passingChecks: number
  warningChecks: number
  failingChecks: number
  recoverablePoints: number
}

export interface ScoreSheet {
  /** Per-category breakdown */
  categories: Record<Category, CategoryScore>
  /** Weighted overall (0-100) */
  overallScore: number
  /** Sum of recoverable opportunity points, capped at 100 */
  opportunityScore: number
  opportunityLevel: 'low' | 'medium' | 'high' | 'very-high'
  /** Every check that was run (passing AND failing) */
  scoredChecks: ScoredCheck[]
  /** Flat breakdown: failed/warning checks only, sorted by impact */
  breakdown: ScoreBreakdownItem[]
  /** What the audit *did not* check because it wasn't relevant */
  skippedChecks: Array<{ id: string; label: string; reason: string }>
  /** Narrative copy fields used in the UI */
  growthPotential: string
  businessImpact: string
  leadOpportunity: string
}

export interface ScoreBreakdownItem {
  label: string
  category: Category
  points: number          // Recoverable opportunity points
  severity: Severity
  reason: string          // The "value" — what was found
  recommendation: string
}

/**
 * Severity multipliers determine how much "recoverable opportunity"
 * a failed check is worth, on top of its weight.
 *
 * critical = 5x: must-fix issues that block the primary business outcome
 * high     = 3x: significant fixes with measurable lift
 * medium   = 1.5x: meaningful improvements
 * low      = 0.6x: polish / nice-to-have
 * info     = 0:   passing checks (no points)
 */
const SEVERITY_MULTIPLIER: Record<Severity, number> = {
  critical: 5,
  high: 3,
  medium: 1.5,
  low: 0.6,
  info: 0
}

/**
 * Category weights for the overall score.
 *
 * Why these numbers:
 *  - Security: people overlook it, but a missing SSL kills trust → 20%
 *  - SEO: drives traffic that everything else depends on → 25%
 *  - Performance: directly affects conversion + SEO ranking → 20%
 *  - Conversion: the page's actual job is converting → 25%
 *  - Marketing: tracking + retargeting matter but vary by site type → 10%
 */
const CATEGORY_WEIGHT: Record<Category, number> = {
  seo: 0.25,
  conversion: 0.25,
  performance: 0.20,
  security: 0.20,
  marketing: 0.10
}

export class ScoreEngine {
  static score(
    crawl: CrawlResult,
    features: ExtractedFeatures,
    profile: SiteProfile
  ): ScoreSheet {
    // Run every applicable check
    const runResults = runAllChecks(crawl, features, profile)

    // Build ScoredCheck list and compute per-category aggregates
    const scoredChecks: ScoredCheck[] = []
    const categoryBuckets: Record<Category, { weighted: number; passing: number; pass: number; warn: number; fail: number; recoverable: number }> = {
      performance: { weighted: 0, passing: 0, pass: 0, warn: 0, fail: 0, recoverable: 0 },
      seo: { weighted: 0, passing: 0, pass: 0, warn: 0, fail: 0, recoverable: 0 },
      marketing: { weighted: 0, passing: 0, pass: 0, warn: 0, fail: 0, recoverable: 0 },
      conversion: { weighted: 0, passing: 0, pass: 0, warn: 0, fail: 0, recoverable: 0 },
      security: { weighted: 0, passing: 0, pass: 0, warn: 0, fail: 0, recoverable: 0 }
    }
    const breakdown: ScoreBreakdownItem[] = []

    for (const { check, result, effectiveWeight } of runResults) {
      // Opportunity points = effective weight × severity multiplier (only if not passed)
      const pts = result.passed ? 0 : Math.round(effectiveWeight * SEVERITY_MULTIPLIER[result.severity])

      scoredChecks.push({
        id: check.id,
        label: check.label,
        category: check.category,
        weight: effectiveWeight,
        result,
        applicable: true,
        opportunityPoints: pts
      })

      // Aggregate per category
      const b = categoryBuckets[check.category]
      b.weighted += effectiveWeight
      if (result.status === 'pass') {
        b.passing += effectiveWeight   // Full credit
        b.pass++
      } else if (result.status === 'warning') {
        b.passing += effectiveWeight * 0.5  // Half credit (issue exists but minor)
        b.warn++
        b.recoverable += pts
        breakdown.push({
          label: check.label,
          category: check.category,
          points: pts,
          severity: result.severity,
          reason: result.value,
          recommendation: result.recommendation
        })
      } else {
        // fail → no credit
        b.fail++
        b.recoverable += pts
        breakdown.push({
          label: check.label,
          category: check.category,
          points: pts,
          severity: result.severity,
          reason: result.value,
          recommendation: result.recommendation
        })
      }
    }

    // Build per-category score sheets
    const categories: Record<Category, CategoryScore> = {} as any
    for (const cat of Object.keys(categoryBuckets) as Category[]) {
      const b = categoryBuckets[cat]
      const score = b.weighted > 0 ? Math.round((b.passing / b.weighted) * 100) : 100
      categories[cat] = {
        category: cat,
        score,
        applicableChecks: b.pass + b.warn + b.fail,
        passingChecks: b.pass,
        warningChecks: b.warn,
        failingChecks: b.fail,
        recoverablePoints: b.recoverable
      }
    }

    // Skipped checks — explain what we didn't audit and why
    const skippedChecks = this.buildSkippedChecksReport(profile, runResults.map(r => r.check.id))

    // Overall — weighted average across the 5 categories
    let totalWeight = 0
    let weightedSum = 0
    for (const cat of Object.keys(categories) as Category[]) {
      const c = categories[cat]
      const w = CATEGORY_WEIGHT[cat]
      if (c.applicableChecks === 0) continue   // Don't penalise a category with no applicable checks
      totalWeight += w
      weightedSum += c.score * w
    }
    const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 100

    // Opportunity score — sum of recoverable points capped at 100
    const opportunitySum = breakdown.reduce((s, b) => s + b.points, 0)
    const opportunityScore = Math.min(100, opportunitySum)

    let opportunityLevel: ScoreSheet['opportunityLevel'] = 'low'
    if (opportunityScore >= 70) opportunityLevel = 'very-high'
    else if (opportunityScore >= 45) opportunityLevel = 'high'
    else if (opportunityScore >= 20) opportunityLevel = 'medium'

    // Narrative copy
    const { growthPotential, businessImpact, leadOpportunity } = this.buildNarrative(profile, overallScore, opportunityLevel)

    // Sort breakdown by impact (severity then points)
    breakdown.sort((a, b) => {
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
      if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity]
      return b.points - a.points
    })

    return {
      categories,
      overallScore,
      opportunityScore,
      opportunityLevel,
      scoredChecks,
      breakdown,
      skippedChecks,
      growthPotential,
      businessImpact,
      leadOpportunity
    }
  }

  private static buildSkippedChecksReport(
    profile: SiteProfile,
    runChecks: string[]
  ): Array<{ id: string; label: string; reason: string }> {
    // Look at the full registry and find checks that weren't run
    // (because applicability filtered them out). Then explain why.
    const { CHECKS } = require('./CheckRegistry') as typeof import('./CheckRegistry')
    const runSet = new Set(runChecks)
    const out: Array<{ id: string; label: string; reason: string }> = []
    const typeLabel = profile.type.replace(/_/g, ' ')

    for (const c of CHECKS) {
      if (runSet.has(c.id)) continue
      const reason = `Not applicable for ${typeLabel} sites`
      out.push({ id: c.id, label: c.label, reason })
    }
    return out
  }

  private static buildNarrative(
    profile: SiteProfile,
    overallScore: number,
    level: ScoreSheet['opportunityLevel']
  ): { growthPotential: string; businessImpact: string; leadOpportunity: string } {
    const typeLabel = profile.subtype || profile.type.replace(/_/g, ' ')

    let growthPotential: string
    let businessImpact: string
    let leadOpportunity: string

    if (level === 'very-high') {
      growthPotential = `Exceptional growth headroom — multiple high-impact gaps across performance, SEO, and conversion are open for ${typeLabel} sites of this scale.`
      businessImpact = 'Resolving the top fixes should drive a 45-70% conversion lift over a quarter.'
      leadOpportunity = profile.type === 'ecommerce'
        ? 'Expect 25-50% more checkout completions once cart, trust, and tracking are fixed.'
        : profile.type === 'saas_product'
          ? 'Expect 30-60% more trial signups once demo CTA, pricing visibility, and pixel infrastructure are in place.'
          : profile.type === 'local_business'
            ? 'Expect 20-40 additional inbound enquiries per month once booking, contact, and local schema are fixed.'
            : 'Expect 25-40 additional qualified leads per month after fixing the high-impact items.'
    } else if (level === 'high') {
      growthPotential = `Strong growth potential — several meaningful gaps remain for a typical ${typeLabel} site.`
      businessImpact = 'Estimated 25-45% conversion lift with the recommended fixes.'
      leadOpportunity = profile.type === 'ecommerce'
        ? 'Expect 15-25% more completed purchases.'
        : profile.type === 'saas_product'
          ? 'Expect 15-30% more trial signups.'
          : profile.type === 'local_business'
            ? 'Expect 10-20 additional monthly enquiries.'
            : 'Capturing 12-22 additional leads per month is realistic.'
    } else if (level === 'medium') {
      growthPotential = `Moderate growth potential — most fundamentals are in place but targeted improvements will move the needle.`
      businessImpact = 'Estimated 10-25% conversion lift with the recommended fixes.'
      leadOpportunity = profile.type === 'local_business'
        ? 'Expect 5-10 additional monthly enquiries.'
        : 'Capturing 5-12 additional leads per month is realistic.'
    } else {
      growthPotential = `Limited optimisation headroom — the ${typeLabel} site is in good shape. Focus on the remaining low-priority polish items.`
      businessImpact = 'Estimated 5-10% conversion lift from polish-level improvements.'
      leadOpportunity = 'Maintain current standards and re-audit quarterly to catch regressions.'
    }

    return { growthPotential, businessImpact, leadOpportunity }
  }
}

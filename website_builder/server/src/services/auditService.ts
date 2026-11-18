import { getDb } from '../database/init'
import { WebsiteAnalysisEngine } from './WebsiteAnalysisEngine'

/**
 * Run one or more audits. Returns the single audit result for a single URL
 * input, or an array of {url, success, data|error} for multi-URL batch input.
 */
export async function runAuditService(urlOrUrls: string | string[], requestedCategories?: string[]) {
  const urls = Array.isArray(urlOrUrls)
    ? urlOrUrls
    : String(urlOrUrls).split(',').map(u => u.trim()).filter(Boolean)

  const uniqueUrls = [...new Set(urls.map(u => u.trim()).filter(Boolean))].slice(0, 10)
  const results: any[] = []

  // Concurrency 2 — keeps CPU + network within sane bounds while letting
  // batch audits make progress in parallel.
  const CONCURRENCY = 2
  const queue = [...uniqueUrls]

  const worker = async () => {
    while (queue.length > 0) {
      const currentUrl = queue.shift()
      if (!currentUrl) break
      try {
        const auditResult = await WebsiteAnalysisEngine.analyzeWebsite(currentUrl, requestedCategories)
        // Persist to DB — non-fatal if it fails.
        try { persistAudit(auditResult) } catch (e) {
          console.warn(`[runAuditService] DB persist failed for ${currentUrl}:`, (e as Error).message)
        }
        results.push({ url: currentUrl, success: true, data: auditResult })
      } catch (err: any) {
        console.error(`[runAuditService] Failed to analyze ${currentUrl}:`, err)
        results.push({ url: currentUrl, success: false, error: err.message || String(err) })
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, uniqueUrls.length) }, worker)
  await Promise.all(workers)

  // Single-URL callers get the direct audit result. Multi-URL get the batch array.
  if (!Array.isArray(urlOrUrls)) {
    const mainRes = results.find(r => r.url === urlOrUrls.trim())
    if (mainRes) {
      if (mainRes.success) return mainRes.data
      throw new Error(mainRes.error)
    }
    throw new Error('Audit failed to complete.')
  }

  return results
}

function persistAudit(audit: any): void {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO audits
    (id, url, created_at, performance_score, seo_score, marketing_score, conversion_score, security_score,
     overall_score, opportunity_score, opportunity_level, raw_data, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const opp = audit.opportunityScore || {}
  stmt.run(
    audit.id,
    audit.url,
    audit.createdAt || new Date().toISOString(),
    opp.performance ?? 0,
    opp.seo ?? 0,
    opp.marketing ?? 0,
    opp.conversion ?? 0,
    opp.security ?? 0,
    audit.overallScore ?? 0,
    opp.overall ?? 0,
    opp.level || 'low',
    JSON.stringify(audit),
    'completed'
  )
}

export function getAuditById(id: string) {
  const db = getDb()
  const row = db.prepare('SELECT raw_data FROM audits WHERE id = ?').get(id) as { raw_data: string } | undefined
  if (!row) return null
  return JSON.parse(row.raw_data)
}

export function getAllAudits() {
  const db = getDb()
  return db.prepare(
    'SELECT id, url, created_at, overall_score, opportunity_score, opportunity_level, status FROM audits ORDER BY created_at DESC'
  ).all()
}

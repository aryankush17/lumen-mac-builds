import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler'
import { runAuditService, getAuditById, getAllAudits } from '../services/auditService'

const router = Router()

/**
 * Race an awaitable against a hard timeout. If the audit takes longer than
 * REQUEST_TIMEOUT_MS, we return a degraded response instead of letting the
 * client sit indefinitely on a UI spinner.
 */
const REQUEST_TIMEOUT_MS = 60000

function withRequestTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Audit exceeded ${ms}ms`)), ms)
    })
  ]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
}

// POST /api/audit — run a new audit
router.post('/', asyncHandler(async (req, res) => {
  const { url, categories } = req.body
  if (!url) {
    res.status(400).json({ success: false, error: 'URL is required' })
    return
  }
  try {
    const result = await withRequestTimeout(runAuditService(url, categories), REQUEST_TIMEOUT_MS)
    res.json({ success: true, data: result, message: 'Audit completed successfully' })
  } catch (err: any) {
    const msg = err?.message || String(err)
    const isTimeout = msg.includes('exceeded') || msg.includes('timed out')
    res.status(isTimeout ? 504 : 500).json({
      success: false,
      error: isTimeout
        ? `Audit timed out — the target site may be slow, blocking automated requests, or unreachable. Try a different URL.`
        : `Audit failed: ${msg}`
    })
  }
}))

// GET /api/audit — list all audits
router.get('/', asyncHandler(async (_req, res) => {
  const audits = getAllAudits()
  res.json({ success: true, data: audits })
}))

// GET /api/audit/:id — get single audit
router.get('/:id', asyncHandler(async (req, res) => {
  const audit = getAuditById(req.params.id)
  if (!audit) {
    res.status(404).json({ success: false, error: 'Audit not found' })
    return
  }
  res.json({ success: true, data: audit })
}))

export default router

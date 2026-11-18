import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler'
import { BlueprintService, BlueprintInput } from '../services/BlueprintService'
import { listNiches, NICHE_PROFILES } from '../services/NicheLibrary'

const router = Router()

// POST /api/blueprint — generate a blueprint from form input
router.post('/', asyncHandler(async (req, res) => {
  const input: BlueprintInput = req.body
  if (!input.businessName || input.businessName.trim().length === 0) {
    res.status(400).json({ success: false, error: 'businessName is required' })
    return
  }

  const blueprint = BlueprintService.generate(input)

  // Persist — non-fatal if it fails
  try { BlueprintService.save(blueprint) } catch (e) {
    console.warn('[blueprint] persist failed:', (e as Error).message)
  }

  res.json({ success: true, data: blueprint })
}))

// GET /api/blueprint — list all blueprints
router.get('/', asyncHandler(async (_req, res) => {
  const items = BlueprintService.listAll()
  res.json({ success: true, data: items })
}))

// GET /api/blueprint/niches — list available niches (for UI dropdown)
router.get('/niches', asyncHandler(async (_req, res) => {
  const niches = listNiches().map(n => ({
    slug: n.slug,
    label: n.label,
    positioning: NICHE_PROFILES[n.slug]?.positioning.split('.')[0] + '.'
  }))
  res.json({ success: true, data: niches })
}))

// GET /api/blueprint/:id — fetch single blueprint
router.get('/:id', asyncHandler(async (req, res) => {
  const blueprint = BlueprintService.getById(req.params.id)
  if (!blueprint) {
    res.status(404).json({ success: false, error: 'Blueprint not found' })
    return
  }
  res.json({ success: true, data: blueprint })
}))

export default router

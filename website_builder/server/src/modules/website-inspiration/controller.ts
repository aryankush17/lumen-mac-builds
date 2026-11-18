import { Request, Response } from 'express'
import { InspirationService } from './service'

export class InspirationController {
  static async getInspiration(req: Request, res: Response) {
    try {
      const { businessType, industry, keyword, description } = req.body

      const typeClean = String(businessType || '').trim().toLowerCase()
      const indClean = String(industry || '').trim().toLowerCase()
      const kwClean = String(keyword || '').trim().toLowerCase()
      const descClean = String(description || '').trim().toLowerCase()

      if (!typeClean && !indClean && !kwClean && !descClean) {
        return res.status(400).json({ error: 'Please provide at least one search criterion (business type, industry, keyword, or description).' })
      }

      console.log(`[Controller] Initiating fresh search for businessType="${businessType}", location="${keyword}"`)

      // 1. Search for real websites via Gemini
      const searchResults = await InspirationService.searchWebsites(
        businessType || '',
        industry || '',
        keyword || '',
        description || ''
      )

      // 2. Process and capture screenshots
      const results = await InspirationService.processWebsites(searchResults, keyword || '')

      // 3. Generate Prompt Enhancement summary
      const promptEnhancement = InspirationService.generatePromptEnhancement(results, businessType || '', industry || '')

      return res.json({
        source: 'live',
        results,
        promptEnhancement
      })
    } catch (e: any) {
      console.error('Error in Website Inspiration module controller:', e)
      return res.status(500).json({ error: e.message || 'Internal server error while processing website inspiration.' })
    }
  }
}

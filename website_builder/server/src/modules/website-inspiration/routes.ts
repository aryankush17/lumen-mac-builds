import { Router } from 'express'
import * as express from 'express'
import * as path from 'path'
import { InspirationController } from './controller'

const router = Router()

// Route to find websites and capture screenshots
router.post('/', InspirationController.getInspiration)

// Static middleware to serve screenshot files
router.use('/screenshots', express.static(path.join(process.env.LUMEN_STUDIO_DATA_DIR || process.cwd(), 'screenshots')))

export default router

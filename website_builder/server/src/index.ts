import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import dotenv from 'dotenv'
import { initDatabase } from './database/init'
import { errorHandler } from './middleware/errorHandler'
import auditRoutes from './routes/audit'
import blueprintRoutes from './routes/blueprint'
import inspirationRoutes from './modules/website-inspiration/routes'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173'], credentials: true }))
app.use(morgan('dev'))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Initialise DB
initDatabase()

// Health check
app.get('/api', (_req, res) => {
  res.json({
    name: 'Lumen API',
    status: 'active',
    endpoints: [
      'GET  /api/health',
      'POST /api/audit       — run a website audit',
      'GET  /api/audit       — list audits',
      'GET  /api/audit/:id   — fetch single audit',
      'POST /api/blueprint   — generate AI builder prompt from form input',
      'GET  /api/blueprint   — list blueprints',
      'GET  /api/blueprint/niches — list available business niches',
      'GET  /api/blueprint/:id — fetch single blueprint',
      'POST /api/inspiration — find design inspiration and capture screenshots'
    ]
  })
})
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() })
})

// Routes — just the two features
app.use('/api/audit', auditRoutes)
app.use('/api/blueprint', blueprintRoutes)
app.use('/api/inspiration', inspirationRoutes)

// Error handler
app.use(errorHandler)

// Bind to loopback only. This backend is reached exclusively through the local
// Python bridge (127.0.0.1); binding 0.0.0.0 would expose the audit/inspiration
// API to the whole LAN. Do not change to 0.0.0.0.
app.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`\nLumen Server running on http://127.0.0.1:${PORT}`)
  console.log(`API available at http://127.0.0.1:${PORT}/api`)
})

export default app

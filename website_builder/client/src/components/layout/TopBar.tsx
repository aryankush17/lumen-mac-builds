import { useLocation } from 'react-router-dom'
import { Plus, HelpCircle } from 'lucide-react'
import { motion } from 'framer-motion'
import { startWbTour } from '../../lib/tour'

const pageNames: Record<string, { title: string; subtitle: string }> = {
  '/build': { title: 'Website Studio', subtitle: 'Your ideas. Your design. Your website.' },
  '/audit':     { title: 'Website Audit',     subtitle: 'Score any live website with a type-aware audit engine' },
  '/blueprint': { title: 'Website Blueprint', subtitle: 'Describe a business, get an AI builder prompt' }
}

export default function TopBar() {
  const location = useLocation()
  const page = pageNames[location.pathname] || { title: 'Lumen', subtitle: 'Site audit + blueprint tooling' }

  return (
    <header className="fixed top-0 left-64 right-0 h-16 z-30 flex items-center justify-between px-6 border-b border-border bg-background/80 backdrop-blur-md">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
      >
        <h2 className="font-display font-bold text-text-primary text-lg leading-tight">{page.title}</h2>
        <p className="text-text-muted text-xs">{page.subtitle}</p>
      </motion.div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => startWbTour()}
          title="Walk me through the Website Builder"
          className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5"
        >
          <HelpCircle className="w-3.5 h-3.5" /> Walkthrough
        </button>
        {/* Quick "New" button context-aware to current tool */}
        {location.pathname.startsWith('/audit') && (
          <button
            onClick={() => window.location.reload()}
            className="btn-primary text-xs px-3 py-2 hidden sm:flex"
          >
            <Plus className="w-3.5 h-3.5" /> New Audit
          </button>
        )}
        {location.pathname.startsWith('/blueprint') && (
          <button
            onClick={() => window.location.reload()}
            className="btn-primary text-xs px-3 py-2 hidden sm:flex"
          >
            <Plus className="w-3.5 h-3.5" /> New Blueprint
          </button>
        )}
      </div>
    </header>
  )
}

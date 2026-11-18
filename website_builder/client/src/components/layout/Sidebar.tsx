import { NavLink, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Globe, Layers, Sparkles } from 'lucide-react'
import { clsx } from 'clsx'

interface NavItem {
  label: string
  path: string
  icon: React.ElementType
  description: string
}

const navItems: NavItem[] = [
  { label: 'Website Studio', path: '/build', icon: Layers, description: 'Design, edit & export your site' },
  { label: 'Website Audit',       path: '/audit',       icon: Globe,     description: 'Score any live site' },
  { label: 'Website Blueprint',   path: '/blueprint',   icon: Layers,    description: 'Form → AI builder prompt' },
  { label: 'Inspiration Finder',  path: '/inspiration', icon: Sparkles,  description: 'Discover design ideas' }
]

export default function Sidebar() {
  const location = useLocation()

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-surface-3 border-r border-border flex flex-col z-40 overflow-hidden">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border flex-shrink-0">
        <img src="/lumen-logo.png" alt="" className="w-8 h-8" draggable={false} />
        <div>
          <h1 className="font-display font-bold text-text-primary text-base leading-tight">Lumen</h1>
          <p className="text-[10px] text-text-muted font-medium tracking-widest uppercase">Site Tooling</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto scrollbar-hide py-4 px-3" data-tour="wb-tools">
        <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest px-3 mb-2">Tools</p>
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = location.pathname.startsWith(item.path)
          return (
            <NavLink key={item.path} to={item.path}>
              <motion.div
                whileHover={{ x: 2 }}
                whileTap={{ scale: 0.98 }}
                className={clsx('nav-item group relative items-start gap-3 py-2.5', isActive && 'active')}
              >
                <Icon className={clsx(
                  'w-4 h-4 flex-shrink-0 mt-0.5 transition-colors',
                  isActive ? 'text-primary' : 'text-text-muted group-hover:text-text-secondary'
                )} />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-medium">{item.label}</div>
                  <div className="text-[11px] text-text-muted truncate">{item.description}</div>
                </div>
              </motion.div>
            </NavLink>
          )
        })}
      </nav>

    </aside>
  )
}

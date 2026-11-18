import { clsx } from 'clsx'
import { motion } from 'framer-motion'
import { CheckCircle, XCircle, AlertTriangle, HelpCircle, TrendingUp } from 'lucide-react'

// ─── Score Badge ─────────────────────────────────────────────────────────────
interface ScoreBadgeProps {
  score: number
  size?: 'sm' | 'md' | 'lg'
}

export function ScoreBadge({ score, size = 'md' }: ScoreBadgeProps) {
  const color = score >= 80 ? 'text-accent bg-accent/10 border-accent/20'
    : score >= 60 ? 'text-primary bg-primary/10 border-primary/20'
    : score >= 40 ? 'text-warning-500 bg-warning-500/10 border-warning-500/20'
    : 'text-danger-500 bg-danger-500/10 border-danger-500/20'

  const sizeClass = size === 'sm' ? 'text-xs px-2 py-0.5' : size === 'lg' ? 'text-base px-3 py-1' : 'text-sm px-2.5 py-0.5'

  return (
    <span className={clsx('badge border font-bold tabular-nums', color, sizeClass)}>
      {score}
    </span>
  )
}

// ─── Status Icon ──────────────────────────────────────────────────────────────
interface StatusIconProps {
  status: 'pass' | 'fail' | 'warning' | 'unknown'
  size?: number
}

export function StatusIcon({ status, size = 16 }: StatusIconProps) {
  if (status === 'pass') return <CheckCircle style={{ width: size, height: size }} className="text-accent flex-shrink-0" />
  if (status === 'fail') return <XCircle style={{ width: size, height: size }} className="text-danger-500 flex-shrink-0" />
  if (status === 'warning') return <AlertTriangle style={{ width: size, height: size }} className="text-warning-500 flex-shrink-0" />
  return <HelpCircle style={{ width: size, height: size }} className="text-text-muted flex-shrink-0" />
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
interface ProgressBarProps {
  value: number
  max?: number
  className?: string
  color?: string
  animated?: boolean
  showLabel?: boolean
}

export function ProgressBar({ value, max = 100, className, color, animated = true, showLabel = false }: ProgressBarProps) {
  const pct = Math.min(100, (value / max) * 100)
  const barColor = color || (pct >= 80 ? '#C9A961' : pct >= 60 ? '#C9A961' : pct >= 40 ? '#C9A961' : '#C9A961')

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: barColor }}
          initial={animated ? { width: 0 } : { width: `${pct}%` }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </div>
      {showLabel && <span className="text-xs tabular-nums text-text-secondary w-8 text-right">{Math.round(pct)}%</span>}
    </div>
  )
}

// ─── Animated Score Circle ────────────────────────────────────────────────────
interface ScoreCircleProps {
  score: number
  size?: number
  label?: string
  sublabel?: string
}

export function ScoreCircle({ score, size = 140, label, sublabel }: ScoreCircleProps) {
  const radius = (size - 20) / 2
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (score / 100) * circumference

  const color = score >= 80 ? '#C9A961' : score >= 60 ? '#C9A961' : score >= 40 ? '#C9A961' : '#C9A961'

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1a2236" strokeWidth="8" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 8px ${color}60)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <motion.span
          className="font-display font-bold tabular-nums"
          style={{ color, fontSize: size * 0.22 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
        >
          {score}
        </motion.span>
        {label && <span className="text-xs text-text-secondary mt-0.5">{label}</span>}
        {sublabel && <span className="text-[10px] text-text-muted">{sublabel}</span>}
      </div>
    </div>
  )
}

// ─── Metric Card ──────────────────────────────────────────────────────────────
interface MetricCardProps {
  label: string
  value: string | number
  change?: string
  changePositive?: boolean
  icon?: React.ElementType
  color?: string
}

export function MetricCard({ label, value, change, changePositive, icon: Icon, color = '#C9A961' }: MetricCardProps) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="glass-card p-5 cursor-default"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-display font-bold text-text-primary mt-1 tabular-nums">{value}</p>
        </div>
        {Icon && (
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}15` }}>
            <Icon className="w-5 h-5" style={{ color }} />
          </div>
        )}
      </div>
      {change && (
        <div className={clsx('flex items-center gap-1 text-xs font-medium', changePositive !== false ? 'text-accent' : 'text-danger-500')}>
          <TrendingUp className="w-3 h-3" />
          <span>{change}</span>
        </div>
      )}
    </motion.div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
interface SkeletonProps {
  className?: string
  lines?: number
}

export function Skeleton({ className, lines = 1 }: SkeletonProps) {
  if (lines > 1) {
    return (
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className={clsx('skeleton rounded-lg h-4', i === lines - 1 && 'w-3/4', className)} />
        ))}
      </div>
    )
  }
  return <div className={clsx('skeleton rounded-lg', className)} />
}

// ─── Empty State ─────────────────────────────────────────────────────────────
interface EmptyStateProps {
  icon: React.ElementType
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-20 text-center"
    >
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
        <Icon className="w-8 h-8 text-primary" />
      </div>
      <h3 className="font-display font-bold text-text-primary text-lg mb-2">{title}</h3>
      <p className="text-text-muted text-sm max-w-sm mb-6">{description}</p>
      {action && (
        <button onClick={action.onClick} className="btn-primary">
          {action.label}
        </button>
      )}
    </motion.div>
  )
}

// ─── Badge ────────────────────────────────────────────────────────────────────
interface BadgeProps {
  children: React.ReactNode
  variant?: 'primary' | 'accent' | 'warning' | 'danger' | 'default'
  size?: 'sm' | 'md'
}

export function Badge({ children, variant = 'default', size = 'md' }: BadgeProps) {
  const variantClass = {
    primary: 'bg-primary/10 text-primary border-primary/20',
    accent: 'bg-accent/10 text-accent border-accent/20',
    warning: 'bg-warning-500/10 text-warning-500 border-warning-500/20',
    danger: 'bg-danger-500/10 text-danger-500 border-danger-500/20',
    default: 'bg-surface-3 text-text-secondary border-border',
  }[variant]

  return (
    <span className={clsx('badge border', variantClass, size === 'sm' && 'text-[10px] px-2 py-0.5')}>
      {children}
    </span>
  )
}

// ─── Section Header ───────────────────────────────────────────────────────────
interface SectionHeaderProps {
  title: string
  subtitle?: string
  action?: React.ReactNode
  icon?: React.ElementType
  iconColor?: string
}

export function SectionHeader({ title, subtitle, action, icon: Icon, iconColor = '#C9A961' }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${iconColor}15` }}>
            <Icon className="w-5 h-5" style={{ color: iconColor }} />
          </div>
        )}
        <div>
          <h3 className="font-display font-bold text-text-primary">{title}</h3>
          {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}

// ─── Loading Spinner ──────────────────────────────────────────────────────────
export function LoadingSpinner({ size = 20 }: { size?: number }) {
  return (
    <img src="/lumen-logo.png" alt="" className="animate-[spin_2.2s_linear_infinite]" style={{ width: size, height: size }} draggable={false} />
  )
}

// ─── Tab Bar ──────────────────────────────────────────────────────────────────
interface Tab {
  id: string
  label: string
  icon?: React.ElementType
  count?: number
}

interface TabBarProps {
  tabs: Tab[]
  active: string
  onChange: (id: string) => void
}

export function TabBar({ tabs, active, onChange }: TabBarProps) {
  return (
    <div className="flex gap-1 p-1 bg-surface-3 border border-border rounded-xl">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const isActive = tab.id === active
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={clsx(
              'relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200',
              isActive ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
            )}
          >
            {isActive && (
              <motion.div
                layoutId="tabBg"
                className="absolute inset-0 bg-surface border border-border rounded-lg"
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative flex items-center gap-2">
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {tab.label}
              {tab.count !== undefined && (
                <span className="badge bg-surface-3 text-text-muted text-[10px] px-1.5 py-0.5">{tab.count}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

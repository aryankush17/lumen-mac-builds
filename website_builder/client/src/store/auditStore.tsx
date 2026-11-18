import { createContext, useContext, useState, ReactNode } from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CheckItem {
  label: string
  status: 'pass' | 'fail' | 'warning'
  value?: string
  impact: 'high' | 'medium' | 'low'
  recommendation: string
  opportunityPoints: number
}

export interface ScoreBreakdownItem {
  label: string
  points: number
  reason: string
}

export interface PriorityFix {
  title: string
  points: number
  impact: 'high' | 'medium' | 'low'
  category: string
}

export interface AuditResult {
  id: string
  url: string
  createdAt: string
  categories: string[]
  aiSummary: string
  scoreBreakdown: ScoreBreakdownItem[]
  overallScore: number
  opportunityScore: {
    performance: number | null
    seo: number | null
    marketing: number | null
    conversion: number | null
    security: number | null
    overall: number
    level: string
    growthPotential: string
    priorityFixes: PriorityFix[]
    scoreBreakdown: ScoreBreakdownItem[]
    businessImpact: string
    leadOpportunity: string
  }
  performance?: { score: number } & Record<string, CheckItem | number>
  seo?: { score: number } & Record<string, CheckItem | number>
  marketing?: { score: number } & Record<string, CheckItem | number>
  conversion?: { score: number } & Record<string, CheckItem | number>
  security?: { score: number } & Record<string, CheckItem | number>
  techStack?: Record<string, unknown>
  timeline?: any[]
}

export interface CompetitorData {
  id: string
  competitorUrl: string
  competitorDomain: string
  comparison: {
    yourSite: { label: string; speed: number; seo: number; ctaVisibility: number; userExperience: number }
    competitor: { label: string; url: string; speed: number; seo: number; ctaVisibility: number; userExperience: number }
  }
  gaps: string[]
  advantages: string[]
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface AuditContextValue {
  audit: AuditResult | null
  setAudit: (a: AuditResult | null) => void
  competitor: CompetitorData | null
  setCompetitor: (c: CompetitorData | null) => void
  clearSession: () => void
}

const AuditContext = createContext<AuditContextValue | null>(null)

export function AuditProvider({ children }: { children: ReactNode }) {
  const [audit, setAudit] = useState<AuditResult | null>(null)
  const [competitor, setCompetitor] = useState<CompetitorData | null>(null)

  const clearSession = () => {
    setAudit(null)
    setCompetitor(null)
  }

  return (
    <AuditContext.Provider value={{ audit, setAudit, competitor, setCompetitor, clearSession }}>
      {children}
    </AuditContext.Provider>
  )
}

export function useAuditStore() {
  const ctx = useContext(AuditContext)
  if (!ctx) throw new Error('useAuditStore must be used inside AuditProvider')
  return ctx
}

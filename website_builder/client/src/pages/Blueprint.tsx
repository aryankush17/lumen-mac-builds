/**
 * Blueprint — fill out a structured form about a business, get back a
 * niche-aware site plan + AI builder prompt for Claude / v0 / Lovable / Cursor.
 */

import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Layers, Sparkles, Copy, Check, ChevronRight, ChevronDown,
  FileText, Building2, Users, Target, Palette, Lightbulb, Settings,
  Zap, Globe, Wand2
} from 'lucide-react'
import { blueprintApi } from '../api'

type Goal = 'leads' | 'sales' | 'bookings' | 'donations' | 'signups' | 'awareness' | 'other'
type Budget = 'low' | 'mid' | 'high' | 'unknown'

interface BlueprintForm {
  businessName: string
  industry: string
  businessModel: string
  productOrService: string
  yearFounded: string
  targetAudience: string
  geographicMarket: string
  language: string
  primaryGoal: Goal
  primaryGoalOther: string
  services: string
  uniqueValueProp: string
  brandVoice: string
  existingCopy: string
  hasLogo: boolean
  hasBrandColors: boolean
  brandColors: string
  preferredFonts: string
  inspirationSites: string
  requiredFeatures: string
  integrationsNeeded: string
  budgetTier: Budget
  timeline: string
  compliance: string
}

const EMPTY_FORM: BlueprintForm = {
  businessName: '', industry: '', businessModel: '', productOrService: '', yearFounded: '',
  targetAudience: '', geographicMarket: '', language: '',
  primaryGoal: 'leads', primaryGoalOther: '',
  services: '', uniqueValueProp: '', brandVoice: '', existingCopy: '',
  hasLogo: false, hasBrandColors: false, brandColors: '', preferredFonts: '',
  inspirationSites: '',
  requiredFeatures: '', integrationsNeeded: '',
  budgetTier: 'unknown', timeline: '', compliance: ''
}

/** Pre-filled sample for the "Load example" affordance. */
const EXAMPLE_FORM: BlueprintForm = {
  businessName: 'Brightline Dental',
  industry: 'Dental clinic',
  businessModel: 'appointment-based services',
  productOrService: 'General and cosmetic dentistry',
  yearFounded: '2014',
  targetAudience: 'Families and young professionals seeking quality, accessible dental care',
  geographicMarket: 'Greater Toronto Area',
  language: 'English, French',
  primaryGoal: 'bookings',
  primaryGoalOther: '',
  services: 'General dentistry\nDental implants\nOrthodontics\nPediatric dentistry\nCosmetic dentistry',
  uniqueValueProp: 'Weekend hours, pediatric specialists, and a calm, modern clinic environment',
  brandVoice: 'warm, professional, reassuring',
  existingCopy: '',
  hasLogo: true,
  hasBrandColors: true,
  brandColors: 'Primary #2C7A7B (calm teal), Accent #FBD38D (warm peach)',
  preferredFonts: 'Inter for body, Fraunces for headlines',
  inspirationSites: '',
  requiredFeatures: 'Online booking widget\nLive Google Reviews\nClick-to-call on mobile',
  integrationsNeeded: 'Calendly for booking\nGoogle Reviews\nMailchimp for newsletter',
  budgetTier: 'mid',
  timeline: '6 weeks',
  compliance: ''
}

const GOAL_OPTIONS: Array<{ value: Goal; label: string }> = [
  { value: 'leads',     label: 'Lead generation' },
  { value: 'sales',     label: 'Sales (e-commerce)' },
  { value: 'bookings',  label: 'Bookings / appointments' },
  { value: 'donations', label: 'Donations (nonprofit)' },
  { value: 'signups',   label: 'Trial signups (SaaS)' },
  { value: 'awareness', label: 'Brand awareness' },
  { value: 'other',     label: 'Other' }
]

const BUDGET_OPTIONS: Array<{ value: Budget; label: string }> = [
  { value: 'low',     label: 'Low — static / template-based' },
  { value: 'mid',     label: 'Mid — modern stack, polished design' },
  { value: 'high',    label: 'High — bespoke design + custom integrations' },
  { value: 'unknown', label: 'Not sure yet' }
]

/** Map every form section to an icon + colour. */
const SECTION_META = {
  identity:  { icon: Building2, color: '#C9A961', label: 'Business Identity' },
  audience:  { icon: Users,     color: '#C9A961', label: 'Audience' },
  goal:      { icon: Target,    color: '#C9A961', label: 'Primary Goal' },
  content:   { icon: Lightbulb, color: '#C9A961', label: 'Content & Voice' },
  brand:     { icon: Palette,   color: '#C9A961', label: 'Brand Assets' },
  refs:      { icon: Sparkles,  color: '#C9A961', label: 'Inspiration & Must-Haves' },
  technical: { icon: Settings,  color: '#6B7280', label: 'Technical Constraints' }
} as const

export default function Blueprint() {
  const [form, setForm] = useState<BlueprintForm>(EMPTY_FORM)
  const [niches, setNiches] = useState<Array<{ slug: string; label: string; positioning: string }>>([])
  const [status, setStatus] = useState<'idle' | 'generating' | 'complete' | 'error'>('idle')
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)
  const [promptCopied, setPromptCopied] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(['brand', 'technical']))

  useEffect(() => {
    blueprintApi.listNiches()
      .then(r => { if (r?.success) setNiches(r.data || []) })
      .catch(() => { /* informational only */ })
  }, [])

  const set = <K extends keyof BlueprintForm>(key: K, value: BlueprintForm[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const canSubmit = useMemo(() => form.businessName.trim().length > 0, [form.businessName])

  /** Completeness score: % of meaningful fields filled, used for the progress meter. */
  const completeness = useMemo(() => {
    const fields: Array<keyof BlueprintForm> = [
      'businessName', 'industry', 'businessModel', 'productOrService',
      'targetAudience', 'geographicMarket',
      'primaryGoal', 'services', 'uniqueValueProp', 'brandVoice',
      'inspirationSites', 'requiredFeatures', 'integrationsNeeded'
    ]
    const filled = fields.filter(k => {
      const v = form[k] as string
      return typeof v === 'string' && v.trim().length > 0
    }).length
    return Math.round((filled / fields.length) * 100)
  }, [form])

  const toggleSection = (key: string) =>
    setCollapsedSections(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  const handleGenerate = async () => {
    if (!canSubmit) { setError('Business name is required to start.'); return }
    setError(''); setStatus('generating'); setResult(null)
    try {
      const res = await blueprintApi.generate(form as any)
      if (res?.success && res.data) {
        setResult(res.data)
        setStatus('complete')
        // Scroll to top after results land
        window.scrollTo({ top: 0, behavior: 'smooth' })
      } else {
        setStatus('error')
        setError(res?.error || 'Blueprint generation failed')
      }
    } catch (e: any) {
      setStatus('error')
      setError(e?.response?.data?.error || e?.message || 'Blueprint generation failed')
    }
  }

  const handleReset = () => {
    setForm(EMPTY_FORM); setResult(null); setStatus('idle'); setError(''); setPromptCopied(false)
  }

  const handleLoadExample = () => {
    setForm(EXAMPLE_FORM)
    // Open all sections so the user sees what's been filled
    setCollapsedSections(new Set())
  }

  const handleCopyPrompt = async () => {
    if (!result?.aiPrompt) return
    try {
      await navigator.clipboard.writeText(result.aiPrompt)
      setPromptCopied(true)
      setTimeout(() => setPromptCopied(false), 2000)
    } catch { /* clipboard API unavailable */ }
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      {status !== 'complete' && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-end justify-between gap-6 flex-wrap"
        >
          <div className="flex-1 min-w-[300px]">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-semibold uppercase tracking-widest mb-3">
              <Wand2 className="w-3 h-3" /> Website Blueprint
            </div>
            <h1 className="text-3xl md:text-4xl font-display font-bold text-text-primary tracking-tight leading-tight">
              Describe a business.<br />
              <span className="text-text-secondary">Get a builder-ready prompt.</span>
            </h1>
            <p className="text-sm text-text-secondary mt-3 max-w-xl leading-relaxed">
              Lumen classifies the niche, recommends the right page structure and conversion flow,
              then emits a paste-ready brief for your AI builder.
            </p>
          </div>
          <button
            onClick={handleLoadExample}
            className="btn-secondary text-xs px-4 py-2 flex items-center gap-2 hover:bg-surface-2"
          >
            <Sparkles className="w-3.5 h-3.5" /> Load Example
          </button>
        </motion.div>
      )}

      {status === 'complete' && (
        <div className="flex items-start justify-between gap-4 mb-2">
          <div>
            <h1 className="text-2xl md:text-3xl font-display font-bold text-text-primary tracking-tight">
              Blueprint ready
            </h1>
            <p className="text-sm text-text-secondary mt-1">
              Classified as <span className="text-primary font-medium">{result?.profile?.label}</span> · Generated {new Date(result?.createdAt).toLocaleString()}
            </p>
          </div>
          <button onClick={handleReset} className="btn-secondary px-4 py-2 text-sm">
            New Blueprint
          </button>
        </div>
      )}

      {/* Progress meter (only on form view) */}
      {status !== 'complete' && (
        <ProgressMeter completeness={completeness} />
      )}

      {/* FORM */}
      {status !== 'complete' && (
        <FormView
          form={form}
          set={set}
          niches={niches}
          status={status}
          error={error}
          canSubmit={canSubmit}
          collapsedSections={collapsedSections}
          toggleSection={toggleSection}
          onSubmit={handleGenerate}
        />
      )}

      {/* RESULTS */}
      {status === 'complete' && result && (
        <ResultsView result={result} promptCopied={promptCopied} onCopy={handleCopyPrompt} />
      )}
    </div>
  )
}

// ─── PROGRESS METER ───────────────────────────────────────────────────────────

function ProgressMeter({ completeness }: { completeness: number }) {
  const tier =
    completeness < 30 ? { label: 'Just getting started', color: '#9C9C93' } :
    completeness < 60 ? { label: 'Building context', color: '#C9A961' } :
    completeness < 85 ? { label: 'Strong signal', color: '#C9A961' } :
                        { label: 'Comprehensive brief', color: '#C9A961' }

  return (
    <div className="glass-card p-4 flex items-center gap-4">
      <div className="flex-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] uppercase tracking-widest font-semibold text-text-muted">
            Brief completeness
          </span>
          <span className="text-xs font-medium" style={{ color: tier.color }}>
            {tier.label}
          </span>
        </div>
        <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${completeness}%` }}
            transition={{ type: 'spring', stiffness: 80, damping: 18 }}
            style={{ backgroundColor: tier.color }}
          />
        </div>
      </div>
      <div className="text-2xl font-display font-bold tabular-nums" style={{ color: tier.color }}>
        {completeness}%
      </div>
    </div>
  )
}

// ─── FORM ─────────────────────────────────────────────────────────────────────

function FormView({
  form, set, niches, status, error, canSubmit, collapsedSections, toggleSection, onSubmit
}: {
  form: BlueprintForm
  set: <K extends keyof BlueprintForm>(k: K, v: BlueprintForm[K]) => void
  niches: Array<{ slug: string; label: string; positioning: string }>
  status: string
  error: string
  canSubmit: boolean
  collapsedSections: Set<string>
  toggleSection: (k: string) => void
  onSubmit: () => void
}) {
  const recognisedNiches = niches.slice(0, 5).map(n => n.label).join(' · ')

  return (
    <div className="space-y-4">
      {/* Identity */}
      <Section meta={SECTION_META.identity} subtitle="What is the business and what does it do?" defaultOpen>
        <Field label="Business name" required>
          <Input
            value={form.businessName}
            onChange={v => set('businessName', v)}
            placeholder="The business as it'll appear in the H1"
            autoFocus
          />
        </Field>
        <Field label="Industry / niche" hint={recognisedNiches ? `Recognised niches: ${recognisedNiches}…` : undefined}>
          <Input
            value={form.industry}
            onChange={v => set('industry', v)}
            placeholder="e.g. Dental clinic, restaurant, SaaS product"
          />
        </Field>
        <Field label="Business model">
          <Input
            value={form.businessModel}
            onChange={v => set('businessModel', v)}
            placeholder="e.g. subscription SaaS, appointment-based services, e-commerce"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Main product or service" full={false}>
            <Input
              value={form.productOrService}
              onChange={v => set('productOrService', v)}
              placeholder="One sentence — what they sell"
            />
          </Field>
          <Field label="Year founded" full={false}>
            <Input
              value={form.yearFounded}
              onChange={v => set('yearFounded', v)}
              placeholder="e.g. 2018"
            />
          </Field>
        </div>
      </Section>

      {/* Audience */}
      <Section meta={SECTION_META.audience} subtitle="Who buys, where, and in what language?" defaultOpen>
        <Field label="Target audience">
          <Textarea
            value={form.targetAudience}
            onChange={v => set('targetAudience', v)}
            placeholder="e.g. Families and young adults looking for quality dental care"
            rows={2}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Geographic market" full={false}>
            <Input
              value={form.geographicMarket}
              onChange={v => set('geographicMarket', v)}
              placeholder="e.g. Greater Toronto Area / United Kingdom / Global"
            />
          </Field>
          <Field label="Primary language(s)" full={false}>
            <Input
              value={form.language}
              onChange={v => set('language', v)}
              placeholder="e.g. English, Spanish, French"
            />
          </Field>
        </div>
      </Section>

      {/* Goal */}
      <Section meta={SECTION_META.goal} subtitle="What should the website actually drive?" defaultOpen>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {GOAL_OPTIONS.map(opt => (
            <GoalTile
              key={opt.value}
              label={opt.label}
              active={form.primaryGoal === opt.value}
              onClick={() => set('primaryGoal', opt.value)}
            />
          ))}
        </div>
        {form.primaryGoal === 'other' && (
          <div className="mt-3">
            <Field label="Describe your goal">
              <Input
                value={form.primaryGoalOther}
                onChange={v => set('primaryGoalOther', v)}
                placeholder="What's the main thing visitors should do?"
              />
            </Field>
          </div>
        )}
      </Section>

      {/* Content */}
      <Section meta={SECTION_META.content} subtitle="Specifics that make the prompt genuinely useful" defaultOpen>
        <Field
          label="Services or products offered"
          hint="One per line — populates the services section of the site"
        >
          <Textarea
            value={form.services}
            onChange={v => set('services', v)}
            placeholder={'General dentistry\nDental implants\nOrthodontics'}
            rows={4}
          />
        </Field>
        <Field
          label="Unique differentiator"
          hint="What sets this business apart? Be specific."
        >
          <Textarea
            value={form.uniqueValueProp}
            onChange={v => set('uniqueValueProp', v)}
            placeholder="e.g. Weekend hours, pediatric specialists, family-owned since 2014"
            rows={2}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4">
          <Field label="Brand voice / tone">
            <Input
              value={form.brandVoice}
              onChange={v => set('brandVoice', v)}
              placeholder="e.g. warm and approachable, authoritative, playful"
            />
          </Field>
          <Field label="Existing copy" hint="Any tagline, mission, or about-us text the AI should adapt — optional">
            <Textarea
              value={form.existingCopy}
              onChange={v => set('existingCopy', v)}
              placeholder="Paste any existing copy here"
              rows={3}
            />
          </Field>
        </div>
      </Section>

      {/* Brand — collapsible */}
      <CollapsibleSection
        meta={SECTION_META.brand}
        subtitle="Visual assets already in place"
        collapsed={collapsedSections.has('brand')}
        onToggle={() => toggleSection('brand')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ToggleField
            label="Logo available?"
            checked={form.hasLogo}
            onChange={v => set('hasLogo', v)}
          />
          <ToggleField
            label="Brand colours specified?"
            checked={form.hasBrandColors}
            onChange={v => set('hasBrandColors', v)}
          />
        </div>
        <AnimatePresence>
          {form.hasBrandColors && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <Field label="Brand colours">
                <Input
                  value={form.brandColors}
                  onChange={v => set('brandColors', v)}
                  placeholder="e.g. Primary #2C7A7B (teal), Accent #FBD38D (warm peach)"
                />
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        <Field label="Preferred fonts" hint="Optional — overrides niche default">
          <Input
            value={form.preferredFonts}
            onChange={v => set('preferredFonts', v)}
            placeholder="e.g. Inter for body, Fraunces for headlines"
          />
        </Field>
      </CollapsibleSection>

      {/* References & Must-Haves */}
      <Section meta={SECTION_META.refs} subtitle="Sites the client likes and specific features the site must have" defaultOpen>
        <Field
          label="Inspiration sites"
          hint="URLs of sites the client likes — one per line"
        >
          <Textarea
            value={form.inspirationSites}
            onChange={v => set('inspirationSites', v)}
            placeholder={'https://example1.com\nhttps://example2.com'}
            rows={2}
          />
        </Field>
        <Field
          label="Required features"
          hint="Specific functionality the site must have"
        >
          <Textarea
            value={form.requiredFeatures}
            onChange={v => set('requiredFeatures', v)}
            placeholder={'e.g.\nWhatsApp button\nLive Google Reviews\nMulti-language toggle'}
            rows={3}
          />
        </Field>
        <Field
          label="Integrations needed"
          hint="External tools to connect"
        >
          <Textarea
            value={form.integrationsNeeded}
            onChange={v => set('integrationsNeeded', v)}
            placeholder={'e.g.\nCalendly for booking\nMailchimp for newsletter\nStripe for payments'}
            rows={3}
          />
        </Field>
      </Section>

      {/* Technical — collapsible */}
      <CollapsibleSection
        meta={SECTION_META.technical}
        subtitle="Budget, timeline, compliance — shapes stack recommendations"
        collapsed={collapsedSections.has('technical')}
        onToggle={() => toggleSection('technical')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Budget tier" full={false}>
            <Select
              value={form.budgetTier}
              onChange={v => set('budgetTier', v as Budget)}
              options={BUDGET_OPTIONS}
            />
          </Field>
          <Field label="Timeline" full={false}>
            <Input
              value={form.timeline}
              onChange={v => set('timeline', v)}
              placeholder="e.g. 4 weeks, ASAP, no rush"
            />
          </Field>
        </div>
        <Field label="Compliance requirements" hint="e.g. GDPR, HIPAA, PCI-DSS, accessibility">
          <Input
            value={form.compliance}
            onChange={v => set('compliance', v)}
            placeholder="Leave blank if none"
          />
        </Field>
      </CollapsibleSection>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Action bar */}
      <div className="sticky bottom-4 z-30 flex items-center justify-between gap-3 bg-background/85 backdrop-blur-xl py-4 px-5 border border-border rounded-2xl shadow-lg">
        <div className="text-xs text-text-secondary">
          {canSubmit ? (
            <>Ready to generate. The more detail, the better the output.</>
          ) : (
            <>Add a business name to enable generation.</>
          )}
        </div>
        <button
          onClick={onSubmit}
          disabled={!canSubmit || status === 'generating'}
          className="btn-primary px-6 py-3 text-sm shadow-glow-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {status === 'generating' ? (
            <><img src="/lumen-logo.png" alt="" className="w-4 h-4 animate-[spin_2.2s_linear_infinite]" draggable={false} /> Generating…</>
          ) : (
            <><Wand2 className="w-4 h-4" /> Generate Blueprint</>
          )}
        </button>
      </div>
    </div>
  )
}

// ─── SECTION COMPONENTS ───────────────────────────────────────────────────────

interface SectionMeta { icon: React.ElementType; color: string; label: string }

function Section({ meta, subtitle, children }: { meta: SectionMeta; subtitle: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card p-6"
    >
      <div className="flex items-start gap-4 mb-5 pb-4 border-b border-border">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-display font-bold text-text-primary">{meta.label}</h3>
          <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </motion.div>
  )
}

function CollapsibleSection({
  meta, subtitle, collapsed, onToggle, children
}: {
  meta: SectionMeta
  subtitle: string
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card overflow-hidden"
    >
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-4 p-6 hover:bg-surface-2/40 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-display font-bold text-text-primary">{meta.label}</h3>
            <span className="text-[10px] text-text-muted uppercase tracking-widest">Optional</span>
          </div>
          <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>
        </div>
        <ChevronDown
          className={`w-5 h-5 text-text-muted transition-transform flex-shrink-0 ${collapsed ? '' : 'rotate-180'}`}
        />
      </button>
      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-6 pb-6 pt-0 space-y-4 border-t border-border">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ─── FIELD PRIMITIVES ─────────────────────────────────────────────────────────

function Field({ label, hint, required, full = true, children }: {
  label: string; hint?: string; required?: boolean; full?: boolean; children: React.ReactNode
}) {
  return (
    <div className={full ? '' : ''}>
      <label className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-text-secondary">
          {label}{required && <span className="text-primary ml-1">*</span>}
        </span>
        {hint && (
          <span className="text-[10px] text-text-muted italic max-w-[60%] text-right truncate">{hint}</span>
        )}
      </label>
      {children}
    </div>
  )
}

function Input({ value, onChange, placeholder, autoFocus }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  return (
    <input
      autoFocus={autoFocus}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary/60 focus:bg-surface-2 transition-colors"
    />
  )
}

function Textarea({ value, onChange, placeholder, rows = 3 }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary/60 focus:bg-surface-2 transition-colors resize-none"
    />
  )
}

function Select({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-sm text-text-primary focus:outline-none focus:border-primary/60 transition-colors"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center justify-between gap-3 p-3 rounded-lg border transition-all w-full ${
        checked
          ? 'border-primary/40 bg-primary/5'
          : 'border-border bg-surface hover:bg-surface-2'
      }`}
    >
      <span className="text-sm text-text-primary font-medium">{label}</span>
      <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-primary' : 'bg-surface-2 border border-border'}`}>
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  )
}

function GoalTile({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`p-3 rounded-xl border transition-all text-left ${
        active
          ? 'border-primary/60 bg-primary/10 shadow-glow-sm'
          : 'border-border bg-surface hover:bg-surface-2 hover:border-border-2'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 mt-0.5 ${active ? 'border-primary' : 'border-text-muted'}`}>
          {active && <div className="w-full h-full rounded-full bg-primary scale-50" />}
        </div>
        <span className={`text-xs font-medium leading-tight ${active ? 'text-text-primary' : 'text-text-secondary'}`}>
          {label}
        </span>
      </div>
    </button>
  )
}

// ─── RESULTS VIEW ─────────────────────────────────────────────────────────────

function ResultsView({ result, promptCopied, onCopy }: { result: any; promptCopied: boolean; onCopy: () => void }) {
  const plan = result.plan || {}
  const profile = result.profile || {}

  return (
    <div className="space-y-6">
      {/* Niche + summary */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-card p-6 border-primary/20 bg-primary/5"
      >
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-[10px] uppercase tracking-widest font-semibold text-text-muted">Classified niche</span>
              <span className="badge bg-primary/20 text-primary text-[10px] px-2 py-0.5">{profile.label || result.niche}</span>
            </div>
            <p className="text-text-primary text-base font-medium leading-relaxed">{result.businessSummary}</p>
            <p className="text-text-secondary text-sm mt-3 leading-relaxed">{profile.positioning}</p>
          </div>
        </div>
      </motion.div>

      {/* Primary conversion */}
      {plan.primaryConversion && (
        <Card title="Primary Conversion Mechanism" icon={Target}>
          <p className="text-text-primary font-medium">{plan.primaryConversion.label}</p>
          <p className="text-sm text-text-secondary leading-relaxed mt-2">{plan.primaryConversion.notes}</p>
        </Card>
      )}

      {/* Pages */}
      {plan.pages && plan.pages.length > 0 && (
        <Card title="Required Pages" subtitle={`${plan.pages.length} pages structured for ${profile.label || 'this site type'}`} icon={Globe}>
          <div className="space-y-2">
            {plan.pages.map((p: any, i: number) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-surface border border-border">
                <code className="text-[11px] font-mono bg-surface-2 px-2 py-1 rounded text-primary flex-shrink-0">{p.path}</code>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{p.label}</p>
                  <p className="text-xs text-text-secondary mt-0.5">{p.purpose}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Homepage sections */}
      {plan.homeSections && plan.homeSections.length > 0 && (
        <Card title="Homepage Structure" subtitle="Top-to-bottom section plan with required content" icon={Layers}>
          <div className="space-y-3">
            {plan.homeSections.map((s: any, i: number) => (
              <div key={i} className="p-4 rounded-xl border border-border bg-surface">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-bold text-text-muted bg-surface-2 rounded px-1.5 py-0.5">{i + 1}</span>
                  <h4 className="text-sm font-semibold text-text-primary">{s.name}</h4>
                </div>
                <p className="text-xs text-text-secondary italic mb-3">{s.purpose}</p>
                <ul className="space-y-1.5">
                  {s.must.map((m: string, j: number) => (
                    <li key={j} className="flex items-start gap-2 text-xs text-text-secondary">
                      <ChevronRight className="w-3 h-3 text-primary flex-shrink-0 mt-0.5" />
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Compact grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plan.trustSignals && <CompactCard title="Trust Signals" items={plan.trustSignals} />}
        {plan.schemaTypes && <CompactCard title="Schema Markup" items={plan.schemaTypes} mono />}
        {plan.technical && <CompactCard title="Technical Requirements" items={plan.technical} />}
        {plan.integrations && <CompactCard title="Recommended Integrations" items={plan.integrations} />}
        {plan.visualStyle && (
          <div className="glass-card p-4 md:col-span-2">
            <h4 className="text-xs font-bold uppercase tracking-widest text-text-muted mb-3">Visual Style</h4>
            <dl className="space-y-2 text-xs">
              <div><dt className="text-text-muted">Palette:</dt><dd className="text-text-secondary mt-0.5">{plan.visualStyle.palette}</dd></div>
              <div><dt className="text-text-muted">Typography:</dt><dd className="text-text-secondary mt-0.5">{plan.visualStyle.typography}</dd></div>
              <div><dt className="text-text-muted">Imagery:</dt><dd className="text-text-secondary mt-0.5">{plan.visualStyle.imagery}</dd></div>
              <div><dt className="text-text-muted">Mood:</dt><dd className="text-text-secondary mt-0.5">{plan.visualStyle.mood}</dd></div>
            </dl>
          </div>
        )}
      </div>

      {/* Tracking */}
      {plan.tracking && (
        <Card title="Marketing & Analytics" icon={Zap}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <TrackBadge label="GA4" on={plan.tracking.googleAnalytics} />
            <TrackBadge label="GTM" on={plan.tracking.tagManager} />
            <TrackBadge label="Meta Pixel" on={plan.tracking.metaPixel} />
            <TrackBadge label="LinkedIn Insight" on={plan.tracking.linkedinInsight} />
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">{plan.tracking.notes}</p>
        </Card>
      )}

      {/* AI prompt — headline output */}
      <Card
        title="AI Builder Prompt"
        subtitle="Paste into Claude / v0 / Lovable / Cursor"
        icon={Wand2}
        action={
          <button onClick={onCopy} className="btn-primary px-4 py-2 text-xs flex items-center gap-1.5">
            {promptCopied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy Prompt</>}
          </button>
        }
      >
        <div className="relative">
          <div className="absolute top-3 right-3 flex items-center gap-1.5 text-[10px] text-text-muted bg-surface-2/60 px-2 py-1 rounded backdrop-blur-sm">
            <FileText className="w-3 h-3" />
            <span>{result.aiPrompt?.length || 0} chars · {(result.aiPrompt?.split('\n').length || 0)} lines</span>
          </div>
          <pre className="bg-surface-3 border border-border rounded-xl p-5 pt-10 text-xs leading-relaxed overflow-x-auto max-h-[500px] overflow-y-auto font-mono text-text-secondary whitespace-pre-wrap">
            {result.aiPrompt}
          </pre>
        </div>
      </Card>
    </div>
  )
}

function Card({ title, subtitle, action, children }: {
  title: string; subtitle?: string; icon?: React.ElementType; action?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <div>
            <h3 className="text-base font-display font-bold text-text-primary">{title}</h3>
            {subtitle && <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </motion.div>
  )
}

function CompactCard({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  return (
    <div className="glass-card p-4">
      <h4 className="text-xs font-bold uppercase tracking-widest text-text-muted mb-3">{title}</h4>
      <ul className="space-y-1.5">
        {items.slice(0, 8).map((item, i) => (
          <li key={i} className={`text-xs text-text-secondary leading-relaxed ${mono ? 'font-mono' : ''}`}>
            <span className="text-primary mr-1.5">•</span>{item}
          </li>
        ))}
        {items.length > 8 && (
          <li className="text-[10px] text-text-muted italic">+ {items.length - 8} more</li>
        )}
      </ul>
    </div>
  )
}

function TrackBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <div className={`flex items-center gap-2 p-2 rounded-lg border ${on ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-surface text-text-muted'}`}>
      <span className="text-xs font-medium">{label}</span>
    </div>
  )
}

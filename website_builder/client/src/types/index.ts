// All shared TypeScript types for the Lumen platform

export interface AuditResult {
  id: string
  url: string
  createdAt: string
  performance: PerformanceAudit
  seo: SEOAudit
  marketing: MarketingAudit
  conversion: ConversionAudit
  security: SecurityAudit
  techStack: TechStackAudit
  overallScore: number
  opportunityScore: OpportunityScore
}

export interface PerformanceAudit {
  score: number
  pageSpeed: CheckItem
  coreWebVitals: CheckItem
  mobileResponsiveness: CheckItem
  ssl: CheckItem
  imageOptimization: CheckItem
}

export interface SEOAudit {
  score: number
  titleTag: CheckItem
  metaDescription: CheckItem
  h1Tags: CheckItem
  altTags: CheckItem
  robotsTxt: CheckItem
  sitemap: CheckItem
  schemaMarkup: CheckItem
  canonicalUrls: CheckItem
}

export interface MarketingAudit {
  score: number
  googleAnalytics: CheckItem
  googleTagManager: CheckItem
  metaPixel: CheckItem
  linkedinPixel: CheckItem
  newsletterForms: CheckItem
  liveChat: CheckItem
}

export interface ConversionAudit {
  score: number
  ctaVisibility: CheckItem
  contactForm: CheckItem
  bookingForm: CheckItem
  testimonials: CheckItem
  trustSignals: CheckItem
  phoneVisibility: CheckItem
  whatsappIntegration: CheckItem
}

export interface SecurityAudit {
  score: number
  https: CheckItem
  securityHeaders: CheckItem
  openAdminPages: CheckItem
  cmsDetection: CheckItem
}

export interface TechStackAudit {
  cms: string | null
  framework: string | null
  hostingProvider: string | null
  cdn: string | null
  analyticsTools: string[]
  crmTools: string[]
  marketingTools: string[]
}

export interface CheckItem {
  label: string
  status: 'pass' | 'fail' | 'warning' | 'unknown'
  value?: string
  impact?: 'high' | 'medium' | 'low'
  recommendation?: string
  opportunityPoints?: number
}

export interface OpportunityScore {
  performance: number
  seo: number
  marketing: number
  conversion: number
  security: number
  overall: number
  level: 'low' | 'medium' | 'high' | 'very-high'
  growthPotential: string
  priorityFixes: PriorityFix[]
  businessImpact: string
  leadOpportunity: string
}

export interface PriorityFix {
  title: string
  points: number
  impact: 'high' | 'medium' | 'low'
  category: string
}

export interface WebsiteIntelligence {
  id: string
  url: string
  primaryKeywords: string[]
  secondaryKeywords: string[]
  keywordDensity: KeywordDensity[]
  seoStructure: SeoStructure
  contentStrategy: string
  internalLinking: string
  navigationStructure: string[]
  brandPositioning: string
  uniqueSellingProps: string[]
  colorPalette: ColorInfo[]
  typography: TypographyInfo
  trustSignals: string[]
  conversionFunnel: string[]
}

export interface KeywordDensity {
  keyword: string
  count: number
  density: number
}

export interface SeoStructure {
  hasH1: boolean
  h1Text?: string
  headingCount: number
  metaTitle?: string
  metaDesc?: string
}

export interface ColorInfo {
  hex: string
  name: string
  usage: string
}

export interface TypographyInfo {
  primaryFont: string
  secondaryFont?: string
  headingSize: string
  bodySize: string
}

export interface Requirement {
  id: string
  createdAt: string
  updatedAt: string
  // Business Details
  businessName: string
  businessType: string
  industry: string
  businessWebsite?: string
  businessLocation?: string
  numberOfEmployees?: string
  yearsInBusiness?: string
  servicesOffered?: string
  businessDescription?: string
  currentWebsiteStatus?: string
  // Owner Details
  ownerName?: string
  ownerEmail: string
  ownerPhone?: string
  designation?: string
  preferredContactMethod?: string
  bestTimeToContact?: string
  // Project Details
  targetAudience: string
  goals?: string
  requiredPages?: string
  requiredFeatures?: string
  competitors?: string
  timeline?: string
  // Branding
  brandStyle?: string
  colorPreferences?: string
  designPreferences?: string
  // Requirements
  additionalNotes?: string
  detailedRequirements?: string
  // Files
  uploadedFiles?: string
  // JSON blob
  rawData?: string
  status: 'pending' | 'in-review' | 'completed'
}

export interface Strategy {
  id: string
  requirementId?: string
  auditId?: string
  createdAt: string
  websiteGoals: string[]
  userJourney: UserJourneyStep[]
  customerPersonas: CustomerPersona[]
  sitemap: SitemapNode[]
  contentStrategy: string
  seoStrategy: string
  conversionStrategy: string
  designSystem: string
  technicalRecommendations: string[]
  developmentRoadmap: RoadmapPhase[]
}

export interface UserJourneyStep {
  step: number
  title: string
  description: string
  touchpoints: string[]
}

export interface CustomerPersona {
  name: string
  age: string
  role: string
  painPoints: string[]
  goals: string[]
}

export interface SitemapNode {
  page: string
  url: string
  children?: SitemapNode[]
  priority: 'high' | 'medium' | 'low'
}

export interface RoadmapPhase {
  phase: number
  title: string
  duration: string
  tasks: string[]
  deliverables: string[]
}

export interface Blueprint {
  id: string
  requirementId?: string
  strategyId?: string
  createdAt: string
  pages: BlueprintPage[]
}

export interface BlueprintPage {
  name: string
  url: string
  sections: BlueprintSection[]
  developerNotes: string[]
  designerNotes: string[]
}

export interface BlueprintSection {
  name: string
  components: string[]
  content: string
  features: string[]
}

export interface GeneratedPrompt {
  id: string
  requirementId?: string
  createdAt: string
  platform: 'claude' | 'chatgpt' | 'lovable' | 'bolt' | 'cursor' | 'replit'
  basicPrompt: string
  advancedPrompt: string
  developerPrompt: string
  designPrompt: string
}

export interface Competitor {
  id: string
  name: string
  url: string
  speed: number
  seoScore: number
  conversionScore: number
  techStack: string[]
  trustSignals: string[]
  designQuality: number
  features: string[]
  marketingIntegrations: string[]
  strengths: string[]
  weaknesses: string[]
}

export interface RevenueOpportunity {
  id: string
  auditId?: string
  requirementId?: string
  createdAt: string
  potentialRevenueLoss: number
  leadLossEstimation: number
  conversionImprovementPotential: number
  projectedRevenueGain: number
  businessImpactSummary: string
  monthlyProjection: MonthlyProjection[]
  assumptions: string[]
}

export interface MonthlyProjection {
  month: string
  current: number
  projected: number
}

export interface CRMEntry {
  id: string
  leadId?: string
  requirementId?: string
  auditId?: string
  createdAt: string
  updatedAt: string
  auditReport?: string
  opportunityScore?: number
  competitorAnalysis?: string
  revenueEstimate?: number
  strategyDocument?: string
  blueprint?: string
  generatedPrompts?: string
  outreachNotes?: string
  followUpHistory?: FollowUp[]
  status: 'new' | 'contacted' | 'proposal' | 'won' | 'lost'
}

export interface FollowUp {
  date: string
  note: string
  method: string
  outcome: string
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

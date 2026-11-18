export interface SearchResult {
  name: string
  url: string
  domain: string
  description: string
  provider?: string
  query?: string
  stage1Confirmed?: boolean
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>
}

export interface WebsiteInspirationResult {
  name: string
  domain: string
  url: string
  searchRank: number
  pageTitle: string
  metaDescription: string
  faviconUrl: string
  screenshotPath: string // Static URL or local filename
  httpStatus: number
  responseTime: number // ms
  captureTime: string // ISO timestamp
  screenshotResolution: string // e.g. "1280x2400"
  screenshotSize: number // bytes
  status: 'Captured Successfully' | 'Failed'
  errorMessage?: string

  // Brand/Design metadata (extracted during browser crawl)
  primaryBrandColor?: string
  secondaryBrandColor?: string
  fontFamilies?: string[]
  logoUrl?: string

  // Business information fields
  justdialUrl?: string
  address?: string
  city?: string
  state?: string
  confidence?: number
  selectionReason?: string
  selectedBy?: "gemini" | "rule-engine"
  candidateCount?: number
}

export interface InspirationModuleCache {
  [queryKey: string]: {
    cachedAt: string // ISO timestamp
    results: WebsiteInspirationResult[]
  }
}

import axios from 'axios'

export interface WebsiteInspirationResult {
  name: string
  domain: string
  url: string
  searchRank: number
  pageTitle: string
  metaDescription: string
  faviconUrl: string
  screenshotPath: string
  httpStatus: number
  responseTime: number
  captureTime: string
  screenshotResolution: string
  screenshotSize: number
  status: 'Captured Successfully' | 'Failed'
  errorMessage?: string

  primaryBrandColor?: string
  secondaryBrandColor?: string
  fontFamilies?: string[]
  logoUrl?: string
}

export interface InspirationApiResponse {
  source: 'live' | 'cache'
  results: WebsiteInspirationResult[]
}

export const inspirationApi = {
  get: async (input: {
    businessName?: string
    businessType: string
    industry: string
    keyword?: string
    description?: string
  }): Promise<InspirationApiResponse> => {
    const res = await axios.post('/api/inspiration', input, { timeout: 120000 })
    return res.data
  }
}

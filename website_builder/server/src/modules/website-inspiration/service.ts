import * as fs from 'fs'
import * as path from 'path'
import { chromium } from 'playwright-chromium'
import { SearchResult, WebsiteInspirationResult } from './types'

const SCREENSHOTS_DIR = path.join(process.env.LUMEN_STUDIO_DATA_DIR || process.cwd(), 'screenshots')
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })
}

const DIRECTORY_DOMAINS = [
  'yelp.com', 'yellowpages.com', 'whitepages.com', 'tripadvisor.', 'facebook.com',
  'instagram.com', 'linkedin.com', 'pinterest.com', 'twitter.com', 'youtube.com',
  'wikipedia.org', 'local.com', 'threebestrated.', 'groupon.com', 'expedia.com',
  'booking.com', 'foursquare.com', 'reddit.com', 'justdial.com', 'indiamart.com'
]

interface GeminiDiscoveredWebsite {
  businessName: string
  website: string
  address?: string
  city?: string
  state?: string
  country?: string
  confidence?: number
}

export class InspirationService {
  /**
   * Normalize search location parameter
   */
  private static normalizeLocation(location: string): string {
    return String(location || '').trim().replace(/\s+/g, ' ')
  }

  /**
   * Helper to clean markdown json code block wraps from Gemini output
   */
  private static parseGeminiJsonResponse(text: string): any {
    let clean = text.trim()
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```[a-zA-Z0-9]*\s*/, '')
      clean = clean.replace(/\s*```$/, '')
    }
    return JSON.parse(clean)
  }

  /**
   * Discovery Source: Google Gemini REST API
   * Generates a prompt and contacts the Gemini generateContent endpoint.
   */
  static async searchWebsites(
    businessType: string,
    industry: string,
    keyword: string,
    description: string
  ): Promise<SearchResult[]> {
    const cleanLocation = this.normalizeLocation(keyword)
    if (!cleanLocation) return []

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      console.warn('[DiscoveryService] GEMINI_API_KEY is not configured.')
      return []
    }

    const model = 'gemini-flash-latest'
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    // Dynamically build the prompt exactly as requested by the user
    const promptText = `You are a professional business discovery assistant.

Find official business websites matching the following request.

Business Type:
${businessType}

Industry:
${industry}

Location:
${cleanLocation}

Requirements:

* Search for real businesses operating in the requested location.
* Return only official business websites.
* Do NOT return directory websites.
* Do NOT return listing websites.
* Do NOT return social media profiles.
* Do NOT return marketplace pages.
* Do NOT return review pages.
* Do NOT invent businesses.
* Do NOT invent URLs.
* Do NOT guess websites.
* Return at least 10 businesses whenever possible.
* If fewer than 10 businesses exist in the exact locality, gradually expand to the nearest administrative area until enough real businesses are found.
* Every website must belong to the requested business and location.

Return JSON only.

Expected JSON:
{
  "websites":[
    {
      "businessName":"",
      "website":"",
      "address":"",
      "city":"",
      "state":"",
      "country":"",
      "confidence":95
    }
  ]
}

Only return valid JSON. Do not include markdown formatting, code blocks like "\`\`\`json", or any conversational text.`

    console.log(`[DiscoveryService] Querying Gemini model="${model}" for location="${cleanLocation}"`)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }),
        signal: AbortSignal.timeout(45000)
      })

      if (!res.ok) {
        throw new Error(`Gemini API returned status ${res.status}: ${res.statusText}`)
      }

      const data = await res.json() as any
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (text) {
        const parsed = this.parseGeminiJsonResponse(text)
        if (parsed && Array.isArray(parsed.websites)) {
          const list: GeminiDiscoveredWebsite[] = parsed.websites
          
          console.log(`[DiscoveryService] Gemini returned ${list.length} candidate websites.`)

          // Convert candidates to SearchResult format
          return list.map(item => ({
            name: item.businessName,
            url: item.website || '',
            domain: item.website ? new URL(item.website).hostname.replace('www.', '') : '',
            description: `Address: ${item.address || ''}, City: ${item.city || ''}, State: ${item.state || ''}`,
            provider: 'GeminiAPI',
            query: `${businessType} ${cleanLocation}`,
            stage1Confirmed: true,
            address: item.address,
            city: item.city,
            state: item.state,
            country: item.country,
            confidence: item.confidence
          }))
        }
      }
    } catch (e: any) {
      console.error('[DiscoveryService] Gemini Search Request failed:', e)
    }

    return []
  }

  /**
   * Process & Capture Screenshots Pipeline
   */
  static async processWebsites(searchResults: SearchResult[], keyword: string): Promise<WebsiteInspirationResult[]> {
    const candidates = searchResults as any[]
    
    // De-duplicate Candidate Websites by domain and name
    const seenNames = new Set<string>()
    const seenDomains = new Set<string>()
    const uniqueCandidates: any[] = []

    for (const cand of candidates) {
      const nameNorm = cand.name.toLowerCase().trim()
      const domainNorm = cand.domain.toLowerCase().trim()
      
      if (!cand.url || seenNames.has(nameNorm) || seenDomains.has(domainNorm)) {
        continue
      }

      // Format check (valid http/https URL)
      try {
        new URL(cand.url)
      } catch {
        console.log(`[Validation] Discarding malformed URL: ${cand.url}`)
        continue
      }

      // Directory / Social Media filter
      const isDirectory = DIRECTORY_DOMAINS.some(d => cand.url.includes(d)) || cand.url.includes('google.com/search')
      if (isDirectory) {
        console.log(`[Validation] Discarding directory listing URL: ${cand.url}`)
        continue
      }

      seenNames.add(nameNorm)
      seenDomains.add(domainNorm)
      uniqueCandidates.push(cand)
    }

    const validatedBusinesses = uniqueCandidates.slice(0, 11) // Limit to 11 candidates to prevent frontend Axios query timeouts
    console.log(`[Pipeline] Validating reachability & capturing screenshots for ${validatedBusinesses.length} official candidates...`)

    const finalResults: WebsiteInspirationResult[] = []
    const concurrencyLimit = 3
    let browser: any = null

    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      })
    } catch (e) {
      console.warn('[Pipeline] Failed to launch Playwright browser:', e)
    }

    for (let i = 0; i < validatedBusinesses.length; i += concurrencyLimit) {
      const batch = validatedBusinesses.slice(i, i + concurrencyLimit)
      const promises = batch.map((biz, idx) => {
        const rank = i + idx + 1
        return this.processSingleWebsite(browser, biz, rank)
      })
      const batchResults = await Promise.all(promises)
      for (const res of batchResults) {
        if (res !== null) {
          finalResults.push(res)
        }
      }
    }

    if (browser) {
      try {
        await browser.close()
      } catch {}
    }

    // Sort: successful captures first, then high confidence scores
    finalResults.sort((a, b) => {
      const capA = a.status === 'Captured Successfully' ? 1 : 0
      const capB = b.status === 'Captured Successfully' ? 1 : 0
      if (capA !== capB) return capB - capA

      const confA = a.confidence || 0
      const confB = b.confidence || 0
      return confB - confA
    })

    finalResults.forEach((res, idx) => {
      res.searchRank = idx + 1
    })

    return finalResults
  }

  /**
   * Process & capture single website metadata & layout
   */
  private static async processSingleWebsite(
    browser: any,
    biz: any,
    rank: number
  ): Promise<WebsiteInspirationResult | null> {
    const timestamp = Date.now()
    const parsedUrl = new URL(biz.url)
    const sanitizedDomain = parsedUrl.hostname.replace(/[^a-z0-9]/gi, '_').toLowerCase()
    const filename = `${sanitizedDomain}-${timestamp}.png`
    const filePath = path.join(SCREENSHOTS_DIR, filename)

    const result: WebsiteInspirationResult = {
      name: biz.name,
      domain: parsedUrl.hostname.replace('www.', ''),
      url: biz.url,
      searchRank: rank,
      pageTitle: biz.name,
      metaDescription: biz.description || '',
      faviconUrl: `https://www.google.com/s2/favicons?sz=64&domain=${parsedUrl.hostname}`,
      screenshotPath: '',
      httpStatus: 200,
      responseTime: 0,
      captureTime: new Date().toISOString(),
      screenshotResolution: '1280x800',
      screenshotSize: 0,
      status: 'Failed',
      address: biz.address,
      city: biz.city,
      state: biz.state,
      confidence: biz.confidence,
      selectionReason: 'Discovered by Gemini API',
      selectedBy: 'gemini',
      candidateCount: 1
    }

    if (!browser) {
      return result
    }

    let context: any = null
    let page: any = null

    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1
      })
      page = await context.newPage()

      const startTime = Date.now()
      const response = await page.goto(biz.url, {
        waitUntil: 'commit',
        timeout: 15000
      })
      result.responseTime = Date.now() - startTime
      result.httpStatus = response ? response.status() : 200

      // Discard unreachable status
      if (result.httpStatus >= 400) {
        console.warn(`[Pipeline] Discarding unreachable URL ${biz.url} - Status ${result.httpStatus}`)
        return null
      }

      try {
        await page.waitForLoadState('networkidle', { timeout: 4000 })
      } catch {}

      // Scroll page slightly to trigger lazy load assets
      try {
        await page.evaluate(async () => {
          const win = globalThis as any
          await new Promise<void>((resolve) => {
            let totalHeight = 0
            const distance = 150
            const timer = win.setInterval(() => {
              const scrollHeight = win.document.body.scrollHeight
              win.scrollBy(0, distance)
              totalHeight += distance
              if (totalHeight >= scrollHeight || totalHeight > 3000) {
                win.clearInterval(timer)
                resolve()
              }
            }, 40)
          })
        })
        await page.waitForTimeout(500)
        await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0))
      } catch {}

      // Extract metadata & assets
      const metadata = await page.evaluate(() => {
        const win = globalThis as any
        const doc = win.document

        // Fonts
        const fontSet = new Set<string>()
        const elements = Array.from(doc.querySelectorAll('body, h1, h2, h3, p, a, button')) as any[]
        for (const el of elements.slice(0, 30)) {
          const style = win.getComputedStyle(el)
          const font = style.fontFamily
          if (font) {
            const primaryFont = font.split(',')[0].replace(/['"]/g, '').trim()
            if (primaryFont) fontSet.add(primaryFont)
          }
        }

        // Colors
        const colorMap = new Map<string, number>()
        const colorElements = Array.from(doc.querySelectorAll('header, nav, footer, button, .btn, [class*="primary"], h1')) as any[]
        for (const el of colorElements) {
          const style = win.getComputedStyle(el)
          const bg = style.backgroundColor
          const fg = style.color
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            colorMap.set(bg, (colorMap.get(bg) || 0) + 1)
          }
          if (fg && fg !== 'rgba(0, 0, 0, 0)' && fg !== 'transparent') {
            colorMap.set(fg, (colorMap.get(fg) || 0) + 1)
          }
        }
        const sortedColors = Array.from(colorMap.entries())
          .filter(([color]) => {
            return !color.includes('rgba(0, 0, 0, 0)') && color !== 'rgb(255, 255, 255)' && color !== 'rgb(0, 0, 0)'
          })
          .sort((a, b) => b[1] - a[1])
          .map(([color]) => color)

        // Logo
        let logoUrl = ''
        const logoImg = doc.querySelector('img[src*="logo" i], img[class*="logo" i], img[id*="logo" i]')
        if (logoImg && (logoImg as any).src) {
          logoUrl = (logoImg as any).src
        }

        // Favicon
        let faviconUrl = ''
        const favEl = doc.querySelector('link[rel*="icon" i]')
        if (favEl && (favEl as any).href) {
          faviconUrl = (favEl as any).href
        }

        return {
          fontFamilies: Array.from(fontSet).slice(0, 5),
          primaryBrandColor: sortedColors[0] || 'rgb(37, 99, 235)',
          secondaryBrandColor: sortedColors[1] || 'rgb(79, 70, 229)',
          logoUrl,
          pageTitle: doc.title || '',
          metaDescription: doc.querySelector('meta[name="description" i]')?.getAttribute('content') || '',
          faviconUrl
        }
      })

      if (metadata) {
        result.fontFamilies = metadata.fontFamilies
        result.primaryBrandColor = metadata.primaryBrandColor
        result.secondaryBrandColor = metadata.secondaryBrandColor
        if (metadata.logoUrl) result.logoUrl = metadata.logoUrl
        if (metadata.pageTitle) result.pageTitle = metadata.pageTitle
        if (metadata.metaDescription) result.metaDescription = metadata.metaDescription.slice(0, 300)
        if (metadata.faviconUrl) result.faviconUrl = metadata.faviconUrl
      }

      const bodyHeight = await page.evaluate(() => (globalThis as any).document.body.scrollHeight)
      result.screenshotResolution = `1280x${bodyHeight}`

      // Capture screenshot
      await page.screenshot({ path: filePath, fullPage: true })
      result.screenshotPath = `screenshots/${filename}`
      result.screenshotSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
      result.status = 'Captured Successfully'

    } catch (e: any) {
      console.warn(`[Pipeline] Failed capturing single website ${biz.url}:`, e.message)
      result.errorMessage = e.message || 'Page load timeout'
    } finally {
      if (page) {
        try { await page.close() } catch {}
      }
      if (context) {
        try { await context.close() } catch {}
      }
    }

    return result
  }

  /**
   * Prompt Enhancement Generator Add-on
   * Summarizes the validated URLs, observed layouts, CTA styles, typography, and patterns.
   */
  static generatePromptEnhancement(
    results: WebsiteInspirationResult[],
    businessType: string,
    industry: string
  ): string {
    const activeWebsites = results.filter(r => r.status === 'Captured Successfully')
    const websitesText = activeWebsites.map((r, idx) => `${idx + 1}. ${r.url}`).join('\n')

    // Collect observed fonts and colors dynamically
    const fonts = Array.from(new Set(activeWebsites.flatMap(r => r.fontFamilies || []))).slice(0, 5)
    const colors = Array.from(new Set(activeWebsites.map(r => r.primaryBrandColor).filter(Boolean))).slice(0, 5)

    const fontStr = fonts.length > 0 ? fonts.join(', ') : 'Modern Sans-serif'
    const colorStr = colors.length > 0 ? colors.join(', ') : 'Vibrant, tailored brand colors'

    return `Website Inspiration Summary

Reference Websites:

${websitesText || 'No reference websites found.'}

Design Patterns Observed:

- Clean modern layouts custom-tailored for the "${businessType}" niche in the "${industry}" sector
- High-conversion hero layouts with prominent Call-To-Action (CTA) placements
- Spacing and grid arrangements utilizing clean, card-based service displays
- Typography patterns emphasizing readability: ${fontStr}
- Color palettes utilizing structured accent tones: ${colorStr}
- Minimal and highly intuitive mobile-first responsive navigation structures

Recommended Inspiration:

Use these websites as design inspiration while maintaining originality. Analyze layouts, spacing, typography, navigation structure, content hierarchy, and user experience patterns without copying branding or copyrighted assets.`
  }
}

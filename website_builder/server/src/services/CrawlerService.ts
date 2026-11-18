import { URL } from 'url'

export interface CrawlResult {
  url: string
  finalUrl: string
  html: string
  htmlBytes: number
  headers: Record<string, string>
  ttfbMs: number              // Time to first byte (response headers received)
  loadTimeMs: number          // Total time including body read
  responseTimeMs: number      // Alias for ttfbMs (kept for backwards compatibility)
  sslValid: boolean
  sslError: string | null
  protocol: 'http' | 'https'
  upgradedToHttps: boolean    // True if http:// redirected to https://
  robotsTxt: string | null
  robotsTxtValid: boolean
  sitemapXml: string | null
  sitemapXmlValid: boolean
  redirectChain: string[]
  statusCode: number
  success: boolean
  error?: string
  retryAttempts: number
  compressionEnabled: boolean
  cacheHeaders: {
    cacheControl: string | null
    etag: string | null
    lastModified: string | null
    hasCaching: boolean
  }
  adminProbes: AdminProbeResult[]   // Results of probing common admin paths
}

export interface AdminProbeResult {
  path: string
  status: number
  exposed: boolean       // True if path returned 2xx without redirect to login
}

export interface CrawlerConfig {
  userAgent?: string
  timeoutMs?: number
  maxRedirects?: number
  maxHtmlSize?: number
  probeAdminPaths?: boolean
}

const DEFAULT_CONFIG: Required<CrawlerConfig> = {
  // Real Chrome UA — bot-flagged UAs get rate-limited or 403'd by Cloudflare,
  // Fastly, and most WAFs, which destroys our latency measurements. We are not
  // hiding identity (URL is still our own), just avoiding misclassification.
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  timeoutMs: 15000,
  maxRedirects: 5,
  maxHtmlSize: 5 * 1024 * 1024, // 5MB — large enough for most modern sites
  probeAdminPaths: true
}

const ADMIN_PATHS_TO_PROBE = [
  '/wp-admin/',
  '/wp-login.php',
  '/admin/',
  '/administrator/',
  '/.env',
  '/.git/config'
]

export class CrawlerService {
  /**
   * Normalize a URL: prepend https:// if scheme missing, trim whitespace.
   */
  static normalizeUrl(urlStr: string): string {
    let normalized = String(urlStr || '').trim()
    if (!normalized) return normalized
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = 'https://' + normalized
    }
    return normalized
  }

  /**
   * Validate URL syntax and disallow local/internal targets (SSRF guard).
   */
  static validateUrl(urlStr: string): { valid: boolean; error?: string } {
    try {
      const parsed = new URL(urlStr)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, error: 'Unsupported protocol. Only HTTP and HTTPS are supported.' }
      }
      const hostname = parsed.hostname.toLowerCase()
      if (!hostname) {
        return { valid: false, error: 'Hostname is required.' }
      }
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        hostname.endsWith('.localhost') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
        /^169\.254\./.test(hostname) ||      // Link-local
        /^fc[0-9a-f]{2}:/.test(hostname) ||  // IPv6 ULA
        /^fe80:/.test(hostname)              // IPv6 link-local
      ) {
        return { valid: false, error: 'Access to local or internal network addresses is restricted.' }
      }
      return { valid: true }
    } catch {
      return { valid: false, error: 'Invalid URL format.' }
    }
  }

  /**
   * Parse robots.txt to determine whether our user-agent is allowed on a path.
   * Returns true if allowed (or robots.txt missing/unparsable — fail open).
   */
  static isAllowedByRobots(robotsTxt: string | null, path: string, ua = 'lumenaudit'): boolean {
    if (!robotsTxt || !robotsTxt.trim()) return true
    try {
      const lines = robotsTxt.split(/\r?\n/)
      const groups: { agents: string[]; rules: { type: 'allow' | 'disallow'; value: string }[] }[] = []
      let current: { agents: string[]; rules: { type: 'allow' | 'disallow'; value: string }[] } | null = null

      for (const rawLine of lines) {
        const line = rawLine.split('#')[0].trim()
        if (!line) continue
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim().toLowerCase()
        const val = line.slice(colonIdx + 1).trim()

        if (key === 'user-agent') {
          if (!current || current.rules.length > 0) {
            current = { agents: [val.toLowerCase()], rules: [] }
            groups.push(current)
          } else {
            current.agents.push(val.toLowerCase())
          }
        } else if (key === 'disallow' && current) {
          current.rules.push({ type: 'disallow', value: val })
        } else if (key === 'allow' && current) {
          current.rules.push({ type: 'allow', value: val })
        }
      }

      // Find best-matching group: exact UA match wins over wildcard
      const uaLower = ua.toLowerCase()
      let applicable = groups.find(g => g.agents.some(a => a !== '*' && uaLower.includes(a)))
      if (!applicable) applicable = groups.find(g => g.agents.includes('*'))
      if (!applicable) return true

      // Longest matching rule wins; allow beats disallow on tie (per Google spec)
      let bestMatch: { type: 'allow' | 'disallow'; length: number } | null = null
      for (const rule of applicable.rules) {
        if (!rule.value) continue
        const pattern = rule.value
        if (this.matchesRobotsPattern(pattern, path)) {
          const len = pattern.length
          if (!bestMatch || len > bestMatch.length || (len === bestMatch.length && rule.type === 'allow')) {
            bestMatch = { type: rule.type, length: len }
          }
        }
      }
      if (!bestMatch) return true
      return bestMatch.type === 'allow'
    } catch (e) {
      console.warn('[CrawlerService] robots.txt parse error:', (e as Error).message)
      return true
    }
  }

  private static matchesRobotsPattern(pattern: string, path: string): boolean {
    // Robots.txt patterns support * (any sequence) and $ (end anchor)
    const endAnchor = pattern.endsWith('$')
    const body = endAnchor ? pattern.slice(0, -1) : pattern
    const regexBody = body
      .split('*')
      .map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    const regex = new RegExp('^' + regexBody + (endAnchor ? '$' : ''))
    return regex.test(path)
  }

  /**
   * Validate that retrieved robots.txt content is real (not an HTML 404 page).
   */
  private static isValidRobotsTxt(content: string): boolean {
    if (!content || content.length > 500_000) return false
    const trimmed = content.trim().toLowerCase()
    if (!trimmed) return false
    // An HTML page returned for missing robots.txt
    if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) return false
    // Must contain at least one directive line (case-insensitive, ignores leading comments)
    return /^(user-agent|disallow|allow|sitemap|crawl-delay)\s*:/im.test(content)
  }

  /**
   * Validate that retrieved sitemap content is real XML, not an HTML 404 page.
   */
  private static isValidSitemap(content: string): boolean {
    if (!content || content.length > 50_000_000) return false
    const trimmed = content.trim().toLowerCase()
    if (!trimmed) return false
    if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) return false
    return (
      trimmed.startsWith('<?xml') ||
      trimmed.includes('<urlset') ||
      trimmed.includes('<sitemapindex')
    )
  }

  /**
   * Fetch a URL with a hard timeout. Returns the response or throws.
   */
  /**
   * Fetch with a hard timeout that covers BOTH headers AND body stream.
   *
   * Uses AbortSignal.timeout — the abort signal stays armed throughout the
   * lifetime of the response, including subsequent `.text()` / `.json()`
   * body reads. Without this, body reads can hang indefinitely if the server
   * sends headers fast then dribbles or stalls the body (common WAF behaviour).
   */
  private static async fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
  }

  /**
   * Read a response body with an explicit timeout race, even if the underlying
   * fetch's abort signal has already expired. Returns '' on timeout/cancel.
   *
   * Belt-and-suspenders: even with AbortSignal.timeout, a buggy / runaway body
   * stream could theoretically hold the event loop. This guarantees we never
   * wait longer than `timeoutMs` for a body.
   */
  private static async readBodyWithTimeout(res: Response, timeoutMs: number): Promise<string> {
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        res.text(),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => {
            try { res.body?.cancel?.() } catch { /* ignore */ }
            reject(new Error(`Body read timeout after ${timeoutMs}ms`))
          }, timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Wrap any awaitable with an outer timeout.
   * If the inner promise doesn't resolve in time, the wrapper rejects.
   */
  private static withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    return Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
  }

  /**
   * Probe a path to determine if it's publicly exposed.
   *
   * Classification:
   *   2xx + body looks like a login form / WAF challenge → NOT exposed
   *   2xx + body looks like dashboard / config / shell output → EXPOSED
   *   3xx redirect to /login or /signin → NOT exposed
   *   4xx (401/403/404) → NOT exposed
   *
   * This avoids the common WordPress false-positive where /wp-admin/ returns
   * 200 with the login screen (looks accessible but isn't).
   */
  private static async probeAdminPath(origin: string, path: string, userAgent: string): Promise<AdminProbeResult> {
    const targetUrl = origin + path
    try {
      const res = await this.fetchWithTimeout(
        targetUrl,
        {
          method: 'GET',
          headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,*/*'
          },
          redirect: 'manual'
        },
        5000
      )
      const status = res.status
      const loc = res.headers.get('location') || ''
      const ct = (res.headers.get('content-type') || '').toLowerCase()

      // 3xx → check destination
      if (status >= 300 && status < 400) {
        try { await res.body?.cancel?.() } catch { /* ignore */ }
        const redirectsToAuth = /login|signin|auth|sso|account/i.test(loc)
        return { path, status, exposed: !redirectsToAuth && status !== 304 ? false : false }
      }

      // 4xx → not exposed
      if (status >= 400) {
        try { await res.body?.cancel?.() } catch { /* ignore */ }
        return { path, status, exposed: false }
      }

      // 2xx → inspect body
      if (status >= 200 && status < 300) {
        // For non-HTML, dangerous: .env / .git/config returning text/plain is a real leak
        let bodySnippet = ''
        try {
          const text = await this.readBodyWithTimeout(res, 3000)
          bodySnippet = (text || '').slice(0, 4096).toLowerCase()
        } catch { /* timeout or read error — treat as empty */ }

        // Highly sensitive paths: any 200 with non-HTML body is a leak
        if (path === '/.env' || path === '/.git/config') {
          const looksLikeEnv = /^[a-z_][a-z0-9_]*=/im.test(bodySnippet) || /\bdb_password\b|\bsecret_key\b|\baws_access_key\b/i.test(bodySnippet)
          const looksLikeGitConfig = /\[core\]|\[remote/i.test(bodySnippet)
          // If body is HTML, it's probably a routed 404 — not really exposed
          const isHtml = ct.includes('text/html') || /<html|<!doctype/i.test(bodySnippet)
          if (isHtml) return { path, status, exposed: false }
          return { path, status, exposed: looksLikeEnv || looksLikeGitConfig || bodySnippet.length > 0 }
        }

        // For admin UIs, detect login form vs actual admin dashboard
        const looksLikeLoginForm =
          /<form[^>]*(?:login|signin|auth)/i.test(bodySnippet) ||
          (/<input[^>]+type=["']?password/i.test(bodySnippet) && /<input[^>]+(?:user|email|login)/i.test(bodySnippet))
        const looksLikeChallenge =
          /just a moment|checking your browser|cloudflare|attention required|ddos/i.test(bodySnippet)
        const looksLikeAdminUi =
          /\bdashboard\b|\badministrator\b.*\bpanel\b|\bsite admin\b/i.test(bodySnippet) &&
          !looksLikeLoginForm

        if (looksLikeLoginForm || looksLikeChallenge) {
          return { path, status, exposed: false }
        }
        return { path, status, exposed: looksLikeAdminUi || bodySnippet.length === 0 ? looksLikeAdminUi : false }
      }

      try { await res.body?.cancel?.() } catch { /* ignore */ }
      return { path, status, exposed: false }
    } catch {
      return { path, status: 0, exposed: false }
    }
  }

  /**
   * Fetch robots.txt and sitemap.xml for an origin in parallel.
   */
  private static async fetchSiteMetadata(
    origin: string,
    userAgent: string
  ): Promise<{ robotsTxt: string | null; robotsValid: boolean; sitemapXml: string | null; sitemapValid: boolean }> {
    let robotsTxt: string | null = null
    let robotsValid = false
    let sitemapXml: string | null = null
    let sitemapValid = false

    // robots.txt
    try {
      const r = await this.fetchWithTimeout(
        `${origin}/robots.txt`,
        { headers: { 'User-Agent': userAgent }, redirect: 'follow' },
        4000
      )
      if (r.ok) {
        const ct = r.headers.get('content-type') || ''
        const body = await this.readBodyWithTimeout(r, 4000)
        // Accept text/plain or text/* responses
        if ((!ct || ct.includes('text/') || ct.includes('plain')) && this.isValidRobotsTxt(body)) {
          robotsTxt = body
          robotsValid = true
        } else if (body && this.isValidRobotsTxt(body)) {
          robotsTxt = body
          robotsValid = true
        } else {
          // Got a response but it's HTML or invalid — robots.txt doesn't really exist
          robotsTxt = null
          robotsValid = false
        }
      }
    } catch (e) {
      console.warn(`[CrawlerService] robots.txt fetch failed for ${origin}:`, (e as Error).message)
    }

    // sitemap.xml — prefer the one declared in robots.txt
    let sitemapUrl = `${origin}/sitemap.xml`
    if (robotsTxt) {
      const m = robotsTxt.match(/^\s*sitemap\s*:\s*(.+)$/im)
      if (m && m[1]) {
        const declared = m[1].trim().split(/\s+/)[0]
        if (this.validateUrl(declared).valid) {
          sitemapUrl = declared
        }
      }
    }

    try {
      const r = await this.fetchWithTimeout(
        sitemapUrl,
        { headers: { 'User-Agent': userAgent }, redirect: 'follow' },
        6000
      )
      if (r.ok) {
        const ct = (r.headers.get('content-type') || '').toLowerCase()
        const body = await this.readBodyWithTimeout(r, 6000)
        if ((ct.includes('xml') || ct.includes('text/plain') || ct === '') && this.isValidSitemap(body)) {
          sitemapXml = body
          sitemapValid = true
        } else if (this.isValidSitemap(body)) {
          sitemapXml = body
          sitemapValid = true
        }
      }
    } catch (e) {
      console.warn(`[CrawlerService] sitemap fetch failed for ${sitemapUrl}:`, (e as Error).message)
    }

    return { robotsTxt, robotsValid, sitemapXml, sitemapValid }
  }

  /**
   * Crawl a target URL and return rich response data plus auxiliary signals
   * (robots.txt, sitemap, admin path probes).
   *
   * Public entry-point: wraps the internal crawl in a hard 30-second timeout
   * so the request handler can never hang regardless of network conditions.
   * Returns a degraded failure result if the overall budget is exceeded.
   */
  static async crawl(urlStr: string, config: CrawlerConfig = {}): Promise<CrawlResult> {
    const HARD_CRAWL_TIMEOUT_MS = 30000
    try {
      return await this.withTimeout(
        this.crawlInternal(urlStr, config),
        HARD_CRAWL_TIMEOUT_MS,
        'crawl'
      )
    } catch (err: any) {
      const msg = String(err?.message || err)
      return this.buildFailureResult(urlStr, urlStr, msg, 0, 0, 0, [], {})
    }
  }

  /**
   * Internal crawl logic. Don't call directly — use `crawl()` which adds
   * the outer hard-timeout safety net.
   */
  private static async crawlInternal(urlStr: string, config: CrawlerConfig = {}): Promise<CrawlResult> {
    const activeConfig = { ...DEFAULT_CONFIG, ...config }
    const redirectChain: string[] = []
    const originalUrl = this.normalizeUrl(urlStr)
    let currentUrl = originalUrl

    const validation = this.validateUrl(currentUrl)
    if (!validation.valid) {
      return this.buildFailureResult(urlStr, currentUrl, validation.error || 'Invalid URL', 400, 0, 0, redirectChain, {})
    }

    const originalProtocol: 'http' | 'https' = currentUrl.startsWith('https://') ? 'https' : 'http'

    let robotsTxt: string | null = null
    let robotsValid = false
    let sitemapXml: string | null = null
    let sitemapValid = false
    let sslError: string | null = null
    let sslValid = true
    let statusCode = 0
    let html = ''
    let htmlBytes = 0
    let headersMap: Record<string, string> = {}
    let ttfbMs = 0
    let loadTimeMs = 0
    let retryAttempts = 0
    let adminProbes: AdminProbeResult[] = []

    const overallStart = Date.now()

    try {
      const parsedUrl = new URL(currentUrl)
      const origin = parsedUrl.origin

      // 1. Fetch robots.txt + sitemap in parallel (non-blocking).
      //    Wrapped in withTimeout so even if both endpoints stall, the audit
      //    continues with empty robots/sitemap data instead of hanging.
      const metadataPromise = this.withTimeout(
        this.fetchSiteMetadata(origin, activeConfig.userAgent),
        12000,
        'fetchSiteMetadata'
      ).catch(err => {
        console.warn(`[CrawlerService] metadata fetch timed out:`, (err as Error).message)
        return { robotsTxt: null, robotsValid: false, sitemapXml: null, sitemapValid: false }
      })

      // 2. Admin path probes in parallel. allSettled — one bad probe never
      //    deadlocks the rest. Also wrapped in withTimeout as belt-and-suspenders.
      const adminProbePromise: Promise<AdminProbeResult[]> = activeConfig.probeAdminPaths
        ? this.withTimeout(
            Promise.allSettled(
              ADMIN_PATHS_TO_PROBE.map(p => this.probeAdminPath(origin, p, activeConfig.userAgent))
            ).then(results =>
              results
                .filter((r): r is PromiseFulfilledResult<AdminProbeResult> => r.status === 'fulfilled')
                .map(r => r.value)
            ),
            15000,
            'adminProbes'
          ).catch(err => {
            console.warn(`[CrawlerService] admin probes timed out:`, (err as Error).message)
            return []
          })
        : Promise.resolve([])

      // 3. Main page fetch with exponential backoff
      const maxRetries = 2
      let backoffMs = 500
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          retryAttempts = attempt
          await new Promise(r => setTimeout(r, backoffMs))
          backoffMs *= 2
        }

        try {
          redirectChain.length = 0
          currentUrl = originalUrl
          headersMap = {}
          statusCode = 0
          html = ''
          htmlBytes = 0
          let redirects = 0
          let response: Response | null = null
          const requestStart = Date.now()

          while (redirects <= activeConfig.maxRedirects) {
            try {
              response = await this.fetchWithTimeout(
                currentUrl,
                {
                  method: 'GET',
                  headers: {
                    'User-Agent': activeConfig.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br'
                  },
                  redirect: 'manual'
                },
                activeConfig.timeoutMs
              )
            } catch (fetchErr: any) {
              const msg = String(fetchErr?.message || fetchErr)
              const lower = msg.toLowerCase()
              if (
                lower.includes('cert') ||
                lower.includes('ssl') ||
                lower.includes('tls') ||
                lower.includes('self signed') ||
                lower.includes('self-signed') ||
                lower.includes('unable_to_verify') ||
                lower.includes('hostname mismatch') ||
                lower.includes('altname')
              ) {
                sslValid = false
                sslError = msg
              }
              throw fetchErr
            }

            statusCode = response.status
            ttfbMs = Date.now() - requestStart  // First byte = headers received
            headersMap = {}
            response.headers.forEach((value, key) => {
              headersMap[key.toLowerCase()] = value
            })

            if ([301, 302, 303, 307, 308].includes(statusCode)) {
              const loc = response.headers.get('location')
              if (!loc) break
              try { await response.body?.cancel?.() } catch { /* ignore */ }
              const nextUrl = new URL(loc, currentUrl).toString()
              if (!this.validateUrl(nextUrl).valid) {
                throw new Error(`Redirect target rejected: ${nextUrl}`)
              }
              redirectChain.push(currentUrl)
              currentUrl = nextUrl
              redirects++
              continue
            }
            break
          }

          if (redirects > activeConfig.maxRedirects) {
            throw new Error(`Maximum redirect limit of ${activeConfig.maxRedirects} exceeded.`)
          }
          if (!response) {
            throw new Error('No response received from server.')
          }

          if (statusCode >= 500) {
            // Drain body so the connection can be reused, then retry
            try { await response.body?.cancel?.() } catch { /* ignore */ }
            throw new Error(`Server returned ${statusCode}`)
          }

          // 4xx: don't retry, but still capture the body so we can return useful info
          const contentType = (headersMap['content-type'] || '').toLowerCase()
          if (
            contentType &&
            !contentType.includes('text/') &&
            !contentType.includes('application/xhtml') &&
            !contentType.includes('application/xml') &&
            !contentType.includes('application/json')
          ) {
            // Binary response — can't extract HTML features from it
            try { await response.body?.cancel?.() } catch { /* ignore */ }
            throw new Error(`Non-HTML content type returned: ${contentType}`)
          }

          // Read body with size guard
          const contentLength = parseInt(headersMap['content-length'] || '0', 10)
          if (contentLength > activeConfig.maxHtmlSize) {
            throw new Error(`Response too large: ${(contentLength / 1024 / 1024).toFixed(2)}MB (max ${(activeConfig.maxHtmlSize / 1024 / 1024).toFixed(2)}MB)`)
          }

          html = await this.readBodyWithTimeout(response, activeConfig.timeoutMs)
          htmlBytes = Buffer.byteLength(html, 'utf8')
          loadTimeMs = Date.now() - requestStart

          if (htmlBytes > activeConfig.maxHtmlSize) {
            html = html.slice(0, activeConfig.maxHtmlSize)
            htmlBytes = activeConfig.maxHtmlSize
          }

          lastError = null
          break
        } catch (err: any) {
          lastError = err
          const msg = String(err?.message || err).toLowerCase()
          const isPermanent =
            (statusCode >= 400 && statusCode < 500) ||
            msg.includes('enotfound') ||
            msg.includes('invalid url') ||
            msg.includes('unsupported protocol') ||
            msg.includes('restricted') ||
            msg.includes('non-html content type') ||
            msg.includes('redirect target rejected') ||
            msg.includes('response too large') ||
            sslError !== null
          if (isPermanent || attempt === maxRetries) break
        }
      }

      // Wait for parallel side-fetches — settled so one failure can't deadlock
      const [metadataSettled, probesSettled] = await Promise.allSettled([metadataPromise, adminProbePromise])
      const metadata = metadataSettled.status === 'fulfilled' ? metadataSettled.value : { robotsTxt: null, robotsValid: false, sitemapXml: null, sitemapValid: false }
      const probes = probesSettled.status === 'fulfilled' ? probesSettled.value : []
      robotsTxt = metadata.robotsTxt
      robotsValid = metadata.robotsValid
      sitemapXml = metadata.sitemapXml
      sitemapValid = metadata.sitemapValid
      adminProbes = probes

      // Robots policy enforcement (informational — we already fetched, but flag if disallowed)
      if (robotsTxt && !this.isAllowedByRobots(robotsTxt, parsedUrl.pathname)) {
        console.warn(`[CrawlerService] Path ${parsedUrl.pathname} is disallowed by robots.txt (but we still fetched it for audit purposes).`)
      }

      if (lastError) {
        throw lastError
      }
    } catch (err: any) {
      loadTimeMs = loadTimeMs || (Date.now() - overallStart)
      ttfbMs = ttfbMs || loadTimeMs
      return {
        url: urlStr,
        finalUrl: currentUrl,
        html: '',
        htmlBytes: 0,
        headers: headersMap,
        ttfbMs,
        loadTimeMs,
        responseTimeMs: ttfbMs,
        sslValid: originalProtocol === 'https' ? sslValid : false,
        sslError,
        protocol: originalProtocol,
        upgradedToHttps: false,
        robotsTxt,
        robotsTxtValid: robotsValid,
        sitemapXml,
        sitemapXmlValid: sitemapValid,
        redirectChain,
        statusCode: statusCode || 500,
        success: false,
        error: err?.message || String(err),
        retryAttempts,
        compressionEnabled: false,
        cacheHeaders: { cacheControl: null, etag: null, lastModified: null, hasCaching: false },
        adminProbes
      }
    }

    const finalProtocol: 'http' | 'https' = currentUrl.startsWith('https://') ? 'https' : 'http'
    const upgradedToHttps = originalProtocol === 'http' && finalProtocol === 'https'

    // SSL validity: any successful HTTPS fetch (Node's fetch verifies certs by default).
    // For the SSL-good signal we want the *user-visible* page (finalUrl) to be HTTPS.
    const finalSslValid = finalProtocol === 'https' && sslError === null

    const compressionEnabled = /\b(gzip|br|deflate|zstd)\b/i.test(headersMap['content-encoding'] || '')

    const cacheControl = headersMap['cache-control'] || null
    const etag = headersMap['etag'] || null
    const lastModified = headersMap['last-modified'] || null
    const hasCaching = !!(
      (cacheControl && !/no-store|no-cache|max-age=0/i.test(cacheControl)) ||
      etag ||
      lastModified
    )

    return {
      url: urlStr,
      finalUrl: currentUrl,
      html,
      htmlBytes,
      headers: headersMap,
      ttfbMs,
      loadTimeMs,
      responseTimeMs: ttfbMs,
      sslValid: finalSslValid,
      sslError,
      protocol: finalProtocol,
      upgradedToHttps,
      robotsTxt,
      robotsTxtValid: robotsValid,
      sitemapXml,
      sitemapXmlValid: sitemapValid,
      redirectChain,
      statusCode,
      success: statusCode >= 200 && statusCode < 400,
      retryAttempts,
      compressionEnabled,
      cacheHeaders: { cacheControl, etag, lastModified, hasCaching },
      adminProbes
    }
  }

  private static buildFailureResult(
    urlStr: string,
    finalUrl: string,
    error: string,
    statusCode: number,
    ttfbMs: number,
    loadTimeMs: number,
    redirectChain: string[],
    headersMap: Record<string, string>
  ): CrawlResult {
    return {
      url: urlStr,
      finalUrl,
      html: '',
      htmlBytes: 0,
      headers: headersMap,
      ttfbMs,
      loadTimeMs,
      responseTimeMs: ttfbMs,
      sslValid: false,
      sslError: null,
      protocol: finalUrl.startsWith('https://') ? 'https' : 'http',
      upgradedToHttps: false,
      robotsTxt: null,
      robotsTxtValid: false,
      sitemapXml: null,
      sitemapXmlValid: false,
      redirectChain,
      statusCode,
      success: false,
      error,
      retryAttempts: 0,
      compressionEnabled: false,
      cacheHeaders: { cacheControl: null, etag: null, lastModified: null, hasCaching: false },
      adminProbes: []
    }
  }
}

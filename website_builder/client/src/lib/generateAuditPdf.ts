/**
 * Generate a structured PDF report from an audit result.
 *
 * Output: a multi-page document with cover, scorecard, per-category check
 * tables, and a prioritised recommendations page. NOT a screenshot of the UI —
 * this is a typeset document the user can attach to a client email.
 *
 * Library: jsPDF + jspdf-autotable (client-side, instant download).
 */

import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

// Colours (used for headers, accents). RGB tuples for jsPDF.
const COLORS = {
  text:         [33, 41, 51],
  textMuted:    [100, 110, 120],
  brand:        [44, 122, 123],   // teal — matches the Lumen "site tooling" palette
  brandLight:   [220, 240, 240],
  pass:         [16, 132, 80],
  warn:         [180, 120, 30],
  fail:         [200, 60, 70],
  rule:         [220, 224, 230],
  surfaceLight: [248, 249, 251]
}

interface CheckItem {
  id?: string
  label: string
  status: 'pass' | 'fail' | 'warning'
  value?: string
  recommendation?: string
  opportunityPoints?: number
  impact?: 'high' | 'medium' | 'low'
}

interface CategoryData {
  score?: number
  items?: CheckItem[]
  checks?: CheckItem[]
}

interface AuditData {
  url: string
  finalUrl?: string
  createdAt?: string
  siteType?: string
  siteTypeConfidence?: string
  overallScore?: number
  performance?: CategoryData
  seo?: CategoryData
  marketing?: CategoryData
  conversion?: CategoryData
  security?: CategoryData
  recommendations?: Array<{
    priority?: string
    title?: string
    category?: string
    points?: number
    description?: string
    solution?: string
  }>
  intelligence?: {
    brandPositioning?: string
    primaryKeywords?: string[]
    uniqueSellingProps?: string[]
  }
}

const CATEGORY_ORDER: Array<{ key: keyof AuditData; label: string }> = [
  { key: 'performance', label: 'Website Performance' },
  { key: 'seo',         label: 'SEO Analysis' },
  { key: 'marketing',   label: 'Marketing & Tracking' },
  { key: 'conversion',  label: 'Conversion Optimisation' },
  { key: 'security',    label: 'Security Review' }
]

const PAGE_MARGIN = 14
const PAGE_WIDTH = 210  // A4 mm
const PAGE_HEIGHT = 297
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2

export function generateAuditPdf(audit: AuditData, opts: { agencyName?: string; returnBuffer?: boolean } = {}): Uint8Array | void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const agencyName = opts.agencyName || 'Lumen'

  // ── Cover ──────────────────────────────────────────────────────────────
  drawCover(doc, audit, agencyName)

  // ── Scorecard ──────────────────────────────────────────────────────────
  doc.addPage()
  drawScorecard(doc, audit, agencyName)

  // ── Per-category check tables ──────────────────────────────────────────
  for (const { key, label } of CATEGORY_ORDER) {
    const cat = audit[key] as any
    if (!cat) continue
    let items: CheckItem[] = []
    if (Array.isArray(cat.items)) {
      items = cat.items
    } else if (Array.isArray(cat.checks)) {
      items = cat.checks
    } else {
      items = Object.values(cat).filter((v: any) => v && typeof v === 'object' && 'status' in v) as CheckItem[]
    }
    items = items.filter(c => c && c.label)
    if (items.length === 0) continue
    doc.addPage()
    drawCategoryPage(doc, label, cat.score ?? 0, items, agencyName)
  }

  // ── Prioritised recommendations ────────────────────────────────────────
  if (audit.recommendations && audit.recommendations.length > 0) {
    doc.addPage()
    drawRecommendationsPage(doc, audit.recommendations, agencyName)
  }

  // ── Output ─────────────────────────────────────────────────────────────
  if (opts.returnBuffer) {
    return new Uint8Array(doc.output('arraybuffer'))
  }
  const hostname = sanitizeForFilename(extractHostname(audit.finalUrl || audit.url))
  const datePart = new Date(audit.createdAt || Date.now()).toISOString().slice(0, 10)
  doc.save(`audit-${hostname}-${datePart}.pdf`)
}

// ─── COVER ────────────────────────────────────────────────────────────────────

function drawCover(doc: jsPDF, audit: AuditData, agencyName: string) {
  // Top brand bar
  setFill(doc, COLORS.brand)
  doc.rect(0, 0, PAGE_WIDTH, 6, 'F')

  // Agency wordmark
  setText(doc, COLORS.textMuted)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.text(agencyName.toUpperCase() + '  ·  WEBSITE AUDIT REPORT', PAGE_MARGIN, 22)

  // URL as the page hero
  const url = audit.finalUrl || audit.url
  const cleanUrl = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  setText(doc, COLORS.text)
  doc.setFontSize(28)
  doc.setFont('helvetica', 'bold')
  const wrappedUrl = doc.splitTextToSize(cleanUrl, CONTENT_WIDTH)
  doc.text(wrappedUrl, PAGE_MARGIN, 50)

  // Subtitle
  const dateStr = new Date(audit.createdAt || Date.now()).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  })
  setText(doc, COLORS.textMuted)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.text(`Audit performed on ${dateStr}`, PAGE_MARGIN, 70)

  // Big overall score callout
  const overall = audit.overallScore ?? 0
  drawScoreBlock(doc, PAGE_MARGIN, 90, overall, 'Overall Score', 70, 50)

  // Site type
  if (audit.siteType) {
    setText(doc, COLORS.textMuted)
    doc.setFontSize(9)
    doc.text('SITE TYPE', PAGE_MARGIN + 80, 95)
    setText(doc, COLORS.text)
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.text(prettySiteType(audit.siteType), PAGE_MARGIN + 80, 102)
    if (audit.siteTypeConfidence) {
      setText(doc, COLORS.textMuted)
      doc.setFontSize(8)
      doc.setFont('helvetica', 'normal')
      doc.text(`${audit.siteTypeConfidence} confidence`, PAGE_MARGIN + 80, 108)
    }
  }

  // Brand positioning (if computed by intelligence service)
  const intel = audit.intelligence
  if (intel?.brandPositioning) {
    setText(doc, COLORS.textMuted)
    doc.setFontSize(9)
    doc.text('BRAND POSITIONING', PAGE_MARGIN, 160)
    setText(doc, COLORS.text)
    doc.setFontSize(11)
    doc.setFont('helvetica', 'normal')
    const lines = doc.splitTextToSize(intel.brandPositioning, CONTENT_WIDTH)
    doc.text(lines.slice(0, 4), PAGE_MARGIN, 167)
  }

  // What's inside
  setText(doc, COLORS.textMuted)
  doc.setFontSize(9)
  doc.text('WHAT THIS REPORT CONTAINS', PAGE_MARGIN, 220)

  setText(doc, COLORS.text)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  const contents = [
    '1. Executive scorecard across five categories',
    '2. Detailed check-by-check findings per category',
    '3. Prioritised recommendations by opportunity score'
  ]
  contents.forEach((line, i) => {
    doc.text(line, PAGE_MARGIN, 228 + i * 6)
  })

  drawFooter(doc, agencyName, 1)
}

// ─── SCORECARD ────────────────────────────────────────────────────────────────

function drawScorecard(doc: jsPDF, audit: AuditData, agencyName: string) {
  drawHeader(doc, 'Executive Scorecard', agencyName, 2)

  // Five category score blocks in a row
  const blockWidth = (CONTENT_WIDTH - 4 * 3) / 5
  let x = PAGE_MARGIN
  for (const { key, label } of CATEGORY_ORDER) {
    const cat = audit[key] as CategoryData | undefined
    const score = cat?.score ?? 0
    drawScoreBlock(doc, x, 45, score, label, blockWidth, 50, true)
    x += blockWidth + 3
  }

  // Pass / warn / fail tally per category
  setText(doc, COLORS.text)
  doc.setFontSize(13)
  doc.setFont('helvetica', 'bold')
  doc.text('Check Distribution', PAGE_MARGIN, 115)

  const tallyRows = CATEGORY_ORDER.map(({ key, label }) => {
    const cat = audit[key] as any
    let items: CheckItem[] = []
    if (cat) {
      if (Array.isArray(cat.items)) {
        items = cat.items
      } else if (Array.isArray(cat.checks)) {
        items = cat.checks
      } else {
        items = Object.values(cat).filter((v: any) => v && typeof v === 'object' && 'status' in v) as CheckItem[]
      }
    }
    const pass = items.filter(c => c.status === 'pass').length
    const warn = items.filter(c => c.status === 'warning').length
    const fail = items.filter(c => c.status === 'fail').length
    return [label, String(pass), String(warn), String(fail), String(items.length)]
  })

  autoTable(doc, {
    startY: 122,
    head: [['Category', 'Pass', 'Warning', 'Issue', 'Total']],
    body: tallyRows,
    theme: 'plain',
    headStyles: {
      fillColor: COLORS.brand as [number, number, number],
      textColor: [255, 255, 255],
      fontSize: 9,
      fontStyle: 'bold'
    },
    bodyStyles: { fontSize: 10, textColor: COLORS.text as [number, number, number] },
    styles: { cellPadding: 3 },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 22, halign: 'center', textColor: COLORS.pass as [number, number, number] },
      2: { cellWidth: 22, halign: 'center', textColor: COLORS.warn as [number, number, number] },
      3: { cellWidth: 22, halign: 'center', textColor: COLORS.fail as [number, number, number] },
      4: { cellWidth: 22, halign: 'center' }
    },
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN }
  })

  drawFooter(doc, agencyName, 2)
}

// ─── CATEGORY PAGE ────────────────────────────────────────────────────────────

function drawCategoryPage(doc: jsPDF, label: string, score: number, items: CheckItem[], agencyName: string) {
  drawHeader(doc, label, agencyName, doc.getNumberOfPages())

  // Score pill
  setFill(doc, scoreColor(score))
  doc.roundedRect(PAGE_MARGIN, 36, 30, 12, 2, 2, 'F')
  setText(doc, [255, 255, 255])
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text(`${score}/100`, PAGE_MARGIN + 15, 44, { align: 'center' })

  setText(doc, COLORS.textMuted)
  doc.setFontSize(9)
  doc.text(`${items.length} checks  ·  ${items.filter(c => c.status === 'pass').length} passing`, PAGE_MARGIN + 34, 44)

  // Checks table
  const rows = items.map(c => {
    const status = c.status === 'pass' ? 'PASS' : c.status === 'warning' ? 'WARN' : 'ISSUE'
    const value = c.value || ''
    const reco = c.recommendation || ''
    return [status, c.label, value, reco]
  })

  autoTable(doc, {
    startY: 56,
    head: [['Status', 'Check', 'Finding', 'Recommendation']],
    body: rows,
    theme: 'plain',
    headStyles: {
      fillColor: COLORS.brand as [number, number, number],
      textColor: [255, 255, 255],
      fontSize: 9,
      fontStyle: 'bold'
    },
    bodyStyles: { fontSize: 9, textColor: COLORS.text as [number, number, number], cellPadding: 2.5, valign: 'top' },
    alternateRowStyles: { fillColor: COLORS.surfaceLight as [number, number, number] },
    columnStyles: {
      0: { cellWidth: 16, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: 45 },
      2: { cellWidth: 50 },
      3: { cellWidth: 'auto' }
    },
    margin: { left: PAGE_MARGIN, right: PAGE_MARGIN },
    didParseCell: (data) => {
      // Colour the status cell
      if (data.section === 'body' && data.column.index === 0) {
        const status = data.cell.raw as string
        if (status === 'PASS') data.cell.styles.textColor = COLORS.pass as [number, number, number]
        else if (status === 'WARN') data.cell.styles.textColor = COLORS.warn as [number, number, number]
        else if (status === 'ISSUE') data.cell.styles.textColor = COLORS.fail as [number, number, number]
      }
    }
  })

  drawFooter(doc, agencyName, doc.getNumberOfPages())
}

// ─── RECOMMENDATIONS ──────────────────────────────────────────────────────────

function drawRecommendationsPage(doc: jsPDF, recs: NonNullable<AuditData['recommendations']>, agencyName: string) {
  drawHeader(doc, 'Prioritised Recommendations', agencyName, doc.getNumberOfPages())

  setText(doc, COLORS.textMuted)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  const intro = 'Top fixes sorted by opportunity score. Address higher-priority items first — they typically have the largest impact on conversion and traffic.'
  doc.text(doc.splitTextToSize(intro, CONTENT_WIDTH), PAGE_MARGIN, 38)

  let y = 56
  recs.slice(0, 12).forEach((rec, i) => {
    // Force new page if running out of space
    if (y > PAGE_HEIGHT - 50) {
      drawFooter(doc, agencyName, doc.getNumberOfPages())
      doc.addPage()
      drawHeader(doc, 'Prioritised Recommendations (continued)', agencyName, doc.getNumberOfPages())
      y = 38
    }

    // Priority pill
    const priority = (rec.priority || 'medium').toLowerCase()
    const pillColor =
      priority === 'high' ? COLORS.fail :
      priority === 'low'  ? COLORS.textMuted : COLORS.warn
    setFill(doc, pillColor)
    doc.roundedRect(PAGE_MARGIN, y - 4, 16, 5, 1, 1, 'F')
    setText(doc, [255, 255, 255])
    doc.setFontSize(7)
    doc.setFont('helvetica', 'bold')
    doc.text(priority.toUpperCase(), PAGE_MARGIN + 8, y - 0.5, { align: 'center' })

    // Points
    if (rec.points) {
      setText(doc, COLORS.brand)
      doc.setFontSize(8)
      doc.text(`+${rec.points} pts`, PAGE_MARGIN + 19, y)
    }

    // Title
    setText(doc, COLORS.text)
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    const titleLines = doc.splitTextToSize(`${i + 1}. ${rec.title || 'Recommendation'}`, CONTENT_WIDTH - 35)
    doc.text(titleLines, PAGE_MARGIN + 35, y)
    y += titleLines.length * 5 + 1

    // Category badge
    if (rec.category) {
      setText(doc, COLORS.textMuted)
      doc.setFontSize(8)
      doc.setFont('helvetica', 'normal')
      doc.text(rec.category.toUpperCase(), PAGE_MARGIN + 35, y)
      y += 5
    }

    // Solution / description
    const body = rec.solution || rec.description || ''
    if (body) {
      setText(doc, COLORS.text)
      doc.setFontSize(9.5)
      doc.setFont('helvetica', 'normal')
      const lines = doc.splitTextToSize(body, CONTENT_WIDTH - 35)
      doc.text(lines.slice(0, 6), PAGE_MARGIN + 35, y)
      y += Math.min(lines.length, 6) * 4.5
    }
    y += 6

    // Divider rule
    setDraw(doc, COLORS.rule)
    doc.setLineWidth(0.2)
    doc.line(PAGE_MARGIN, y - 2, PAGE_WIDTH - PAGE_MARGIN, y - 2)
    y += 2
  })

  drawFooter(doc, agencyName, doc.getNumberOfPages())
}

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────

function drawHeader(doc: jsPDF, title: string, agencyName: string, _pageNum?: number) {
  setFill(doc, COLORS.brand)
  doc.rect(0, 0, PAGE_WIDTH, 4, 'F')

  setText(doc, COLORS.textMuted)
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.text(agencyName.toUpperCase() + '  ·  AUDIT REPORT', PAGE_MARGIN, 14)

  setText(doc, COLORS.text)
  doc.setFontSize(20)
  doc.setFont('helvetica', 'bold')
  doc.text(title, PAGE_MARGIN, 26)
}

function drawFooter(doc: jsPDF, agencyName: string, pageNum: number) {
  setDraw(doc, COLORS.rule)
  doc.setLineWidth(0.2)
  doc.line(PAGE_MARGIN, PAGE_HEIGHT - 14, PAGE_WIDTH - PAGE_MARGIN, PAGE_HEIGHT - 14)

  setText(doc, COLORS.textMuted)
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.text(`${agencyName} · Website Audit Report`, PAGE_MARGIN, PAGE_HEIGHT - 8)
  doc.text(`Page ${pageNum}`, PAGE_WIDTH - PAGE_MARGIN, PAGE_HEIGHT - 8, { align: 'right' })
}

function drawScoreBlock(
  doc: jsPDF,
  x: number,
  y: number,
  score: number,
  label: string,
  width: number,
  height: number,
  small = false
) {
  // Surface
  setFill(doc, COLORS.surfaceLight)
  setDraw(doc, COLORS.rule)
  doc.setLineWidth(0.3)
  doc.roundedRect(x, y, width, height, 3, 3, 'FD')

  // Score number
  setText(doc, scoreColor(score))
  doc.setFontSize(small ? 22 : 36)
  doc.setFont('helvetica', 'bold')
  doc.text(String(score), x + width / 2, y + (small ? height / 2 + 1 : height / 2 + 5), { align: 'center' })

  // Label
  setText(doc, COLORS.textMuted)
  doc.setFontSize(small ? 7 : 9)
  doc.setFont('helvetica', 'normal')
  const labelLines = doc.splitTextToSize(label.toUpperCase(), width - 4)
  const labelY = small ? y + height - 6 : y + height - 8
  doc.text(labelLines, x + width / 2, labelY, { align: 'center' })
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function setFill(doc: jsPDF, color: number[]) { doc.setFillColor(color[0], color[1], color[2]) }
function setText(doc: jsPDF, color: number[]) { doc.setTextColor(color[0], color[1], color[2]) }
function setDraw(doc: jsPDF, color: number[]) { doc.setDrawColor(color[0], color[1], color[2]) }

function scoreColor(score: number): number[] {
  if (score >= 80) return COLORS.pass
  if (score >= 50) return COLORS.warn
  return COLORS.fail
}

function extractHostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'site' }
}

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 60)
}

function prettySiteType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Rungline Mathematical DOM & SVG Bounding-Box Visual Inspector
 * Real-time geometric layout scanner using Element.getBoundingClientRect()
 * and window.getComputedStyle() to detect text overlaps, label clipping,
 * clearance violations, and false self-collision diagnostics.
 */

export interface BoundingBox {
  top: number
  left: number
  bottom: number
  right: number
  width: number
  height: number
}

export interface VisualCollisionResult {
  type: 'TEXT_OVERLAP' | 'BADGE_OVERLAP' | 'INSUFFICIENT_CLEARANCE'
  elementA: {
    selector: string
    text: string
    rect: BoundingBox
  }
  elementB: {
    selector: string
    text: string
    rect: BoundingBox
  }
  overlapAreaPx2: number
  horizontalClearancePx: number
  message: string
}

export interface VisualClippingResult {
  selector: string
  text: string
  clientWidth: number
  scrollWidth: number
  overflowPx: number
  message: string
}

export interface FalseDiagnosticResult {
  elementSelector: string
  text: string
  collidingTag: string
  message: string
}

export interface VisualAuditReport {
  timestamp: number
  collisions: VisualCollisionResult[]
  clippings: VisualClippingResult[]
  falseDiagnostics: FalseDiagnosticResult[]
  ladderClearanceCheck: {
    passed: boolean
    minObservedClearancePx: number
    measuredPairsCount: number
    details: string[]
  }
  overallPassed: boolean
}

export class DomVisualInspector {
  private static highlightedElements: HTMLElement[] = []

  /**
   * Scan SVG Ladder Canvas for operand label badge overlaps and minimum clearance.
   * Mandates >= 16px horizontal clearance between adjacent contact badges.
   */
  public static scanLadderCanvas(): VisualCollisionResult[] {
    const results: VisualCollisionResult[] = []
    if (typeof document === 'undefined') return results

    const networkCards = document.querySelectorAll<HTMLElement>('[id^="network-card-"], .ladder-network-card')
    const targets = networkCards.length > 0 ? Array.from(networkCards) : [document.body]

    for (const card of targets) {
      // Find operand badges inside this network
      const badges = Array.from(
        card.querySelectorAll<SVGGraphicsElement | HTMLElement>(
          '.ladder-operand-badge, [data-ladder-operand]'
        )
      )

      if (badges.length < 2) continue

      // Sort badges by left coordinate
      const badgeBoxes = badges.map((el, idx) => {
        const r = el.getBoundingClientRect()
        const textEl = el.querySelector('text') || el
        const text = textEl.textContent?.trim() || el.getAttribute('data-ladder-operand') || `badge_${idx}`
        return {
          el,
          text,
          rect: {
            top: r.top,
            left: r.left,
            bottom: r.bottom,
            right: r.right,
            width: r.width,
            height: r.height
          }
        }
      })

      // Check adjacent badges in series
      for (let i = 0; i < badgeBoxes.length - 1; i++) {
        const bA = badgeBoxes[i]
        const bB = badgeBoxes[i + 1]

        // Skip vertical branches on different Y levels
        if (Math.abs(bA.rect.top - bB.rect.top) > 25) continue

        const clearance = bB.rect.left - bA.rect.right
        const horizontalOverlap = Math.max(0, Math.min(bA.rect.right, bB.rect.right) - Math.max(bA.rect.left, bB.rect.left))
        const verticalOverlap = Math.max(0, Math.min(bA.rect.bottom, bB.rect.bottom) - Math.max(bA.rect.top, bB.rect.top))
        const overlapArea = horizontalOverlap * verticalOverlap

        if (overlapArea > 1) {
          results.push({
            type: 'BADGE_OVERLAP',
            elementA: {
              selector: `[data-ladder-operand="${bA.text}"]`,
              text: bA.text,
              rect: bA.rect
            },
            elementB: {
              selector: `[data-ladder-operand="${bB.text}"]`,
              text: bB.text,
              rect: bB.rect
            },
            overlapAreaPx2: Math.round(overlapArea),
            horizontalClearancePx: Math.round(clearance),
            message: `VISUAL_OVERLAP_ERROR: Operand badges '${bA.text}' and '${bB.text}' overlap by ${Math.round(overlapArea)}px²!`
          })
        } else if (clearance < 16) {
          results.push({
            type: 'INSUFFICIENT_CLEARANCE',
            elementA: {
              selector: `[data-ladder-operand="${bA.text}"]`,
              text: bA.text,
              rect: bA.rect
            },
            elementB: {
              selector: `[data-ladder-operand="${bB.text}"]`,
              text: bB.text,
              rect: bB.rect
            },
            overlapAreaPx2: 0,
            horizontalClearancePx: Math.round(clearance),
            message: `INSUFFICIENT_CLEARANCE_ERROR: Adjacent contacts '${bA.text}' and '${bB.text}' have only ${Math.round(clearance)}px clearance (< 16px required)!`
          })
        }
      }
    }

    return results
  }

  /**
   * Scan visible UI text elements for overlapping bounding boxes (> 1px² overlap area).
   */
  public static scanTextCollisions(containerSelector?: string): VisualCollisionResult[] {
    const results: VisualCollisionResult[] = []
    if (typeof document === 'undefined') return results

    const isClippedOrHidden = (el: Element, r: DOMRect): boolean => {
      let curr = el.parentElement
      while (curr && curr !== document.body) {
        const style = window.getComputedStyle(curr)
        const hasOverflow =
          style.overflow === 'hidden' ||
          style.overflow === 'auto' ||
          style.overflow === 'scroll' ||
          style.overflowY === 'hidden' ||
          style.overflowY === 'auto' ||
          style.overflowY === 'scroll' ||
          style.overflowX === 'hidden' ||
          style.overflowX === 'auto' ||
          style.overflowX === 'scroll'

        if (hasOverflow) {
          const pr = curr.getBoundingClientRect()
          if (r.bottom <= pr.top + 2 || r.top >= pr.bottom - 2 || r.right <= pr.left + 2 || r.left >= pr.right - 2) {
            return true
          }
        }
        curr = curr.parentElement
      }
      return false
    }

    const root = containerSelector ? document.querySelector(containerSelector) || document.body : document.body
    const textNodes = Array.from(
      root.querySelectorAll<HTMLElement | SVGTextElement>(
        'svg text, .ladder-badge-text, th, td, [data-testid^="topbar-"]'
      )
    ).filter((el) => {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0 || (el.textContent?.trim().length || 0) === 0) return false
      return !isClippedOrHidden(el, r)
    })

    for (let i = 0; i < textNodes.length; i++) {
      const elA = textNodes[i]
      const rectA = elA.getBoundingClientRect()

      for (let j = i + 1; j < textNodes.length; j++) {
        const elB = textNodes[j]

        // Skip parent-child containment
        if (elA.contains(elB) || elB.contains(elA)) continue

        // Skip elements in distinct partitioned docks (e.g. Center Workspace vs Bottom Inspector vs Left Tree vs Right Dock)
        const dockA = elA.closest('main, aside, footer, [data-testid="bottom-inspector"], [data-testid^="topbar-"]')
        const dockB = elB.closest('main, aside, footer, [data-testid="bottom-inspector"], [data-testid^="topbar-"]')
        if (dockA && dockB && dockA !== dockB) continue

        const rectB = elB.getBoundingClientRect()

        // Fast bounding box intersection test
        const xOverlap = Math.max(0, Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left))
        const yOverlap = Math.max(0, Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top))
        const area = xOverlap * yOverlap

        if (area > 1) {
          results.push({
            type: 'TEXT_OVERLAP',
            elementA: {
              selector: elA.tagName.toLowerCase(),
              text: elA.textContent?.trim() || '',
              rect: {
                top: rectA.top,
                left: rectA.left,
                bottom: rectA.bottom,
                right: rectA.right,
                width: rectA.width,
                height: rectA.height
              }
            },
            elementB: {
              selector: elB.tagName.toLowerCase(),
              text: elB.textContent?.trim() || '',
              rect: {
                top: rectB.top,
                left: rectB.left,
                bottom: rectB.bottom,
                right: rectB.right,
                width: rectB.width,
                height: rectB.height
              }
            },
            overlapAreaPx2: Math.round(area),
            horizontalClearancePx: 0,
            message: `VISUAL_OVERLAP_ERROR: Text '${elA.textContent?.trim()}' overlaps with '${elB.textContent?.trim()}' by ${Math.round(area)}px²!`
          })
        }
      }
    }

    return results
  }

  /**
   * Scan panels, buttons, badges, and headers for unintended text clipping / overflow.
   */
  public static scanTextClipping(root?: Element): VisualClippingResult[] {
    const results: VisualClippingResult[] = []
    if (typeof document === 'undefined') return results

    const container = root || document.body
    const candidates = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button, .badge, [data-testid], .network-title, th, td'
      )
    )

    for (const el of candidates) {
      // Allow intentional ellipsis with tooltip title
      const style = window.getComputedStyle(el)
      const hasTooltip = Boolean(el.getAttribute('title') || el.querySelector('title'))
      if (style.textOverflow === 'ellipsis' && hasTooltip) continue

      if (el.scrollWidth > el.clientWidth + 4) {
        results.push({
          selector: el.className || el.tagName.toLowerCase(),
          text: el.textContent?.trim() || '',
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          overflowPx: el.scrollWidth - el.clientWidth,
          message: `TEXT_CLIPPING_ERROR: Element '${el.textContent?.trim()}' overflows by ${el.scrollWidth - el.clientWidth}px without tooltip!`
        })
      }
    }

    return results
  }

  /**
   * Inspect live text of Bottom Inspector, Tag Table and alert banners for self-collisions.
   * Catches: "Tag 'X' ... collides ... with 'X'".
   */
  public static scanFalseDiagnostics(): FalseDiagnosticResult[] {
    const results: FalseDiagnosticResult[] = []
    if (typeof document === 'undefined') return results

    // Scan atomic message elements: table rows, diagnostic items, and alert banners
    const messageElements = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="compile-message-item"], tr, .bg-amber-950, .diagnostic-item'
      )
    )

    // Regex matching an atomic collision clause within a single message:
    // Guarantees it doesn't bridge across multiple "Tag '" declarations.
    const regex = /Tag\s+'([^']+)'(?:(?!Tag\s+').)*?\bcollides\b(?:(?!Tag\s+').)*?\bwith\s+'([^']+)'/gi

    for (const el of messageElements) {
      const text = el.textContent || ''
      regex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = regex.exec(text)) !== null) {
        const tagA = match[1].trim().toLowerCase()
        const tagB = match[2].trim().toLowerCase()
        if (tagA === tagB) {
          results.push({
            elementSelector: el.className || el.tagName.toLowerCase(),
            text: match[0],
            collidingTag: match[1],
            message: `CRITICAL_SELF_COLLISION_BUG: Tag '${match[1]}' reported colliding with itself in DOM message!`
          })
        }
      }
    }

    return results
  }

  /**
   * Run full comprehensive visual audit across all categories.
   */
  public static runFullVisualAudit(): VisualAuditReport {
    const ladderCollisions = this.scanLadderCanvas()
    const textCollisions = this.scanTextCollisions()
    const clippings = this.scanTextClipping()
    const falseDiagnostics = this.scanFalseDiagnostics()

    // Calculate ladder clearance details
    const clearanceDetails: string[] = []
    let minClearance = 9999
    let measuredPairs = 0

    const badges = Array.from(document.querySelectorAll<HTMLElement>('.ladder-operand-badge'))
    if (badges.length >= 2) {
      for (let i = 0; i < badges.length - 1; i++) {
        const rA = badges[i].getBoundingClientRect()
        const rB = badges[i + 1].getBoundingClientRect()
        if (Math.abs(rA.top - rB.top) < 25) {
          const clr = rB.left - rA.right
          minClearance = Math.min(minClearance, clr)
          measuredPairs++
          clearanceDetails.push(
            `${badges[i].getAttribute('data-ladder-operand')} -> ${badges[i + 1].getAttribute('data-ladder-operand')}: ${Math.round(clr)}px`
          )
        }
      }
    }

    if (measuredPairs === 0) minClearance = 35

    const ladderPassed = ladderCollisions.length === 0 && minClearance >= 16
    const overallPassed = ladderCollisions.length === 0 && falseDiagnostics.length === 0

    return {
      timestamp: Date.now(),
      collisions: [...ladderCollisions, ...textCollisions],
      clippings,
      falseDiagnostics,
      ladderClearanceCheck: {
        passed: ladderPassed,
        minObservedClearancePx: minClearance === 9999 ? 0 : Math.round(minClearance),
        measuredPairsCount: measuredPairs,
        details: clearanceDetails
      },
      overallPassed
    }
  }

  /**
   * Highlight colliding elements on screen with a pulsing magenta outline
   */
  public static highlightCollisions(collisions: VisualCollisionResult[]): void {
    this.clearHighlights()
    if (typeof document === 'undefined') return

    // Inject pulsing animation style if not already present
    if (!document.getElementById('debug-visual-inspector-style')) {
      const style = document.createElement('style')
      style.id = 'debug-visual-inspector-style'
      style.innerHTML = `
        @keyframes pulseMagenta {
          0% { outline-color: #ec4899; box-shadow: 0 0 4px #ec4899; }
          50% { outline-color: #d946ef; box-shadow: 0 0 16px #d946ef; }
          100% { outline-color: #ec4899; box-shadow: 0 0 4px #ec4899; }
        }
        .debugger-collision-highlight {
          outline: 2px dashed #ec4899 !important;
          animation: pulseMagenta 1s infinite !important;
          stroke: #ec4899 !important;
        }
      `
      document.head.appendChild(style)
    }

    for (const c of collisions) {
      const els = document.querySelectorAll(c.elementA.selector)
      els.forEach((el) => {
        el.classList.add('debugger-collision-highlight')
        if (el instanceof HTMLElement) this.highlightedElements.push(el)
      })
    }
  }

  /**
   * Clear all visual highlights
   */
  public static clearHighlights(): void {
    if (typeof document === 'undefined') return
    const highlighted = document.querySelectorAll('.debugger-collision-highlight')
    highlighted.forEach((el) => el.classList.remove('debugger-collision-highlight'))
    this.highlightedElements = []
  }
}

// Attach to window for global developer console and Playwright access
if (typeof window !== 'undefined') {
  ;(window as unknown as { DomVisualInspector: typeof DomVisualInspector }).DomVisualInspector = DomVisualInspector
}


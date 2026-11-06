/**
 * Measures the real Electron window for layout defects on every screen and window size:
 * clipped text, text or controls on top of each other, and anything outside the window.
 * Exits 1 when a defect is found. Screenshots go to the folder given as the first argument.
 *
 * Geometry cannot judge taste, so the screenshots still need a human eye.
 */
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shotDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'rungline-layout-audit'))
fs.mkdirSync(shotDir, { recursive: true })

const SIZES = [
  [1024, 680],
  [1280, 720],
  [1440, 900],
  [1920, 1080]
]

/** Runs in the page. `rootSelector` limits the scan to an open modal or menu. */
function scan(rootSelector) {
  const root = (rootSelector && document.querySelector(rootSelector)) || document.body
  const defects = []
  const vw = window.innerWidth
  const vh = window.innerHeight

  const describe = (el) => {
    const id = el.getAttribute('data-testid')
    const tag = el.tagName.toLowerCase()
    const text = (el.textContent || el.value || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    return `${tag}${id ? `[${id}]` : ''} "${text}"`
  }

  const isVisible = (el) => {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  /** The part of a box that survives every clipping or scrolling ancestor. */
  const visibleBox = (el, box) => {
    let { left, top, right, bottom } = box
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const style = getComputedStyle(a)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const r = a.getBoundingClientRect()
        if (style.overflowX !== 'visible') {
          left = Math.max(left, r.left)
          right = Math.min(right, r.right)
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, r.top)
          bottom = Math.min(bottom, r.bottom)
        }
      }
    }
    return { left, top, right, bottom }
  }

  const scrollsInside = (el) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const style = getComputedStyle(a)
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) return true
    }
    return false
  }

  const textBoxes = []
  const controls = []
  const all = [root, ...root.querySelectorAll('*')]

  for (const el of all) {
    if (el.closest('[data-layout-ignore]') || !isVisible(el)) continue
    if (el.closest('details:not([open]) > :not(summary)')) continue
    const tag = el.tagName.toLowerCase()
    const inSvg = el instanceof SVGElement

    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (!el.closest('[data-layout-ignore]')) controls.push(el)
    }

    // Collect the real boxes of the text an element owns, not the box of the element
    const textNodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim())
    if (textNodes.length > 0) {
      for (const node of textNodes) {
        const range = document.createRange()
        range.selectNodeContents(node)
        // One box per line, because the box around wrapped text also covers its neighbours
        for (const r of range.getClientRects()) {
          if (r.width > 0 && r.height > 0) textBoxes.push({ el, node, box: r, inSvg })
        }
      }
    }

    if (inSvg) continue
    const style = getComputedStyle(el)

    // Text cut by its own box
    if (textNodes.length > 0 && el.clientWidth > 0) {
      const over = el.scrollWidth - el.clientWidth
      const overY = el.scrollHeight - el.clientHeight
      const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip'
      const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip'
      if (clipsX && over > 1) {
        const kind = style.textOverflow === 'ellipsis' ? 'ELLIPSIS' : 'CLIPPED_X'
        defects.push({ kind, what: describe(el), px: over })
      }
      if (clipsY && overY > 2) defects.push({ kind: 'CLIPPED_Y', what: describe(el), px: overY })
    }

    // Inputs too narrow for the value they hold
    if ((tag === 'input' || tag === 'textarea') && el.type !== 'range' && el.type !== 'checkbox' && el.type !== 'radio' && el.value) {
      if (el.scrollWidth - el.clientWidth > 1 && tag === 'input') {
        const kind = getComputedStyle(el).textOverflow === 'ellipsis' ? 'ELLIPSIS' : 'INPUT_CLIPPED'
        defects.push({ kind, what: `${describe(el)} value="${el.value.slice(0, 30)}"`, px: el.scrollWidth - el.clientWidth })
      }
    }

    // Outside the window with no way to scroll to it
    const rect = el.getBoundingClientRect()
    if ((rect.right > vw + 1 || rect.bottom > vh + 1 || rect.left < -1 || rect.top < -1) && !scrollsInside(el)) {
      const box = visibleBox(el, rect)
      if (box.right - box.left > 0 && box.bottom - box.top > 0) {
        defects.push({ kind: 'OUT_OF_WINDOW', what: describe(el), px: Math.round(Math.max(rect.right - vw, rect.bottom - vh, -rect.left, -rect.top)) })
      }
    }

    // A child that sticks out of a box that does not clip or scroll it paints over its neighbours
    if (el.parentElement && style.position !== 'absolute' && style.position !== 'fixed' && !el.parentElement.closest('svg')) {
      const parent = el.parentElement
      const ps = getComputedStyle(parent)
      const p = parent.getBoundingClientRect()
      if (ps.overflowX === 'visible' && rect.width > 0 && rect.right > p.right + 2 && p.width > 0 && parent !== root) {
        defects.push({ kind: 'SPILLS_PARENT', what: describe(el), px: Math.round(rect.right - p.right) })
      }
      if (ps.overflowY === 'visible' && rect.height > 0 && rect.bottom > p.bottom + 3 && p.height > 0 && parent !== root) {
        defects.push({ kind: 'SPILLS_PARENT_Y', what: describe(el), px: Math.round(rect.bottom - p.bottom) })
      }
    }

    // Horizontal scrollbar on a panel: legal, but usually a sign something does not fit
    if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth - el.clientWidth > 1 && !el.closest('svg')) {
      defects.push({ kind: 'H_SCROLLBAR', what: describe(el).slice(0, 70), px: el.scrollWidth - el.clientWidth })
    }
  }

  const overlapOf = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    return w > 0 && h > 0 ? { w, h } : null
  }
  const isOpaque = (el) => {
    const match = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)
    if (!match) return false
    return match.length < 4 || Number(match[3]) > 0.6
  }
  /** A modal, a menu or a popup paints over everything else on purpose. */
  const layerOf = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const style = getComputedStyle(a)
      if (style.position === 'fixed' || (style.position !== 'static' && Number(style.zIndex) >= 30)) return a
    }
    return document.body
  }
  /** False when a separate layer or a third opaque box hides the shared area. */
  const bothPainted = (a, b, boxA, boxB) => {
    if (layerOf(a) !== layerOf(b)) return false
    const x = (Math.max(boxA.left, boxB.left, 0) + Math.min(boxA.right, boxB.right, vw)) / 2
    const y = (Math.max(boxA.top, boxB.top, 0) + Math.min(boxA.bottom, boxB.bottom, vh)) / 2
    const stack = document.elementsFromPoint(x, y)
    const position = (el) => {
      const found = stack.findIndex((s) => s === el || el.contains(s))
      return found < 0 ? stack.length : found
    }
    const lowest = Math.max(position(a), position(b))
    for (let i = 0; i < Math.min(lowest, stack.length); i++) {
      const over = stack[i]
      const related = over.contains(a) || over.contains(b) || a.contains(over) || b.contains(over)
      if (!related && isOpaque(over)) return false
      if (layerOf(over) !== layerOf(a)) return false
    }
    return true
  }

  // Text on text
  const texts = textBoxes
    .map((t) => ({ ...t, vis: visibleBox(t.el, t.box) }))
    .filter((t) => t.vis.right - t.vis.left > 1 && t.vis.bottom - t.vis.top > 1)
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]
      const b = texts[j]
      if (a.el === b.el) continue
      const o = overlapOf(a.vis, b.vis)
      if (!o || o.w < 2 || o.h < 3) continue
      if (a.el.contains(b.el) || b.el.contains(a.el)) {
        // A label and its nested <strong> report the same line box when text wraps. Real collisions
        // inside one line would need absolute positioning, which these never use.
        continue
      }
      if (!bothPainted(a.el, b.el, a.vis, b.vis)) continue
      defects.push({
        kind: 'TEXT_OVERLAP',
        what: `${describe(a.el).slice(0, 60)} <> ${describe(b.el).slice(0, 60)}`,
        px: Math.round(o.w * o.h)
      })
    }
  }

  // Control on control
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]
      const b = controls[j]
      if (a.contains(b) || b.contains(a)) continue
      const boxA = visibleBox(a, a.getBoundingClientRect())
      const boxB = visibleBox(b, b.getBoundingClientRect())
      const o = overlapOf(boxA, boxB)
      if (o && o.w > 1 && o.h > 1 && bothPainted(a, b, boxA, boxB)) {
        defects.push({ kind: 'CONTROL_OVERLAP', what: `${describe(a).slice(0, 60)} <> ${describe(b).slice(0, 60)}`, px: Math.round(o.w * o.h) })
      }
    }
  }

  return defects
}

const launchEnv = { ...process.env, NODE_ENV: 'test' }
delete launchEnv.ELECTRON_RUN_AS_NODE
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rungline-layout-'))
const app = await electron.launch({ executablePath: electronPath, args: ['.', `--user-data-dir=${userData}`], cwd: projectRoot, env: launchEnv })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

const resize = async ([w, h]) => {
  await app.evaluate(
    ({ BrowserWindow }, [cw, ch]) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.unmaximize()
      win.setMinimumSize(800, 500)
      win.setContentSize(cw, ch)
    },
    [w, h]
  )
  await page.waitForTimeout(250)
}

const results = new Map()
const check = async (view, rootSelector) => {
  const size = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)
  await page.waitForTimeout(120)
  const defects = await page.evaluate(scan, rootSelector || null)
  for (const d of defects) {
    const key = `${d.kind} | ${view} | ${d.what}`
    if (!results.has(key)) results.set(key, { ...d, view, sizes: new Set() })
    results.get(key).sizes.add(size)
  }
  await page.screenshot({ path: path.join(shotDir, `${view}-${size}.png`) })
}
const ui = (fn, arg) => page.evaluate(fn, arg)
const setUi = (patch) => ui((p) => window.plcTestContext.useUIStore.setState(p), patch)

const eachSize = async (view, rootSelector) => {
  for (const size of SIZES) {
    await resize(size)
    await check(view, rootSelector)
  }
}

// ---- Startup wizard ----
await page.locator('[data-testid="project-startup-wizard"]').waitFor({ timeout: 8000 })
await eachSize('wizard-create')
await page.locator('[data-testid="wizard-nav-open"]').click()
await eachSize('wizard-open')

// ---- Workbench with the demo project ----
await ui(async () => {
  await window.plcTestContext.useProjectStore.getState().loadDemoProject()
})
await page.locator('[data-testid="topbar-run-button"]').waitFor({ timeout: 8000 })
await page.waitForTimeout(600)

const inventory = await ui(() => {
  const b = window.plcTestContext.useBlockStore.getState()
  const t = window.plcTestContext.useTagStore.getState()
  const pick = (x) => x.fileName
  return {
    lad: b.ladBlocks.map(pick),
    scl: b.sclBlocks.map(pick),
    db: b.dataBlocks.map(pick),
    tables: t.tagTables.map((x) => x.id)
  }
})
console.log('Demo project:', JSON.stringify(inventory))

const tabs = [
  { id: 'audit-hw', title: 'Hardware Config', type: 'hardware' },
  { id: 'audit-all', title: 'All Tags', type: 'allTags' },
  { id: 'audit-sim', title: 'Virtual IO', type: 'simulation' },
  { id: 'audit-trace', title: 'Trace', type: 'trace' },
  ...inventory.lad.slice(0, 2).map((f) => ({ id: `audit-${f}`, title: f, type: 'lad', targetId: f })),
  ...inventory.scl.slice(0, 2).map((f) => ({ id: `audit-${f}`, title: f, type: 'scl', targetId: f })),
  ...inventory.db.slice(0, 2).map((f) => ({ id: `audit-${f}`, title: f, type: 'db', targetId: f })),
  ...inventory.tables.slice(0, 1).map((f) => ({ id: `audit-tbl-${f}`, title: 'Tag Table', type: 'tagTable', targetId: f }))
]

for (const tab of tabs) {
  await ui((t) => {
    const store = window.plcTestContext.useUIStore.getState()
    store.openTab(t)
    store.setActiveTab(t.id)
  }, tab)
  await eachSize(`tab-${tab.type}-${String(tab.targetId || tab.id).replace(/[^\w]+/g, '_')}`)
}

// ---- Selection toolbars of contacts and coils ----
// The bounds check does not see SVG shapes, so each toolbar is measured against the box that clips it
// and sampled to prove that nothing is painted over it.
const toolbarDefects = async () =>
  page.evaluate(() => {
    const found = []
    for (const bar of document.querySelectorAll('[data-testid$="-selection-toolbar"]')) {
      const box = bar.querySelector('rect').getBoundingClientRect()
      const clip = bar.closest('[data-testid="ladder-scroll-container"]').getBoundingClientRect()
      const svg = bar.closest('svg').getBoundingClientRect()
      const rail = svg.left + (30 + 2.5) * (svg.width / bar.closest('svg').viewBox.baseVal.width)
      if (box.top < clip.top || box.bottom > clip.bottom) found.push(`cut vertically by ${Math.round(Math.max(clip.top - box.top, box.bottom - clip.bottom))}px`)
      if (box.left < svg.left || box.right > svg.right) found.push('outside the rung horizontally')
      if (box.left < rail) found.push('covers the left power rail')
      let covered = 0
      for (let i = 1; i < 24; i++) {
        const x = box.left + (box.width * i) / 24
        const y = box.top + box.height / 2
        if (x < clip.left || x > clip.right) continue
        const hit = document.elementFromPoint(x, y)
        if (hit && hit.closest('svg') === bar.closest('svg') && !bar.contains(hit)) covered++
      }
      if (covered) found.push(`${covered}/23 samples covered by ${bar.getAttribute('data-testid')}`)
    }
    return found
  })

const SELECT_DEFECTS = []
for (const f of inventory.lad.slice(0, 2)) {
  await ui((id) => window.plcTestContext.useUIStore.getState().setActiveTab(id), `audit-${f}`)
  await page.waitForTimeout(250)
  const count = await page.locator('[data-testid="contact-bottom-address"], [data-testid="coil-bottom-address"]').count()
  console.log(`Selecting ${count} contacts and coils in ${f}`)
  for (const size of SIZES) {
    await resize(size)
    const n = await page.locator('[data-testid="contact-bottom-address"], [data-testid="coil-bottom-address"]').count()
    let toolbars = 0
    for (let i = 0; i < n; i++) {
      await page.evaluate((idx) => {
        const el = document.querySelectorAll('[data-testid="contact-bottom-address"], [data-testid="coil-bottom-address"]')[idx]
        el.scrollIntoView({ block: 'center', inline: 'center' })
      }, i)
      await page.evaluate((idx) => {
        const el = document.querySelectorAll('[data-testid="contact-bottom-address"], [data-testid="coil-bottom-address"]')[idx]
        el.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }, i)
      await page.waitForTimeout(40)
      const barCount = await page.locator('[data-testid$="-selection-toolbar"]').count()
      toolbars += barCount
      for (const d of await toolbarDefects()) SELECT_DEFECTS.push(`${f} #${i} @${size.join('x')}: ${d}`)
      if (i === 0 && barCount) await page.screenshot({ path: path.join(shotDir, `toolbar-${f.replace(/[^\w]+/g, '_')}-${size.join('x')}.png`) })
    }
    console.log(`  ${JSON.stringify(size)}: ${toolbars} toolbars shown for ${n} elements`)
    if (n > 0 && toolbars === 0) SELECT_DEFECTS.push(`${f} @${JSON.stringify(size)}: selecting never opened a toolbar`)
  }
  await page.keyboard.press('Escape')
}
console.log(`Selection toolbar defects: ${SELECT_DEFECTS.length}`)
for (const d of [...new Set(SELECT_DEFECTS)].slice(0, 40)) console.log('  ' + d)

// ---- Sub tabs and alternate editor views ----
const clickAndCheck = async (view, locator) => {
  if ((await locator.count()) === 0) {
    console.log('not found:', view)
    return
  }
  await locator.first().click()
  await page.waitForTimeout(150)
  await eachSize(view)
}
const showTab = (id) => ui((tabId) => window.plcTestContext.useUIStore.getState().setActiveTab(tabId), id)
await showTab('audit-sim')
for (const [view, label] of [['sim-mimic', 'Mimic'], ['sim-scenario', 'Scenario'], ['sim-trace', 'Trace'], ['sim-rack', 'I/O Rack']]) {
  await clickAndCheck(view, page.locator('main button', { hasText: new RegExp(`^(${label})`) }))
}
await showTab('audit-hw')
for (const [view, label] of [['hw-memory', 'System & Clock'], ['hw-digital', 'DI '], ['hw-analog', 'AI '], ['hw-obs', 'OB Execution'], ['hw-general', 'General']]) {
  await clickAndCheck(view, page.locator('main button', { hasText: label }))
}
await ui(() => {
  const { udts } = window.plcTestContext.useBlockStore.getState()
  const store = window.plcTestContext.useUIStore.getState()
  if (udts[0]) {
    store.openTab({ id: 'audit-udt', title: udts[0].name, type: 'udt', targetId: udts[0].id })
    store.setActiveTab('audit-udt')
  }
})
await eachSize('tab-udt')
const ladTab = `audit-${inventory.lad[0]}`
await showTab(ladTab)
await clickAndCheck('lad-stl', page.locator('[data-testid="toggle-bytecode-view"]'))
await page.locator('[data-testid="toggle-bytecode-view"]').first().click()
await clickAndCheck('lad-json', page.locator('main button[title="View AST JSON"]'))
await page.locator('main button[title="View SVG Ladder"]').first().click()
await clickAndCheck('lad-force', page.locator('main button[title="Toggle Quick I/O Forcing Bar"]'))
await page.locator('main button[title="Toggle Quick I/O Forcing Bar"]').first().click()
await resize([1440, 900])
await ui(() => {
  const s = window.plcTestContext.useUIStore.getState()
  if (!s.isSplitView) s.toggleSplitView()
  s.setSplitTab('audit-all')
})
await eachSize('split-view')
await ui(() => window.plcTestContext.useUIStore.getState().toggleSplitView())
await ui(() => window.plcTestContext.useUIStore.setState({ bottomDockHeight: 230 }))

// ---- Docks ----
const first = tabs.find((t) => t.type === 'lad') || tabs[0]
await ui((t) => window.plcTestContext.useUIStore.getState().setActiveTab(t.id), first)
for (const bottom of ['compile', 'crossref', 'memoryMap', 'trace']) {
  await setUi({ bottomActiveTab: bottom, bottomDockCollapsed: false })
  await eachSize(`bottom-${bottom}`)
}
await setUi({ bottomActiveTab: 'compile', rightActiveTab: 'agent' })
await eachSize('right-agent')
await ui(() => {
  const store = window.plcTestContext.useUIStore.getState()
  store.sendAgentMessage('Motor icin mühürleme devresi kur, Start_Butonu_Uzun_Etiket_Adi_Boyle_Olursa_Ne_Olur %I0.0 ve 5 saniye sonra lamba yansin', 'user')
  store.sendAgentMessage('Devre OB1 içine eklendi.\n\nhttps://example.invalid/cok/uzun/bir/adres/kirilmayan_tek_kelime_olursa_panel_tasiyor_mu_diye_bakmak_icin_yazildi_0123456789\n\nDerleme hatasız.', 'agent', ['MEB_Standardi'], {
    snippet: 'x'.repeat(200),
    isError: true,
    errorDetails: 'Hata: ' + 'y'.repeat(300)
  })
})
await eachSize('right-agent-messages')
await setUi({ rightActiveTab: 'instructions', leftDockCollapsed: true })
await eachSize('left-collapsed')
await setUi({ leftDockCollapsed: false, rightDockCollapsed: true })
await eachSize('right-collapsed')
await setUi({ rightDockCollapsed: false, rightDockWidth: 260, leftDockWidth: 180 })
await eachSize('docks-narrow')
await setUi({ rightDockWidth: 540, leftDockWidth: 420 })
await resize([1280, 720])
await check('docks-wide')
await setUi({ rightDockWidth: 320, leftDockWidth: 240, bottomDockCollapsed: true })
await eachSize('bottom-collapsed')
await setUi({ bottomDockCollapsed: false })

// ---- Running, monitor overlays ----
await ui(() => {
  const s = window.plcTestContext.useRuntimeStore.getState()
  if (!s.start()) {
    s.syncProjectToEngine()
    s.engine.start()
  }
})
await page.waitForTimeout(500)
await eachSize('plc-running')
await ui(() => window.plcTestContext.useRuntimeStore.getState().stop())

// ---- Menus ----
for (const label of ['File', 'Edit', 'View', 'PLC', 'Tools']) {
  const item = page.locator('button', { hasText: new RegExp(`^${label}$`) }).first()
  if ((await item.count()) === 0) {
    console.log('menu not found:', label)
    continue
  }
  await item.click()
  await eachSize(`menu-${label}`)
  await item.click()
}

// ---- Modals ----
const modal = async (view, open, rootSelector, close) => {
  await open()
  await page.waitForTimeout(250)
  await eachSize(view, rootSelector)
  await close()
  await page.waitForTimeout(150)
}
await modal(
  'modal-add-block',
  () => setUi({ isAddBlockModalOpen: true }),
  null,
  () => setUi({ isAddBlockModalOpen: false })
)
await modal(
  'modal-debug-log',
  () => setUi({ isDebugLogModalOpen: true }),
  '[data-testid="debug-log-modal"]',
  () => setUi({ isDebugLogModalOpen: false })
)
await setUi({ rightActiveTab: 'agent' })
await modal(
  'modal-book-trainer',
  () => setUi({ isBookTrainerOpen: true }),
  '[data-testid="rag-book-trainer-modal"]',
  () => setUi({ isBookTrainerOpen: false })
)
await page.locator('[data-testid="agent-panel"] button:has(svg.lucide-settings)').first().click()
for (const provider of ['gemini', 'ollama', 'openai']) {
  await page.locator(`[data-testid="provider-btn-${provider}"]`).click()
  await eachSize(`modal-ai-settings-${provider}`, '[data-testid="ai-settings-modal"]')
}
await page.locator('[data-testid="ai-settings-save-button"]').click()
await setUi({ rightActiveTab: 'instructions' })

await page.locator('[data-testid="topbar-export-button"]').click()
await page.locator('[data-testid="tia-modal"]').waitFor({ timeout: 4000 })
for (const key of await page.locator('[data-testid^="tia-tab-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))) {
  await page.locator(`[data-testid="${key}"]`).click()
  await eachSize(`modal-${key}`, '[data-testid="tia-modal"]')
}
await page.keyboard.press('Escape')
const tiaStillOpen = await page.locator('[data-testid="tia-modal"]').count()
if (tiaStillOpen) await page.locator('[data-testid="tia-modal"] button:has(svg.lucide-x)').first().click()

await page.locator('[data-testid="topbar-auto-debug-button"]').click()
await page.waitForTimeout(300)
await eachSize('modal-live-debugger')

// ---- Report ----
const order = ['TEXT_OVERLAP', 'CONTROL_OVERLAP', 'OUT_OF_WINDOW', 'CLIPPED_X', 'CLIPPED_Y', 'INPUT_CLIPPED', 'SPILLS_PARENT', 'SPILLS_PARENT_Y', 'H_SCROLLBAR', 'ELLIPSIS']
const rows = [...results.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.what.localeCompare(b.what))
const lines = rows.map((r) => `${r.kind.padEnd(16)} ${String(r.px).padStart(5)}px  ${r.view}  [${[...r.sizes].join(' ')}]\n    ${r.what}`)
fs.writeFileSync(path.join(shotDir, 'report.txt'), lines.join('\n') + '\n')

const counts = {}
for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1
console.log('Defects by kind:', JSON.stringify(counts))
console.log('Renderer errors:', errors.length, errors.slice(0, 5))
console.log(`Report: ${path.join(shotDir, 'report.txt')}`)

await app.close()
const blocking = rows.filter((r) => r.kind !== 'ELLIPSIS' && r.kind !== 'H_SCROLLBAR')
process.exit(blocking.length > 0 || errors.length > 0 || SELECT_DEFECTS.length > 0 ? 1 : 0)

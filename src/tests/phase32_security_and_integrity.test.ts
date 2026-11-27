// Phase 32: Regression tests for Phase 1 Security, Data Integrity & Stability hardening.
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import * as http from 'http'
import { AddressInfo } from 'net'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  approveCreateParent,
  approveOpenRoot,
  assertApprovedCreateTarget,
  assertApprovedOpenRoot,
  assertPlainFileName,
  resolveInsideReal
} from '../main/pathGuard'
import { FileEngine } from '../main/fileEngine'
import { cancelAiHttpRequest, MAX_RESPONSE_BYTES, sendAiHttpRequest } from '../main/aiHttp'
import { BlackBoxLogger } from '../renderer/src/services/diagnostics/BlackBoxLogger'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`✅ PASS: ${name}`)
  } else {
    failed++
    console.error(`❌ FAIL: ${name}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`)
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

async function run(): Promise<void> {
  console.log('=== PHASE 32: SECURITY, DATA INTEGRITY & STABILITY ===\n')
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plc-sec-'))

  try {
    // 1. pathGuard dialog approval, symlink/junction containment & ADS/device checks
    const unapprovedDir = path.join(tmpRoot, 'unapproved')
    const approvedOpen = path.join(tmpRoot, 'approved_open')
    const approvedParent = path.join(tmpRoot, 'approved_parent')
    const outsideDir = path.join(tmpRoot, 'outside')
    await fs.mkdir(unapprovedDir, { recursive: true })
    await fs.mkdir(approvedOpen, { recursive: true })
    await fs.mkdir(approvedParent, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })

    check('Unapproved open root is rejected', throws(() => assertApprovedOpenRoot(unapprovedDir)))
    approveOpenRoot(approvedOpen)
    check('Dialog-approved open root is accepted', !throws(() => assertApprovedOpenRoot(approvedOpen)))

    check('Unapproved create target is rejected', throws(() => assertApprovedCreateTarget(path.join(unapprovedDir, 'Proj'))))
    approveCreateParent(approvedParent)
    check(
      'Create target inside approved parent is accepted',
      !throws(() => assertApprovedCreateTarget(path.join(approvedParent, 'Proj1')))
    )
    check(
      'Sibling prefix escape on create target is rejected',
      throws(() => assertApprovedCreateTarget(`${approvedParent}_evil/Proj1`))
    )

    // Symlink / NTFS junction escape check
    const junctionPath = path.join(approvedOpen, 'blocks', 'link_escape')
    await fs.mkdir(path.join(approvedOpen, 'blocks'), { recursive: true })
    let linkCreated = false
    try {
      await fs.symlink(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir')
      linkCreated = true
    } catch {
      linkCreated = false
    }
    if (linkCreated) {
      check(
        'resolveInsideReal rejects symlink/junction escaping project root',
        await rejects(() => resolveInsideReal(approvedOpen, 'blocks/link_escape/pwn.txt'))
      )
      const realOutside = await fs.realpath(outsideDir)
      const canonicalBundleFile = await resolveInsideReal(path.join(junctionPath, 'new_bundle'), 'sources/UDT_Motor.udt')
      check(
        'resolveInsideReal allows non-existent root under symlinked/short parent path',
        canonicalBundleFile === path.join(realOutside, 'new_bundle', 'sources', 'UDT_Motor.udt'),
        canonicalBundleFile
      )
      await fs.rm(junctionPath, { recursive: true, force: true })
    } else {
      console.log('  skip symlink/junction escape test: symlink creation not permitted on this environment')
    }

    check('assertPlainFileName rejects NTFS ADS colon', throws(() => assertPlainFileName('OB1.scl:stream')))
    check('assertPlainFileName rejects Windows CON device name', throws(() => assertPlainFileName('CON')))
    check('assertPlainFileName rejects Windows NUL.txt device name', throws(() => assertPlainFileName('NUL.txt')))
    check('assertPlainFileName rejects trailing dot', throws(() => assertPlainFileName('bad.')))
    check('assertPlainFileName accepts valid block filename', assertPlainFileName('OB1_Main.scl') === 'OB1_Main.scl')

    // 2. FileEngine atomic concurrent writes, pre-validation & trash behavior
    const concProject = path.join(tmpRoot, 'conc_proj')
    await FileEngine.ensureProjectDirectories(concProject)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        FileEngine.saveSingleFile(concProject, 'blocks/Concurrent.db.json', JSON.stringify({ seq: i, pad: 'x'.repeat(256) }))
      )
    )
    const concRaw = await fs.readFile(path.join(concProject, 'blocks', 'Concurrent.db.json'), 'utf-8')
    const concParsed = JSON.parse(concRaw) as { seq: number }
    const leftTmp = (await fs.readdir(path.join(concProject, 'blocks'))).filter((f) => f.endsWith('.tmp'))
    check('20 concurrent saveSingleFile calls produce valid JSON and 0 .tmp leftovers', typeof concParsed.seq === 'number' && leftTmp.length === 0, {
      concParsed,
      leftTmp
    })

    const missingTrashResult = await FileEngine.moveToTrash(concProject, 'blocks/DoesNotExist.scl')
    const trashDirExists = existsSync(path.join(concProject, '.trash'))
    check('moveToTrash on missing file returns false without creating .trash', missingTrashResult === false && !trashDirExists)

    // 3. main/aiHttp SSRF, redirect, size limit, duplicate ID & secret host binding
    const metaBlocked = await sendAiHttpRequest({
      id: 'ssrf-meta',
      url: 'http://169.254.169.254/latest/meta-data/',
      method: 'GET',
      headers: {},
      timeoutMs: 1000
    })
    check('aiHttp blocks cloud metadata 169.254.169.254', metaBlocked.error === 'network' && metaBlocked.status === 0, metaBlocked)

    const lanBlocked = await sendAiHttpRequest({
      id: 'ssrf-lan-blocked',
      url: 'http://10.0.0.1:11434/api/tags',
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      allowPrivateNetwork: false
    })
    check('aiHttp blocks private LAN IP by default', lanBlocked.error === 'network' && /Private LAN/i.test(lanBlocked.message || ''), lanBlocked)

    const geminiWrongHost = await sendAiHttpRequest({
      id: 'gemini-wrong-host',
      url: 'https://evil.example.com/v1beta/models',
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      authSecret: 'geminiApiKey'
    })
    check(
      'aiHttp refuses to send geminiApiKey to non-Google host',
      geminiWrongHost.error === 'network' && /generativelanguage\.googleapis\.com/.test(geminiWrongHost.message || ''),
      geminiWrongHost
    )

    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/secret' })
        res.end()
        return
      }
      if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('A'.repeat(MAX_RESPONSE_BYTES + 4096))
        return
      }
      if (req.url === '/slow-dup') {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200)
            res.end('late')
          }
        }, 500)
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const redirRes = await sendAiHttpRequest({
        id: 'redir-test',
        url: `http://127.0.0.1:${port}/redirect`,
        method: 'GET',
        headers: {},
        timeoutMs: 3000
      })
      check('aiHttp refuses HTTP 302 redirects (redirect: error)', redirRes.error === 'network' && redirRes.status === 0, redirRes)

      const hugeRes = await sendAiHttpRequest({
        id: 'huge-test',
        url: `http://127.0.0.1:${port}/huge`,
        method: 'GET',
        headers: {},
        timeoutMs: 5000
      })
      check('aiHttp aborts oversized >10 MB responses', hugeRes.error === 'network' && /MB limit/i.test(hugeRes.message || ''), hugeRes)

      const firstSlow = sendAiHttpRequest({
        id: 'dup-id',
        url: `http://127.0.0.1:${port}/slow-dup`,
        method: 'GET',
        headers: {},
        timeoutMs: 5000
      })
      const secondFast = await sendAiHttpRequest({
        id: 'dup-id',
        url: `http://127.0.0.1:${port}/ok`,
        method: 'GET',
        headers: {},
        timeoutMs: 5000
      })
      const firstResult = await firstSlow
      cancelAiHttpRequest('dup-id')
      check(
        'Duplicate request.id aborts prior request without deleting new one',
        firstResult.error === 'cancelled' && secondFast.status === 200,
        { firstResult, secondFast }
      )

      const clampedTimeout = await sendAiHttpRequest({
        id: 'nan-timeout',
        url: `http://127.0.0.1:${port}/slow-dup`,
        method: 'GET',
        headers: {},
        timeoutMs: Number.NaN
      })
      check(
        'Clamped timeout error never outputs NaN s',
        clampedTimeout.status === 200 || (clampedTimeout.message !== undefined && !clampedTimeout.message.includes('NaN')),
        clampedTimeout
      )
    } finally {
      server.closeAllConnections()
      server.close()
    }

    // 4. BlackBoxLogger recursive secret redaction
    const logger = BlackBoxLogger.getInstance()
    logger.clearLogs()
    const entry = logger.log('AI_ERROR', 'Auth failed with Bearer sk-proj-secretvalue9876543210', {
      openaiApiKey: 'sk-openaisecret1234567890',
      nested: {
        headers: { Authorization: 'Bearer tokensecret99887766' },
        errorBody: 'Invalid key AIzaSySecretGoogleKey123456'
      }
    })
    const serializedEntry = JSON.stringify(entry)
    check(
      'BlackBoxLogger redacts openaiApiKey, Bearer tokens, sk-*, and AIza* tokens',
      !serializedEntry.includes('sk-proj-secretvalue9876543210') &&
        !serializedEntry.includes('sk-openaisecret1234567890') &&
        !serializedEntry.includes('tokensecret99887766') &&
        !serializedEntry.includes('AIzaSySecretGoogleKey123456') &&
        serializedEntry.includes('...7890'),
      serializedEntry
    )

    // 5. TiaBridge.cs path traversal and version validation
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    if (process.platform === 'win32' && existsSync(csc)) {
      const bridgeDir = path.join(tmpRoot, 'bridge_test')
      await fs.mkdir(bridgeDir, { recursive: true })
      const exe = path.join(bridgeDir, 'TiaBridge.exe')
      execFileSync('cmd.exe', ['/c', path.resolve('tools/tia-bridge/build.cmd'), exe], { stdio: 'pipe' })
      check('TiaBridge.cs compiles cleanly with System.Xml.dll', existsSync(exe))

      let badVerCode = 0
      try {
        execFileSync(exe, ['verify', bridgeDir, '--out', path.join(bridgeDir, 'out1'), '--tia-version', '19" bad'], { stdio: 'pipe' })
      } catch (err) {
        badVerCode = (err as { status: number }).status
      }
      check('TiaBridge rejects non-numeric --tia-version (prevents XML/regex injection)', badVerCode === 1, badVerCode)
    } else {
      console.log('  skip TiaBridge C# checks: csc.exe unavailable')
    }

    // 6. Static security audit of CSP, preload & simulation store
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    const viteCfg = await fs.readFile(path.join(repoRoot, 'electron.vite.config.ts'), 'utf-8')
    const preloadSrc = await fs.readFile(path.join(repoRoot, 'src/preload/index.ts'), 'utf-8')
    const simStoreSrc = await fs.readFile(path.join(repoRoot, 'src/renderer/src/stores/useSimulationStore.ts'), 'utf-8')

    const cspBlock = viteCfg.match(/const CONTENT_SECURITY_POLICY = \[([\s\S]*?)\]/)?.[1] || viteCfg
    check(
      'CSP removes unsafe-eval and blanket http:/https:/ws: while keeping worker-src and rungline-sim frame-src',
      !cspBlock.includes("'unsafe-eval'") &&
        !cspBlock.includes('http: https: ws:') &&
        cspBlock.includes("worker-src 'self' blob:") &&
        cspBlock.includes('frame-src rungline-sim:')
    )
    check('Preload removes secrets:get and fails closed when contextIsolation is off', !preloadSrc.includes('secrets:get') && preloadSrc.includes('Preload requires contextIsolation'))
    check('useSimulationStore no longer uses new Function', !simStoreSrc.includes('new Function'))
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }

  console.log(`\nPHASE 32 SUMMARY: ${passed} PASSED, ${failed} FAILED`)
  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error('Fatal Phase 32 failure:', err)
  process.exit(1)
})

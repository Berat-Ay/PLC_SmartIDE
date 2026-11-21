// Regression tests for Remediation Blueprint 1/3:
// SCL extension (.scl), project:create disk persistence + pathGuard registration,
// AddBlockModal LAD schema & Instance DB parent FB binding, SCL header/tab rename,
// online value parsing, and zero window.prompt() / legacy SCL-JSON extension regressions.
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FileEngine } from '../main/fileEngine'
import { assertProjectRoot, registerProjectRoot } from '../main/pathGuard'
import { createDataBlockDefinition, createInitialLadNetworks } from '../shared/blocks/blockFactory'
import { getOnlineValuePlaceholder, parseOnlineValue } from '../shared/s7/onlineValueParser'
import { effectiveInterface, emptyInterface, parseSourceBlock, renameSourceBlockHeader } from '../shared/scl/sourceBlock'
import { SclBlockDefinition } from '../shared/types/blocks'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { SclInterpreter } from '../renderer/src/runtime/SclInterpreter'
import { ProjectCompilerEngine } from '../renderer/src/services/compiler/ProjectCompilerEngine'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useUIStore } from '../renderer/src/stores/useUIStore'

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

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)))
    } else {
      out.push(full)
    }
  }
  return out
}

async function run(): Promise<void> {
  console.log('=== PHASE 26: REMEDIATION BLUEPRINT 1/3 ===\n')
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plc-pkg1-'))

  try {
    // 1. FileEngine.createProject (SCL) + pathGuard + round-trip
    const sclProjDir = path.join(tmpRoot, 'SclProject')
    const createdScl = await FileEngine.createProject({
      name: 'SclProject',
      targetPath: sclProjDir,
      cpuProfileId: 'cpu-1511',
      defaultLanguage: 'SCL'
    })

    for (const subdir of ['blocks', 'tags', 'types', 'hardware', 'simulation']) {
      const stat = await fs.stat(path.join(sclProjDir, subdir))
      check(`createProject creates '${subdir}/' subdirectory`, stat.isDirectory())
    }

    const blockFiles = await fs.readdir(path.join(sclProjDir, 'blocks'))
    check('SCL project writes OB1_Main.scl on disk', blockFiles.includes('OB1_Main.scl'), blockFiles)
    check('SCL project does not write legacy JSON-suffixed SCL file', !blockFiles.includes('OB1_Main.scl' + '.json'), blockFiles)

    const ob1Raw = await fs.readFile(path.join(sclProjDir, 'blocks', 'OB1_Main.scl'), 'utf-8')
    check('OB1_Main.scl starts with ORGANIZATION_BLOCK "Main"', ob1Raw.includes('ORGANIZATION_BLOCK "Main"'), ob1Raw)
    check('OB1_Main.scl ends with END_ORGANIZATION_BLOCK', ob1Raw.includes('END_ORGANIZATION_BLOCK'), ob1Raw)

    const parsedOb1 = parseSourceBlock(ob1Raw)
    check('OB1_Main.scl parses cleanly with parseSourceBlock', parsedOb1.hasHeader && parsedOb1.kind === 'OB' && parsedOb1.errors.length === 0, parsedOb1.errors)
    const syntaxOb1 = SclInterpreter.validateSyntax(ob1Raw)
    check('OB1_Main.scl passes SclInterpreter.validateSyntax', syntaxOb1.valid, syntaxOb1.errors)

    registerProjectRoot(createdScl.projectPath)
    let rootAccepted = true
    try {
      assertProjectRoot(createdScl.projectPath)
    } catch {
      rootAccepted = false
    }
    check('Registered created project root passes assertProjectRoot', rootAccepted)

    const savedOk = await FileEngine.saveProject(createdScl)
    check('FileEngine.saveProject succeeds after project creation', savedOk)

    const reloadedScl = await FileEngine.loadProject(createdScl.projectPath)
    check('Reloaded SCL project has OB1_Main.scl', reloadedScl.sclBlocks.some((b) => b.fileName === 'OB1_Main.scl'), reloadedScl.sclBlocks.map((b) => b.fileName))
    check('Reloaded SCL project has 0 loadErrors', (reloadedScl.loadErrors?.length || 0) === 0, reloadedScl.loadErrors)

    const sclCompile = ProjectCompilerEngine.runFullProjectCompilation(
      reloadedScl.tagTables,
      reloadedScl.ladBlocks,
      reloadedScl.sclBlocks,
      reloadedScl.hardware,
      reloadedScl.dataBlocks,
      reloadedScl.udts
    )
    check('Newly created SCL project compiles cleanly', sclCompile.canDownload && sclCompile.errorsCount === 0, sclCompile.diagnostics)

    // 2. FileEngine.createProject (LAD) + error guards
    const ladProjDir = path.join(tmpRoot, 'LadProject')
    const createdLad = await FileEngine.createProject({
      name: 'LadProject',
      targetPath: ladProjDir,
      cpuProfileId: 'cpu-1214c',
      defaultLanguage: 'LAD'
    })
    check('LAD project creates OB1_Main.lad.json', createdLad.ladBlocks[0]?.fileName === 'OB1_Main.lad.json')
    check('LAD OB1 network uses valid nodes array', Array.isArray(createdLad.ladBlocks[0]?.networks[0]?.nodes) && typeof createdLad.ladBlocks[0]?.networks[0]?.id === 'string')

    let emptyRejected = false
    try {
      await FileEngine.createProject({ name: 'Bad', targetPath: '   ', cpuProfileId: 'cpu-1214c', defaultLanguage: 'LAD' })
    } catch {
      emptyRejected = true
    }
    check('FileEngine.createProject rejects empty targetPath', emptyRejected)

    const fileInsteadOfDir = path.join(tmpRoot, 'not_a_dir.txt')
    await fs.writeFile(fileInsteadOfDir, 'hello', 'utf-8')
    let filePathRejected = false
    try {
      await FileEngine.createProject({ name: 'BadFile', targetPath: fileInsteadOfDir, cpuProfileId: 'cpu-1214c', defaultLanguage: 'LAD' })
    } catch {
      filePathRejected = true
    }
    check('FileEngine.createProject rejects path pointing to existing file', filePathRejected)

    // 3. Renderer store fallback createNewProject (SCL)
    useProjectStore.getState().createNewProject({
      name: 'StoreSclProj',
      cpuProfileId: 'cpu-1214c',
      defaultLanguage: 'SCL'
    })
    const storeScl = useBlockStore.getState().sclBlocks
    const uiState = useUIStore.getState()
    check('useProjectStore.createNewProject sets OB1_Main.scl', storeScl.length === 1 && storeScl[0].fileName === 'OB1_Main.scl', storeScl[0]?.fileName)
    check('useProjectStore.createNewProject opens OB1_Main.scl tab', uiState.activeTabId === 'OB1_Main.scl' && uiState.tabs[0]?.targetId === 'OB1_Main.scl', uiState.tabs)

    // 4. AddBlockModal LAD scaffolding + Instance DB binding + PlcRuntimeEngine execution
    const ladNetworks = createInitialLadNetworks()
    check(
      'createInitialLadNetworks uses valid LadderNetwork schema (id + nodes[], no elements)',
      ladNetworks.length === 1 &&
        typeof ladNetworks[0].id === 'string' &&
        ladNetworks[0].id.length > 0 &&
        ladNetworks[0].networkNumber === 1 &&
        ladNetworks[0].title === 'Network 1' &&
        Array.isArray(ladNetworks[0].nodes) &&
        !('elements' in ladNetworks[0]),
      ladNetworks
    )

    let instanceWithoutFbRejected = false
    try {
      createDataBlockDefinition({
        blockNumber: 10,
        name: 'DB10_Orphan',
        dbType: 'Instance',
        optimizedAccess: true
      })
    } catch {
      instanceWithoutFbRejected = true
    }
    check('createDataBlockDefinition requires parentFb for Instance DB', instanceWithoutFbRejected)

    const fbCode = `FUNCTION_BLOCK "FB2_Counter"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nVAR_INPUT\n  Enable : Bool := FALSE;\nEND_VAR\nVAR_OUTPUT\n  CountOut : Int := 0;\nEND_VAR\nVAR\n  Acc : Int := 0;\nEND_VAR\nVAR_TEMP\n  Scratch : Int;\nEND_VAR\nBEGIN\n  IF #Enable THEN\n    #Acc := #Acc + 1;\n  END_IF;\n  #CountOut := #Acc;\nEND_FUNCTION_BLOCK\n`
    const fbBlock: SclBlockDefinition = {
      blockType: 'FB',
      blockNumber: 2,
      name: 'FB2_Counter',
      fileName: 'FB2_Counter.scl',
      optimizedAccess: true,
      interface: emptyInterface(),
      code: fbCode
    }
    fbBlock.interface = effectiveInterface(fbBlock)

    const instDb = createDataBlockDefinition({
      blockNumber: 2,
      name: 'DB2_CounterInst',
      dbType: 'Instance',
      optimizedAccess: true,
      parentFb: { name: fbBlock.name, interface: fbBlock.interface }
    })
    check('Instance DB binds parentFbName', instDb.parentFbName === 'FB2_Counter', instDb.parentFbName)
    check(
      'Instance DB inherits input/output/inOut/static vars and excludes temp/constant',
      instDb.variables.map((v) => v.name).join(',') === 'Enable,CountOut,Acc',
      instDb.variables.map((v) => v.name)
    )

    const obCaller: SclBlockDefinition = {
      blockType: 'OB',
      blockNumber: 1,
      name: 'Main',
      fileName: 'OB1_Main.scl',
      optimizedAccess: true,
      interface: emptyInterface(),
      code: `ORGANIZATION_BLOCK "Main"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nBEGIN\n  "DB2_CounterInst"(Enable := TRUE);\nEND_ORGANIZATION_BLOCK\n`
    }

    const fbRuntimeCompile = ProjectCompilerEngine.runFullProjectCompilation(
      [],
      [],
      [obCaller, fbBlock],
      createdScl.hardware,
      [instDb],
      []
    )
    check('Project with created FB + Instance DB compiles cleanly', fbRuntimeCompile.canDownload && fbRuntimeCompile.errorsCount === 0, fbRuntimeCompile.diagnostics)

    const engine = new PlcRuntimeEngine({
      projectPath: tmpRoot,
      metadata: createdScl.metadata,
      hardware: createdScl.hardware,
      tagTables: [],
      udts: [],
      dataBlocks: [instDb],
      ladBlocks: [],
      sclBlocks: [obCaller, fbBlock]
    }) as PlcRuntimeEngine & {
      intervalHandle: NodeJS.Timeout
      interruptHandles: NodeJS.Timeout[]
      runCyclicScan(): void
    }
    engine.start()
    clearInterval(engine.intervalHandle)
    engine.interruptHandles.forEach((h) => clearInterval(h))
    engine.runCyclicScan()
    engine.runCyclicScan()
    const countOut = engine.getVariable('"DB2_CounterInst".CountOut')
    check('PlcRuntimeEngine executes FB via created Instance DB', countOut === 2, countOut)
    engine.stop()

    // 5. SCL header rename + store sync + tab title sync
    const renamedFb = renameSourceBlockHeader(fbCode, 'FB2_Renamed')
    check('renameSourceBlockHeader updates FUNCTION_BLOCK header', renamedFb.includes('FUNCTION_BLOCK "FB2_Renamed"'), renamedFb)
    check('renameSourceBlockHeader preserves VAR_INPUT and body', renamedFb.includes('Enable : Bool') && renamedFb.includes('#Acc := #Acc + 1;'))

    const fcWithComment = `// Banner comment\nFUNCTION "FC_Old" : Real\nVAR_INPUT\n  X : Real;\nEND_VAR\nBEGIN\n  #FC_Old := #X;\nEND_FUNCTION\n`
    const renamedFc = renameSourceBlockHeader(fcWithComment, 'FC_New')
    check('renameSourceBlockHeader preserves comment and return type on FUNCTION', renamedFc.includes('// Banner comment') && renamedFc.includes('FUNCTION "FC_New" : Real'), renamedFc)

    useBlockStore.getState().setBlocks({ udts: [], dataBlocks: [], ladBlocks: [], sclBlocks: [fbBlock] })
    useBlockStore.getState().updateSclBlock('FB2_Counter.scl', { name: 'FB2_Motor' })
    const updatedScl = useBlockStore.getState().sclBlocks[0]
    check('useBlockStore.updateSclBlock syncs SCL header name', updatedScl.name === 'FB2_Motor' && parseSourceBlock(updatedScl.code).name === 'FB2_Motor', updatedScl.code)

    useUIStore.getState().setTabs([
      { id: 'tab_scl_FB2_Counter.scl', title: 'FB2_Counter', type: 'scl', targetId: 'FB2_Counter.scl' },
      { id: 'tab_other', title: 'Other', type: 'hardware' }
    ])
    useUIStore.getState().updateTabTitle('scl', 'FB2_Counter.scl', 'FB2_Motor')
    const tabsAfter = useUIStore.getState().tabs
    check('useUIStore.updateTabTitle updates matching tab and leaves others intact', tabsAfter[0].title === 'FB2_Motor' && tabsAfter[1].title === 'Other', tabsAfter)

    // 6. Online value parser validation
    check('parseOnlineValue INT valid', parseOnlineValue('-120', 'INT').ok && (parseOnlineValue('-120', 'INT') as { ok: true; value: number }).value === -120)
    check('parseOnlineValue INT out of range rejected', !parseOnlineValue('40000', 'INT').ok)
    check('parseOnlineValue DINT valid', parseOnlineValue('100000', 'DINT').ok)
    check('parseOnlineValue WORD hex literal valid', (parseOnlineValue('16#00FF', 'WORD') as { ok: true; value: number }).value === 255)
    check('parseOnlineValue REAL valid & invalid', (parseOnlineValue('3.14', 'REAL') as { ok: true; value: number }).value === 3.14 && !parseOnlineValue('abc', 'REAL').ok)
    check('parseOnlineValue TIME literal T#5s -> 5000', (parseOnlineValue('T#5s', 'TIME') as { ok: true; value: number }).value === 5000)
    check('parseOnlineValue TIME invalid rejected', !parseOnlineValue('T#invalid', 'TIME').ok)
    check('parseOnlineValue STRING valid & max length enforced', parseOnlineValue('Motor OK', 'STRING').ok && !parseOnlineValue('x'.repeat(255), 'STRING').ok)
    check('getOnlineValuePlaceholder returns hint for TIME', getOnlineValuePlaceholder('TIME').includes('T#'))

    // 7. Static source audit: 0 prompt() calls in src/renderer & 0 legacy SCL-JSON extensions in src/
    const rendererFiles = await listFilesRecursive(path.join(process.cwd(), 'src', 'renderer'))
    const promptHits: string[] = []
    for (const file of rendererFiles) {
      if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue
      const text = await fs.readFile(file, 'utf-8')
      if (/\b(?:window\.)?prompt\s*\(/.test(text)) {
        promptHits.push(path.relative(process.cwd(), file))
      }
    }
    check('Zero window.prompt() or bare prompt() calls remain in src/renderer', promptHits.length === 0, promptHits)

    const allSrcFiles = await listFilesRecursive(path.join(process.cwd(), 'src'))
    const sclJsonNeedle = '.scl' + '.json'
    const sclJsonHits: string[] = []
    for (const file of allSrcFiles) {
      if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue
      const text = await fs.readFile(file, 'utf-8')
      if (text.includes(sclJsonNeedle)) {
        sclJsonHits.push(path.relative(process.cwd(), file))
      }
    }
    check('Zero legacy .scl json extension references remain in src/', sclJsonHits.length === 0, sclJsonHits)
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }

  console.log(`\nPHASE 26 SUMMARY: ${passed} PASSED, ${failed} FAILED`)
  process.exit(failed > 0 ? 1 : 0)
}

run()

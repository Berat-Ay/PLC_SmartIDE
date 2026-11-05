// TIA export and import: file text, ordering, round trips and the bridge source.
// These tests compare against hand-written expectations, not against real TIA output. Real compile results come
// from tools/tia-bridge. Replace the fixtures in this file with real exports once they exist.
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { FileEngine } from '../main/fileEngine'
import { bundleFolderName, readImportFolder, writeBundleFiles } from '../main/tiaFiles'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { ProjectCompilerEngine } from '../renderer/src/services/compiler/ProjectCompilerEngine'
import { emptyInterface } from '../shared/scl/sourceBlock'
import { buildTiaBundle, TiaBundle } from '../shared/tia/bundle'
import { mergeTiaImport } from '../shared/tia/merge'
import { readTagTableXml, readTiaFolder } from '../shared/tia/readers'
import { qualifySclBody } from '../shared/tia/sclQualify'
import { tiaTypeName, writeDataBlock, writeTagTableXml, writeUdt } from '../shared/tia/writers'
import { LadBlockDefinition, SclBlockDefinition } from '../shared/types/blocks'
import { ProjectLoadPayload } from '../shared/types/ipc'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function file(bundle: TiaBundle, name: string): string {
  const found = bundle.files.find((f) => f.filename === name)
  if (!found) throw new Error(`${name} is not in the bundle`)
  return found.content
}

const toImportFiles = (bundle: TiaBundle) =>
  bundle.files.map((f) => ({ path: (f.folder ? `${f.folder}/` : '') + f.filename, content: f.content }))

function sclBlock(name: string, blockType: 'OB' | 'FB' | 'FC', blockNumber: number, code: string): SclBlockDefinition {
  return { name, blockType, blockNumber, fileName: `${name}.scl`, optimizedAccess: true, interface: emptyInterface(), code }
}

async function main(): Promise<void> {
  console.log('=== PHASE 15: TIA EXPORT AND IMPORT ===\n')

  // --- Type names -----------------------------------------------------------
  check('Elementary types use TIA spelling', tiaTypeName('DINT') === 'DInt' && tiaTypeName('bool') === 'Bool')
  check('A UDT name gets quotes', tiaTypeName('UDT_Pump') === '"UDT_Pump"')
  check('A quoted name stays', tiaTypeName('"UDT_Pump"') === '"UDT_Pump"')
  check('Arrays keep bounds and inner type', tiaTypeName('ARRAY [0 .. 4] OF REAL') === 'Array[0..4] of Real', tiaTypeName('ARRAY [0 .. 4] OF REAL'))
  check('Array of UDT', tiaTypeName('Array[1..2] of UDT_Pump') === 'Array[1..2] of "UDT_Pump"')
  check('Strings keep their length', tiaTypeName('STRING[20]') === 'String[20]')
  check('Bare timers become IEC types', tiaTypeName('TON') === 'TON_TIME' && tiaTypeName('CTU') === 'CTU_INT')

  // --- Qualifying SCL statements ---------------------------------------------
  const iface = { ...emptyInterface(), input: [{ id: 'a', name: 'Speed', dataType: 'Int', retain: false, accessibleFromHMI: false }] }
  const globals = { globals: new Set(['motor', 'db1', 'fc_scale']) }
  const q = (body: string): string => qualifySclBody(body, iface, 'Blk', globals)
  check('Local gets #', q('Speed := 1;') === '#Speed := 1;', q('Speed := 1;'))
  check('Global gets quotes', q('Motor := TRUE;') === '"Motor" := TRUE;')
  check('Already explicit names stay', q('#Speed := "Motor";') === '#Speed := "Motor";')
  check('Keywords stay', q('IF Speed > 1 THEN Motor := NOT Motor; END_IF;') === 'IF #Speed > 1 THEN "Motor" := NOT "Motor"; END_IF;')
  check('Comments stay', q('// Speed\n(* Motor *) Motor := 1;') === '// Speed\n(* Motor *) "Motor" := 1;')
  check('Strings stay', q("x := 'Speed';") === "x := 'Speed';")
  check('Member after a dot stays', q('DB1.Speed := Speed;') === '"DB1".Speed := #Speed;')
  check('Call parameter names stay', q('FC_Scale(Speed := Speed);') === '"FC_Scale"(Speed := #Speed);')
  check('Output parameter names stay', q('FC_Scale(Speed => Speed);') === '"FC_Scale"(Speed => #Speed);')
  check('Typed literals stay', q('x := T#5s; y := 16#FF; z := INT#3;') === 'x := T#5s; y := 16#FF; z := INT#3;')
  check('Array range and index', q('a[0..1] := Speed;') === 'a[0..1] := #Speed;', q('a[0..1] := Speed;'))
  check('Absolute addresses stay', q('%M0.0 := TRUE;') === '%M0.0 := TRUE;')
  check('Function return target gets quotes', qualifySclBody('Blk := 1;', iface, 'Blk', globals) === '"Blk" := 1;')

  // --- Writers --------------------------------------------------------------
  const udt = writeUdt({
    id: 'u',
    name: 'UDT_A',
    fileName: 'UDT_A.udt.json',
    members: [
      { id: '1', name: 'Run', dataType: 'BOOL', comment: 'Line one\nline two' },
      { id: '2', name: 'Other', dataType: 'UDT_B', defaultValue: '' }
    ]
  }).content
  check('UDT header and footer', udt.startsWith('TYPE "UDT_A"\nVERSION : 0.1\n') && udt.includes('END_STRUCT;') && udt.includes('END_TYPE'))
  check('UDT comment stays on one line', udt.includes('Run : Bool; // Line one line two'), udt)
  check('Nested UDT is quoted', udt.includes('Other : "UDT_B";'))

  const baseDb = { blockType: 'DB' as const, blockNumber: 3, name: 'D', fileName: 'D.db.json', optimizedAccess: true }
  const v = (name: string, retain: boolean) => ({ id: name, name, dataType: 'Int', retain, accessibleFromHMI: true })
  const nonRetained = writeDataBlock({ ...baseDb, dbType: 'Global', variables: [v('a', false)] }).content
  check('DB without retain says NON_RETAIN before VAR', nonRetained.indexOf('NON_RETAIN') > 0 && nonRetained.indexOf('NON_RETAIN') < nonRetained.indexOf('VAR'), nonRetained)
  const mixed = writeDataBlock({ ...baseDb, dbType: 'Global', variables: [v('a', false), v('b', true)] }).content
  check('Optimized DB separates retain sections', mixed.includes('VAR RETAIN') && !mixed.includes('NON_RETAIN'), mixed)
  const standardMixed = writeDataBlock({ ...baseDb, optimizedAccess: false, dbType: 'Global', variables: [v('a', false), v('b', true)] })
  check('Standard DB warns that retain is block-wide', standardMixed.warnings.length === 1 && !standardMixed.content.includes('VAR RETAIN'))
  check('Standard access attribute is written', standardMixed.content.includes("S7_Optimized_Access := 'FALSE'"))
  const instance = writeDataBlock({ ...baseDb, dbType: 'Instance', parentFbName: 'FB_A', variables: [] }).content
  check('Instance DB names its FB', instance.includes('\n"FB_A"\n') && !instance.includes('VAR'), instance)
  const timerDb = writeDataBlock({ ...baseDb, dbType: 'Instance', parentFbName: 'TON', variables: [] }).content
  check('Timer instance DB uses IEC_TIMER', timerDb.includes('\nIEC_TIMER\n'), timerDb)

  const tagXml = writeTagTableXml({
    id: 't',
    name: 'A&B',
    fileName: 'x',
    tags: [
      { id: '1', name: 'Good', dataType: 'BOOL', address: '%I0.0', comment: 'x < y & z' },
      { id: '2', name: 'NoAddress', dataType: 'BOOL', address: '' }
    ]
  })
  check('Tag XML escapes text', tagXml.content.includes('x &lt; y &amp; z') && tagXml.content.includes('<Name>A&amp;B</Name>'))
  check('A tag without address is reported, not written', tagXml.warnings.length === 1 && !tagXml.content.includes('NoAddress'))
  const ids = [...tagXml.content.matchAll(/\bID="([^"]+)"/g)].map((m) => m[1])
  check('XML element IDs are unique', new Set(ids).size === ids.length, ids)
  const tagBack = readTagTableXml(tagXml.content, 'f.xml')
  check('Tag XML reads back', tagBack?.name === 'A&B' && tagBack.tags[0].comment === 'x < y & z' && tagBack.tags[0].address === '%I0.0', tagBack)
  check('Other SimaticML is not taken for a tag table', readTagTableXml('<Document><SW.Blocks.FC /></Document>', 'x.xml') === null)

  // --- The smoke project ----------------------------------------------------
  const smoke = await FileEngine.loadProject('examples/tia_smoke')
  check('Smoke project loads without errors', (smoke.loadErrors || []).length === 0, smoke.loadErrors)
  const compiled = ProjectCompilerEngine.runFullProjectCompilation(smoke.tagTables, smoke.ladBlocks, smoke.sclBlocks, smoke.hardware, smoke.dataBlocks, smoke.udts)
  check('Smoke project passes the IDE compiler', compiled.canDownload && compiled.diagnostics.filter((d) => d.severity === 'Error').length === 0, compiled.diagnostics)

  const bundle = buildTiaBundle(smoke)
  const order = bundle.manifest.steps.map((s) => s.name)
  const before = (a: string, b: string): boolean => order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b)
  check('UDT comes before the DB that uses it', before('UDT_Motor', 'DB1_Plant'), order)
  check('FB comes before its instance DB', before('FB1_Motor', 'DB2_MotorInstance'), order)
  check('Called blocks come before OB1', before('FC1_Scale', 'OB1_Main') && before('DB2_MotorInstance', 'OB1_Main'), order)
  check('Manifest names the CPU', bundle.manifest.cpu?.orderNumber === '6ES7 214-1AG40-0XB0' && bundle.manifest.cpu?.firmware === 'V4.6', bundle.manifest.cpu)
  check('Every manifest step has a file', bundle.manifest.steps.every((s) => bundle.files.some((f) => `sources/${f.filename}` === s.file)))
  check('Every tag table has a file', bundle.manifest.tagTables.every((t) => bundle.files.some((f) => `tags/${f.filename}` === t.file)))
  check('A source file is not an instruction list for LAD', bundle.manifest.skipped.length === 0)
  check('Non-OB1 OB type is flagged', bundle.manifest.warnings.some((w) => w.includes('OB30_Cyclic')), bundle.manifest.warnings)

  const fb = file(bundle, 'FB1_Motor.scl')
  check('FB source has header, attribute and footer', fb.startsWith('FUNCTION_BLOCK "FB1_Motor"\n') && fb.includes("{ S7_Optimized_Access := 'TRUE' }") && fb.trimEnd().endsWith('END_FUNCTION_BLOCK'))
  check('FB source keeps nested indentation', fb.includes('\n     #Latched := TRUE;\n'), fb)
  const fc = file(bundle, 'FC1_Scale.scl')
  check('FC keeps its return type', fc.startsWith('FUNCTION "FC1_Scale" : Real\n'), fc)
  check('The IDE-only interface text is not duplicated', (fb.match(/VAR_INPUT/g) || []).length === 1)

  // Round trip: export, read back, export again gives the same files
  const back = readTiaFolder(toImportFiles(bundle))
  check('Round trip has no warnings', back.warnings.length === 0, back.warnings)
  check('Round trip keeps all blocks', back.sclBlocks.length === 4 && back.dataBlocks.length === 2 && back.udts.length === 1 && back.tagTables.length === 1)
  check('Round trip keeps block numbers', back.sclBlocks.find((b) => b.name === 'OB30_Cyclic')?.blockNumber === 30)
  const plant = back.dataBlocks.find((d) => d.name === 'DB1_Plant')
  check('Round trip keeps a global DB global', plant?.dbType === 'Global' && plant.variables.length === 4, plant)
  check('Round trip keeps retain', plant?.variables.find((x) => x.name === 'TotalStarts')?.retain === true)
  check('Round trip strips UDT quotes for the IDE', plant?.variables.find((x) => x.name === 'Motor1')?.dataType === 'UDT_Motor', plant?.variables)
  const inst = back.dataBlocks.find((d) => d.name === 'DB2_MotorInstance')
  check('Round trip keeps the instance link', inst?.dbType === 'Instance' && inst.parentFbName === 'FB1_Motor', inst)

  const again = buildTiaBundle({ ...smoke, ...back, ladBlocks: [] } as ProjectLoadPayload)
  for (const original of bundle.files.filter((f) => f.type !== 'manifest')) {
    const second = again.files.find((f) => f.filename === original.filename)
    check(`Second export is identical: ${original.filename}`, second?.content === original.content, second?.content)
  }

  // The same program must behave the same way in the simulator after the round trip
  const runMotor = (payload: ProjectLoadPayload): boolean[] => {
    const engine = new PlcRuntimeEngine(payload) as unknown as SimEngine
    let now = 1000
    engine.setClock(() => now)
    engine.start()
    if (engine.intervalHandle) clearInterval(engine.intervalHandle)
    engine.interruptHandles.forEach((h) => clearInterval(h))
    return simulate(engine, (ms) => {
      now += ms
    })
  }
  const originalRun = runMotor(smoke)
  check('Smoke motor starts only after the 500 ms delay', originalRun.join() === 'false,false,true,false', originalRun)
  const roundTripRun = runMotor({ ...smoke, ...back, ladBlocks: [] } as ProjectLoadPayload)
  check('Round-tripped program behaves the same in the simulator', roundTripRun.join() === originalRun.join(), roundTripRun)

  // --- LAD and bundle warnings ----------------------------------------------
  const lad: LadBlockDefinition = {
    blockType: 'OB',
    blockNumber: 1,
    name: 'OB1_Lad',
    fileName: 'OB1_Lad.lad.json',
    optimizedAccess: true,
    interface: emptyInterface(),
    networks: []
  } as unknown as LadBlockDefinition
  const withLad = buildTiaBundle({ ...smoke, ladBlocks: [lad] })
  check('A LAD block is skipped and named', withLad.manifest.skipped.some((s) => s.name === 'OB1_Lad'))
  check('A LAD block produces a warning', withLad.manifest.warnings.some((w) => w.includes('LAD')))
  check('No file is written for a LAD block', !withLad.files.some((f) => f.filename.includes('OB1_Lad')))

  const cycle = buildTiaBundle({
    ...smoke,
    sclBlocks: [sclBlock('A', 'FC', 10, '"B"();'), sclBlock('B', 'FC', 11, '"A"();')],
    dataBlocks: [],
    udts: []
  })
  check('A call cycle still exports both blocks and warns', cycle.manifest.steps.length === 2 && cycle.manifest.warnings.some((w) => w.includes('cycle')), cycle.manifest)

  const unknownCpu = buildTiaBundle({
    ...smoke,
    hardware: { ...smoke.hardware, general: { ...smoke.hardware.general, targetCpu: 'nothing', cpuName: 'nothing' } },
    metadata: { ...smoke.metadata, targetCpu: 'nothing' }
  })
  check('An unknown CPU is reported', unknownCpu.manifest.cpu === null && unknownCpu.manifest.warnings.some((w) => w.includes('CPU')), unknownCpu.manifest.cpu)

  const fragment = buildTiaBundle({
    ...smoke,
    sclBlocks: [{ ...sclBlock('FC9', 'FC', 9, 'Motor_Output := TRUE;'), code: '"Motor_Output" := TRUE;' }]
  })
  const fragmentText = file(fragment, 'FC9.scl')
  check('A fragment without header gets one', fragmentText.startsWith('FUNCTION "FC9" : Void\n') && fragmentText.includes('BEGIN'), fragmentText)

  // --- Reading what TIA writes ----------------------------------------------
  const bomSource = '\uFEFFFUNCTION_BLOCK "FromTia"\r\n{ S7_Optimized_Access := \'TRUE\' }\r\nVERSION : 0.1\r\n   VAR_INPUT \r\n      a : Bool;\r\n   END_VAR\r\n\r\nBEGIN\r\n\t#a := TRUE;\r\nEND_FUNCTION_BLOCK\r\n\r\n'
  const fromTia = readTiaFolder([{ path: 'sources/FromTia.scl', content: bomSource }])
  check('A source with BOM and CRLF reads', fromTia.sclBlocks[0]?.name === 'FromTia' && fromTia.sclBlocks[0].interface.input.length === 1, fromTia)
  check('Code from TIA is stored without BOM or CR', !fromTia.sclBlocks[0]?.code.includes('\r') && !fromTia.sclBlocks[0]?.code.startsWith('\uFEFF'))
  check('A missing number is reported', fromTia.warnings.some((w) => w.includes('no block number')), fromTia.warnings)
  check('A number in the name is used', readTiaFolder([{ path: 'x.scl', content: 'FUNCTION "FC12_X" : Void\nBEGIN\nEND_FUNCTION\n' }]).sclBlocks[0]?.blockNumber === 12)
  check('The main OB keeps number 1', readTiaFolder([{ path: 'x.scl', content: 'ORGANIZATION_BLOCK "Main"\nBEGIN\nEND_ORGANIZATION_BLOCK\n' }]).sclBlocks[0]?.blockNumber === 1)

  const dbWithValues = readTiaFolder([
    {
      path: 'd.db',
      content: 'DATA_BLOCK "DB5_V"\nVERSION : 0.1\nNON_RETAIN\n   VAR\n      a : Int;\n      s : "U";\n   END_VAR\n\nBEGIN\n   a := 7;\n   s.x := 1;\n\nEND_DATA_BLOCK\n'
    }
  ])
  check('A DB start value reads', dbWithValues.dataBlocks[0]?.variables.find((x) => x.name === 'a')?.defaultValue === '7', dbWithValues.dataBlocks)
  check('An unsupported start value is reported', dbWithValues.warnings.some((w) => w.includes('s.x')), dbWithValues.warnings)

  const noHeader = readTiaFolder([{ path: 'x.scl', content: '#a := 1;' }])
  check('A file without header is reported', noHeader.sclBlocks.length === 0 && noHeader.warnings.length === 1)
  const ladXml = readTiaFolder([{ path: 'xml/L.xml', content: '<Document><SW.Blocks.FC><ProgrammingLanguage>LAD</ProgrammingLanguage><FlgNet /></SW.Blocks.FC></Document>' }])
  check('A LAD export is reported, not imported', ladXml.sclBlocks.length === 0 && ladXml.warnings.some((w) => w.includes('LAD')), ladXml)
  const sclXml = readTiaFolder([{ path: 'xml/S.xml', content: '<Document><SW.Blocks.FC><ProgrammingLanguage>SCL</ProgrammingLanguage></SW.Blocks.FC></Document>' }])
  check('The XML twin of a text block is ignored quietly', sclXml.warnings.length === 0, sclXml.warnings)
  check('A broken manifest is reported', readTiaFolder([{ path: 'manifest.json', content: '{' }]).warnings.length === 1)

  // --- Merging into the open project ----------------------------------------
  const empty = { udts: [], dataBlocks: [], ladBlocks: [], sclBlocks: [], tagTables: [] }
  const firstMerge = mergeTiaImport(empty, back)
  check('A first import only adds', firstMerge.added.length === 8 && firstMerge.replaced.length === 0, firstMerge.added)
  const secondMerge = mergeTiaImport(firstMerge.next, back)
  check('A second import only replaces', secondMerge.added.length === 0 && secondMerge.replaced.length === 8, secondMerge)
  check('Replacing does not duplicate', secondMerge.next.sclBlocks.length === 4)
  const renamedFile = { ...firstMerge.next, sclBlocks: firstMerge.next.sclBlocks.map((b) => ({ ...b, fileName: `custom_${b.fileName}` })) }
  const keepFile = mergeTiaImport(renamedFile, back)
  check('Replacing keeps the file name on disk', keepFile.next.sclBlocks.every((b) => b.fileName.startsWith('custom_')))
  check('Merging leaves the input untouched', firstMerge.next.sclBlocks.every((b) => !b.fileName.startsWith('custom_')))
  const ladClash = mergeTiaImport({ ...empty, ladBlocks: [{ ...lad, name: 'OB1_Main' }] }, back)
  check('An import does not overwrite a LAD block', ladClash.next.ladBlocks.length === 1 && !ladClash.next.sclBlocks.some((b) => b.name === 'OB1_Main') && ladClash.skipped.length === 1, ladClash.skipped)
  const numberClash = mergeTiaImport({ ...empty, sclBlocks: [sclBlock('Old', 'FB', 1, '')] }, back)
  check('A block number clash is reported', numberClash.warnings.some((w) => w.includes('FB1')), numberClash.warnings)

  // --- Disk access -----------------------------------------------------------
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'plc-tia-'))
  try {
    check('Bundle folder name is safe', bundleFolderName('A B/../C') === 'A_B_C_TIA', bundleFolderName('A B/../C'))
    const root = path.join(tmp, 'bundle')
    await writeBundleFiles(root, bundle.files)
    check('Bundle files are written', existsSync(path.join(root, 'manifest.json')) && existsSync(path.join(root, 'sources', 'FB1_Motor.scl')))

    const rejects = async (files: { filename: string; folder: string; content: string }[]): Promise<boolean> => {
      try {
        await writeBundleFiles(root, files)
        return false
      } catch {
        return true
      }
    }
    check('A path in a file name is refused', await rejects([{ filename: '../x.scl', folder: 'sources', content: '' }]))
    check('An unknown folder is refused', await rejects([{ filename: 'x.scl', folder: '../..', content: '' }]))
    check('Nothing escaped the bundle folder', !existsSync(path.join(tmp, 'x.scl')))

    const read = await readImportFolder(root)
    check('A bundle folder reads back', readTiaFolder(read.files).sclBlocks.length === 4, read.files.length)

    const result = path.join(tmp, 'result')
    await writeBundleFiles(path.join(result, 'exported'), bundle.files)
    await fs.mkdir(path.join(result, 'tia-project'), { recursive: true })
    await fs.writeFile(path.join(result, 'tia-project', 'junk.xml'), '<x/>')
    await fs.writeFile(path.join(result, 'tia-report.json'), '{}')
    const fromResult = await readImportFolder(result)
    check('A result folder uses its exported part', path.basename(fromResult.folder) === 'exported' && !fromResult.files.some((f) => f.path.includes('junk')), fromResult.folder)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }

  // --- The bridge source ------------------------------------------------------
  const bridgeSource = await fs.readFile('tools/tia-bridge/TiaBridge.cs', 'utf-8')
  check('The bridge has no compile-time Siemens dependency', !/^using Siemens/m.test(bridgeSource))
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (process.platform === 'win32' && existsSync(csc)) {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plc-bridge-'))
    try {
      const exe = path.join(outDir, 'TiaBridge.exe')
      execFileSync('cmd.exe', ['/c', path.resolve('tools/tia-bridge/build.cmd'), exe], { stdio: 'pipe' })
      check('The bridge compiles with the Windows C# compiler', existsSync(exe))
      let exitCode = 0
      try {
        execFileSync(exe, ['nonsense'], { stdio: 'pipe' })
      } catch (err) {
        exitCode = (err as { status: number }).status
      }
      check('The bridge rejects an unknown command', exitCode === 1, exitCode)
    } finally {
      await fs.rm(outDir, { recursive: true, force: true })
    }
  } else {
    console.log('  skip The bridge build: csc.exe is not on this machine')
  }

  console.log(`\nPhase 15: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

interface SimEngine {
  setClock(clock: () => number): void
  start(): void
  runCyclicScan(): void
  intervalHandle: NodeJS.Timeout | null
  interruptHandles: NodeJS.Timeout[]
  memory: {
    writeBit(area: string, byte: number, bit: number, value: boolean): void
    readBit(area: string, byte: number, bit: number): boolean
  }
}

/** Start_Button %I0.0, Stop_Button %I0.1, Motor_Output %Q0.0. Returns the output after each step. */
function simulate(engine: SimEngine, advance: (ms: number) => void): boolean[] {
  const mem = engine.memory
  const scan = (): boolean => {
    engine.runCyclicScan()
    return mem.readBit('Q', 0, 0)
  }
  const out: boolean[] = []
  mem.writeBit('I', 0, 1, true) // NC stop contact
  mem.writeBit('I', 0, 0, true)
  out.push(scan())
  advance(100)
  out.push(scan())
  advance(450)
  out.push(scan())
  mem.writeBit('I', 0, 1, false)
  scan()
  out.push(scan())
  return out
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

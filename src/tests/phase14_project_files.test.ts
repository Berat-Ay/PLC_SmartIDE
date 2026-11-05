// Regression tests for project loading, saving and path safety.
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FileEngine } from '../main/fileEngine'
import { assertPlainFileName, assertProjectRoot, registerProjectRoot, resolveInside } from '../main/pathGuard'
import { emptyInterface } from '../shared/scl/sourceBlock'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { SclBlockDefinition } from '../shared/types/blocks'

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

async function run(): Promise<void> {
  console.log('=== PHASE 14: PROJECT FILES ===\n')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plc-files-'))

  try {
    // Path guard
    check('A relative path stays in the project', resolveInside(root, 'blocks/a.scl') === path.join(root, 'blocks', 'a.scl'))
    check('A leading slash means the project root', resolveInside(root, '/blocks/a.scl') === path.join(root, 'blocks', 'a.scl'))
    check('Parent traversal is rejected', throws(() => resolveInside(root, '../evil.txt')))
    check('Nested traversal is rejected', throws(() => resolveInside(root, 'blocks/../../evil.txt')))
    check('A sibling with the same prefix is rejected', throws(() => resolveInside(root, `../${path.basename(root)}x/a`)))
    check('A path is not a plain file name', throws(() => assertPlainFileName('..\\evil.scl')))
    check('A plain file name is accepted', assertPlainFileName('OB1.scl') === 'OB1.scl')
    check('An unopened folder is rejected', throws(() => assertProjectRoot(path.join(root, 'other'))))
    registerProjectRoot(root)
    check('An opened folder is accepted', !throws(() => assertProjectRoot(root)))

    // Traversal through save
    let rejected = false
    try {
      await FileEngine.saveSingleFile(root, '../escape.txt', 'x')
    } catch {
      rejected = true
    }
    check('saveSingleFile refuses to leave the project', rejected)

    // Fresh project
    const fresh = await FileEngine.loadProject(root)
    check('Missing config gets defaults', !!fresh.hardware.general && fresh.loadErrors?.length === 0)

    // Corrupt required files are not overwritten
    const hwPath = path.join(root, 'hardware', 'cpu_config.json')
    await fs.writeFile(hwPath, '{ broken', 'utf-8')
    let loadFailed = false
    try {
      await FileEngine.loadProject(root)
    } catch {
      loadFailed = true
    }
    check('Corrupt CPU config stops the load', loadFailed)
    check('Corrupt CPU config stays on disk', (await fs.readFile(hwPath, 'utf-8')) === '{ broken')
    await fs.rm(hwPath)

    // One damaged file does not hide the rest
    await fs.writeFile(path.join(root, 'tags', 'bad.tags.json'), 'nope', 'utf-8')
    await fs.writeFile(
      path.join(root, 'tags', 'good.tags.json'),
      JSON.stringify({ id: 'g', name: 'g', tags: [] }),
      'utf-8'
    )
    await fs.writeFile(path.join(root, 'simulation', 'plant.sim.js'), '// scenario', 'utf-8')
    await fs.writeFile(
      path.join(root, 'blocks', 'FB7_Motor.scl'),
      `FUNCTION_BLOCK "Motor"\n{ S7_Optimized_Access := 'FALSE' }\nVAR_INPUT\n  Run : Bool;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n`,
      'utf-8'
    )
    const partial = await FileEngine.loadProject(root)
    check('A damaged tag file is reported', partial.loadErrors?.[0]?.file === 'tags/bad.tags.json', partial.loadErrors)
    check('Other tag files still load', partial.tagTables.length === 1)
    check('Scenario text loads', partial.simulationScripts?.[0]?.code === '// scenario')

    // SCL header is the source of block facts
    const motor = partial.sclBlocks[0]
    check('SCL name comes from the header', motor.name === 'Motor')
    check('SCL type comes from the header', motor.blockType === 'FB')
    check('SCL number comes from the file name', motor.blockNumber === 7)
    check('SCL optimized flag comes from the header', motor.optimizedAccess === false)
    check('SCL interface comes from the header', motor.interface.input[0]?.name === 'Run')

    // A fragment saves as a complete source; no temporary files stay behind
    partial.sclBlocks.push({
      blockType: 'FC',
      blockNumber: 3,
      name: 'FC3',
      fileName: 'FC3.scl',
      optimizedAccess: true,
      interface: emptyInterface(),
      code: '#a := 1;'
    })
    await FileEngine.saveProject(partial)
    const saved = await fs.readFile(path.join(root, 'blocks', 'FC3.scl'), 'utf-8')
    check('A body-only block saves with a header', saved.includes('FUNCTION "FC3"') && saved.includes('#a := 1;'), saved)
    const leftovers = (await fs.readdir(path.join(root, 'blocks'))).filter((f) => f.endsWith('.tmp'))
    check('No temporary files remain', leftovers.length === 0, leftovers)

    let badName = false
    try {
      await FileEngine.saveProject({ ...partial, sclBlocks: [{ ...partial.sclBlocks[0], fileName: '../../evil.scl' }] })
    } catch {
      badName = true
    }
    check('A block file name cannot be a path', badName)

    // Interface table edits reach the source
    const block: SclBlockDefinition = {
      blockType: 'FB',
      blockNumber: 1,
      name: 'FB1',
      fileName: 'FB1.scl',
      optimizedAccess: true,
      interface: emptyInterface(),
      code: `FUNCTION_BLOCK "FB1"\nVAR_INPUT\n  A : Bool;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n`
    }
    const store = useBlockStore.getState()
    store.setBlocks({ udts: [], dataBlocks: [], ladBlocks: [], sclBlocks: [block] })
    check('Store derives the interface from the source', useBlockStore.getState().sclBlocks[0].interface.input[0]?.name === 'A')
    store.addBlockInterfaceVariable('FB1.scl', 'input', { name: 'B', dataType: 'Int' })
    const edited = useBlockStore.getState().sclBlocks[0]
    check('A new interface variable is in the source', /B\s*:\s*Int;/.test(edited.code), edited.code)
    check('The source edit keeps the existing variable', /A\s*:\s*Bool;/i.test(edited.code), edited.code)
    store.updateSclBlock('FB1.scl', { code: edited.code.replace('A : Bool', 'Renamed : Bool') })
    check(
      'A source edit updates the interface',
      useBlockStore.getState().sclBlocks[0].interface.input.some((v) => v.name === 'Renamed')
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  console.log(`\nPHASE 14 SUMMARY: ${passed} PASSED, ${failed} FAILED`)
  process.exit(failed > 0 ? 1 : 0)
}

run()

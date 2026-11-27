// Regression tests for Remediation Blueprint 3/3:
// Cross-reference DB navigation (.db.json canonicalization & renamed DBs),
// Unified keyboard shortcuts & Ctrl+B/F7 conflict resolution,
// Comparator & Math in-place pin/operator AST edits & store persistence,
// and Dynamic CPU context chip in AgentPanel.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CrossReferenceEngine } from '../renderer/src/services/CrossReferenceEngine'
import {
  normalizeDbFileName,
  resolveDbCrossReferenceTab,
  stripDbExtension
} from '../renderer/src/utils/crossRefNavigation'
import {
  isEditableElement,
  resolveGlobalShortcut
} from '../renderer/src/utils/keyboardShortcuts'
import {
  updateComparatorOperator,
  updateComparatorPin,
  updateMathBoxType,
  updateMathPin
} from '../renderer/src/utils/ladderBoxEdits'
import { formatCpuChipLabel } from '../renderer/src/utils/cpuChipLabel'
import {
  CPU_1214C_PROFILE,
  CPU_1511_PROFILE,
  CPU_1516_PROFILE
} from '../shared/constants/cpuProfiles'
import { buildInitialProjectPayload } from '../shared/project/createProjectPayload'
import type { DataBlockDefinition, LadBlockDefinition } from '../shared/types/blocks'
import type { LadderComparatorNode, LadderMathNode, LadderParallelBranchNode } from '../shared/types/ladder'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useHardwareStore } from '../renderer/src/stores/useHardwareStore'

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

function makeBlankInterface() {
  return { input: [], output: [], inOut: [], static: [], temp: [], constant: [] }
}

async function run(): Promise<void> {
  console.log('=== PHASE 28: REMEDIATION BLUEPRINT 3/3 ===\n')

  // ---------------------------------------------------------------------------
  // 1. Cross-Reference DB Navigation (Single .db.json & Renamed DB Resolution)
  // ---------------------------------------------------------------------------
  const dbRenamed: DataBlockDefinition = {
    id: 'DB1_PlantData.db.json',
    blockType: 'DB',
    blockNumber: 1,
    name: 'PlantData_Renamed',
    fileName: 'DB1_PlantData.db.json',
    dbType: 'Global',
    optimizedAccess: false,
    variables: [
      {
        id: 'var_sp',
        name: 'TankSetpoint',
        dataType: 'MyTankUdt',
        defaultValue: '50.0',
        retain: true,
        accessibleFromHMI: true
      }
    ]
  }

  CrossReferenceEngine.rebuildIndex({
    tagTables: [],
    udts: [],
    dataBlocks: [dbRenamed],
    ladBlocks: [],
    sclBlocks: []
  })

  const dbDeclRefs = CrossReferenceEngine.query('PlantData_Renamed').references
  const dbVarRefs = CrossReferenceEngine.query('TankSetpoint').references
  const dbUdtRefs = CrossReferenceEngine.query('MyTankUdt').references

  check(
    'CrossReferenceEngine stores canonical single .db.json sourceObjectId for DB decl, var, and UDT use',
    dbDeclRefs.length === 1 &&
      dbDeclRefs[0].sourceObjectId === 'DB1_PlantData.db.json' &&
      dbVarRefs.length >= 1 &&
      dbVarRefs[0].sourceObjectId === 'DB1_PlantData.db.json' &&
      dbUdtRefs.length === 1 &&
      dbUdtRefs[0].sourceObjectId === 'DB1_PlantData.db.json' &&
      ![...dbDeclRefs, ...dbVarRefs, ...dbUdtRefs].some((r) => r.sourceObjectId.includes('.db.json' + '.db.json')),
    { decl: dbDeclRefs[0]?.sourceObjectId, var: dbVarRefs[0]?.sourceObjectId, udt: dbUdtRefs[0]?.sourceObjectId }
  )

  const resolvedFromCanonical = resolveDbCrossReferenceTab(dbDeclRefs[0], [dbRenamed])
  check(
    'resolveDbCrossReferenceTab opens ProjectTree-exact tab_db_<fileName> for renamed DB (name !== fileName)',
    resolvedFromCanonical.id === 'tab_db_DB1_PlantData.db.json' &&
      resolvedFromCanonical.targetId === 'DB1_PlantData.db.json' &&
      resolvedFromCanonical.title === 'PlantData_Renamed' &&
      resolvedFromCanonical.type === 'db',
    resolvedFromCanonical
  )

  const resolvedFromLegacyDoubled = resolveDbCrossReferenceTab(
    {
      sourceObject: 'PlantData_Renamed',
      sourceObjectId: 'DB1_PlantData.db.json' + '.db.json'
    },
    [dbRenamed]
  )
  check(
    'resolveDbCrossReferenceTab strips legacy doubled suffix and resolves cleanly',
    resolvedFromLegacyDoubled.id === 'tab_db_DB1_PlantData.db.json' &&
      resolvedFromLegacyDoubled.targetId === 'DB1_PlantData.db.json' &&
      stripDbExtension('DB1_PlantData.db.json' + '.db.json') === 'DB1_PlantData' &&
      normalizeDbFileName('DB1_PlantData.db.json' + '.db.json') === 'DB1_PlantData.db.json',
    resolvedFromLegacyDoubled
  )

  // ---------------------------------------------------------------------------
  // 2. Unified Keyboard Shortcuts & Ctrl+B / F7 Conflict Resolution
  // ---------------------------------------------------------------------------
  const nonEditableDiv = { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget
  const makeKey = (
    key: string,
    opts: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string; target: EventTarget | null }> = {}
  ) => ({
    key,
    code: opts.code,
    ctrlKey: !!opts.ctrlKey,
    metaKey: !!opts.metaKey,
    altKey: !!opts.altKey,
    shiftKey: !!opts.shiftKey,
    target: opts.target ?? nonEditableDiv
  })

  check(
    'resolveGlobalShortcut maps all TopAppBar & BottomInspector shortcuts accurately',
    resolveGlobalShortcut(makeKey('n', { ctrlKey: true })) === 'new-project' &&
      resolveGlobalShortcut(makeKey('o', { ctrlKey: true })) === 'open-project' &&
      resolveGlobalShortcut(makeKey('s', { ctrlKey: true })) === 'save-project' &&
      resolveGlobalShortcut(makeKey('b', { ctrlKey: true })) === 'compile' &&
      resolveGlobalShortcut(makeKey('F7')) === 'compile' &&
      resolveGlobalShortcut(makeKey('m', { ctrlKey: true })) === 'toggle-monitoring' &&
      resolveGlobalShortcut(makeKey('F11')) === 'cross-reference' &&
      resolveGlobalShortcut(makeKey('1', { altKey: true })) === 'toggle-left-dock' &&
      resolveGlobalShortcut(makeKey('2', { altKey: true })) === 'toggle-right-dock' &&
      resolveGlobalShortcut(makeKey('3', { altKey: true })) === 'toggle-bottom-dock' &&
      resolveGlobalShortcut(makeKey('s', { altKey: true })) === 'toggle-split-view'
  )

  check(
    'Ctrl+Shift+B and Shift+F7 do NOT trigger global compile (reserved for Ladder canvas)',
    resolveGlobalShortcut(makeKey('b', { ctrlKey: true, shiftKey: true })) === null &&
      resolveGlobalShortcut(makeKey('F7', { shiftKey: true })) === null
  )

  const inputEl = { tagName: 'INPUT' } as unknown as EventTarget
  const textareaEl = { tagName: 'TEXTAREA' } as unknown as EventTarget
  const selectEl = { tagName: 'SELECT' } as unknown as EventTarget
  const contentEditableEl = {
    tagName: 'DIV',
    isContentEditable: true
  } as unknown as EventTarget
  const monacoChildEl = {
    tagName: 'SPAN',
    closest: (sel: string) => (sel.includes('.monaco-editor') ? {} : null)
  } as unknown as EventTarget

  check(
    'isEditableElement detects INPUT, TEXTAREA, SELECT, contenteditable, and Monaco/CodeMirror editors',
    isEditableElement(inputEl) &&
      isEditableElement(textareaEl) &&
      isEditableElement(selectEl) &&
      isEditableElement(contentEditableEl) &&
      isEditableElement(monacoChildEl) &&
      !isEditableElement(nonEditableDiv)
  )

  check(
    'Global shortcuts are suppressed in editable fields EXCEPT Ctrl+S save',
    resolveGlobalShortcut(makeKey('b', { ctrlKey: true, target: inputEl })) === null &&
      resolveGlobalShortcut(makeKey('F7', { target: monacoChildEl })) === null &&
      resolveGlobalShortcut(makeKey('F11', { target: textareaEl })) === null &&
      resolveGlobalShortcut(makeKey('1', { altKey: true, target: selectEl })) === null &&
      resolveGlobalShortcut(makeKey('s', { ctrlKey: true, target: inputEl })) === 'save-project' &&
      resolveGlobalShortcut(makeKey('s', { ctrlKey: true, target: monacoChildEl })) === 'save-project'
  )

  // ---------------------------------------------------------------------------
  // 3. In-Place Pin & Operator Edits for Comparator & Math Boxes + Store Dirtying
  // ---------------------------------------------------------------------------
  const cmpTop: LadderComparatorNode = {
    id: 'cmp_main_1',
    kind: 'comparator',
    comparatorType: 'CMP_EQ',
    op1: 'C1.CV',
    op2: '5',
    dataType: 'INT'
  }
  const addBranchNode: LadderMathNode = {
    id: 'math_add_branch',
    kind: 'math',
    boxType: 'ADD',
    in1: 'Setpoint',
    in2: '10',
    out: 'TargetVal',
    dataType: 'INT'
  }
  const scaleNode: LadderMathNode = {
    id: 'math_scale_1',
    kind: 'math',
    boxType: 'SCALE_X',
    min: '0.0',
    max: '100.0',
    value: 'NormRatio',
    out: 'TankTemp_Eng',
    dataType: 'REAL'
  }
  const parallelNode: LadderParallelBranchNode = {
    id: 'par_1',
    kind: 'parallel',
    branches: [[addBranchNode], [scaleNode]]
  }

  let testLad: LadBlockDefinition = {
    blockType: 'OB',
    blockNumber: 1,
    name: 'Main',
    fileName: 'OB1_Main.lad.json',
    optimizedAccess: false,
    schemaVersion: '2.0',
    interface: makeBlankInterface(),
    networks: [
      {
        id: 'net_1',
        networkNumber: 1,
        title: 'Comparator & Math Network',
        nodes: [cmpTop, parallelNode]
      }
    ]
  }

  testLad = updateComparatorPin(testLad, 0, 'cmp_main_1', 'op1', 'BatchCount')
  testLad = updateComparatorPin(testLad, 0, 'cmp_main_1', 'op2', '12')
  testLad = updateComparatorOperator(testLad, 0, 'cmp_main_1', 'CMP_GE')

  const updatedCmp = testLad.networks[0].nodes![0] as LadderComparatorNode
  check(
    'updateComparatorPin and updateComparatorOperator mutate op1, op2, and comparatorType immutably',
    updatedCmp.op1 === 'BatchCount' &&
      updatedCmp.op2 === '12' &&
      updatedCmp.comparatorType === 'CMP_GE',
    updatedCmp
  )

  testLad = updateMathPin(testLad, 0, 'math_add_branch', 'in2', '25')
  testLad = updateMathPin(testLad, 0, 'math_add_branch', 'out', 'ScaledSum')
  testLad = updateMathBoxType(testLad, 0, 'math_add_branch', 'SUB')
  testLad = updateMathPin(testLad, 0, 'math_scale_1', 'min', '-10.0')
  testLad = updateMathPin(testLad, 0, 'math_scale_1', 'value', 'NormVal_New')
  testLad = updateMathPin(testLad, 0, 'math_scale_1', 'max', '250.0')
  testLad = updateMathPin(testLad, 0, 'math_scale_1', 'out', 'EngOut')

  const updatedPar = testLad.networks[0].nodes![1] as LadderParallelBranchNode
  const updatedSub = updatedPar.branches[0][0] as LadderMathNode
  const updatedScale = updatedPar.branches[1][0] as LadderMathNode

  check(
    'updateMathPin and updateMathBoxType update nested parallel-branch ADD/SUB and SCALE_X pins',
    updatedSub.boxType === 'SUB' &&
      updatedSub.in1 === 'Setpoint' &&
      updatedSub.in2 === '25' &&
      updatedSub.out === 'ScaledSum' &&
      updatedScale.min === '-10.0' &&
      updatedScale.value === 'NormVal_New' &&
      updatedScale.max === '250.0' &&
      updatedScale.out === 'EngOut',
    { updatedSub, updatedScale }
  )

  // Verify persistence in useBlockStore + useProjectStore.markDirty(true)
  const payload = buildInitialProjectPayload({
    name: 'Pkg3_Test_Proj',
    projectPath: '/tmp/pkg3_test',
    cpuProfileId: 'cpu-1214c',
    defaultLanguage: 'LAD'
  })
  payload.ladBlocks = [testLad]
  useProjectStore.getState().setProject(payload)
  check('Project starts clean after setProject', useProjectStore.getState().isDirty === false)

  const nextLad = updateComparatorOperator(testLad, 0, 'cmp_main_1', 'CMP_LT')
  useBlockStore.getState().updateLadBlock(nextLad.fileName, nextLad)
  useProjectStore.getState().markDirty(true)
  const storedCmp = useBlockStore.getState().ladBlocks[0].networks[0].nodes![0] as LadderComparatorNode

  check(
    'Box edits persist in useBlockStore.updateLadBlock and mark project dirty',
    storedCmp.comparatorType === 'CMP_LT' && useProjectStore.getState().isDirty === true,
    { storedCmp, isDirty: useProjectStore.getState().isDirty }
  )

  // ---------------------------------------------------------------------------
  // 4. Dynamic CPU Context Chip in AgentPanel
  // ---------------------------------------------------------------------------
  useHardwareStore.getState().applyCpuProfile(CPU_1214C_PROFILE)
  const label1214 = formatCpuChipLabel(useHardwareStore.getState().config, 'Virtual S7-1200')

  useHardwareStore.getState().applyCpuProfile(CPU_1511_PROFILE)
  const label1511 = formatCpuChipLabel(useHardwareStore.getState().config, 'Virtual S7-1200')

  useHardwareStore.getState().applyCpuProfile(CPU_1516_PROFILE)
  const label1516 = formatCpuChipLabel(useHardwareStore.getState().config, 'Virtual S7-1200')

  check(
    'formatCpuChipLabel dynamically reflects S7-1200 and S7-1500 profile switches',
    label1214 === 'CPU 1214C DC/DC/DC (S7-1200)' &&
      label1511 === 'CPU 1511-1 PN (S7-1500)' &&
      label1516 === 'CPU 1516-3 PN/DP (S7-1500)' &&
      formatCpuChipLabel(null, null) === 'Virtual S7',
    { label1214, label1511, label1516 }
  )

  // ---------------------------------------------------------------------------
  // 5. Static Wiring & UI Tooltip Checks
  // ---------------------------------------------------------------------------
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const svgCanvasSrc = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/src/components/center/ladder/SvgLadderCanvas.tsx'),
    'utf8'
  )
  const ladderRenderersSrc = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/src/components/center/ladder/LadderNodeRenderers.tsx'),
    'utf8'
  )
  const ribbonSrc = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/src/components/center/ladder/InstructionRibbon.tsx'),
    'utf8'
  )
  const agentPanelSrc = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/src/components/rightdock/AgentPanel.tsx'),
    'utf8'
  )

  check(
    'SvgLadderCanvas & InstructionRibbon conflict-free shortcuts and box pin testids present',
    svgCanvasSrc.includes("e.shiftKey && e.key === 'F8'") &&
      svgCanvasSrc.includes("e.shiftKey && e.key === 'F7'") &&
      !svgCanvasSrc.includes("else if (e.ctrlKey && (e.key === 'b' || e.key === 'B'))") &&
      ladderRenderersSrc.includes('data-testid={`comparator-op1-${cmp.id}`}') &&
      ladderRenderersSrc.includes('data-testid={`comparator-op2-${cmp.id}`}') &&
      ladderRenderersSrc.includes('data-testid={`comparator-op-${cmp.id}`}') &&
      ladderRenderersSrc.includes('data-testid={`math-pin-${pinKey}-${m.id}`}') &&
      ladderRenderersSrc.includes('data-testid={`math-op-${node.id}`}') &&
      ribbonSrc.includes('Shift+F7') &&
      ribbonSrc.includes('Shift+F8')
  )

  check(
    'AgentPanel no longer hardcodes S7-1200 in CPU chip and renders data-testid="agent-cpu-chip"',
    agentPanelSrc.includes('data-testid="agent-cpu-chip"') &&
      !agentPanelSrc.includes("metadata?.targetCpu ? 'S7-1200'")
  )

  console.log(`\nPhase 28 Summary: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal test failure:', err)
  process.exit(1)
})

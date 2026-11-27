import assert from 'node:assert/strict'
import type { LadNetwork } from '../shared/types/blocks'
import type { LadderContactNode, LadderCounterNode, LadderParallelBranchNode, LadderTimerNode } from '../shared/types/ladder'
import { generateId } from '../renderer/src/utils/id'
import { makeTabId } from '../renderer/src/utils/tabIds'
import { parseInlineMarkdownTokens } from '../renderer/src/utils/inlineMarkdown'
import { buildTraceCsv, escapeCsvCell } from '../renderer/src/utils/csv'
import {
  addParallelBranchTier,
  clearNetworkAt,
  countOperandReferences,
  createInstructionNode,
  deleteNetworkAt,
  deleteNodeById,
  deleteParallelBranchLeg,
  getInstructionBoxDimensions,
  getNodeRenderWidth,
  insertNetworkAt,
  insertNodeAtZone,
  insertNodeInNetwork,
  moveNetwork,
  moveNodeToZone,
  updateNodeById,
  wrapNodeInParallelBranch
} from '../renderer/src/components/center/ladder/ladderAstOps'
import { SnapshotHistory } from '../renderer/src/runtime/engine/SnapshotHistory'
import { SymbolForceTable } from '../renderer/src/runtime/engine/SymbolForceTable'
import { S7BinaryMemory } from '../renderer/src/runtime/S7BinaryMemory'
import { PlcRuntimeEngine } from '../renderer/src/runtime/PlcRuntimeEngine'
import { DemoProjectSeeder } from '../renderer/src/services/DemoProjectSeeder'
import { useProjectStore } from '../renderer/src/stores/useProjectStore'
import { useTagStore } from '../renderer/src/stores/useTagStore'
import { useBlockStore } from '../renderer/src/stores/useBlockStore'
import { useCrossRefStore } from '../renderer/src/stores/useCrossRefStore'
import { flushProjectCoordinator } from '../renderer/src/stores/projectCoordinator'

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed++
  console.log(`✅ PASS: ${name}`)
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj)
    for (const val of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(val)
    }
  }
  return obj
}

console.log('=== PHASE 35: ARCHITECTURE, UI & PERF REGRESSION TESTS ===\n')

test('generateId produces 1,000 unique IDs without collisions', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    seen.add(generateId('node'))
  }
  assert.equal(seen.size, 1000)
})

test('makeTabId produces canonical IDs across all tab types', () => {
  assert.equal(makeTabId('hardware'), 'tab_hardware_config')
  assert.equal(makeTabId('allTags'), 'tab_all_tags')
  assert.equal(makeTabId('simulation'), 'tab_simulation')
  assert.equal(makeTabId('trace'), 'tab_trace')
  assert.equal(makeTabId('tagTable', 't1'), 'tab_tags_t1')
  assert.equal(makeTabId('db', 'DB1.db.json'), 'tab_db_DB1.db.json')
  assert.equal(makeTabId('udt', 'u1'), 'tab_udt_u1')
  assert.equal(makeTabId('lad', 'OB1.lad.json'), 'tab_lad_OB1.lad.json')
  assert.equal(makeTabId('scl', 'FB1.scl'), 'tab_scl_FB1.scl')
})

test('createInstructionNode creates proper TONR (with rOperand) and CTUD (with cdOperand/rLdOperand)', () => {
  const tonr = createInstructionNode('timer', 'TONR') as LadderTimerNode
  assert.equal(tonr.kind, 'timer')
  assert.equal(tonr.timerType, 'TONR')
  assert.ok(tonr.instanceDb.startsWith('DB_TONR_'))
  assert.equal(tonr.rOperand, '???')

  const tof = createInstructionNode('timer', 'TOF') as LadderTimerNode
  assert.ok(tof.instanceDb.startsWith('DB_TOF_'))

  const ctud = createInstructionNode('counter', 'CTUD') as LadderCounterNode
  assert.equal(ctud.counterType, 'CTUD')
  assert.ok(ctud.instanceDb.startsWith('DB_CTUD_'))
  assert.equal(ctud.cdOperand, '???')
  assert.equal(ctud.rLdOperand, '???')

  assert.equal(getInstructionBoxDimensions(tonr).height, 90)
  assert.equal(getNodeRenderWidth(tonr), getInstructionBoxDimensions(tonr).width + 30)
})

test('ladderAstOps never mutates frozen input AST across insert, move, branch, wrap, reorder & delete', () => {
  const frozenNetworks: LadNetwork[] = deepFreeze([
    {
      id: 'net1',
      networkNumber: 1,
      title: 'Rung 1',
      nodes: [
        { id: 'c1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'StartBtn' },
        {
          id: 'parallel_legacy_1',
          kind: 'parallel',
          branches: [
            [{ id: 'b0', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Auto' }],
            [{ id: 'b1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Manual' }],
            [{ id: 'b2', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Maint' }]
          ]
        },
        { id: 'q1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Motor' }
      ]
    },
    {
      id: 'net2',
      networkNumber: 2,
      title: 'Rung 2',
      nodes: [{ id: 'c2', kind: 'contact', contactType: 'NO_CONTACT', operand: 'StartBtn' }]
    }
  ]) as LadNetwork[]

  // Insert into 3rd tier (index 2) without mutating frozen arrays
  const c3 = createInstructionNode('contact', 'NC_CONTACT') as LadderContactNode
  const afterInsert = insertNodeInNetwork(frozenNetworks, c3, {
    selectedNodeId: 'b2',
    selectedNetworkNumber: 1,
    selectedBranchTarget: null
  })
  const leg2 = (afterInsert.networks[0].nodes[1] as LadderParallelBranchNode).branches[2]
  assert.equal(leg2.length, 2)
  assert.equal(leg2[1].id, c3.id)

  // Add tier, update, wrap, move node, delete leg, clear/move/delete networks
  const tiered = addParallelBranchTier(frozenNetworks, 'parallel_legacy_1')
  assert.equal(tiered.newTierIndex, 3)
  assert.equal((tiered.networks[0].nodes[1] as LadderParallelBranchNode).branches.length, 4)

  const moved = moveNodeToZone(frozenNetworks, 'c2', { netIdx: 0, insertIndex: 1 })
  assert.equal(moved.movedNode?.id, 'c2')
  assert.equal(moved.networks[0].nodes[1].id, 'c2')
  assert.equal(moved.networks[1].nodes.length, 0)

  const wrapped = wrapNodeInParallelBranch(frozenNetworks, 'c2')
  assert.equal(wrapped[1].nodes[0].kind, 'parallel')

  const updated = updateNodeById(frozenNetworks, 'q1', (n) =>
    n.kind === 'coil' ? { ...n, operand: 'Conveyor' } : n
  )
  assert.equal((updated[0].nodes[2] as { operand: string }).operand, 'Conveyor')

  const deleted = deleteNodeById(frozenNetworks, 'b2')
  assert.equal((deleted[0].nodes[1] as LadderParallelBranchNode).branches[2].length, 0)

  const healed = deleteParallelBranchLeg(frozenNetworks, 'parallel_legacy_1', 2)
  assert.equal((healed[0].nodes[1] as LadderParallelBranchNode).branches.length, 2)

  const insertedAt = insertNodeAtZone(frozenNetworks, createInstructionNode('contact'), { netIdx: 1, insertIndex: 0 })
  assert.equal(insertedAt.networks[1].nodes.length, 2)

  const netMoved = moveNetwork(frozenNetworks, 1, 0)
  assert.ok(netMoved)
  assert.equal(netMoved.networks[0].id, 'net2')
  assert.equal(netMoved.networks[0].networkNumber, 1)
  assert.equal(netMoved.networks[1].networkNumber, 2)

  const netAdded = insertNetworkAt(frozenNetworks, 1, false)
  assert.equal(netAdded.networks.length, 3)
  assert.equal(netAdded.networks[2].networkNumber, 3)

  const netCleared = clearNetworkAt(frozenNetworks, 0)
  assert.equal(netCleared[0].nodes.length, 0)

  const netDeleted = deleteNetworkAt(frozenNetworks, 0)
  assert.equal(netDeleted.networks.length, 1)
  assert.equal(netDeleted.networks[0].networkNumber, 1)

  assert.equal(countOperandReferences(frozenNetworks, 'StartBtn', 'c1'), 1)
  assert.equal(countOperandReferences(frozenNetworks, 'Auto', 'b0'), 0)
})

test('projectCoordinator flushes cross-references and overlaps without store import cycles', () => {
  const demo = DemoProjectSeeder.createDemoProject()
  useProjectStore.getState().setProject(demo)
  const tblId = useTagStore.getState().tagTables[0].id
  useTagStore.getState().addTag(tblId, { name: 'Phase35_Sensor', address: '%I3.0', dataType: 'BOOL' })
  useBlockStore.getState().updateLadBlock(demo.ladBlocks[0].fileName, {
    ...demo.ladBlocks[0],
    networks: [
      ...demo.ladBlocks[0].networks,
      {
        id: 'p35_net',
        networkNumber: demo.ladBlocks[0].networks.length + 1,
        title: 'Phase35 CrossRef Check',
        nodes: [{ id: 'p35_c', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Phase35_Sensor' }]
      }
    ]
  })
  flushProjectCoordinator(false)
  useCrossRefStore.getState().setQuery('Phase35_Sensor')
  const q = useCrossRefStore.getState().queryResult
  assert.ok(q && q.references.length >= 2)
  useProjectStore.getState().closeProject()
})

test('SnapshotHistory & SymbolForceTable work accurately as standalone extracted runtime subsystems', () => {
  const hist = new SnapshotHistory(3)
  for (let c = 1; c <= 5; c++) {
    hist.push({
      cycleNumber: c,
      timestamp: c * 10,
      triggeringOb: 1,
      cycleDurationMs: 1,
      pii: new Uint8Array([c]),
      piq: new Uint8Array(1),
      merker: new Uint8Array(1),
      dataBlocks: {},
      ladPowerState: {},
      sclLineValues: {}
    })
  }
  assert.equal(hist.length, 3)
  assert.deepEqual(
    hist.getAll().map((s) => s.cycleNumber),
    [3, 4, 5]
  )
  assert.deepEqual(
    hist.getSince(3).map((s) => s.cycleNumber),
    [4, 5]
  )
  assert.equal(hist.getAtCycle(4)?.cycleNumber, 4)

  const mem = new S7BinaryMemory()
  const forces = new SymbolForceTable(mem)
  forces.setForce('m0.0', true, true)
  assert.equal(forces.normalizeForceKey('M0.0'), '%M0.0')
  assert.equal(mem.forceOverrides.get('%M0.0'), true)
  forces.clearAll()
  assert.equal(forces.map.size, 0)

  const engine = new PlcRuntimeEngine()
  const tonrRes = engine.memory.updateTonrTimer('T_P35', true, false, 100, 0)
  assert.equal(tonrRes.Q, false)
  assert.equal(engine.memory.updateTonrTimer('T_P35', true, false, 100, 120).Q, true)
})

test('parseInlineMarkdownTokens preserves code-before-bold ordering', () => {
  const tokens = parseInlineMarkdownTokens('Use `TONR` before **EmergencyStop** check.')
  assert.deepEqual(
    tokens.map((t) => `${t.type}:${t.value}`),
    ['text:Use ', 'code:TONR', 'text: before ', 'bold:EmergencyStop', 'text: check.']
  )
})

test('escapeCsvCell and buildTraceCsv escape quotes, commas, %, # and newlines cleanly', () => {
  assert.equal(escapeCsvCell('Motor#1, "Run" %Q0.0'), '"Motor#1, ""Run"" %Q0.0"')
  const csv = buildTraceCsv(['ts', 'Tag#1 (%I0.0)'], [[10, 'Line1\nLine2']])
  assert.equal(csv, 'ts,"Tag#1 (%I0.0)"\n10,"Line1\nLine2"')
})

console.log(`\nPhase 35 Summary: ${passed} passed, 0 failed`)

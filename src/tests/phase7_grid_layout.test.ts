import assert from 'node:assert'
import { LadderGridLayoutEngine } from '../renderer/src/services/layout/LadderGridLayoutEngine'
import { LadNetwork } from '@shared/types/blocks'
import { LadderContactNode, LadderCoilNode, LadderParallelBranchNode } from '@shared/types/ladder'

let passCount = 0
function testPass(name: string) {
  passCount++
  console.log(`PASS: ${name}`)
}

console.log('\n=== RUNNING PHASE 7 2D CELLULAR MATRIX LAYOUT ENGINE TESTS ===\n')

// 1. Empty Network Layout
function testEmptyNetwork() {
  console.log('--- 1. Testing Empty Network Grid Layout ---')

  const net: LadNetwork = {
    networkNumber: 1,
    title: 'Empty Network',
    nodes: []
  }

  const layout = LadderGridLayoutEngine.layoutNetwork(net, 0, 1100)
  assert.strictEqual(layout.maxRow, 0)
  assert.strictEqual(layout.maxCol, 0)
  assert.ok(layout.svgWidth >= 1100)
  assert.ok(layout.svgHeight >= 160)
  assert.strictEqual(layout.wireSegments.length, 1, 'Contains single main horizontal wire')
  assert.strictEqual(layout.dropZones.length, 1, 'Contains single centered drop zone')

  testPass('Empty Network renders clean default wire with 0 clipping')
}

// 2. 8 Contacts in Series + 1 Output Coil (Zero-Collision Auto-Sizing)
function testEightSeriesContactsAndCoil() {
  console.log('\n--- 2. Testing 8 Series Contacts + 1 Coil (Auto-Sizing & Coil Push) ---')

  const nodes: LadderContactNode[] = []
  for (let i = 1; i <= 8; i++) {
    nodes.push({
      id: `contact_${i}`,
      kind: 'contact',
      contactType: 'NO_CONTACT',
      operand: `Sensor_${i}`,
      address: `%I0.${i - 1}`
    })
  }

  const coil: LadderCoilNode = {
    id: 'coil_motor',
    kind: 'coil',
    coilType: 'OUTPUT_COIL',
    operand: 'Motor_Run',
    address: '%Q0.0'
  }

  const net: LadNetwork = {
    networkNumber: 1,
    title: '8 Series Contacts Network',
    nodes: [...nodes, coil]
  }

  const layout = LadderGridLayoutEngine.layoutNetwork(net, 0, 1100)

  // Assert coil was pushed beyond all 8 contacts
  assert.ok(layout.coilCol >= 8, `coilCol is ${layout.coilCol} (must be >= 8)`)
  const lastContact = layout.nodeLayouts.get('contact_8')!
  const coilLayout = layout.nodeLayouts.get('coil_motor')!

  assert.ok(coilLayout.x >= lastContact.exitWireX, 'Coil X is strictly >= last contact exit wire X')
  assert.ok(coilLayout.x - lastContact.exitWireX >= 0, 'Zero contact-coil overlap!')
  assert.ok(layout.svgWidth > 1100, `SVG width expanded to ${layout.svgWidth}px (> 1100px)`)
  assert.ok(layout.rightRailX > coilLayout.exitWireX, 'Right rail terminates cleanly after coil')

  // Verify all 8 contacts have sequential non-overlapping X coordinates
  for (let i = 1; i <= 7; i++) {
    const cA = layout.nodeLayouts.get(`contact_${i}`)!
    const cB = layout.nodeLayouts.get(`contact_${i + 1}`)!
    assert.ok(cB.x >= cA.exitWireX, `Contact ${i + 1} does not overlap Contact ${i}`)
  }

  testPass('8 series contacts cleanly laid out with dynamic width and zero coil collision')
}

// 3. Multi-Tier Parallel Branches (3 Tiers) & Unequal Lengths
function testParallelBranchesUnequalLengths() {
  console.log('\n--- 3. Testing 3-Tier Parallel Branch with Unequal Lengths ---')

  // Leg 0: 1 contact
  const leg0: LadderContactNode[] = [
    { id: 'c_leg0', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Start_A', address: '%I0.0' }
  ]

  // Leg 1: 3 contacts in series
  const leg1: LadderContactNode[] = [
    { id: 'c_leg1_1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Aux_1', address: '%M0.0' },
    { id: 'c_leg1_2', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Aux_2', address: '%M0.1' },
    { id: 'c_leg1_3', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Aux_3', address: '%M0.2' }
  ]

  // Leg 2: 1 contact
  const leg2: LadderContactNode[] = [
    { id: 'c_leg2', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Manual_Ovr', address: '%I0.5' }
  ]

  const parallelNode: LadderParallelBranchNode = {
    id: 'p_branch_1',
    kind: 'parallel',
    branches: [leg0, leg1, leg2]
  }

  const coil: LadderCoilNode = {
    id: 'coil_pump',
    kind: 'coil',
    coilType: 'OUTPUT_COIL',
    operand: 'Pump_Run',
    address: '%Q0.1'
  }

  const net: LadNetwork = {
    networkNumber: 1,
    title: 'Unequal Parallel Branches',
    nodes: [parallelNode, coil]
  }

  const layout = LadderGridLayoutEngine.layoutNetwork(net, 0, 1100)

  // Assert 3 vertical tiers
  assert.strictEqual(layout.maxRow, 2, 'Layout tracks 3 vertical rows (0, 1, 2)')
  assert.ok(layout.forkJoins.length === 1, '1 parallel fork/join structure registered')

  const forkJoin = layout.forkJoins[0]
  assert.ok(forkJoin.forkBottomY > forkJoin.forkTopY, 'Fork line spans vertically downward')
  assert.ok(forkJoin.joinBottomY > forkJoin.joinTopY, 'Join line spans vertically downward')

  // Verify that all 3 legs connect to the exact same joinX
  const wireJoins = layout.wireSegments.filter((w) => w.x2 === forkJoin.joinX)
  assert.ok(wireJoins.length >= 3, `All branch legs route cleanly into joinX=${forkJoin.joinX}`)

  // Height check: bottom row must be well within svgHeight
  assert.ok(layout.svgHeight > forkJoin.forkBottomY + 50, 'SVG height provides ample clearance below bottom tier')

  testPass('3-Tier parallel branches with unequal lengths connect orthogonally without clipping')
}

// 4. Magnetic Drop Zone Nearest Neighbor Lookup
function testMagneticDropZoneLookup() {
  console.log('\n--- 4. Testing Magnetic Drop Zone Nearest Neighbor Lookup ---')

  const net: LadNetwork = {
    networkNumber: 1,
    title: 'Drop Zone Test',
    nodes: [
      { id: 'c1', kind: 'contact', contactType: 'NO_CONTACT', operand: 'Btn1', address: '%I0.0' }
    ]
  }

  const layout = LadderGridLayoutEngine.layoutNetwork(net, 0, 1100)
  assert.ok(layout.dropZones.length >= 2, 'Has at least 2 drop targets (before & after contact)')

  // Search near drop zone 0 (around x=64, y=90)
  const nearest = LadderGridLayoutEngine.findNearestDropTarget(layout.dropZones, 70, 93, 60)
  assert.ok(nearest, 'Found nearest drop zone within 60px snap radius')
  assert.strictEqual(nearest.target.insertIndex, 0, 'Target is insertIndex 0')

  // Search far away (e.g. x=500, y=500)
  const farAway = LadderGridLayoutEngine.findNearestDropTarget(layout.dropZones, 500, 500, 60)
  assert.strictEqual(farAway, null, 'Returns null when cursor is outside snap radius')

  testPass('Magnetic drop zone snapping accurately snaps within 60px proximity')
}

// Execute all test functions
testEmptyNetwork()
testEightSeriesContactsAndCoil()
testParallelBranchesUnequalLengths()
testMagneticDropZoneLookup()

console.log(`\n======================================================`)
console.log(`ALL PHASE 7 GRID LAYOUT UNIT TESTS PASSED: ${passCount}/${passCount}`)
console.log(`======================================================\n`)


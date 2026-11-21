import type { LadBlockDefinition } from '../../../shared/types/blocks'
import type {
  ComparatorType,
  LadderComparatorNode,
  LadderMathNode,
  LadderNode,
  LadderParallelBranchNode,
  LadderSeriesNode
} from '../../../shared/types/ladder'

export type ComparatorPinKey = 'op1' | 'op2'
export type MathPinKey = 'in1' | 'in2' | 'out' | 'min' | 'max' | 'value'
export type ComparatorOperatorType = ComparatorType
export type ArithmeticMathBoxType = 'ADD' | 'SUB' | 'MUL' | 'DIV'

export const COMPARATOR_OPERATOR_OPTIONS: Array<{
  value: ComparatorOperatorType
  symbol: string
  label: string
}> = [
  { value: 'CMP_EQ', symbol: '==', label: '== (Equal)' },
  { value: 'CMP_NE', symbol: '<>', label: '<> (Not Equal)' },
  { value: 'CMP_GT', symbol: '>', label: '> (Greater Than)' },
  { value: 'CMP_LT', symbol: '<', label: '< (Less Than)' },
  { value: 'CMP_GE', symbol: '>=', label: '>= (Greater or Equal)' },
  { value: 'CMP_LE', symbol: '<=', label: '<= (Less or Equal)' }
]

export const ARITHMETIC_MATH_OPTIONS: Array<{
  value: ArithmeticMathBoxType
  label: string
}> = [
  { value: 'ADD', label: 'ADD (+)' },
  { value: 'SUB', label: 'SUB (-)' },
  { value: 'MUL', label: 'MUL (*)' },
  { value: 'DIV', label: 'DIV (/)' }
]

function mapNodesInNetwork(
  nodes: LadderNode[],
  nodeId: string,
  updater: (node: LadderNode) => LadderNode
): LadderNode[] {
  let changed = false
  const nextNodes = nodes.map((node) => {
    if (node.id === nodeId) {
      const updated = updater(node)
      if (updated !== node) changed = true
      return updated
    }
    if (node.kind === 'parallel') {
      const parallelNode = node as LadderParallelBranchNode
      let branchChanged = false
      const nextBranches = parallelNode.branches.map((branch) => {
        const mapped = mapNodesInNetwork(branch || [], nodeId, updater) as LadderSeriesNode[]
        if (mapped !== branch) branchChanged = true
        return mapped
      })
      if (branchChanged) {
        changed = true
        return { ...parallelNode, branches: nextBranches }
      }
    }
    return node
  })
  return changed ? nextNodes : nodes
}

function updateNetworkNode(
  block: LadBlockDefinition,
  netIdx: number,
  nodeId: string,
  updater: (node: LadderNode) => LadderNode
): LadBlockDefinition {
  const targetNet = block.networks[netIdx]
  if (!targetNet || !targetNet.nodes) return block
  const nextNodes = mapNodesInNetwork(targetNet.nodes, nodeId, updater)
  if (nextNodes === targetNet.nodes) return block
  const nextNetworks = [...block.networks]
  nextNetworks[netIdx] = { ...targetNet, nodes: nextNodes }
  return { ...block, networks: nextNetworks }
}

export function updateComparatorPin(
  block: LadBlockDefinition,
  netIdx: number,
  nodeId: string,
  pin: ComparatorPinKey,
  value: string
): LadBlockDefinition {
  const trimmed = value.trim()
  if (!trimmed) return block
  return updateNetworkNode(block, netIdx, nodeId, (node) => {
    if (node.kind !== 'comparator') return node
    const cmp = node as LadderComparatorNode
    return { ...cmp, [pin]: trimmed }
  })
}

export function updateComparatorOperator(
  block: LadBlockDefinition,
  netIdx: number,
  nodeId: string,
  comparatorType: ComparatorOperatorType
): LadBlockDefinition {
  return updateNetworkNode(block, netIdx, nodeId, (node) => {
    if (node.kind !== 'comparator') return node
    const cmp = node as LadderComparatorNode
    return { ...cmp, comparatorType }
  })
}

export function updateMathPin(
  block: LadBlockDefinition,
  netIdx: number,
  nodeId: string,
  pin: MathPinKey,
  value: string
): LadBlockDefinition {
  const trimmed = value.trim()
  if (!trimmed) return block
  return updateNetworkNode(block, netIdx, nodeId, (node) => {
    if (node.kind !== 'math') return node
    const math = node as LadderMathNode
    return { ...math, [pin]: trimmed }
  })
}

export function updateMathBoxType(
  block: LadBlockDefinition,
  netIdx: number,
  nodeId: string,
  boxType: ArithmeticMathBoxType
): LadBlockDefinition {
  return updateNetworkNode(block, netIdx, nodeId, (node) => {
    if (node.kind !== 'math') return node
    const math = node as LadderMathNode
    return { ...math, boxType }
  })
}

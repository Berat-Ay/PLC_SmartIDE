import { LadderNode, LadderParallelBranchNode } from '../types/ladder'

interface NetworkLike {
  id?: string
  nodes?: LadderNode[]
}

function collectNodeIds(nodes: LadderNode[] | undefined, into: Set<string>): void {
  for (const node of nodes || []) {
    if (node.id) into.add(node.id)
    if (node.kind === 'parallel') {
      for (const branch of (node as LadderParallelBranchNode).branches || []) collectNodeIds(branch, into)
    }
  }
}

function freeId(wanted: string, used: Set<string>): string {
  let id = wanted
  for (let n = 2; used.has(id); n++) id = `${wanted}_${n}`
  used.add(id)
  return id
}

/**
 * Returns the networks to add with ids that the block does not have yet, for the networks and for their nodes.
 * A generated circuit numbers its nodes from 1, so a second one repeats the ids of the first. The editor finds a
 * node by its id: with a repeated id, renaming or deleting one contact would change the other one too.
 */
export function withUniqueLadderIds<T extends NetworkLike>(existing: NetworkLike[], incoming: T[]): T[] {
  const usedNodes = new Set<string>()
  const usedNetworks = new Set<string>()
  for (const net of existing) {
    if (net.id) usedNetworks.add(net.id)
    collectNodeIds(net.nodes, usedNodes)
  }

  const renumber = (nodes: LadderNode[]): LadderNode[] =>
    nodes.map((node) => {
      const id = node.id ? freeId(node.id, usedNodes) : node.id
      if (node.kind === 'parallel') {
        const parallel = node as LadderParallelBranchNode
        return { ...parallel, id, branches: (parallel.branches || []).map(renumber) }
      }
      return id === node.id ? node : { ...node, id }
    })

  return incoming.map((net) => ({
    ...net,
    ...(net.id ? { id: freeId(net.id, usedNetworks) } : {}),
    ...(net.nodes ? { nodes: renumber(net.nodes) } : {})
  }))
}

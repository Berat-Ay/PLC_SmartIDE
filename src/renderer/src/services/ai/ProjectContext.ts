/** What the agent reads from the project in the stores: OB1, the tags and the memory the CPU writes itself */

import { useTagStore } from '../../stores/useTagStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { TagDefinition } from '@shared/types/tags'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { DslCompilerOptions } from '../compiler/LadderDslCompiler'
import { AiCircuitSynthesisPayload } from './aiTypes'
import { walkLadderNodes } from './aiClientUtils'

/** Merker bytes the configured CPU writes itself. */
export function reservedMerkerBytes(): number[] {
  const config = useHardwareStore.getState().config
  const bytes: number[] = []
  if (config?.clockMemory?.enabled) bytes.push(config.clockMemory.byteAddress)
  if (config?.systemMemory?.enabled) bytes.push(config.systemMemory.byteAddress)
  return bytes
}

/**
 * Replacing OB1 removes the tags only OB1 used, so their addresses are free for the new program.
 * A tag stays if it is in another table or anything outside OB1 mentions it, at any depth of a network or
 * in SCL source. A false match only keeps a tag, while a missed one would break that block.
 */
export function tagsKeptWhenReplacingOb1(): TagDefinition[] {
  const { tagTables } = useTagStore.getState()
  const blocks = useBlockStore.getState()
  const referencedIdentifiers = new Set<string>()
  const addRef = (raw?: string): void => {
    if (!raw) return
    const cleaned = raw.replace(/"/g, '').trim().toLowerCase()
    if (cleaned) referencedIdentifiers.add(cleaned)
    for (const token of raw.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) {
      referencedIdentifiers.add(token[0].toLowerCase())
    }
    for (const addr of raw.matchAll(/%[IQM][BWD]?\d+(?:\.\d+)?/gi)) {
      referencedIdentifiers.add(addr[0].toLowerCase())
    }
  }

  for (const lad of blocks.ladBlocks) {
    if ((lad.blockType === 'OB' && lad.blockNumber === 1) || lad.name === 'OB1_Main') continue
    for (const net of lad.networks || []) {
      if (net.isSclNetwork && net.sclCode) {
        addRef(net.sclCode)
        continue
      }
      walkLadderNodes(net.nodes, (n) => {
        if (n.kind === 'contact') {
          addRef(n.operand)
          addRef(n.address)
          addRef(n.symbolName)
          addRef(n.edgeTag)
        } else if (n.kind === 'coil') {
          addRef(n.operand)
          addRef(n.address)
          addRef(n.symbolName)
        } else if (n.kind === 'timer') {
          addRef(n.inOperand)
          addRef(n.ptOperand)
          addRef(n.qOperand)
          addRef(n.etOperand)
        } else if (n.kind === 'counter') {
          addRef(n.cuOperand)
          addRef(n.cdOperand)
          addRef(n.cuCdOperand)
          addRef(n.rLdOperand)
          addRef(n.pvOperand)
          addRef(n.qOperand)
          addRef(n.quOperand)
          addRef(n.qdOperand)
          addRef(n.cvOperand)
        } else if (n.kind === 'comparator') {
          addRef(n.op1)
          addRef(n.op2)
        } else if (n.kind === 'math') {
          addRef(n.in1)
          addRef(n.in2)
          addRef(n.out)
          addRef(n.value)
          addRef(n.min)
          addRef(n.max)
        }
      })
    }
  }

  for (const scl of blocks.sclBlocks) {
    addRef(scl.code)
  }

  return tagTables.flatMap((table, index) =>
    table.tags.filter(
      (t) =>
        index > 0 ||
        referencedIdentifiers.has(t.name.trim().toLowerCase()) ||
        (t.address ? referencedIdentifiers.has(t.address.trim().toLowerCase()) : false)
    )
  )
}

export function dslOptions(operationMode: AiCircuitSynthesisPayload['operationMode'] = defaultCircuitMode()): DslCompilerOptions {
  const allTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
  const reserved = reservedMerkerBytes()
  if (operationMode !== 'replace_ob1_networks') return { existingTags: allTags, reservedMerkerBytes: reserved }
  const keptTags = tagsKeptWhenReplacingOb1()
  return { keptTags, releasedTags: allTags.filter((t) => !keptTags.includes(t)), reservedMerkerBytes: reserved }
}

/** The project as it stands in the stores */
export function projectInStores(): ProjectLoadPayload {
  const blocks = useBlockStore.getState()
  const metadata = useProjectStore.getState().metadata
  return {
    projectPath: metadata?.projectPath || '',
    metadata,
    hardware: useHardwareStore.getState().config,
    tagTables: useTagStore.getState().tagTables,
    udts: blocks.udts,
    dataBlocks: blocks.dataBlocks,
    ladBlocks: blocks.ladBlocks,
    sclBlocks: blocks.sclBlocks
  } as ProjectLoadPayload
}

/** Adding is the safe default: replacing is only for an empty OB1 or an explicit request. */
export function defaultCircuitMode(): AiCircuitSynthesisPayload['operationMode'] {
  const ob1 = useBlockStore.getState().ladBlocks.find((b) => (b.blockType === 'OB' && b.blockNumber === 1) || b.name === 'OB1_Main')
  const hasLogic = (ob1?.networks || []).some((n) => (n.nodes || []).length > 0)
  return hasLogic ? 'append_ob1_networks' : 'replace_ob1_networks'
}

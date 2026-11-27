/** Writes a generated circuit into the first tag table and OB1, or stages it for the user's review */

import { makeTabId } from '../../utils/tabIds'
import { PlcAgentTools } from './PlcAgentTools'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useUIStore } from '../../stores/useUIStore'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import { withUniqueLadderIds } from '@shared/utils/ladderNodeIds'
import { AddressMove, AgentExecutionResponse, AiCircuitSynthesisPayload } from './aiTypes'
import {
  hasEmptyNetwork,
  normalizeAiGeneratedNetworks,
  optimizeAndCleanGeneratedAst,
  sanitizeAndAllocateUniqueAddresses
} from './GeneratedCircuit'
import { reservedMerkerBytes, tagsKeptWhenReplacingOb1 } from './ProjectContext'

/**
 * Applies the synthesized circuit payload into Tag Tables, LAD Block (OB1), and opens workspace tab
 */
export function applyCircuitPayload(
  payload: AiCircuitSynthesisPayload,
  mode: 'auto-apply' | 'diff-view',
  options: { trialRun?: boolean; skipSnapshot?: boolean; protectedTagNames?: Set<string> } = {}
): {
  summaryText: string
  stagedChangeset?: Array<{
    path: string
    title: string
    fileType: string
    beforeContent: string
    afterContent: string
  }>
  /** Tags that could not keep the address the model gave */
  addressMoves: AddressMove[]
  /** Normalized, optimized and address-allocated circuit actually applied/staged */
  effectiveCircuit: AiCircuitSynthesisPayload
} {
  const normalizedNetworks = normalizeAiGeneratedNetworks(payload.networks || [])
  if (normalizedNetworks.length === 0 || hasEmptyNetwork(normalizedNetworks)) {
    throw new Error('The model returned an empty network, so the project was not changed.')
  }
  if (mode === 'auto-apply' && !options.trialRun && !options.skipSnapshot) {
    PlcAgentTools.getInstance().captureSnapshot()
  }
  const tablesBefore = structuredClone(useTagStore.getState().tagTables)
  const allLiveTagsBeforeClean = tablesBefore.flatMap((t) => t.tags)
  const effectivePayload = optimizeAndCleanGeneratedAst(
    {
      ...payload,
      networks: normalizedNetworks
    },
    allLiveTagsBeforeClean,
    options.protectedTagNames
  )
  const isReplacing = effectivePayload.operationMode === 'replace_ob1_networks'
  // The new networks may use an existing tag by name without declaring it again, as the DSL may.
  // Such a tag stays, and keeps its address, when OB1 is replaced. Titles and comments are words, not uses of a tag
  const newProgramText = JSON.stringify(effectivePayload.networks || [], (key, value) =>
    key === 'title' || key === 'comment' ? undefined : value
  )
  const namesInNewProgram = new Set((newProgramText.match(/[\p{L}_][\p{L}\p{N}_]*/gu) || []).map((w) => w.toLowerCase()))
  const usedByNewProgram = (name: string): boolean => namesInNewProgram.has(name.toLowerCase())
  const allLiveTags = useTagStore.getState().tagTables.flatMap((t) => t.tags)
  const existingLiveTags = isReplacing ? allLiveTags.filter((t) => usedByNewProgram(t.name)) : allLiveTags
  const sanitized = sanitizeAndAllocateUniqueAddresses(
    effectivePayload.tagsToUpsert || [],
    effectivePayload.networks || [],
    existingLiveTags,
    reservedMerkerBytes()
  )
  effectivePayload.tagsToUpsert = sanitized.tags
  effectivePayload.networks = sanitized.networks
  const tagsCreatedNames: string[] = []

  // 1. Upsert Tags (and prune orphaned tags on replacement) across all tag tables
  try {
    const tagStore = useTagStore.getState()
    const defaultTableId = tagStore.tagTables[0]?.id || 'tbl_default'

    // Prune orphaned tags if completely replacing OB1 networks to prevent collision duplicates (%Q0.0, %I0.0)
    if (effectivePayload.operationMode === 'replace_ob1_networks') {
      const newTagNames = new Set((effectivePayload.tagsToUpsert || []).map((t) => t.name.toLowerCase()))
      const kept = new Set(tagsKeptWhenReplacingOb1())
      const currentTable = tagStore.tagTables.find((t) => t.id === defaultTableId)
      if (currentTable) {
        const tagsToRemove = currentTable.tags.filter(
          (t) => !newTagNames.has(t.name.toLowerCase()) && !kept.has(t) && !usedByNewProgram(t.name)
        )
        for (const t of tagsToRemove) {
          tagStore.deleteTag(defaultTableId, t.id)
        }
      }
    }

    // Track tag name -> (tableId, tagId) across ALL tables so secondary tables update in-place and duplicates dedupe
    const tagLocationMap = new Map<string, { tableId: string; id: string }>()
    for (const table of useTagStore.getState().tagTables) {
      for (const t of table.tags) {
        tagLocationMap.set(t.name.toLowerCase(), { tableId: table.id, id: t.id })
      }
    }

    for (const tag of effectivePayload.tagsToUpsert || []) {
      const normResult = normalizeS7Address(tag.address)
      const normAddr = normResult.isValid ? normResult.address : tag.address
      const existingLoc = tagLocationMap.get(tag.name.toLowerCase())

      if (existingLoc) {
        tagStore.updateTag(existingLoc.tableId, existingLoc.id, {
          address: normAddr,
          dataType: tag.dataType,
          comment: tag.comment || ''
        })
        tagsCreatedNames.push(`${tag.name} (${normAddr}) [Updated]`)
      } else {
        const created = tagStore.addTag(defaultTableId, {
          name: tag.name,
          address: normAddr,
          dataType: tag.dataType,
          comment: tag.comment || ''
        })
        tagLocationMap.set(tag.name.toLowerCase(), { tableId: defaultTableId, id: created.id })
        tagsCreatedNames.push(`${tag.name} (${normAddr})`)
      }
    }
  } catch (err) {
    console.warn('Failed to upsert tags in applyCircuitPayload:', err)
  }

  // 2. Upsert Networks into OB1_Main
  const blockStore = useBlockStore.getState()
  const ladBlocks = blockStore.ladBlocks
  const ob1 = ladBlocks.find((b) => (b.blockType === 'OB' && b.blockNumber === 1) || b.name === 'OB1_Main')

  let stagedChangeset: Array<{
    path: string
    title: string
    fileType: string
    beforeContent: string
    afterContent: string
  }> | undefined = undefined

  // Diff-View changes nothing until it is approved, so tag edits become staged files too
  const stagedTags: NonNullable<AgentExecutionResponse['stagedChangeset']> = []
  if (mode === 'diff-view') {
    const tablesAfter = useTagStore.getState().tagTables
    for (const before of tablesBefore) {
      const after = tablesAfter.find((t) => t.id === before.id)
      if (!after || JSON.stringify(before) === JSON.stringify(after)) continue
      stagedTags.push({
        path: `/tags/${before.fileName || `${before.id}.tags.json`}`,
        title: `Tags: ${before.name}`,
        fileType: 'tag',
        beforeContent: JSON.stringify(before, null, 2),
        afterContent: JSON.stringify(after, null, 2)
      })
    }
    useTagStore.getState().setTagTables(tablesBefore)
  }

  if (ob1) {
    const rawUpdated =
      effectivePayload.operationMode === 'append_ob1_networks'
        ? [...(ob1.networks || []), ...withUniqueLadderIds(ob1.networks || [], effectivePayload.networks || [])]
        : effectivePayload.networks || []

    // Clone before numbering so snapshot/rollback network objects are never mutated in place
    const updatedNetworks = rawUpdated.map((net, idx) => ({
      ...net,
      networkNumber: idx + 1
    }))

    if (mode === 'auto-apply') {
      blockStore.updateLadBlock(ob1.fileName, { networks: updatedNetworks })

      // 3. Auto-navigate to OB1_Main in workspace
      if (!options.trialRun) {
        try {
          const uiStore = useUIStore.getState()
          const existingTab = uiStore.tabs.find(
            (t) => t.title === 'OB1_Main' || t.title === 'OB1' || t.targetId === ob1.fileName
          )
          if (existingTab) {
            uiStore.setActiveTab(existingTab.id)
          } else {
            uiStore.openTab({
              id: makeTabId('lad', ob1.fileName),
              title: 'OB1_Main',
              type: 'lad',
              targetId: ob1.fileName
            })
          }
        } catch {
          // ignore outside react
        }
      }
    } else {
      // Diff-view staging
      stagedChangeset = [
        ...stagedTags,
        {
          path: `/blocks/${ob1.fileName}`,
          title: `OB1_Main (${updatedNetworks.length} Networks)`,
          fileType: 'lad',
          beforeContent: JSON.stringify(ob1, null, 2),
          afterContent: JSON.stringify({ ...ob1, networks: updatedNetworks }, null, 2)
        }
      ]
    }
  } else if (mode === 'diff-view' && stagedTags.length > 0) {
    stagedChangeset = stagedTags
  }

  const summaryText = [
    payload.explanation,
    '',
    `**Synthesized Ladder Logic Summary:**`,
    `- **Tags Configured:** ${tagsCreatedNames.join(', ') || 'None'}`,
    `- **Networks Drawn:** ${effectivePayload.networks?.length || 0} network(s) in OB1_Main`,
    `- **Execution Mode:** ${mode === 'auto-apply' ? '[Auto-Apply] Directly written to canvas' : '[Diff-View] Staged for review'}`
  ].join('\n')

  return {
    summaryText,
    stagedChangeset,
    addressMoves: sanitized.moved,
    effectiveCircuit: effectivePayload
  }
}

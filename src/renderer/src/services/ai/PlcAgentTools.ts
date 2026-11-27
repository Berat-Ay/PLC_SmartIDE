/**
 * Rungline Industrial PLC Agent Tools
 * 10 Executable Industrial Tools with Compiler-in-the-Loop Verification
 * and Diff-View Staging Support.
 */

import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { useSimulationStore } from '../../stores/useSimulationStore'
import { useUIStore } from '../../stores/useUIStore'
import { DoubleCoilDetector } from '../DoubleCoilDetector'
import { ProjectCompilerEngine } from '../compiler/ProjectCompilerEngine'
import { MemoryOverlapEngine } from '../MemoryOverlapEngine'
import {
  DataBlockDefinition,
  SclBlockDefinition,
  BlockVariable
} from '@shared/types/blocks'
import { UdtDefinition, UdtMember } from '@shared/types/types'
import { TagDefinition } from '@shared/types/tags'
import { effectiveInterface, emptyInterface, parseSourceBlock } from '@shared/scl/sourceBlock'
import { normalizeS7Address } from '@shared/utils/s7AddressNormalizer'
import { generateId } from '../../utils/id'
import { makeTabId } from '../../utils/tabIds'
import { READ_ONLY_TOOLS } from './AgentInstruction'
import { CIRCUIT_PATTERNS, findPattern } from './PatternLibrary'

export interface AgentToolCall {
  tool: string
  params: Record<string, unknown>
}

export interface AgentToolResult {
  tool: string
  success: boolean
  message: string
  data?: unknown
}

export interface StagedFileChange {
  path: string
  title: string
  fileType: 'tag' | 'udt' | 'db' | 'lad' | 'scl' | 'hardware' | 'physics'
  beforeContent: string
  afterContent: string
}

export interface ToolBatchExecutionResult {
  results: AgentToolResult[]
  compilerReport?: {
    success: boolean
    message: string
    errors: string[]
    warnings: string[]
  }
  stagedChangeset?: StagedFileChange[]
}

export interface ProjectSnapshot {
  tags: ReturnType<typeof useTagStore.getState>['tagTables']
  udts: ReturnType<typeof useBlockStore.getState>['udts']
  dataBlocks: ReturnType<typeof useBlockStore.getState>['dataBlocks']
  ladBlocks: ReturnType<typeof useBlockStore.getState>['ladBlocks']
  sclBlocks: ReturnType<typeof useBlockStore.getState>['sclBlocks']
}

// These names become file names and S7 identifiers
function isPlainBlockName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

export class PlcAgentTools {
  private static instance: PlcAgentTools | null = null
  private lastSnapshot: ProjectSnapshot | null = null
  // While set, file writes wait here, so a turn that gets undone leaves nothing on disk
  private heldDiskWrites: Array<{ relPath: string; content: string }> | null = null

  private constructor() { }

  public static getInstance(): PlcAgentTools {
    if (!PlcAgentTools.instance) {
      PlcAgentTools.instance = new PlcAgentTools()
    }
    return PlcAgentTools.instance
  }

  /**
   * Safe bi-directional disk sync via electronApi if running in desktop app
   */
  private syncFileToDisk(relPath: string, content: string): void {
    if (this.heldDiskWrites) {
      this.heldDiskWrites.push({ relPath, content })
      return
    }
    try {
      const projectPath = useProjectStore.getState().projectPath
      useProjectStore.getState().noteLocalWrite()
      if (
        projectPath &&
        typeof window !== 'undefined' &&
        (window as unknown as { electronApi?: { saveProjectFile: (p: string, r: string, c: string) => Promise<unknown> } }).electronApi?.saveProjectFile
      ) {
        ;(window as unknown as { electronApi: { saveProjectFile: (p: string, r: string, c: string) => Promise<unknown> } }).electronApi.saveProjectFile(
          projectPath,
          relPath,
          content
        ).catch((err: unknown) => console.warn('Disk sync skipped or failed:', err))
      }
    } catch (err) {
      console.warn('Disk sync skipped or failed:', err)
    }
  }

  public holdDiskWrites(): void {
    this.heldDiskWrites = []
  }

  public releaseDiskWrites(): void {
    const held = this.heldDiskWrites || []
    this.heldDiskWrites = null
    for (const write of held) this.syncFileToDisk(write.relPath, write.content)
  }

  public discardDiskWrites(): void {
    this.heldDiskWrites = null
  }

  public takeSnapshot(): ProjectSnapshot {
    const tagState = useTagStore.getState()
    const blockState = useBlockStore.getState()
    return {
      tags: structuredClone(tagState.tagTables || []),
      udts: structuredClone(blockState.udts || []),
      dataBlocks: structuredClone(blockState.dataBlocks || []),
      ladBlocks: structuredClone(blockState.ladBlocks || []),
      sclBlocks: structuredClone(blockState.sclBlocks || [])
    }
  }

  public restoreSnapshot(snapshot: ProjectSnapshot): void {
    const cloned = structuredClone(snapshot)
    useTagStore.getState().setTagTables(cloned.tags)
    useBlockStore.setState({
      udts: cloned.udts,
      dataBlocks: cloned.dataBlocks,
      ladBlocks: cloned.ladBlocks,
      sclBlocks: cloned.sclBlocks
    })
  }

  /** Sets what Undo Turn goes back to. */
  public setUndoSnapshot(snapshot: ProjectSnapshot): void {
    this.lastSnapshot = snapshot
  }

  /**
   * Capture project snapshot before applying mutations
   */
  public captureSnapshot(): void {
    this.lastSnapshot = this.takeSnapshot()
  }

  /** The project state the model needs in order to change a project instead of guessing at it. */
  public describeProjectForModel(): string {
    const blocks = useBlockStore.getState()
    const ob1 = blocks.ladBlocks.find((b) => b.blockType === 'OB' && b.blockNumber === 1)
    const { digitalIO, analogIO, clockMemory, systemMemory } = useHardwareStore.getState().config
    const range = (channels: Array<{ address: string }>): string =>
      channels.length > 0 ? `${channels[0].address}..${channels[channels.length - 1].address}` : 'none'
    return JSON.stringify({
      targetCpu: useProjectStore.getState().metadata?.targetCpu,
      inputs: range(digitalIO.diChannels),
      outputs: range(digitalIO.dqChannels),
      analogInputs: range(analogIO.aiChannels),
      clockMemory: clockMemory.enabled ? `%MB${clockMemory.byteAddress}` : 'off',
      systemMemory: systemMemory.enabled ? `%MB${systemMemory.byteAddress}` : 'off',
      tags: useTagStore.getState().tagTables.flatMap((t) => t.tags.map((x) => `${x.name} ${x.address} ${x.dataType}`)),
      udts: blocks.udts.map((u) => u.name),
      dataBlocks: blocks.dataBlocks.map((d) => `${d.name} (DB${d.blockNumber})`),
      ladBlocks: blocks.ladBlocks.map((b) => `${b.name} (${b.blockType}${b.blockNumber})`),
      sclBlocks: blocks.sclBlocks.map((b) => `${b.name} (${b.blockType}${b.blockNumber})`),
      ob1Networks: (ob1?.networks || []).map((n) => n.title || `Network ${n.networkNumber}`)
    })
  }

  /** Smallest free number. FB, FC and DB numbers are separate ranges on a real CPU. */
  private nextBlockNumber(kind: 'FB' | 'FC' | 'DB'): number {
    const blocks = useBlockStore.getState()
    const used =
      kind === 'DB'
        ? blocks.dataBlocks.map((b) => b.blockNumber)
        : [...blocks.ladBlocks, ...blocks.sclBlocks].filter((b) => b.blockType === kind).map((b) => b.blockNumber)
    let number = 1
    while (used.includes(number)) number++
    return number
  }

  /**
   * Revert to the last captured snapshot (cloning state, recalculating tag collisions, and syncing snapshot files to disk)
   */
  public revertLastTurn(): AgentToolResult {
    if (!this.lastSnapshot) {
      return { tool: 'revert_last_turn', success: false, message: 'No snapshot available to revert.' }
    }

    const snap = structuredClone(this.lastSnapshot)
    useTagStore.getState().setTagTables(snap.tags)
    useBlockStore.setState({
      udts: snap.udts,
      dataBlocks: snap.dataBlocks,
      ladBlocks: snap.ladBlocks,
      sclBlocks: snap.sclBlocks
    })
    for (const t of snap.tags) {
      this.syncFileToDisk(`/tags/${t.fileName || `${t.id}.tags.json`}`, JSON.stringify(t, null, 2))
    }
    for (const u of snap.udts) {
      this.syncFileToDisk(`/types/${u.fileName}`, JSON.stringify(u, null, 2))
    }
    for (const d of snap.dataBlocks) {
      this.syncFileToDisk(`/blocks/${d.fileName}`, JSON.stringify(d, null, 2))
    }
    for (const l of snap.ladBlocks) {
      this.syncFileToDisk(`/blocks/${l.fileName}`, JSON.stringify(l, null, 2))
    }
    for (const s of snap.sclBlocks) {
      this.syncFileToDisk(`/blocks/${s.fileName}`, s.code)
    }
    this.lastSnapshot = null

    return { tool: 'revert_last_turn', success: true, message: 'Project state reverted to previous turn snapshot.' }
  }

  /**
   * Execute batch of tool calls with optional diff-view staging
   */
  public async executeToolBatch(
    calls: AgentToolCall[],
    mode: 'auto-apply' | 'diff-view',
    options: { skipSnapshot?: boolean } = {}
  ): Promise<ToolBatchExecutionResult> {
    const hasMutatingCall = calls.some((c) => !READ_ONLY_TOOLS.has(c.tool))
    if (mode === 'auto-apply' && !options.skipSnapshot && hasMutatingCall) {
      this.captureSnapshot()
    }
    const results: AgentToolResult[] = []
    const stagedChangeset: StagedFileChange[] = []

    for (const call of calls) {
      try {
        const res = await this.executeSingleTool(call, mode, stagedChangeset)
        results.push(res)
      } catch (err: unknown) {
        results.push({
          tool: call.tool,
          success: false,
          message: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
        })
      }
    }

    // Run Compiler-in-the-Loop check
    const compilerReport = this.runCompilerVerification()

    return {
      results,
      compilerReport,
      stagedChangeset: mode === 'diff-view' ? stagedChangeset : undefined
    }
  }

  /**
   * Apply changes from a staged changeset
   */
  public applyStagedChangeset(changeset: StagedFileChange[]): ToolBatchExecutionResult {
    this.captureSnapshot()
    const uiStore = useUIStore.getState()
    const results: AgentToolResult[] = []
    let appliedCount = 0

    for (const change of changeset) {
      const blockStore = useBlockStore.getState()
      const tagStore = useTagStore.getState()
      try {
        if (change.fileType === 'scl') {
          let sclObj: Partial<SclBlockDefinition> | null = null
          try {
            const maybe = JSON.parse(change.afterContent)
            if (maybe && typeof maybe === 'object' && typeof maybe.code === 'string') {
              sclObj = maybe as Partial<SclBlockDefinition>
            }
          } catch {
            // Raw SCL source text
          }
          if (sclObj?.fileName && sclObj.name) {
            const exists = blockStore.sclBlocks.some((s) => s.fileName === sclObj!.fileName)
            if (exists) blockStore.updateSclBlock(sclObj.fileName, sclObj)
            else blockStore.addSclBlock(sclObj as SclBlockDefinition)
            this.syncFileToDisk(change.path, sclObj.code || change.afterContent)
            uiStore.openTab({
              id: makeTabId('scl', sclObj.fileName),
              title: sclObj.name,
              type: 'scl',
              targetId: sclObj.fileName
            })
          } else {
            const fileName = change.path.replace(/^\/?blocks\//, '')
            const name = change.title.replace(/^SCL:\s*/, '')
            const current = blockStore.sclBlocks.find((b) => b.fileName === fileName || b.name === name)
            if (current) {
              blockStore.updateSclBlock(current.fileName, { code: change.afterContent })
            } else {
              const parsedSrc = parseSourceBlock(change.afterContent)
              const kind = parsedSrc.kind === 'FB' ? 'FB' : 'FC'
              const added: SclBlockDefinition = {
                name,
                fileName,
                blockType: kind,
                blockNumber: this.nextBlockNumber(kind),
                optimizedAccess: parsedSrc.optimizedAccess ?? true,
                interface: emptyInterface(),
                code: change.afterContent
              }
              added.interface = effectiveInterface(added)
              blockStore.addSclBlock(added)
            }
            this.syncFileToDisk(change.path, change.afterContent)
            uiStore.openTab({
              id: makeTabId('scl', fileName),
              title: name,
              type: 'scl',
              targetId: fileName
            })
          }
          appliedCount++
          continue
        }

        const parsed = JSON.parse(change.afterContent)
        if (change.fileType === 'udt') {
          const exists = blockStore.udts.some((u) => u.id === parsed.id || u.name === parsed.name)
          if (exists) {
            const existing = blockStore.udts.find((u) => u.id === parsed.id || u.name === parsed.name)!
            blockStore.updateUdt(existing.id, { ...parsed, id: existing.id })
          } else {
            blockStore.addUdt(parsed)
          }
          this.syncFileToDisk(change.path, change.afterContent)
          uiStore.openTab({
            id: makeTabId('udt', parsed.id),
            title: parsed.name,
            type: 'udt',
            targetId: parsed.id
          })
          appliedCount++
        } else if (change.fileType === 'db') {
          const exists = blockStore.dataBlocks.some((d) => d.fileName === parsed.fileName)
          if (exists) {
            blockStore.updateDataBlock(parsed.fileName, parsed)
          } else {
            blockStore.addDataBlock(parsed)
          }
          this.syncFileToDisk(change.path, change.afterContent)
          uiStore.openTab({
            id: makeTabId('db', parsed.fileName),
            title: parsed.name,
            type: 'db',
            targetId: parsed.fileName
          })
          appliedCount++
        } else if (change.fileType === 'lad') {
          const exists = blockStore.ladBlocks.some((l) => l.fileName === parsed.fileName)
          if (exists) {
            blockStore.updateLadBlock(parsed.fileName, parsed)
          } else {
            blockStore.addLadBlock(parsed)
          }
          this.syncFileToDisk(change.path, change.afterContent)
          uiStore.openTab({
            id: makeTabId('lad', parsed.fileName),
            title: parsed.name,
            type: 'lad',
            targetId: parsed.fileName
          })
          appliedCount++
        } else if (change.fileType === 'tag') {
          if (Array.isArray(parsed)) {
            tagStore.setTagTables(parsed)
          } else if (parsed.id && Array.isArray(parsed.tags)) {
            const exists = tagStore.tagTables.some((t) => t.id === parsed.id)
            tagStore.setTagTables(
              exists ? tagStore.tagTables.map((t) => (t.id === parsed.id ? parsed : t)) : [...tagStore.tagTables, parsed]
            )
          } else {
            results.push({
              tool: 'apply_staged_changeset',
              success: false,
              message: `Invalid staged tag payload for ${change.path}.`
            })
            continue
          }
          this.syncFileToDisk(change.path, change.afterContent)
          appliedCount++
        } else {
          results.push({
            tool: 'apply_staged_changeset',
            success: false,
            message: `Unsupported staged fileType '${change.fileType}' for ${change.path}.`
          })
        }
      } catch (err: unknown) {
        results.push({
          tool: 'apply_staged_changeset',
          success: false,
          message: `Failed to apply staged change '${change.path}': ${err instanceof Error ? err.message : String(err)}`
        })
      }
    }

    const compilerReport = this.runCompilerVerification()
    const hasFailures = results.some((r) => !r.success)
    if (!hasFailures) {
      results.push({
        tool: 'apply_staged_changeset',
        success: true,
        message: `Applied ${appliedCount} staged change(s).`
      })
    }
    return {
      results,
      compilerReport
    }
  }

  /**
   * Dispatcher for single tool execution
   */
  private async executeSingleTool(
    call: AgentToolCall,
    mode: 'auto-apply' | 'diff-view',
    staged: StagedFileChange[]
  ): Promise<AgentToolResult> {
    switch (call.tool) {
      case 'read_project_overview':
        return this.toolReadProjectOverview()

      case 'read_block':
        return this.toolReadBlock(call.params)

      case 'read_pattern':
        return this.toolReadPattern(call.params)

      case 'manage_plc_tags':
        return this.toolManagePlcTags(call.params, mode, staged)

      case 'create_or_update_udt':
        return this.toolCreateOrUpdateUdt(call.params, mode, staged)

      case 'create_or_update_db':
        return this.toolCreateOrUpdateDb(call.params, mode, staged)

      case 'create_or_update_lad_block':
        return this.toolCreateOrUpdateLadBlock(call.params, mode, staged)

      case 'create_or_update_scl_block':
        return this.toolCreateOrUpdateSclBlock(call.params, mode, staged)

      case 'update_hardware_parameters':
        return this.toolUpdateHardwareParameters(call.params)

      case 'update_plant_physics_scenario':
        return this.toolUpdatePlantPhysicsScenario(call.params)

      case 'run_compiler_and_self_heal':
        return this.toolRunCompilerAndSelfHeal()

      case 'revert_last_turn':
        return this.revertLastTurn()

      default:
        return { tool: call.tool, success: false, message: `Unknown tool '${call.tool}'` }
    }
  }

  // Tool 1: read_project_overview
  private toolReadProjectOverview(): AgentToolResult {
    const proj = useProjectStore.getState()
    const tags = useTagStore.getState()
    const blocks = useBlockStore.getState()

    return {
      tool: 'read_project_overview',
      success: true,
      message: 'Project overview retrieved successfully.',
      data: {
        targetCpu: proj.metadata?.targetCpu,
        cpuState: proj.cpuState,
        tagTablesCount: tags.tagTables.length,
        totalTagsCount: tags.tagTables.reduce((acc, t) => acc + t.tags.length, 0),
        activeCollisions: tags.totalCollisions,
        udts: blocks.udts.map((u) => u.name),
        dataBlocks: blocks.dataBlocks.map((d) => d.name),
        ladBlocks: blocks.ladBlocks.map((l) => l.name),
        sclBlocks: blocks.sclBlocks.map((s) => s.name)
      }
    }
  }

  // Tool: read_block
  private toolReadBlock(params: Record<string, unknown>): AgentToolResult {
    const name = String(params.name || '').toLowerCase()
    const blocks = useBlockStore.getState()
    const scl = blocks.sclBlocks.find((b) => b.name.toLowerCase() === name)
    const found = scl
      ? scl.code
      : [...blocks.ladBlocks, ...blocks.dataBlocks, ...blocks.udts].find((b) => b.name.toLowerCase() === name)
    if (!found) {
      return { tool: 'read_block', success: false, message: `No block or UDT named '${params.name}'.` }
    }
    return { tool: 'read_block', success: true, message: `Read ${params.name}.`, data: found }
  }

  // Tool: read_pattern
  private toolReadPattern(params: Record<string, unknown>): AgentToolResult {
    const pattern = findPattern(String(params.id || ''))
    if (!pattern) {
      const ids = CIRCUIT_PATTERNS.map((p) => p.id).join(', ')
      return { tool: 'read_pattern', success: false, message: `No pattern '${params.id}'. These exist: ${ids}.` }
    }
    return { tool: 'read_pattern', success: true, message: `Read pattern ${pattern.id}.`, data: pattern }
  }

  // Tool 2: manage_plc_tags
  private toolManagePlcTags(
    params: Record<string, unknown>,
    mode: 'auto-apply' | 'diff-view',
    staged: StagedFileChange[]
  ): AgentToolResult {
    const tagStore = useTagStore.getState()
    const action = params.action as string

    if (action === 'resolve_overlaps') {
      if (mode === 'diff-view') {
        const cpuConfig = useHardwareStore.getState().config
        const beforeTables = structuredClone(tagStore.tagTables)
        const resolvedTables = structuredClone(tagStore.tagTables)
        const analysis = MemoryOverlapEngine.analyzeCollisions(resolvedTables, cpuConfig)
        const distinctIds = new Set<string>()
        for (const col of analysis.collisions.values()) {
          if (col.tagId) distinctIds.add(col.tagId)
        }
        for (const tagId of distinctIds) {
          for (const table of resolvedTables) {
            const tag = table.tags.find((t) => t.id === tagId)
            if (tag) {
              const area = (tag.address.startsWith('%I') ? 'I' : tag.address.startsWith('%Q') ? 'Q' : 'M') as 'I' | 'Q' | 'M'
              tag.address = MemoryOverlapEngine.findNextSafeAddress(area, tag.dataType, resolvedTables, cpuConfig, tagId)
              break
            }
          }
        }
        let stagedTablesCount = 0
        for (let i = 0; i < beforeTables.length; i++) {
          const beforeTbl = beforeTables[i]
          const afterTbl = resolvedTables[i]
          if (JSON.stringify(beforeTbl) !== JSON.stringify(afterTbl)) {
            stagedTablesCount++
            staged.push({
              path: `/tags/${beforeTbl.fileName || `${beforeTbl.id}.tags.json`}`,
              title: `Resolve S7 Memory Overlaps (${beforeTbl.name})`,
              fileType: 'tag',
              beforeContent: JSON.stringify(beforeTbl, null, 2),
              afterContent: JSON.stringify(afterTbl, null, 2)
            })
          }
        }
        return {
          tool: 'manage_plc_tags',
          success: true,
          message:
            stagedTablesCount > 0
              ? `Memory overlap resolution staged for ${stagedTablesCount} tag table(s).`
              : 'No memory overlaps needed resolution.'
        }
      }

      tagStore.resolveAllOverlaps()
      return { tool: 'manage_plc_tags', success: true, message: 'All S7 memory overlaps resolved successfully.' }
    }

    if (action === 'upsert' || action === 'add' || action === 'update') {
      const rawIncoming: unknown[] = Array.isArray(params.tags)
        ? params.tags
        : params.tag
          ? [params.tag]
          : []

      if (rawIncoming.length === 0) {
        return { tool: 'manage_plc_tags', success: false, message: 'Missing tags payload.' }
      }

      const incomingTags: TagDefinition[] = []
      for (const item of rawIncoming) {
        if (!item || typeof item !== 'object') {
          return { tool: 'manage_plc_tags', success: false, message: 'Invalid tag object in tags payload.' }
        }
        const rec = item as Partial<TagDefinition>
        if (typeof rec.name !== 'string' || !rec.name.trim()) {
          return { tool: 'manage_plc_tags', success: false, message: 'Every tag must have a non-empty string name.' }
        }
        const cleanName = rec.name.trim()
        let normalizedAddress = typeof rec.address === 'string' ? rec.address.trim() : ''
        if (normalizedAddress) {
          const norm = normalizeS7Address(normalizedAddress)
          if (!norm.isValid) {
            return { tool: 'manage_plc_tags', success: false, message: `Tag '${cleanName}' has invalid S7 address '${rec.address}'.` }
          }
          normalizedAddress = norm.address
        }
        incomingTags.push({
          id: typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : '',
          name: cleanName,
          address: normalizedAddress,
          dataType: (typeof rec.dataType === 'string' && rec.dataType.trim() ? rec.dataType.trim() : 'BOOL') as TagDefinition['dataType'],
          comment: typeof rec.comment === 'string' ? rec.comment : '',
          systemLocked: Boolean(rec.systemLocked)
        })
      }

      const tableId = (params.tableId as string) || tagStore.tagTables[0]?.id
      if (!tableId) {
        return { tool: 'manage_plc_tags', success: false, message: 'No target tag table found.' }
      }

      const targetTable = tagStore.tagTables.find((t) => t.id === tableId) || tagStore.tagTables[0]

      if (mode === 'diff-view') {
        const before = JSON.stringify(targetTable, null, 2)
        const updatedTags = structuredClone(targetTable.tags)
        for (const t of incomingTags) {
          const existingIdx = updatedTags.findIndex(
            (item) => (t.id && item.id === t.id) || item.name.toLowerCase() === t.name.toLowerCase()
          )
          if (existingIdx !== -1) {
            const existing = updatedTags[existingIdx]
            updatedTags[existingIdx] = {
              ...existing,
              name: t.name,
              dataType: t.dataType || existing.dataType,
              address: t.address || existing.address,
              comment: t.comment ?? existing.comment
            }
          } else {
            updatedTags.push({
              ...t,
              id: t.id || generateId('tag'),
              systemLocked: Boolean(t.systemLocked)
            })
          }
        }
        staged.push({
          path: `/tags/${targetTable.fileName || `${targetTable.id}.tags.json`}`,
          title: `Tags: ${incomingTags.map((t) => t.name).join(', ')}`,
          fileType: 'tag',
          beforeContent: before,
          afterContent: JSON.stringify({ ...targetTable, tags: updatedTags }, null, 2)
        })
        return { tool: 'manage_plc_tags', success: true, message: `Tag mutation staged for ${incomingTags.length} tag(s).` }
      }

      for (const t of incomingTags) {
        const currentTable =
          useTagStore.getState().tagTables.find((table) => table.id === targetTable.id) || targetTable
        const existing = currentTable.tags.find(
          (item) => (t.id && item.id === t.id) || item.name.toLowerCase() === t.name.toLowerCase()
        )
        if (existing) {
          tagStore.updateTag(currentTable.id, existing.id, {
            name: t.name,
            dataType: t.dataType,
            ...(t.address ? { address: t.address } : {}),
            ...(t.comment !== undefined ? { comment: t.comment } : {})
          })
        } else {
          const { id: _ignored, ...rest } = t
          tagStore.addTag(currentTable.id, rest)
        }
      }

      const updatedTable = useTagStore.getState().tagTables.find((table) => table.id === targetTable.id)
      if (updatedTable) {
        this.syncFileToDisk(`/tags/${updatedTable.fileName || `${updatedTable.id}.tags.json`}`, JSON.stringify(updatedTable, null, 2))
      }

      return {
        tool: 'manage_plc_tags',
        success: true,
        message: `Applied ${incomingTags.length} tag(s) successfully.`
      }
    }

    if (action === 'delete') {
      const tagIds: string[] = Array.isArray(params.tagIds)
        ? (params.tagIds as string[])
        : params.tagId
          ? [params.tagId as string]
          : []
      const tableId = (params.tableId as string) || tagStore.tagTables[0]?.id
      if (!tableId || tagIds.length === 0) {
        return { tool: 'manage_plc_tags', success: false, message: 'Missing tableId or tagIds.' }
      }
      for (const id of tagIds) {
        tagStore.deleteTag(tableId, id)
      }
      return { tool: 'manage_plc_tags', success: true, message: `Deleted ${tagIds.length} tag(s).` }
    }

    return { tool: 'manage_plc_tags', success: false, message: `Unknown tag action '${action}'` }
  }

  // Tool 3: create_or_update_udt
  private toolCreateOrUpdateUdt(
    params: Record<string, unknown>,
    mode: 'auto-apply' | 'diff-view',
    staged: StagedFileChange[]
  ): AgentToolResult {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const rawFields = params.fields ?? params.members
    if (!name || !Array.isArray(rawFields) || rawFields.length === 0) {
      return { tool: 'create_or_update_udt', success: false, message: 'Missing name or fields array for UDT.' }
    }
    if (!isPlainBlockName(name)) {
      return { tool: 'create_or_update_udt', success: false, message: `'${name}' is not a valid UDT name.` }
    }

    const members: UdtMember[] = []
    for (let i = 0; i < rawFields.length; i++) {
      const f = rawFields[i]
      if (!f || typeof f !== 'object') {
        return { tool: 'create_or_update_udt', success: false, message: `Invalid field at index ${i} for UDT '${name}'.` }
      }
      const fieldRec = f as { name?: unknown; dataType?: unknown; comment?: unknown }
      if (typeof fieldRec.name !== 'string' || !fieldRec.name.trim() || typeof fieldRec.dataType !== 'string' || !fieldRec.dataType.trim()) {
        return { tool: 'create_or_update_udt', success: false, message: `UDT '${name}' field at index ${i} must have non-empty string name and dataType.` }
      }
      members.push({
        id: `member_${i}`,
        name: fieldRec.name.trim(),
        dataType: fieldRec.dataType.trim() as UdtMember['dataType'],
        comment: typeof fieldRec.comment === 'string' ? fieldRec.comment : undefined
      })
    }

    const existing = useBlockStore.getState().udts.find((u) => u.name === name)
    const udt: UdtDefinition = {
      id: existing?.id || `udt_${name.toLowerCase()}`,
      name,
      fileName: existing?.fileName || `${name}.udt.json`,
      description: typeof params.description === 'string' && params.description ? params.description : `UDT generated by Rungline Agent`,
      members
    }

    if (mode === 'diff-view') {
      staged.push({
        path: `/types/${udt.fileName}`,
        title: `UDT: ${name}`,
        fileType: 'udt',
        beforeContent: existing ? JSON.stringify(existing, null, 2) : '// New UDT (Does not exist yet)',
        afterContent: JSON.stringify(udt, null, 2)
      })
      return { tool: 'create_or_update_udt', success: true, message: `UDT ${name} staged in Diff-View.` }
    }

    const blockStore = useBlockStore.getState()
    if (existing) {
      blockStore.updateUdt(existing.id, udt)
    } else {
      blockStore.addUdt(udt)
    }
    this.syncFileToDisk(`/types/${udt.fileName}`, JSON.stringify(udt, null, 2))
    useUIStore.getState().openTab({
      id: makeTabId('udt', udt.id),
      title: udt.name,
      type: 'udt',
      targetId: udt.id
    })
    return { tool: 'create_or_update_udt', success: true, message: `UDT ${name} saved successfully.` }
  }

  // Tool 4: create_or_update_db
  private toolCreateOrUpdateDb(
    params: Record<string, unknown>,
    mode: 'auto-apply' | 'diff-view',
    staged: StagedFileChange[]
  ): AgentToolResult {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const variablesRaw = params.variables === undefined ? [] : params.variables
    if (!name) {
      return { tool: 'create_or_update_db', success: false, message: 'Missing name for DB.' }
    }
    if (!isPlainBlockName(name)) {
      return { tool: 'create_or_update_db', success: false, message: `'${name}' is not a valid DB name.` }
    }
    if (!Array.isArray(variablesRaw)) {
      return { tool: 'create_or_update_db', success: false, message: `DB '${name}' variables must be an array.` }
    }

    const variables: BlockVariable[] = []
    for (let i = 0; i < variablesRaw.length; i++) {
      const v = variablesRaw[i]
      if (!v || typeof v !== 'object') {
        return { tool: 'create_or_update_db', success: false, message: `Invalid variable at index ${i} for DB '${name}'.` }
      }
      const varRec = v as { name?: unknown; dataType?: unknown; initialValue?: unknown; defaultValue?: unknown; comment?: unknown }
      if (typeof varRec.name !== 'string' || !varRec.name.trim() || typeof varRec.dataType !== 'string' || !varRec.dataType.trim()) {
        return { tool: 'create_or_update_db', success: false, message: `DB '${name}' variable at index ${i} must have non-empty string name and dataType.` }
      }
      variables.push({
        id: `var_${i}`,
        name: varRec.name.trim(),
        dataType: varRec.dataType.trim(),
        defaultValue:
          typeof varRec.initialValue === 'string'
            ? varRec.initialValue
            : typeof varRec.defaultValue === 'string'
              ? varRec.defaultValue
              : undefined,
        retain: false,
        accessibleFromHMI: true,
        comment: typeof varRec.comment === 'string' ? varRec.comment : undefined
      })
    }

    const existingDb = useBlockStore.getState().dataBlocks.find((d) => d.name === name)
    const db: DataBlockDefinition = {
      id: existingDb?.id || `db_${name.toLowerCase()}`,
      blockType: 'DB',
      blockNumber: existingDb?.blockNumber ?? this.nextBlockNumber('DB'),
      name,
      fileName: existingDb?.fileName || `${name}.db.json`,
      dbType: 'Global',
      optimizedAccess: params.isOptimized !== false,
      variables
    }

    if (mode === 'diff-view') {
      staged.push({
        path: `/blocks/${db.fileName}`,
        title: `DB: ${name}`,
        fileType: 'db',
        beforeContent: existingDb ? JSON.stringify(existingDb, null, 2) : '// New DB (Does not exist yet)',
        afterContent: JSON.stringify(db, null, 2)
      })
      return { tool: 'create_or_update_db', success: true, message: `DB ${name} staged in Diff-View.` }
    }

    const blockStore = useBlockStore.getState()
    if (existingDb) {
      blockStore.updateDataBlock(db.fileName, db)
    } else {
      blockStore.addDataBlock(db)
    }
    this.syncFileToDisk(`/blocks/${db.fileName}`, JSON.stringify(db, null, 2))
    useUIStore.getState().openTab({
      id: makeTabId('db', db.fileName),
      title: db.name,
      type: 'db',
      targetId: db.fileName
    })
    return { tool: 'create_or_update_db', success: true, message: `DB ${name} saved successfully.` }
  }

  // Tool 5: create_or_update_lad_block
  private toolCreateOrUpdateLadBlock(
    params: Record<string, unknown>,
    mode: 'auto-apply' | 'diff-view',
    staged: StagedFileChange[]
  ): AgentToolResult {
    const blockStore = useBlockStore.getState()
    const blockName = (params.blockName as string) || 'OB1_Main'
    const targetBlock = blockStore.ladBlocks.find((b) => b.name === blockName)

    if (params.action === 'auto_refactor_double_coils') {
      if (!targetBlock) {
        return { tool: 'create_or_update_lad_block', success: false, message: `Block ${blockName} not found.` }
      }

      const refactored = DoubleCoilDetector.autoRefactorBlock(targetBlock)
      if (mode === 'diff-view') {
        staged.push({
          path: `/blocks/${targetBlock.fileName}`,
          title: `LAD Auto-Merge: ${targetBlock.name}`,
          fileType: 'lad',
          beforeContent: JSON.stringify(targetBlock, null, 2),
          afterContent: JSON.stringify(refactored, null, 2)
        })
        return { tool: 'create_or_update_lad_block', success: true, message: `LAD auto-merge staged for ${blockName}.` }
      }

      blockStore.updateLadBlock(targetBlock.fileName, refactored)
      this.syncFileToDisk(`/blocks/${targetBlock.fileName}`, JSON.stringify(refactored, null, 2))
      useUIStore.getState().openTab({
        id: `lad_${targetBlock.fileName}`,
        title: targetBlock.name,
        type: 'lad',
        targetId: targetBlock.fileName
      })
      return { tool: 'create_or_update_lad_block', success: true, message: `Double-coils in ${blockName} auto-merged.` }
    }

    return { tool: 'create_or_update_lad_block', success: false, message: 'Action not supported yet on LAD.' }
  }

  // Tool 6: create_or_update_scl_block
  private toolCreateOrUpdateSclBlock(
    params: Record<string, unknown>,
    mode: 'auto-apply' | 'diff-view',
    staged: StagedFileChange[]
  ): AgentToolResult {
    const name = params.name as string
    const code = (params.sourceCode || params.code || '') as string
    if (!name) {
      return { tool: 'create_or_update_scl_block', success: false, message: 'Missing name for SCL.' }
    }
    if (!isPlainBlockName(name)) {
      return { tool: 'create_or_update_scl_block', success: false, message: `'${name}' is not a valid block name.` }
    }

    const fail = (message: string): AgentToolResult => ({ tool: 'create_or_update_scl_block', success: false, message })
    const parsed = parseSourceBlock(code)
    if (!parsed.hasHeader || (parsed.kind !== 'FB' && parsed.kind !== 'FC' && parsed.kind !== 'OB')) {
      return fail(`sourceCode of ${name} must be a full source, starting with FUNCTION_BLOCK or FUNCTION and its VAR sections.`)
    }
    if (parsed.name !== name) {
      return fail(`sourceCode names the block '${parsed.name}', but the name parameter is '${name}'.`)
    }
    const existing = useBlockStore.getState().sclBlocks.find((b) => b.name === name)
    // A new OB needs an event and number the agent cannot choose safely
    if (parsed.kind === 'OB' && !existing) {
      return fail(`The agent cannot add a new OB. Use an FB or FC for ${name}.`)
    }
    const blockType = parsed.kind
    const sclBlock: SclBlockDefinition = {
      name,
      fileName: existing?.fileName || `${name}.scl`,
      blockType,
      blockNumber: existing?.blockNumber ?? this.nextBlockNumber(blockType as 'FB' | 'FC'),
      optimizedAccess: parsed.optimizedAccess ?? true,
      interface: emptyInterface(),
      code
    }
    sclBlock.interface = effectiveInterface(sclBlock)

    if (mode === 'diff-view') {
      staged.push({
        path: `/blocks/${sclBlock.fileName}`,
        title: `SCL: ${name}`,
        fileType: 'scl',
        beforeContent: existing?.code || '// New SCL Block',
        afterContent: code
      })
      return { tool: 'create_or_update_scl_block', success: true, message: `SCL block ${name} staged in Diff-View.` }
    }

    const blockStore = useBlockStore.getState()
    if (existing) {
      blockStore.updateSclBlock(sclBlock.fileName, sclBlock)
    } else {
      blockStore.addSclBlock(sclBlock)
    }
    this.syncFileToDisk(`/blocks/${sclBlock.fileName}`, code)
    useUIStore.getState().openTab({
      id: `scl_${sclBlock.fileName}`,
      title: sclBlock.name,
      type: 'scl',
      targetId: sclBlock.fileName
    })
    return { tool: 'create_or_update_scl_block', success: true, message: `SCL block ${name} saved successfully.` }
  }

  // Tool 7: update_hardware_parameters
  private toolUpdateHardwareParameters(params: Record<string, unknown>): AgentToolResult {
    const hwStore = useHardwareStore.getState()
    if (params.obCyclicInterruptIntervalMs !== undefined) {
      hwStore.updateOb(30, { cycleTimeMs: Number(params.obCyclicInterruptIntervalMs) })
    }
    if (params.aiWireBreakDetection !== undefined) {
      hwStore.updateAiChannel(0, { wireBreakCheck: Boolean(params.aiWireBreakDetection) })
    }
    return { tool: 'update_hardware_parameters', success: true, message: 'Hardware CPU parameters updated.' }
  }

  // Tool 8: update_plant_physics_scenario
  private toolUpdatePlantPhysicsScenario(params: Record<string, unknown>): AgentToolResult {
    const simStore = useSimulationStore.getState()
    if (params.scenarioCode) {
      simStore.setScenarioCode(String(params.scenarioCode))
      simStore.applyScenarioScript(String(params.scenarioCode))
    }
    return { tool: 'update_plant_physics_scenario', success: true, message: 'Plant physics scenario configured.' }
  }

  // Tool 9: run_compiler_and_self_heal
  private toolRunCompilerAndSelfHeal(): AgentToolResult {
    const blockStore = useBlockStore.getState()
    const tagStore = useTagStore.getState()

    // 1. Auto-refactor double coils if found
    for (const lad of blockStore.ladBlocks) {
      const conflicts = DoubleCoilDetector.scanBlock(lad)
      if (conflicts.length > 0) {
        const refactored = DoubleCoilDetector.autoRefactorBlock(lad)
        blockStore.updateLadBlock(lad.fileName, refactored)
      }
    }

    // 2. Auto-resolve memory collisions if found
    const collisions = MemoryOverlapEngine.analyzeCollisions(tagStore.tagTables, useHardwareStore.getState().config)
    if (collisions.totalCollisionCount > 0) {
      tagStore.resolveAllOverlaps()
    }

    // 3. Final compiler verification
    const report = this.runCompilerVerification()
    return {
      tool: 'run_compiler_and_self_heal',
      success: report.success,
      message: report.message,
      data: report
    }
  }

  /**
   * Comprehensive Compiler-in-the-Loop verification
   */
  public runCompilerVerification(): {
    success: boolean
    message: string
    errors: string[]
    warnings: string[]
  } {
    // The same compiler as the COMPILE button, so the agent and the user see the same result
    const result = ProjectCompilerEngine.runFullProjectCompilation()
    const errors: string[] = []
    const warnings: string[] = []
    for (const diagnostic of result.diagnostics) {
      const blocksProgram = diagnostic.severity === 'Error' && diagnostic.blocksDownload !== false
      if (blocksProgram) errors.push(diagnostic.message)
      else warnings.push(diagnostic.message)
    }

    const success = errors.length === 0
    const message = success
      ? `[OK] Compiler Verified: 0 Errors (${warnings.length} Warnings)`
      : `[ERR] Compiler Failed: ${errors.length} Errors (${errors[0]})`

    return { success, message, errors, warnings }
  }
}

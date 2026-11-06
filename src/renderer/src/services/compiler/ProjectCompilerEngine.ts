import { TagTable } from '@shared/types/tags'
import { CpuConfig } from '@shared/types/hardware'
import { LadBlockDefinition, SclBlockDefinition, LadNetwork, DataBlockDefinition } from '@shared/types/blocks'
import { UdtDefinition } from '@shared/types/types'
import {
  LadderNetwork,
  LadderNode,
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderCounterNode,
  LadderParallelBranchNode
} from '@shared/types/ladder'
import { MemoryOverlapEngine } from '../MemoryOverlapEngine'
import { DoubleCoilDetector } from '../DoubleCoilDetector'
import { SclInterpreter } from '../../runtime/SclInterpreter'
import { StlListingGenerator, ProjectListingSummary } from './StlListingGenerator'
import { findIoBitsWithoutChannel, runProgramChecks } from './ProgramConsistencyChecks'
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useHardwareStore } from '../../stores/useHardwareStore'

export interface CompileMessage {
  id: string
  severity: 'Error' | 'Warning' | 'Info'
  code: string // Legacy code ('ERR_MEMORY_OVERLAP', 'ERR_UNASSIGNED_OPERAND', etc.)
  iecCode?: string // Standard IEC code ('S7-MEM-001', 'S7-LAD-002', 'S7-LAD-003', 'S7-TMR-004', 'S7-SCL-005')
  source: string
  message: string
  location?: {
    blockName?: string
    blockFileName?: string
    networkNumber?: number
    nodeId?: string
    tagName?: string
    tagAddress?: string
    line?: number
  }
  targetId?: string
  targetSymbol?: string
  targetAddress?: string
  autoFixable?: boolean
  fixAction?: string
  fixLabel?: string
  timestamp: number
  /** False for an error that does not stop a real CPU from being loaded. TIA allows overlapping tags. */
  blocksDownload?: boolean
}

export interface CompileResult {
  success: boolean
  errorsCount: number
  warningsCount: number
  infosCount: number
  timestamp: string // "HH:MM:SS"
  bannerMessage: string
  metricSummary?: string
  diagnostics: CompileMessage[]
  /** True when no error prevents the program from going to RUN. */
  canDownload: boolean
  listingSummary?: ProjectListingSummary
}

export class ProjectCompilerEngine {
  /**
   * Executes the comprehensive 5-pass industrial compilation and consistency audit
   */
  public static runFullProjectCompilation(
    tagTables?: TagTable[],
    ladBlocks?: LadBlockDefinition[],
    sclBlocks?: SclBlockDefinition[],
    cpuConfig?: CpuConfig,
    dataBlocks?: DataBlockDefinition[],
    udts?: UdtDefinition[]
  ): CompileResult {
    // If not passed explicitly, grab current state from Zustand stores
    const effectiveTagTables = tagTables || useTagStore.getState().tagTables
    const effectiveLadBlocks = ladBlocks || useBlockStore.getState().ladBlocks
    const effectiveSclBlocks = sclBlocks || useBlockStore.getState().sclBlocks
    const effectiveCpuConfig = cpuConfig || useHardwareStore.getState().config
    const effectiveDataBlocks = dataBlocks || useBlockStore.getState().dataBlocks
    const effectiveUdts = udts || useBlockStore.getState().udts

    const diagnostics: CompileMessage[] = []
    const now = new Date()
    const timestampStr = now.toTimeString().split(' ')[0]

    // =========================================================================
    // PASS 1: S7 Memory Overlap & Address Validity Audit
    // =========================================================================
    const overlapAnalysis = MemoryOverlapEngine.analyzeCollisions(effectiveTagTables, effectiveCpuConfig)
    for (const d of overlapAnalysis.diagnostics) {
      diagnostics.push({
        id: `compile_${d.id}`,
        severity: d.severity,
        code: d.code,
        iecCode: 'S7-MEM-001',
        source: 'Memory Overlap Guard',
        message: `[S7-MEM-001] ${d.message}`,
        location: {
          tagName: d.targetSymbol,
          tagAddress: d.targetAddress
        },
        targetId: d.targetId,
        targetSymbol: d.targetSymbol,
        targetAddress: d.targetAddress,
        autoFixable: d.autoFixable,
        fixAction: d.fixAction || 'AUTO_ASSIGN_ADDRESS',
        fixLabel: d.fixLabel || 'Auto-Assign Safe Address',
        timestamp: d.timestamp,
        blocksDownload: false
      })
    }

    // =========================================================================
    // PASS 2 & 4: Ladder AST Structural Scan & Timer/Counter Instance Verification
    // =========================================================================
    const instantiatedTimers = new Set<string>()
    const instantiatedCounters = new Set<string>()

    // Collect instantiated timer/counter names declared in tag tables
    for (const tbl of effectiveTagTables) {
      for (const t of tbl.tags) {
        if (/^T\d+$/i.test(t.name) || t.dataType === 'TIME') {
          instantiatedTimers.add(t.name.toUpperCase())
        }
        if (/^C\d+$/i.test(t.name)) {
          instantiatedCounters.add(t.name.toUpperCase())
        }
      }
    }

    const collectInstances = (node: LadderNode) => {
      if (node.kind === 'timer') {
        const t = node as LadderTimerNode
        const inst = (t.instanceDb || (t as any).operand || (t as any).timerInstance || t.id).trim().toUpperCase()
        if (inst) instantiatedTimers.add(inst)
      } else if (node.kind === 'counter') {
        const c = node as LadderCounterNode
        const inst = (c.instanceDb || (c as any).operand || (c as any).counterInstance || c.id).trim().toUpperCase()
        if (inst) instantiatedCounters.add(inst)
      } else if (node.kind === 'parallel') {
        const p = node as LadderParallelBranchNode
        for (const branch of p.branches) {
          for (const bn of branch) collectInstances(bn)
        }
      }
    }

    for (const blk of effectiveLadBlocks) {
      for (const net of blk.networks || []) {
        for (const node of net.nodes || []) {
          collectInstances(node)
        }
      }
    }

    // Inspect each node in every network
    const inspectNode = (node: LadderNode, blk: LadBlockDefinition, net: LadNetwork | LadderNetwork) => {
      if (node.kind === 'contact') {
        const c = node as LadderContactNode
        const op = (c.operand || '').trim()
        const addr = (c.address || '').trim()

        // Unassigned operand check (??? or empty)
        if (!op || op === '???' || op === '%??.?' || addr.includes('???')) {
          diagnostics.push({
            id: `err_unassigned_${blk.fileName}_net${net.networkNumber}_${c.id}`,
            severity: 'Error',
            code: 'ERR_UNASSIGNED_OPERAND',
            iecCode: 'S7-LAD-002',
            source: 'LAD Compiler',
            message: `[S7-LAD-002] Contact in ${blk.name}, Network ${net.networkNumber} has unassigned operand ('???').`,
            location: {
              blockName: blk.name,
              blockFileName: blk.fileName,
              networkNumber: net.networkNumber,
              nodeId: c.id
            },
            targetId: c.id,
            autoFixable: true,
            fixAction: 'GO_TO_RUNG',
            fixLabel: 'Go to Rung',
            timestamp: Date.now()
          })
        }

        // Sub-bit timer reference verification (e.g. T1.Q, T2.Q)
        const timerMatch = op.match(/^([A-Za-z0-9_]+)\.(Q|ET|IN|PT)$/i)
        if (timerMatch) {
          const inst = timerMatch[1].toUpperCase()
          if (!instantiatedTimers.has(inst)) {
            diagnostics.push({
              id: `err_timer_inst_${blk.fileName}_net${net.networkNumber}_${c.id}`,
              severity: 'Error',
              code: 'ERR_UNINSTANTIATED_TIMER',
              iecCode: 'S7-TMR-004',
              source: 'Timer Validator',
              message: `[S7-TMR-004] Contact '${op}' in ${blk.name}, Network ${net.networkNumber} references timer '${inst}', but no '${inst}' TON/TOF/TP instruction is instantiated.`,
              location: {
                blockName: blk.name,
                blockFileName: blk.fileName,
                networkNumber: net.networkNumber,
                nodeId: c.id
              },
              targetId: c.id,
              autoFixable: true,
              fixAction: 'GO_TO_RUNG',
              fixLabel: 'Go to Rung',
              timestamp: Date.now()
            })
          }
        }

        // Sub-bit counter reference verification (e.g. C1.QU, C1.QD)
        const counterMatch = op.match(/^([A-Za-z0-9_]+)\.(QU|QD|CV|PV|CU|CD)$/i)
        if (counterMatch) {
          const inst = counterMatch[1].toUpperCase()
          if (!instantiatedCounters.has(inst)) {
            diagnostics.push({
              id: `err_counter_inst_${blk.fileName}_net${net.networkNumber}_${c.id}`,
              severity: 'Error',
              code: 'ERR_UNINSTANTIATED_COUNTER',
              iecCode: 'S7-TMR-004',
              source: 'Counter Validator',
              message: `[S7-TMR-004] Contact '${op}' in ${blk.name}, Network ${net.networkNumber} references counter '${inst}', but no '${inst}' CTU/CTD instruction is instantiated.`,
              location: {
                blockName: blk.name,
                blockFileName: blk.fileName,
                networkNumber: net.networkNumber,
                nodeId: c.id
              },
              targetId: c.id,
              autoFixable: true,
              fixAction: 'GO_TO_RUNG',
              fixLabel: 'Go to Rung',
              timestamp: Date.now()
            })
          }
        }
      } else if (node.kind === 'coil') {
        const c = node as LadderCoilNode
        const op = (c.operand || '').trim()
        const addr = (c.address || '').trim()

        if (!op || op === '???' || op === '%??.?' || addr.includes('???')) {
          diagnostics.push({
            id: `err_unassigned_coil_${blk.fileName}_net${net.networkNumber}_${c.id}`,
            severity: 'Error',
            code: 'ERR_UNASSIGNED_OPERAND',
            iecCode: 'S7-LAD-002',
            source: 'LAD Compiler',
            message: `[S7-LAD-002] Coil in ${blk.name}, Network ${net.networkNumber} has unassigned operand ('???').`,
            location: {
              blockName: blk.name,
              blockFileName: blk.fileName,
              networkNumber: net.networkNumber,
              nodeId: c.id
            },
            targetId: c.id,
            autoFixable: true,
            fixAction: 'GO_TO_RUNG',
            fixLabel: 'Go to Rung',
            timestamp: Date.now()
          })
        }
      } else if (node.kind === 'parallel') {
        const p = node as LadderParallelBranchNode
        for (const branch of p.branches) {
          if (branch.length === 0) {
            diagnostics.push({
              id: `err_dangling_branch_${blk.fileName}_net${net.networkNumber}_${p.id}`,
              severity: 'Error',
              code: 'ERR_UNASSIGNED_OPERAND',
              iecCode: 'S7-LAD-002',
              source: 'LAD Structural Validator',
              message: `[S7-LAD-002] Dangling empty parallel branch in ${blk.name}, Network ${net.networkNumber}.`,
              location: {
                blockName: blk.name,
                blockFileName: blk.fileName,
                networkNumber: net.networkNumber,
                nodeId: p.id
              },
              targetId: p.id,
              autoFixable: true,
              fixAction: 'GO_TO_RUNG',
              fixLabel: 'Go to Rung',
              timestamp: Date.now()
            })
          }
          for (const bn of branch) inspectNode(bn, blk, net)
        }
      }
    }

    for (const blk of effectiveLadBlocks) {
      for (const net of blk.networks || []) {
        if (net.isSclNetwork && net.sclCode) {
          const syntax = SclInterpreter.validateSyntax(net.sclCode)
          for (const err of syntax.errors) {
            diagnostics.push({
              id: `err_scl_net_${blk.fileName}_${net.networkNumber}_${diagnostics.length}`,
              severity: 'Error',
              code: 'ERR_SCL_SYNTAX',
              iecCode: 'S7-SCL-005',
              source: 'SCL Compiler',
              message: `[S7-SCL-005] ${blk.name}, Network ${net.networkNumber}: ${err}`,
              location: { blockName: blk.name, blockFileName: blk.fileName, networkNumber: net.networkNumber },
              targetId: net.id,
              autoFixable: false,
              timestamp: Date.now()
            })
          }
          continue
        }
        if (!net.nodes || net.nodes.length === 0) {
          diagnostics.push({
            id: `err_empty_net_${blk.fileName}_net${net.networkNumber}`,
            severity: 'Error',
            code: 'ERR_UNASSIGNED_OPERAND',
            iecCode: 'S7-LAD-002',
            source: 'LAD Structural Validator',
            message: `[S7-LAD-002] Network ${net.networkNumber} in ${blk.name} is empty with no instructions or output coil.`,
            location: {
              blockName: blk.name,
              blockFileName: blk.fileName,
              networkNumber: net.networkNumber
            },
            targetId: net.id,
            autoFixable: true,
            fixAction: 'GO_TO_RUNG',
            fixLabel: 'Go to Rung',
            timestamp: Date.now(),
            blocksDownload: false
          })
        }
        for (const node of net.nodes || []) {
          inspectNode(node, blk, net)
        }
      }
    }

    // =========================================================================
    // PASS 3: Double-Coil Syndrome Audit
    // =========================================================================
    for (const blk of effectiveLadBlocks) {
      const conflicts = DoubleCoilDetector.detectConflicts(blk)
      for (const conflict of conflicts) {
        diagnostics.push({
          id: `warn_double_coil_${blk.fileName}_${conflict.normalizedOperand}`,
          severity: 'Warning',
          code: 'WARN_DOUBLE_COIL',
          iecCode: 'S7-LAD-003',
          source: 'Double-Coil Detector',
          message: `[S7-LAD-003] Coil '${conflict.operand}' in ${blk.name} is written in multiple networks (${conflict.networkNumbers.join(', ')}). In cyclic scan, earlier states are overwritten by later networks.`,
          location: {
            blockName: blk.name,
            blockFileName: blk.fileName,
            networkNumber: conflict.networkNumbers[0]
          },
          targetId: conflict.operand,
          targetSymbol: conflict.operand,
          autoFixable: true,
          fixAction: 'AUTO_MERGE_COILS',
          fixLabel: 'Auto-Merge into Parallel Latch',
          timestamp: Date.now()
        })
      }
    }

    // =========================================================================
    // PASS 5: SCL Syntax Audit & Unified IEC 61131-3 Bytecode Generation
    // =========================================================================
    for (const sclBlk of effectiveSclBlocks) {
      if (sclBlk.code) {
        const syntaxRes = SclInterpreter.validateSyntax(sclBlk.code)
        if (!syntaxRes.valid) {
          for (const err of syntaxRes.errors) {
            diagnostics.push({
              id: `err_scl_syntax_${sclBlk.fileName}_${Math.random().toString(36).substring(2, 7)}`,
              severity: 'Error',
              code: 'ERR_SCL_SYNTAX',
              iecCode: 'S7-SCL-005',
              source: 'SCL Compiler',
              message: `[S7-SCL-005] ${sclBlk.name}: ${err}`,
              location: {
                blockName: sclBlk.name,
                blockFileName: sclBlk.fileName
              },
              targetId: sclBlk.fileName,
              autoFixable: true,
              fixAction: 'GO_TO_RUNG',
              fixLabel: 'Go to SCL',
              timestamp: Date.now()
            })
          }
        }
      }
    }

    // =========================================================================
    // PASS 6: Symbols, literals, addresses and block references
    // =========================================================================
    const findings = runProgramChecks({
      tagTables: effectiveTagTables,
      ladBlocks: effectiveLadBlocks,
      sclBlocks: effectiveSclBlocks,
      dataBlocks: effectiveDataBlocks,
      udts: effectiveUdts,
      cpuConfig: effectiveCpuConfig
    })
    findings.forEach((finding, index) => {
      diagnostics.push({
        id: `err_program_${index}`,
        severity: 'Error',
        code: finding.iecCode,
        iecCode: finding.iecCode,
        source: 'Program Checker',
        message: finding.message,
        location: {
          blockName: finding.blockName,
          blockFileName: finding.blockFileName,
          networkNumber: finding.networkNumber,
          nodeId: finding.nodeId,
          tagName: finding.tagName,
          line: finding.line
        },
        targetId: finding.nodeId || finding.blockFileName,
        autoFixable: !!finding.blockFileName,
        fixAction: finding.blockFileName ? 'GO_TO_RUNG' : undefined,
        fixLabel: finding.blockFileName ? 'Go to Block' : undefined,
        timestamp: Date.now()
      })
    })

    findIoBitsWithoutChannel(effectiveTagTables, effectiveCpuConfig).forEach((finding, index) => {
      diagnostics.push({
        id: `warn_io_channel_${index}`,
        severity: 'Warning',
        code: finding.iecCode,
        iecCode: finding.iecCode,
        source: 'Program Check',
        message: finding.message,
        location: { tagName: finding.tagName },
        autoFixable: false,
        timestamp: Date.now()
      })
    })

    // Reading aid only: this listing does not run and is not loaded to a CPU
    const listingSummary = StlListingGenerator.forProject(effectiveLadBlocks, effectiveSclBlocks)

    const errorsCount = diagnostics.filter((d) => d.severity === 'Error').length
    const warningsCount = diagnostics.filter((d) => d.severity === 'Warning').length
    const infosCount = diagnostics.filter((d) => d.severity === 'Info').length
    const success = errorsCount === 0

    const canDownload = !diagnostics.some((d) => d.severity === 'Error' && d.blocksDownload !== false)
    const metricSummary = `Checked ${listingSummary.totalNetworks} Networks and ${effectiveSclBlocks.length} SCL Blocks | ${errorsCount} Errors, ${warningsCount} Warnings | STL listing: ${listingSummary.totalInstructions} lines`

    const bannerMessage = success
      ? `[COMPILE SUCCESS — 0 Error(s), ${warningsCount} Warning(s) | Compiled at ${timestampStr}]`
      : `[COMPILE FAILED — ${errorsCount} Error(s), ${warningsCount} Warning(s) | Compiled at ${timestampStr}]`

    return {
      success,
      errorsCount,
      warningsCount,
      infosCount,
      timestamp: timestampStr,
      bannerMessage,
      metricSummary,
      diagnostics,
      canDownload,
      listingSummary
    }
  }
}


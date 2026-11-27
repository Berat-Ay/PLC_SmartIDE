/**
 * Rungline Live "Why is this Coil OFF?" Diagnostics Engine
 * Backwards evaluation through unenergized Ladder AST rungs to pinpoint
 * blocking contact conditions in real-time memory snapshots.
 */

import { LadBlockDefinition, LadNetwork } from '@shared/types/blocks'
import {
  LadderComparatorNode,
  LadderContactNode,
  LadderCounterNode,
  LadderNode,
  LadderParallelBranchNode,
  LadderTimerNode
} from '@shared/types/ladder'
import { useRuntimeStore } from '../../stores/useRuntimeStore'
import { useTagStore } from '../../stores/useTagStore'

export interface BlockingContactInfo {
  nodeId: string
  operand: string
  address: string
  contactType: string
  evaluatedValue: boolean
  recommendedForceValue: boolean
  reason: string
}

export interface CoilDiagnosticReport {
  operand: string
  networkNumber: number
  isEnergized: boolean
  blockingContact?: BlockingContactInfo
  explanationTr: string
  explanationEn: string
  suggestedActionTr: string
  suggestedActionEn: string
}

export class CoilDiagnosticEngine {
  /**
   * Diagnose why a specific coil in a network is OFF
   */
  public static diagnoseCoil(
    block: LadBlockDefinition,
    networkNumber: number,
    coilOperand: string
  ): CoilDiagnosticReport {
    const net = (block.networks || []).find((n: LadNetwork) => n.networkNumber === networkNumber) || (block.networks || [])[0]
    if (!net) {
      return {
        operand: coilOperand,
        networkNumber,
        isEnergized: false,
        explanationTr: `Ağ ${networkNumber} veya geçerli ladder satırı bulunamadı ("${coilOperand}").`,
        explanationEn: `No network ${networkNumber} or valid ladder rung found for coil "${coilOperand}".`,
        suggestedActionTr: `Bobinin yer aldığı ağı kontrol edin.`,
        suggestedActionEn: `Check the network containing coil "${coilOperand}".`
      }
    }

    const runtime = useRuntimeStore.getState()
    const tagStore = useTagStore.getState()

    // Resolve address of the coil
    const allTags = tagStore.tagTables.flatMap((t) => t.tags)
    const coilTag = allTags.find((t) => t.name === coilOperand)
    const coilAddress = coilTag?.address || coilOperand
    const liveCoilVal = runtime.engine.getVariable(coilAddress)
    const isEnergized = Boolean(liveCoilVal)

    if (isEnergized) {
      return {
        operand: coilOperand,
        networkNumber: net.networkNumber,
        isEnergized: true,
        explanationTr: `Bobin "${coilOperand}" şu anda iletimde (ON/TRUE). Güç hattı kesintisiz olarak bobine ulaşmaktadır.`,
        explanationEn: `Coil "${coilOperand}" is currently energized (ON/TRUE). Power rail continuity is satisfied.`,
        suggestedActionTr: `Herhangi bir engelleme bulunmuyor.`,
        suggestedActionEn: `No blocking contact present.`
      }
    }

    const ladPower = runtime.currentSnapshot?.ladPowerState
    const resolveAddr = (op?: string): string => {
      if (!op) return ''
      const tag = allTags.find((t) => t.name.toLowerCase() === op.replace(/"/g, '').trim().toLowerCase())
      return tag?.address || op
    }

    // Trace through network nodes and parallel branches to pinpoint the blocking condition
    let blockingNode: LadderNode | null = null
    let blockingOperand = ''
    let blockingTagAddress = ''
    let blockingType = 'NO_CONTACT'
    let blockingVal = false
    let recommendedForce = true
    let customReason: string | undefined

    const doesNodeConduct = (node: LadderNode): boolean => {
      if (node.kind === 'contact') {
        const ct = node as LadderContactNode
        if (ladPower && ct.id && ladPower[ct.id] !== undefined) {
          return Boolean(ladPower[ct.id].powered)
        }
        const addr = resolveAddr(ct.operand)
        const val = Boolean(runtime.engine.getVariable(addr))
        if (ct.contactType === 'NO_CONTACT') return val
        if (ct.contactType === 'NC_CONTACT') return !val
        // P_TRIG / N_TRIG only conduct for a single scan edge
        return false
      } else if (node.kind === 'parallel') {
        const p = node as LadderParallelBranchNode
        return (p.branches || []).some((branch) => branch.every(doesNodeConduct))
      } else if (node.kind === 'timer') {
        const t = node as LadderTimerNode
        if (ladPower && t.id && ladPower[t.id] !== undefined) return Boolean(ladPower[t.id].powered)
        return Boolean(runtime.engine.getVariable(t.qOperand || `${t.instanceDb}.Q`))
      } else if (node.kind === 'counter') {
        const c = node as LadderCounterNode
        if (ladPower && c.id && ladPower[c.id] !== undefined) return Boolean(ladPower[c.id].powered)
        return Boolean(runtime.engine.getVariable(c.qOperand || `${c.instanceDb}.QU`))
      } else if (node.kind === 'comparator') {
        const cmp = node as LadderComparatorNode
        if (ladPower && cmp.id && ladPower[cmp.id] !== undefined) return Boolean(ladPower[cmp.id].powered)
        const v1 = Number(runtime.engine.getVariable(resolveAddr(cmp.op1)) ?? cmp.op1)
        const v2 = Number(runtime.engine.getVariable(resolveAddr(cmp.op2)) ?? cmp.op2)
        if (!Number.isFinite(v1) || !Number.isFinite(v2)) return true
        switch (cmp.comparatorType) {
          case 'CMP_EQ':
            return v1 === v2
          case 'CMP_NE':
            return v1 !== v2
          case 'CMP_GT':
            return v1 > v2
          case 'CMP_LT':
            return v1 < v2
          case 'CMP_GE':
            return v1 >= v2
          case 'CMP_LE':
            return v1 <= v2
        }
      }
      return true
    }

    const recordBlocker = (
      node: LadderNode,
      operand: string,
      address: string,
      contactType: string,
      evaluatedValue: boolean,
      recommendedForceValue: boolean,
      reason?: string
    ): true => {
      blockingNode = node
      blockingOperand = operand
      blockingTagAddress = address
      blockingType = contactType
      blockingVal = evaluatedValue
      recommendedForce = recommendedForceValue
      customReason = reason
      return true
    }

    const findBlockingInList = (nodeList: LadderNode[]): boolean => {
      for (const node of nodeList) {
        if (node.kind === 'contact') {
          const contact = node as LadderContactNode
          const addr = resolveAddr(contact.operand)
          const val = Boolean(runtime.engine.getVariable(addr))

          if (contact.contactType === 'NO_CONTACT' && !val) {
            return recordBlocker(contact, contact.operand, addr, contact.contactType, val, true)
          } else if (contact.contactType === 'NC_CONTACT' && val) {
            return recordBlocker(contact, contact.operand, addr, contact.contactType, val, false)
          } else if ((contact.contactType === 'P_TRIG' || contact.contactType === 'N_TRIG') && !doesNodeConduct(contact)) {
            const wantEdgeVal = contact.contactType === 'P_TRIG' ? !val : val
            const reason =
              contact.contactType === 'P_TRIG'
                ? `Rising edge trigger P_TRIG('${contact.operand}') is idle (requires 0 -> 1 transition)`
                : `Falling edge trigger N_TRIG('${contact.operand}') is idle (requires 1 -> 0 transition)`
            return recordBlocker(contact, contact.operand, addr, contact.contactType, val, wantEdgeVal, reason)
          }
        } else if (node.kind === 'timer') {
          const t = node as LadderTimerNode
          if (!doesNodeConduct(t)) {
            return recordBlocker(t, t.instanceDb, t.qOperand || `${t.instanceDb}.Q`, t.timerType, false, true, `Timer '${t.instanceDb}' Q output is FALSE (0)`)
          }
        } else if (node.kind === 'counter') {
          const c = node as LadderCounterNode
          if (!doesNodeConduct(c)) {
            return recordBlocker(c, c.instanceDb, c.qOperand || `${c.instanceDb}.QU`, c.counterType, false, true, `Counter '${c.instanceDb}' Q output is FALSE (0)`)
          }
        } else if (node.kind === 'comparator') {
          const cmp = node as LadderComparatorNode
          if (!doesNodeConduct(cmp)) {
            return recordBlocker(cmp, `${cmp.op1} ${cmp.comparatorType} ${cmp.op2}`, resolveAddr(cmp.op1), cmp.comparatorType, false, true, `Comparator condition '${cmp.op1} ${cmp.comparatorType} ${cmp.op2}' is FALSE`)
          }
        } else if (node.kind === 'parallel') {
          const p = node as LadderParallelBranchNode
          const conducts = (p.branches || []).some((branch) => branch.every(doesNodeConduct))
          if (!conducts) {
            for (const branch of p.branches || []) {
              if (findBlockingInList(branch)) {
                return true
              }
            }
          }
        }
      }
      return false
    }

    const nodes = (net.nodes || []) as LadderNode[]
    findBlockingInList(nodes)

    // Only fall back to a leading contact if it actually does NOT conduct
    if (!blockingNode) {
      const nonConductingContact = nodes.find((n: LadderNode) => n.kind === 'contact' && !doesNodeConduct(n)) as LadderContactNode | undefined
      if (nonConductingContact) {
        const addr = resolveAddr(nonConductingContact.operand)
        const val = Boolean(runtime.engine.getVariable(addr))
        recordBlocker(
          nonConductingContact,
          nonConductingContact.operand,
          addr,
          nonConductingContact.contactType,
          val,
          nonConductingContact.contactType !== 'NC_CONTACT'
        )
      }
    }

    const resolvedBlockingNode = blockingNode as LadderNode | null
    const blockingInfo: BlockingContactInfo | undefined = resolvedBlockingNode
      ? {
          nodeId: resolvedBlockingNode.id,
          operand: blockingOperand,
          address: blockingTagAddress,
          contactType: blockingType,
          evaluatedValue: blockingVal,
          recommendedForceValue: recommendedForce,
          reason:
            customReason ||
            (blockingType === 'NC_CONTACT'
              ? `Normally Closed contact '${blockingOperand}' is TRUE (1)`
              : `Normally Open contact '${blockingOperand}' is FALSE (0)`)
        }
      : undefined

    const contactName = blockingInfo?.operand || 'Giriş Koşulu'
    const contactAddr = blockingTagAddress ? `(${blockingTagAddress})` : ''
    const stateLabel = blockingInfo ? (blockingInfo.evaluatedValue ? '1 (TRUE)' : '0 (FALSE)') : '0 (FALSE)'
    const forceLabel = blockingInfo?.recommendedForceValue === false ? 'FALSE' : 'TRUE'

    return {
      operand: coilOperand,
      networkNumber: net.networkNumber,
      isEnergized: false,
      blockingContact: blockingInfo,
      explanationTr: `[DIAGNOSTIC] **Bobin Neden Kapalı? (Network ${net.networkNumber})**\n"${coilOperand}" bobininin enerjisiz kalmasının nedeni: Seri hattaki **${contactName}** ${contactAddr} öğesi ${stateLabel} durumunda olduğu için akım yolunu kesiyor.`,
      explanationEn: `[DIAGNOSTIC] **Why is this Coil OFF? (Network ${net.networkNumber})**\nCoil "${coilOperand}" is de-energized because series element **${contactName}** ${contactAddr} is ${stateLabel}, breaking power rail continuity.`,
      suggestedActionTr: blockingInfo
        ? `Test amacıyla '${contactName}' bitini ${forceLabel} olarak zorlayın veya canlı simülasyon üzerinden ilgili dijital girişi güncelleyin.`
        : `Güç hattı giriş koşulunu ve ağ sırasını kontrol edin.`,
      suggestedActionEn: blockingInfo
        ? `Force '${contactName}' bit to ${forceLabel} for testing or update the corresponding channel in simulation.`
        : `Check the rung input conditions and execution order.`
    }
  }

  /**
   * 1-Click action: Force a blocking bit TRUE or FALSE in runtime memory
   */
  public static forceBlockingBit(addressOrSymbol: string, value: boolean): void {
    const runtime = useRuntimeStore.getState()
    const tagStore = useTagStore.getState()
    const allTags = tagStore.tagTables.flatMap((t) => t.tags)
    const found = allTags.find(
      (t) =>
        t.name.toLowerCase() === addressOrSymbol.toLowerCase() ||
        t.address.toLowerCase() === addressOrSymbol.toLowerCase()
    )
    const targetAddress = found?.address || addressOrSymbol

    runtime.forceValue(targetAddress, value, true)
    runtime.engine.setVariable(targetAddress, value)
    if (found?.name) {
      runtime.forceValue(found.name, value, true)
      runtime.engine.setVariable(found.name, value)
    }
  }

  /**
   * 1-Click action: Force the blocking bit TRUE in runtime memory
   */
  public static forceBlockingBitTrue(addressOrSymbol: string): void {
    this.forceBlockingBit(addressOrSymbol, true)
  }
}

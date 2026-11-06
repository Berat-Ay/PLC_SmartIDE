/**
 * Rungline Live "Why is this Coil OFF?" Diagnostics Engine
 * Backwards evaluation through unenergized Ladder AST rungs to pinpoint
 * blocking contact conditions in real-time memory snapshots.
 */

import { LadBlockDefinition, LadNetwork } from '@shared/types/blocks'
import { LadderContactNode, LadderNode, LadderParallelBranchNode } from '@shared/types/ladder'
import { useRuntimeStore } from '../../stores/useRuntimeStore'
import { useTagStore } from '../../stores/useTagStore'

export interface BlockingContactInfo {
  nodeId: string
  operand: string
  address: string
  contactType: string
  evaluatedValue: boolean
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
    const net = block.networks.find((n: LadNetwork) => n.networkNumber === networkNumber) || block.networks[0]
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

    // Trace backwards through network nodes and parallel branches to pinpoint the blocking contact
    let blockingNode: LadderContactNode | null = null
    let blockingTagAddress = ''
    let blockingVal = false

    const doesNodeConduct = (node: LadderNode): boolean => {
      if (node.kind === 'contact') {
        const ct = node as LadderContactNode
        const tag = allTags.find((t) => t.name === ct.operand)
        const addr = tag?.address || ct.operand
        const val = Boolean(runtime.engine.getVariable(addr))
        return ct.contactType === 'NO_CONTACT' ? val : !val
      } else if (node.kind === 'parallel') {
        const p = node as LadderParallelBranchNode
        return (p.branches || []).some((branch) => branch.every(doesNodeConduct))
      }
      return true
    }

    const findBlockingInList = (nodeList: LadderNode[]): boolean => {
      for (const node of nodeList) {
        if (node.kind === 'contact') {
          const contact = node as LadderContactNode
          const tag = allTags.find((t) => t.name === contact.operand)
          const addr = tag?.address || contact.operand
          const val = Boolean(runtime.engine.getVariable(addr))

          if (contact.contactType === 'NO_CONTACT' && !val) {
            blockingNode = contact
            blockingTagAddress = addr
            blockingVal = val
            return true
          } else if (contact.contactType === 'NC_CONTACT' && val) {
            blockingNode = contact
            blockingTagAddress = addr
            blockingVal = val
            return true
          }
        } else if (node.kind === 'parallel') {
          const p = node as LadderParallelBranchNode
          const conducts = (p.branches || []).some((branch) => branch.every(doesNodeConduct))
          if (!conducts) {
            // Find the primary unclosed NO contact in the parallel branch
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

    if (!blockingNode) {
      const firstContact = nodes.find((n: LadderNode) => n.kind === 'contact') as LadderContactNode | undefined
      if (firstContact) {
        const tag = allTags.find((t) => t.name === firstContact.operand)
        blockingNode = firstContact
        blockingTagAddress = tag?.address || firstContact.operand
        blockingVal = false
      }
    }

    const blockingInfo: BlockingContactInfo | undefined = blockingNode
      ? {
        nodeId: blockingNode.id,
        operand: blockingNode.operand,
        address: blockingTagAddress,
        contactType: blockingNode.contactType,
        evaluatedValue: blockingVal,
        reason:
          blockingNode.contactType === 'NO_CONTACT'
            ? `Normally Open contact '${blockingNode.operand}' is FALSE (0)`
            : `Normally Closed contact '${blockingNode.operand}' is TRUE (1)`
      }
      : undefined

    const contactName = blockingNode?.operand || 'Giriş Koşulu'
    const contactAddr = blockingTagAddress ? `(${blockingTagAddress})` : ''

    return {
      operand: coilOperand,
      networkNumber: net.networkNumber,
      isEnergized: false,
      blockingContact: blockingInfo,
      explanationTr: `[DIAGNOSTIC] **Bobin Neden Kapalı? (Network ${net.networkNumber})**\n"${coilOperand}" bobininin enerjisiz kalmasının nedeni: Seri hattaki **${contactName}** ${contactAddr} kontağı ${blockingNode?.contactType === 'NO_CONTACT' ? '0 (FALSE)' : '1 (TRUE)'} durumunda olduğu için akım yolunu kesiyor.`,
      explanationEn: `[DIAGNOSTIC] **Why is this Coil OFF? (Network ${net.networkNumber})**\nCoil "${coilOperand}" is de-energized because series contact **${contactName}** ${contactAddr} is ${blockingNode?.contactType === 'NO_CONTACT' ? '0 (FALSE)' : '1 (TRUE)'}, breaking power rail continuity.`,
      suggestedActionTr: `Test amacıyla '${contactName}' bitini TRUE olarak zorlayın veya canlı simülasyon üzerinden ilgili dijital girişi aktif edin.`,
      suggestedActionEn: `Force '${contactName}' bit to TRUE for testing or activate the corresponding DI channel in simulation.`
    }
  }

  /**
   * 1-Click action: Force the blocking bit TRUE in runtime memory
   */
  public static forceBlockingBitTrue(addressOrSymbol: string): void {
    const runtime = useRuntimeStore.getState()
    const tagStore = useTagStore.getState()
    const allTags = tagStore.tagTables.flatMap((t) => t.tags)
    const found = allTags.find(
      (t) =>
        t.name.toLowerCase() === addressOrSymbol.toLowerCase() ||
        t.address.toLowerCase() === addressOrSymbol.toLowerCase()
    )
    const targetAddress = found?.address || addressOrSymbol

    runtime.forceValue(targetAddress, true, true)
    runtime.engine.setVariable(targetAddress, true)
    if (found?.name) {
      runtime.forceValue(found.name, true, true)
      runtime.engine.setVariable(found.name, true)
    }
  }
}

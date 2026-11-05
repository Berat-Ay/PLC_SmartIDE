import {
  LadderNetwork,
  LadderNode,
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderCounterNode,
  LadderComparatorNode,
  LadderMathNode,
  LadderParallelBranchNode
} from '@shared/types/ladder'
import { SclExecutionContext, SclInterpreter } from './SclInterpreter'
import { S7BinaryMemory, S7TimerState } from './S7BinaryMemory'
import { parseS7Time } from '@shared/s7/time'

export interface TimerInternalState {
  startTime: number
  lastTickTime: number
  running: boolean
  elapsed: number
  q: boolean
  ptVal: number
}

/**
 * Reads a timer preset: a number of ms, a TIME literal or a symbol holding a TIME.
 * An empty or unresolvable preset falls back to 10 s; the compiler reports invalid literals.
 */
export function parseTimePresetMs(val: unknown, context?: SclExecutionContext): number {
  if (typeof val === 'number' && !isNaN(val) && val > 0) {
    return Math.round(val)
  }
  if (!val) return 10000

  const s = String(val).replace(/^["']|["']$/g, '').trim()
  if (!s) return 10000

  if (/^\d+$/.test(s)) {
    const parsed = parseInt(s, 10)
    return parsed > 0 ? parsed : 10000
  }

  const literal = parseS7Time(s)
  if (literal !== null) return literal
  if (/^(LTIME|TIME|LT|T)#/i.test(s)) return 10000

  if (context) {
    try {
      const evalRes = Number(SclInterpreter.evaluateExpression(s, context))
      if (!isNaN(evalRes) && evalRes >= 0) return Math.round(evalRes)
    } catch {
      // Falls through to the default preset
    }
  }
  return 10000
}

export function normalizeTimerKey(inst: unknown): string {
  if (!inst) return 'T1'
  return String(inst).replace(/^["']|["']$/g, '').trim().toUpperCase()
}

export interface CounterInternalState {
  prevCu: boolean
  cv: number
  q: boolean
}

export interface EdgeInternalState {
  prevVal: boolean
}

export interface LadderEvaluationResult {
  nodePowerStates: Record<
    string,
    {
      powered: boolean
      rloIn?: boolean
      isConducting?: boolean
      bitValue?: boolean
      liveValues?: Record<string, string | number>
    }
  >
}

export class LadderEvaluator {
  private static fallbackMemory = new S7BinaryMemory()
  private static edgeStates = new Map<string, EdgeInternalState>()

  public static resetInternalStates(): void {
    this.fallbackMemory = new S7BinaryMemory()
    this.edgeStates.clear()
  }

  /** Reads an operand that may be a literal, a symbol or a small expression. */
  private static readOperand(op: string | undefined, context: SclExecutionContext): unknown {
    const trimmed = (op || '').trim()
    if (!trimmed) return undefined
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
    return SclInterpreter.evaluateExpression(trimmed, context)
  }

  private static writeOperand(op: string, value: unknown, context: SclExecutionContext): void {
    const raw = op.trim()
    context.setVar(raw.replace(/"/g, ''), value, raw.startsWith('"'))
  }

  private static instanceKey(raw: string, context: SclExecutionContext): string {
    const trimmed = raw.trim()
    const quoted = trimmed.startsWith('"')
    const clean = trimmed.replace(/"/g, '')
    return context.resolveInstanceKey ? context.resolveInstanceKey(clean, quoted) : clean
  }

  /**
   * Evaluates a complete Ladder Network given runtime context, current timestamp, and optional binary memory
   */
  public static evaluateNetwork(
    network: LadderNetwork,
    context: SclExecutionContext,
    currentTimeMs: number,
    memory?: S7BinaryMemory
  ): LadderEvaluationResult {
    const nodePowerStates: Record<
      string,
      {
        powered: boolean
        rloIn?: boolean
        isConducting?: boolean
        bitValue?: boolean
        liveValues?: Record<string, string | number>
      }
    > = {}

    // Handle Hybrid SCL Network
    if (network.isSclNetwork && network.sclCode) {
      const result = SclInterpreter.execute(network.sclCode, context)
      if (!result.success) context.onError?.(`Network ${network.networkNumber}: ${result.error}`)
      return { nodePowerStates }
    }

    // Evaluate series ladder rungs starting with power = true from left rail
    let currentPower = true

    if (network.nodes && Array.isArray(network.nodes)) {
      for (const node of network.nodes) {
        currentPower = this.evaluateNode(node, currentPower, context, currentTimeMs, nodePowerStates, memory)
      }
    }

    return { nodePowerStates }
  }

  /**
   * Evaluates a single node and returns the outgoing power state
   */
  private static evaluateNode(
    node: LadderNode,
    incomingPower: boolean,
    context: SclExecutionContext,
    currentTimeMs: number,
    results: Record<
      string,
      {
        powered: boolean
        rloIn?: boolean
        isConducting?: boolean
        bitValue?: boolean
        liveValues?: Record<string, string | number>
      }
    >,
    memory?: S7BinaryMemory
  ): boolean {
    switch (node.kind) {
      case 'contact': {
        const c = node as LadderContactNode
        const cleanOp = (c.operand || '').replace(/"/g, '').trim()
        const operandQuoted = (c.operand || '').trim().startsWith('"')
        let rawVal: unknown = c.address ? context.getVar(c.address) : undefined
        if (rawVal === undefined) rawVal = context.getVar(cleanOp, operandQuoted)
        const isTrue = !!rawVal
        let isConducting = false

        if (c.contactType === 'NO_CONTACT') {
          isConducting = isTrue
        } else if (c.contactType === 'NC_CONTACT') {
          isConducting = !isTrue
        } else if (c.contactType === 'P_TRIG' || c.contactType === 'N_TRIG') {
          // The edge bit lives in its declared operand when there is one, as on a real CPU
          const edgeKey = (context.instancePrefix?.() || '') + (c.edgeTag || c.address || cleanOp)
          const usesEdgeBit = !!c.edgeTag && !!context.hasSymbol?.(c.edgeTag)
          const edgeState = this.edgeStates.get(edgeKey) || { prevVal: false }
          const previous = usesEdgeBit ? !!context.getVar(c.edgeTag as string) : edgeState.prevVal
          isConducting = c.contactType === 'P_TRIG' ? !previous && isTrue : previous && !isTrue
          edgeState.prevVal = isTrue
          this.edgeStates.set(edgeKey, edgeState)
          if (usesEdgeBit) context.setVar(c.edgeTag as string, isTrue)
        }

        const passesPower = incomingPower && isConducting

        results[c.id] = {
          powered: passesPower,
          rloIn: incomingPower,
          isConducting,
          bitValue: isTrue,
          liveValues: {
            val: isTrue ? 'TRUE' : 'FALSE',
            conducting: isConducting ? 'TRUE' : 'FALSE',
            bit: isTrue ? '1' : '0'
          }
        }
        return passesPower
      }

      case 'coil': {
        const c = node as LadderCoilNode
        const operandQuoted = (c.operand || '').trim().startsWith('"')
        const cleanOp = (c.operand || '').replace(/"/g, '').trim()
        const write = (value: boolean): void => {
          if (c.address) context.setVar(c.address, value)
          // With real memory the address and the symbol are one location
          if (!c.address || (!memory && cleanOp && c.address !== cleanOp)) context.setVar(cleanOp, value, operandQuoted)
        }

        if (c.coilType === 'OUTPUT_COIL') write(incomingPower)
        else if (c.coilType === 'NEGATED_COIL') write(!incomingPower)
        else if (c.coilType === 'SET_COIL' && incomingPower) write(true)
        else if (c.coilType === 'RESET_COIL' && incomingPower) write(false)

        results[c.id] = {
          powered: incomingPower,
          rloIn: incomingPower,
          isConducting: true,
          bitValue: incomingPower,
          liveValues: {
            state: incomingPower ? 'ON' : 'OFF',
            val: incomingPower ? 'TRUE' : 'FALSE'
          }
        }
        return incomingPower
      }

      case 'parallel': {
        const p = node as LadderParallelBranchNode
        let anyBranchPassed = false

        for (const branch of p.branches) {
          let branchPower = incomingPower
          for (const subNode of branch) {
            branchPower = this.evaluateNode(subNode, branchPower, context, currentTimeMs, results, memory)
          }
          if (branchPower) {
            anyBranchPassed = true
          }
        }

        results[p.id] = {
          powered: anyBranchPassed,
          rloIn: incomingPower
        }
        return anyBranchPassed
      }

      case 'timer': {
        const t = node as LadderTimerNode
        const instName = normalizeTimerKey(
          this.instanceKey(
            t.instanceDb ||
              (t as unknown as { instanceName?: string }).instanceName ||
              (t as unknown as { operand?: string }).operand ||
              (t as unknown as { label?: string }).label ||
              (t as unknown as { id?: string }).id ||
              'T1',
            context
          )
        )

        const ptRaw =
          (t as unknown as { ptMs?: number }).ptMs ??
          t.ptOperand ??
          (t as unknown as { presetTime?: string | number }).presetTime ??
          (t as unknown as { timePreset?: string }).timePreset ??
          'T#10s'
        const ptVal = parseTimePresetMs(ptRaw, context)

        const mem = memory || this.fallbackMemory
        const s7t: S7TimerState =
          t.timerType === 'TON'
            ? mem.updateTonTimer(instName, incomingPower, ptVal, currentTimeMs)
            : t.timerType === 'TOF'
              ? mem.updateTofTimer(instName, incomingPower, ptVal, currentTimeMs)
              : mem.updateTpTimer(instName, incomingPower, ptVal, currentTimeMs)
        const q = s7t.Q
        const etMs = Math.round(s7t.ET)
        const ptMs = Math.round(ptVal)
        const progress = ptMs > 0 ? Math.min(100, Math.round((etMs / ptMs) * 100)) : 0

        // Without binary memory the caller's context is the only place these can be read back
        if (!memory) {
          context.setVar(`${instName}.IN`, incomingPower)
          context.setVar(`${instName}.Q`, q)
          context.setVar(`${instName}.ET`, etMs)
          context.setVar(`${instName}.PT`, ptMs)
        }
        if (t.qOperand) this.writeOperand(t.qOperand, q, context)
        if (t.etOperand) this.writeOperand(t.etOperand, etMs, context)

        results[t.id] = {
          powered: q,
          rloIn: incomingPower,
          liveValues: {
            ET: `${etMs}ms`,
            PT: `${ptMs}ms`,
            display: `${etMs}ms / ${ptMs}ms`,
            progress,
            Q: q ? 'TRUE' : 'FALSE'
          }
        }
        return q
      }

      case 'counter': {
        const c = node as LadderCounterNode
        const instName = normalizeTimerKey(this.instanceKey(c.instanceDb || 'C1', context))

        const pv = Number(this.readOperand(c.pvOperand, context)) || 10
        const isReset = !!this.readOperand(c.rLdOperand, context)
        const cuRlo = c.cuOperand ? !!this.readOperand(c.cuOperand, context) : incomingPower
        const cdRlo = c.cdOperand
          ? !!this.readOperand(c.cdOperand, context)
          : c.counterType === 'CTD'
            ? incomingPower
            : false

        const mem = memory || this.fallbackMemory
        const s7c =
          c.counterType === 'CTUD'
            ? mem.updateCtudCounter(instName, cuRlo, cdRlo, isReset, false, pv)
            : c.counterType === 'CTD'
              ? mem.updateCtdCounter(instName, cdRlo, isReset, pv)
              : mem.updateCtuCounter(instName, cuRlo, isReset, pv)
        const { QU: qu, QD: qd, CV: cv } = s7c
        const q = c.counterType === 'CTD' ? qd : qu

        if (!memory) {
          context.setVar(`${instName}.QU`, qu)
          context.setVar(`${instName}.QD`, qd)
          context.setVar(`${instName}.Q`, q)
          context.setVar(`${instName}.CV`, cv)
          context.setVar(`${instName}.PV`, pv)
        }
        if (c.qOperand) this.writeOperand(c.qOperand, q, context)
        if (c.cvOperand) this.writeOperand(c.cvOperand, cv, context)

        results[c.id] = {
          powered: q,
          liveValues: { CV: cv, PV: pv, QU: qu ? 'TRUE' : 'FALSE', QD: qd ? 'TRUE' : 'FALSE', Q: q ? 'TRUE' : 'FALSE' }
        }
        return q
      }

      case 'comparator': {
        const cmp = node as LadderComparatorNode
        const evalOperand = (op: string): number => {
          const value = this.readOperand(op, context)
          if (typeof value === 'boolean') return value ? 1 : 0
          const num = Number(value)
          return isNaN(num) ? 0 : num
        }

        const v1 = evalOperand(cmp.op1)
        const v2 = evalOperand(cmp.op2)
        let res = false

        if (cmp.comparatorType === 'CMP_EQ') res = v1 === v2
        else if (cmp.comparatorType === 'CMP_NE') res = v1 !== v2
        else if (cmp.comparatorType === 'CMP_GT') res = v1 > v2
        else if (cmp.comparatorType === 'CMP_LT') res = v1 < v2
        else if (cmp.comparatorType === 'CMP_GE') res = v1 >= v2
        else if (cmp.comparatorType === 'CMP_LE') res = v1 <= v2

        const passesPower = incomingPower && res
        results[cmp.id] = {
          powered: passesPower,
          liveValues: { in1: v1, in2: v2, result: res ? 'TRUE' : 'FALSE' }
        }
        return passesPower
      }

      case 'math': {
        const m = node as LadderMathNode
        if (!incomingPower) {
          results[m.id] = { powered: false }
          return false
        }

        if (m.boxType === 'NORM_X') {
          const min = Number(SclInterpreter.evaluateExpression(m.min || '0', context)) || 0
          const max = Number(SclInterpreter.evaluateExpression(m.max || m.in2 || '27648', context)) || 27648
          const val = Number(SclInterpreter.evaluateExpression(m.value || m.in1 || '0', context)) || 0
          const norm = max !== min ? (val - min) / (max - min) : 0
          if (m.out) this.writeOperand(m.out, norm, context)
          results[m.id] = {
            powered: true,
            liveValues: { in: val, out: Math.round(norm * 1000) / 1000 }
          }
        } else if (m.boxType === 'SCALE_X') {
          const min = Number(SclInterpreter.evaluateExpression(m.min || '0', context)) || 0
          const max = Number(SclInterpreter.evaluateExpression(m.max || m.in2 || '10', context)) || 10
          const val = Number(SclInterpreter.evaluateExpression(m.value || m.in1 || '0', context)) || 0
          const scaled = min + val * (max - min)
          if (m.out) this.writeOperand(m.out, scaled, context)
          results[m.id] = {
            powered: true,
            liveValues: { in: Math.round(val * 1000) / 1000, out: Math.round(scaled * 100) / 100 }
          }
        } else if (m.boxType === 'MOVE') {
          const val = SclInterpreter.evaluateExpression(m.in1 || '0', context)
          if (m.out) this.writeOperand(m.out, val, context)
          results[m.id] = { powered: true, liveValues: { val: String(val) } }
        } else {
          const in1 = Number(SclInterpreter.evaluateExpression(m.in1 || '0', context)) || 0
          const in2 = Number(SclInterpreter.evaluateExpression(m.in2 || '0', context)) || 0
          let outVal = 0
          if (m.boxType === 'ADD') outVal = in1 + in2
          else if (m.boxType === 'SUB') outVal = in1 - in2
          else if (m.boxType === 'MUL') outVal = in1 * in2
          else if (m.boxType === 'DIV') {
            const outType = m.out ? context.typeOf?.(m.out.replace(/"/g, ''), m.out.trim().startsWith('"'))?.toUpperCase() : undefined
            const isRealOut = !outType || outType === 'REAL' || outType === 'LREAL'
            outVal = in2 !== 0 ? (isRealOut ? in1 / in2 : Math.trunc(in1 / in2)) : 0
          }

          if (m.out) this.writeOperand(m.out, outVal, context)
          results[m.id] = {
            powered: true,
            liveValues: { in1, in2, out: Math.round(outVal * 100) / 100 }
          }
        }

        return true
      }
    }

    return incomingPower
  }
}

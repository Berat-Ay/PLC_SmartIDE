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
import { S7BinaryMemory, S7TimerState, S7CounterState } from './S7BinaryMemory'

export interface TimerInternalState {
  startTime: number
  lastTickTime: number
  running: boolean
  elapsed: number
  q: boolean
  ptVal: number
}

export function parseTimePresetMs(val: unknown, context?: SclExecutionContext): number {
  if (typeof val === 'number' && !isNaN(val) && val > 0) {
    return Math.round(val)
  }
  if (!val) return 10000

  let s = String(val).replace(/^["']|["']$/g, '').trim()
  if (!s) return 10000

  // 1. Pure integer string e.g. "10000"
  if (/^\d+$/.test(s)) {
    const parsed = parseInt(s, 10)
    return parsed > 0 ? parsed : 10000
  }

  // Strip optional leading T#
  if (s.toUpperCase().startsWith('T#')) {
    s = s.substring(2).trim()
  }

  // 2. Tokenize components: e.g. 1m30s, 500ms, 10s, 2m
  let totalMs = 0
  let matchedAny = false

  const mMatch = s.match(/(\d+)\s*m(?!s)/i)
  if (mMatch) {
    totalMs += parseInt(mMatch[1], 10) * 60000
    matchedAny = true
  }

  const sMatch = s.match(/(\d+)\s*s(?![a-z])/i)
  if (sMatch) {
    totalMs += parseInt(sMatch[1], 10) * 1000
    matchedAny = true
  }

  const msMatch = s.match(/(\d+)\s*ms/i)
  if (msMatch) {
    totalMs += parseInt(msMatch[1], 10)
    matchedAny = true
  }

  if (matchedAny && totalMs > 0) {
    return totalMs
  }

  // 3. SCL time expression evaluation
  if (context) {
    try {
      const evalRes = Number(SclInterpreter.evaluateExpression(s, context))
      if (!isNaN(evalRes) && evalRes > 0) return Math.round(evalRes)
    } catch {
      // ignore
    }
  }

  // 4. Symbolic variable in context (e.g. tag named 'PresetDwell')
  if (context && !s.startsWith('%') && !s.toUpperCase().startsWith('T#')) {
    const ctxVal = context.getVar(s)
    if (typeof ctxVal === 'number' && !isNaN(ctxVal) && ctxVal > 0) {
      return Math.round(ctxVal)
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
  private static timerStates = new Map<string, TimerInternalState>()
  private static counterStates = new Map<string, CounterInternalState>()
  private static edgeStates = new Map<string, EdgeInternalState>()

  public static resetInternalStates(): void {
    this.timerStates.clear()
    this.counterStates.clear()
    this.edgeStates.clear()
  }

  public static getAllTimerStates(): Map<string, TimerInternalState> {
    return this.timerStates
  }

  public static getTimerState(key: string): TimerInternalState | undefined {
    return this.timerStates.get(key.toUpperCase()) || this.timerStates.get(key)
  }

  public static setTimerState(key: string, state: TimerInternalState): void {
    this.timerStates.set(key.toUpperCase(), state)
  }

  public static getCounterState(key: string): CounterInternalState | undefined {
    return this.counterStates.get(key.toUpperCase()) || this.counterStates.get(key)
  }

  public static setCounterState(key: string, state: CounterInternalState): void {
    this.counterStates.set(key.toUpperCase(), state)
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
      SclInterpreter.execute(network.sclCode, context)
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
        const cleanOp = (c.operand || '').replace(/^"|"$/g, '').trim()
        let rawVal: unknown = undefined
        if (c.address) {
          rawVal = context.getVar(c.address)
        }
        if (rawVal === undefined || rawVal === 0 || rawVal === false) {
          const symVal = context.getVar(cleanOp)
          if (symVal !== undefined && symVal !== 0 && symVal !== false) {
            rawVal = symVal
          } else if (rawVal === undefined) {
            rawVal = symVal
          }
        }

        // Direct Native Timer & Counter Sub-bit Resolution (e.g. T1.Q, T1, C1.QU)
        if (rawVal === undefined || rawVal === 0 || rawVal === false) {
          const opUpper = cleanOp.toUpperCase()
          const timerMatch = opUpper.match(/^([A-Za-z0-9_]+)\.(Q|IN|ET|PT)$/)
          if (timerMatch) {
            const inst = normalizeTimerKey(timerMatch[1])
            const member = timerMatch[2]
            if (memory) {
              const tMem = memory.getTimer(inst)
              if (member === 'Q') rawVal = tMem.Q
              else if (member === 'ET') rawVal = tMem.ET
              else if (member === 'IN') rawVal = tMem.IN
              else if (member === 'PT') rawVal = tMem.PT
            } else {
              const t = this.getTimerState(inst)
              if (t) {
                if (member === 'Q') rawVal = t.q
                else if (member === 'ET') rawVal = t.elapsed
                else if (member === 'IN') rawVal = t.running
                else if (member === 'PT') rawVal = t.ptVal
              }
            }
          } else if (/^T\d+$/i.test(opUpper)) {
            if (memory) {
              rawVal = memory.getTimer(opUpper).Q
            } else {
              const t = this.getTimerState(opUpper)
              if (t) rawVal = t.q
            }
          }

          const counterMatch = opUpper.match(/^([A-Za-z0-9_]+)\.(QU|QD|CV|PV)$/)
          if (counterMatch) {
            const inst = counterMatch[1].toUpperCase()
            const member = counterMatch[2]
            if (memory) {
              const cMem = memory.getCounter(inst)
              if (member === 'QU' || member === 'Q') rawVal = cMem.QU
              else if (member === 'QD') rawVal = cMem.QD
              else if (member === 'CV') rawVal = cMem.CV
              else if (member === 'PV') rawVal = cMem.PV
            } else {
              const cState = this.getCounterState(inst)
              if (cState && (member === 'QU' || member === 'Q')) rawVal = cState.q
            }
          } else if (/^C\d+$/i.test(opUpper)) {
            if (memory) {
              rawVal = memory.getCounter(opUpper).QU
            } else {
              const cState = this.getCounterState(opUpper)
              if (cState) rawVal = cState.q
            }
          }
        }
        const isTrue = !!rawVal
        let isConducting = false

        if (c.contactType === 'NO_CONTACT') {
          isConducting = isTrue
        } else if (c.contactType === 'NC_CONTACT') {
          isConducting = !isTrue
        } else if (c.contactType === 'P_TRIG') {
          const edgeKey = c.edgeTag || c.address || cleanOp
          const edgeState = this.edgeStates.get(edgeKey) || { prevVal: false }
          isConducting = !edgeState.prevVal && isTrue
          edgeState.prevVal = isTrue
          this.edgeStates.set(edgeKey, edgeState)
        } else if (c.contactType === 'N_TRIG') {
          const edgeKey = c.edgeTag || c.address || cleanOp
          const edgeState = this.edgeStates.get(edgeKey) || { prevVal: false }
          isConducting = edgeState.prevVal && !isTrue
          edgeState.prevVal = isTrue
          this.edgeStates.set(edgeKey, edgeState)
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
        const cleanOp = (c.operand || '').replace(/^"|"$/g, '').trim()
        const targetKey = c.address || cleanOp

        if (c.coilType === 'OUTPUT_COIL') {
          context.setVar(targetKey, incomingPower)
          if (c.address && cleanOp && c.address !== cleanOp) {
            context.setVar(cleanOp, incomingPower)
          }
        } else if (c.coilType === 'NEGATED_COIL') {
          context.setVar(targetKey, !incomingPower)
          if (c.address && cleanOp && c.address !== cleanOp) {
            context.setVar(cleanOp, !incomingPower)
          }
        } else if (c.coilType === 'SET_COIL') {
          if (incomingPower) {
            context.setVar(targetKey, true)
            if (c.address && cleanOp && c.address !== cleanOp) {
              context.setVar(cleanOp, true)
            }
          }
        } else if (c.coilType === 'RESET_COIL') {
          if (incomingPower) {
            context.setVar(targetKey, false)
            if (c.address && cleanOp && c.address !== cleanOp) {
              context.setVar(cleanOp, false)
            }
          }
        }

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
          t.instanceDb ||
          (t as unknown as { instanceName?: string }).instanceName ||
          (t as unknown as { operand?: string }).operand ||
          (t as unknown as { label?: string }).label ||
          (t as unknown as { id?: string }).id ||
          'T1'
        )
        const key = instName

        const ptRaw =
          (t as unknown as { ptMs?: number }).ptMs ??
          t.ptOperand ??
          (t as unknown as { presetTime?: string | number }).presetTime ??
          (t as unknown as { timePreset?: string }).timePreset ??
          'T#10s'
        const ptVal = parseTimePresetMs(ptRaw, context)

        let running = false
        let elapsed = 0
        let q = false

        if (memory) {
          let s7t: S7TimerState
          if (t.timerType === 'TON') {
            s7t = memory.updateTonTimer(instName, incomingPower, ptVal, currentTimeMs)
          } else if (t.timerType === 'TOF') {
            s7t = memory.updateTofTimer(instName, incomingPower, ptVal, currentTimeMs)
          } else {
            s7t = memory.updateTpTimer(instName, incomingPower, ptVal, currentTimeMs)
          }
          running = s7t.running
          elapsed = s7t.ET
          q = s7t.Q

          this.setTimerState(key, {
            startTime: s7t.startTime,
            lastTickTime: s7t.lastTickTime,
            running: s7t.running,
            elapsed: s7t.ET,
            q: s7t.Q,
            ptVal
          })
        } else {
          let timer = this.timerStates.get(key)
          if (!timer) {
            timer = { startTime: 0, lastTickTime: currentTimeMs, running: false, elapsed: 0, q: false, ptVal: 10000 }
            this.timerStates.set(key, timer)
          }
          timer.ptVal = ptVal

          if (t.timerType === 'TON') {
            if (incomingPower) {
              if (!timer.running) {
                timer.running = true
                timer.startTime = currentTimeMs
                timer.lastTickTime = currentTimeMs
                timer.elapsed = 0
                timer.q = false
              } else {
                const dt = Math.max(10, currentTimeMs - timer.lastTickTime)
                timer.lastTickTime = currentTimeMs
                const fromStart = currentTimeMs - timer.startTime
                timer.elapsed = Math.min(ptVal, Math.max(fromStart, timer.elapsed + dt))
                if (timer.elapsed >= ptVal) {
                  timer.q = true
                }
              }
            } else {
              timer.running = false
              timer.elapsed = 0
              timer.q = false
              timer.lastTickTime = currentTimeMs
            }
          } else if (t.timerType === 'TOF') {
            if (incomingPower) {
              timer.running = false
              timer.elapsed = 0
              timer.q = true
              timer.lastTickTime = currentTimeMs
            } else if (timer.q) {
              if (!timer.running) {
                timer.running = true
                timer.startTime = currentTimeMs
                timer.lastTickTime = currentTimeMs
              } else {
                const dt = Math.max(10, currentTimeMs - timer.lastTickTime)
                timer.lastTickTime = currentTimeMs
                timer.elapsed = Math.min(ptVal, Math.max(currentTimeMs - timer.startTime, timer.elapsed + dt))
                if (timer.elapsed >= ptVal) {
                  timer.q = false
                  timer.running = false
                }
              }
            }
          } else if (t.timerType === 'TP') {
            if (incomingPower && !timer.running && !timer.q) {
              timer.running = true
              timer.startTime = currentTimeMs
              timer.lastTickTime = currentTimeMs
              timer.elapsed = 0
              timer.q = true
            } else if (timer.running) {
              const dt = Math.max(10, currentTimeMs - timer.lastTickTime)
              timer.lastTickTime = currentTimeMs
              timer.elapsed = Math.min(ptVal, Math.max(currentTimeMs - timer.startTime, timer.elapsed + dt))
              if (timer.elapsed >= ptVal) {
                timer.q = false
                timer.running = false
              }
            }
          }
          running = timer.running
          elapsed = timer.elapsed
          q = timer.q
        }

        // Export native timer instance variables directly to context and memory
        const etMs = Math.round(elapsed)
        const ptMs = Math.round(ptVal)
        const progress = ptMs > 0 ? Math.min(100, Math.round((etMs / ptMs) * 100)) : 0

        context.setVar(`${instName}.IN`, incomingPower)
        context.setVar(`${instName}.Q`, q)
        context.setVar(`${instName}.ET`, etMs)
        context.setVar(`${instName}.PT`, ptMs)
        context.setVar(`${key}.IN`, incomingPower)
        context.setVar(`${key}.Q`, q)
        context.setVar(`${key}.ET`, etMs)
        context.setVar(`${key}.PT`, ptMs)

        if (memory) {
          memory.setVariable(`${instName}.IN`, incomingPower)
          memory.setVariable(`${instName}.Q`, q)
          memory.setVariable(`${instName}.ET`, etMs)
          memory.setVariable(`${instName}.PT`, ptMs)
          memory.setVariable(`${key}.IN`, incomingPower)
          memory.setVariable(`${key}.Q`, q)
          memory.setVariable(`${key}.ET`, etMs)
          memory.setVariable(`${key}.PT`, ptMs)
        }

        if (t.qOperand) {
          context.setVar(t.qOperand, q)
          if (memory) memory.setVariable(t.qOperand, q)
        }
        if (t.etOperand) {
          context.setVar(t.etOperand, etMs)
          if (memory) memory.setVariable(t.etOperand, etMs)
        }

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
        const instName = c.instanceDb || 'C1'
        const key = instName.toUpperCase()

        const pv = Number(context.getVar(c.pvOperand)) || Number(c.pvOperand) || 10
        const isReset = !!(c.rLdOperand ? context.getVar(c.rLdOperand) : false)

        // Resolve CU and CD inputs
        let cuRlo = incomingPower
        if (c.cuOperand) {
          cuRlo = !!context.getVar(c.cuOperand)
        }
        let cdRlo = false
        if (c.cdOperand) {
          cdRlo = !!context.getVar(c.cdOperand)
        } else if (c.counterType === 'CTD') {
          cdRlo = incomingPower
        }

        let qu = false
        let qd = false
        let cv = 0

        if (memory) {
          if (c.counterType === 'CTUD') {
            const s7c = memory.updateCtudCounter(instName, cuRlo, cdRlo, isReset, false, pv)
            qu = s7c.QU
            qd = s7c.QD
            cv = s7c.CV
          } else if (c.counterType === 'CTD') {
            const s7c = memory.updateCtdCounter(instName, cdRlo, isReset, pv)
            qu = s7c.QU
            qd = s7c.QD
            cv = s7c.CV
          } else {
            const s7c = memory.updateCtuCounter(instName, cuRlo, isReset, pv)
            qu = s7c.QU
            qd = s7c.QD
            cv = s7c.CV
          }
          this.setCounterState(key, { prevCu: cuRlo, cv, q: c.counterType === 'CTD' ? qd : qu })
        } else {
          let counter = this.counterStates.get(key)
          if (!counter) {
            counter = { prevCu: false, cv: c.counterType === 'CTD' ? pv : 0, q: false }
            this.counterStates.set(key, counter)
          }

          if (isReset) {
            counter.cv = c.counterType === 'CTD' ? pv : 0
            counter.q = c.counterType === 'CTD'
          } else {
            if (c.counterType === 'CTUD') {
              const edgeStateCd = this.edgeStates.get(`${key}_CD`) || { prevVal: false }
              if (!counter.prevCu && cuRlo && counter.cv < 32767) {
                counter.cv++
              }
              if (!edgeStateCd.prevVal && cdRlo && counter.cv > 0) {
                counter.cv--
              }
              edgeStateCd.prevVal = cdRlo
              this.edgeStates.set(`${key}_CD`, edgeStateCd)
            } else if (c.counterType === 'CTD') {
              if (!counter.prevCu && cdRlo && counter.cv > 0) {
                counter.cv--
              }
            } else {
              if (!counter.prevCu && cuRlo) {
                counter.cv++
              }
            }
            qu = counter.cv >= pv
            qd = counter.cv <= 0
            counter.q = c.counterType === 'CTD' ? qd : qu
          }
          counter.prevCu = cuRlo
          cv = counter.cv
          qu = counter.cv >= pv
          qd = counter.cv <= 0
        }

        const q = c.counterType === 'CTD' ? qd : qu

        // Export native counter instance variables directly to context
        context.setVar(`${instName}.QU`, qu)
        context.setVar(`${instName}.QD`, qd)
        context.setVar(`${instName}.Q`, q)
        context.setVar(`${instName}.CV`, cv)
        context.setVar(`${instName}.PV`, pv)
        context.setVar(`${key}.QU`, qu)
        context.setVar(`${key}.QD`, qd)
        context.setVar(`${key}.Q`, q)
        context.setVar(`${key}.CV`, cv)
        context.setVar(`${key}.PV`, pv)

        if (memory) {
          memory.setVariable(`${instName}.QU`, qu)
          memory.setVariable(`${instName}.QD`, qd)
          memory.setVariable(`${instName}.Q`, q)
          memory.setVariable(`${instName}.CV`, cv)
          memory.setVariable(`${instName}.PV`, pv)
          memory.setVariable(`${key}.QU`, qu)
          memory.setVariable(`${key}.QD`, qd)
          memory.setVariable(`${key}.Q`, q)
          memory.setVariable(`${key}.CV`, cv)
          memory.setVariable(`${key}.PV`, pv)
        }

        if (c.qOperand) {
          context.setVar(c.qOperand, q)
          if (memory) memory.setVariable(c.qOperand, q)
        }
        if (c.cvOperand) {
          context.setVar(c.cvOperand, cv)
          if (memory) memory.setVariable(c.cvOperand, cv)
        }

        results[c.id] = {
          powered: q,
          liveValues: { CV: cv, PV: pv, QU: qu ? 'TRUE' : 'FALSE', QD: qd ? 'TRUE' : 'FALSE', Q: q ? 'TRUE' : 'FALSE' }
        }
        return q
      }

      case 'comparator': {
        const cmp = node as LadderComparatorNode
        const evalOperand = (op: string): number => {
          const trimmed = (op || '').trim()
          if (!trimmed) return 0
          const directVal = context.getVar(trimmed)
          if (directVal !== undefined && typeof directVal === 'number') {
            return directVal
          }
          if (typeof directVal === 'boolean') {
            return directVal ? 1 : 0
          }
          try {
            const exprRes = SclInterpreter.evaluateExpression(trimmed, context)
            if (exprRes !== undefined && !isNaN(Number(exprRes))) {
              return Number(exprRes)
            }
          } catch {
            // ignore
          }
          const num = Number(trimmed)
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
          if (m.out) context.setVar(m.out, norm)
          results[m.id] = {
            powered: true,
            liveValues: { in: val, out: Math.round(norm * 1000) / 1000 }
          }
        } else if (m.boxType === 'SCALE_X') {
          const min = Number(SclInterpreter.evaluateExpression(m.min || '0', context)) || 0
          const max = Number(SclInterpreter.evaluateExpression(m.max || m.in2 || '10', context)) || 10
          const val = Number(SclInterpreter.evaluateExpression(m.value || m.in1 || '0', context)) || 0
          const scaled = min + val * (max - min)
          if (m.out) context.setVar(m.out, scaled)
          results[m.id] = {
            powered: true,
            liveValues: { in: Math.round(val * 1000) / 1000, out: Math.round(scaled * 100) / 100 }
          }
        } else if (m.boxType === 'MOVE') {
          const val = SclInterpreter.evaluateExpression(m.in1 || '0', context)
          if (m.out) context.setVar(m.out, val)
          results[m.id] = { powered: true, liveValues: { val: String(val) } }
        } else {
          const in1 = Number(SclInterpreter.evaluateExpression(m.in1 || '0', context)) || 0
          const in2 = Number(SclInterpreter.evaluateExpression(m.in2 || '0', context)) || 0
          let outVal = 0
          if (m.boxType === 'ADD') outVal = in1 + in2
          else if (m.boxType === 'SUB') outVal = in1 - in2
          else if (m.boxType === 'MUL') outVal = in1 * in2
          else if (m.boxType === 'DIV') outVal = in2 !== 0 ? in1 / in2 : 0

          if (m.out) context.setVar(m.out, outVal)
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

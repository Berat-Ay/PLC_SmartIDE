import { BuiltinInstanceKind, builtinInstanceKind } from '@shared/s7/typeLayout'
import type { BlockInterface, LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import type { LadderNode } from '@shared/types/ladder'
import type { SclBlockCall } from '../SclInterpreter'
import type { S7BinaryMemory } from '../S7BinaryMemory'
import type { DbEntry } from './DbRegistry'

export type TimerStateRecord = Record<string, { IN: boolean; Q: boolean; PT: number; ET: number }>
export type CounterStateRecord = Record<
  string,
  { CU: boolean; CD: boolean; R: boolean; PV: number; QU: boolean; QD: boolean; CV: number }
>

export interface BuiltinManagerHost {
  memory: S7BinaryMemory
  clock: () => number
  getDbEntries: () => IterableIterator<DbEntry>
  getLiveLadBlocks: () => LadBlockDefinition[]
  getLiveSclBlocks: () => SclBlockDefinition[]
  interfaceOf: (block: LadBlockDefinition | SclBlockDefinition) => BlockInterface
}

/**
 * Manages IEC Timer (TON/TOF/TP/TONR), Counter (CTU/CTD/CTUD), and Edge (R_TRIG/F_TRIG)
 * builtin execution and instance field inspection.
 */
export class BuiltinInstanceManager {
  public timerStates: TimerStateRecord = {}
  public counterStates: CounterStateRecord = {}

  constructor(private readonly host: BuiltinManagerHost) {}

  public clear(): void {
    this.timerStates = {}
    this.counterStates = {}
  }

  public syncInstanceStates(): void {
    for (const [key, t] of this.host.memory.timerStates.entries()) {
      this.timerStates[key] = { IN: t.IN, Q: t.Q, PT: t.PT, ET: Math.round(t.ET) }
    }
    for (const [key, c] of this.host.memory.counterStates.entries()) {
      this.counterStates[key] = { CU: c.CU, CD: c.CD, R: c.R, PV: c.PV, QU: c.QU, QD: c.QD, CV: c.CV }
    }
  }

  public ingestWorkerStates(
    timerStates?: TimerStateRecord,
    counterStates?: CounterStateRecord
  ): void {
    if (timerStates) {
      this.timerStates = { ...timerStates }
      for (const [k, st] of Object.entries(timerStates)) {
        const t = this.host.memory.getTimer(k)
        t.IN = st.IN
        t.Q = st.Q
        t.PT = st.PT
        t.ET = st.ET
      }
    }
    if (counterStates) {
      this.counterStates = { ...counterStates }
      for (const [k, st] of Object.entries(counterStates)) {
        const c = this.host.memory.getCounter(k)
        c.CU = st.CU
        c.CD = st.CD
        c.R = st.R
        c.PV = st.PV
        c.QU = st.QU
        c.QD = st.QD
        c.CV = st.CV
      }
    }
  }

  public callBuiltin(kind: BuiltinInstanceKind, key: string, call: SclBlockCall): void {
    const inputs = new Map(Object.entries(call.inputs).map(([k, v]) => [k.toUpperCase(), v]))
    const has = (n: string, pos?: number): boolean => inputs.has(n) || (pos !== undefined && inputs.has(`ARG_${pos}`))
    const get = (n: string, pos?: number): unknown =>
      inputs.has(n) ? inputs.get(n) : pos !== undefined ? inputs.get(`ARG_${pos}`) : undefined
    const bool = (n: string, fallback: boolean, pos?: number): boolean => (has(n, pos) ? !!get(n, pos) : fallback)
    const num = (n: string, fallback: number, pos?: number): number =>
      has(n, pos) ? Number(get(n, pos)) || 0 : fallback
    const out = (n: string, value: unknown, pos?: number): void => {
      const writerKey =
        Object.keys(call.writers).find((k) => k.toUpperCase() === n) ||
        (pos !== undefined ? Object.keys(call.writers).find((k) => k.toUpperCase() === `ARG_${pos}`) : undefined)
      if (writerKey) call.writers[writerKey](value)
    }
    const now = this.host.clock()

    if (kind === 'TON' || kind === 'TOF' || kind === 'TP') {
      const current = this.host.memory.getTimer(key)
      const inVal = bool('IN', current.IN, 0)
      const pt = num('PT', current.PT, 1)
      const t =
        kind === 'TON'
          ? this.host.memory.updateTonTimer(key, inVal, pt, now)
          : kind === 'TOF'
            ? this.host.memory.updateTofTimer(key, inVal, pt, now)
            : this.host.memory.updateTpTimer(key, inVal, pt, now)
      out('Q', t.Q, 2)
      out('ET', t.ET, 3)
    } else if (kind === 'TONR') {
      const current = this.host.memory.getTimer(key)
      const inVal = bool('IN', current.IN, 0)
      const rVal = bool('R', false, 1)
      const pt = num('PT', current.PT, 2)
      const t = this.host.memory.updateTonrTimer(key, inVal, rVal, pt, now)
      out('Q', t.Q, 3)
      out('ET', t.ET, 4)
    } else if (kind === 'R_TRIG' || kind === 'F_TRIG') {
      const e = this.host.memory.updateEdge(key, kind, bool('CLK', false, 0))
      out('Q', e.Q, 1)
    } else if (kind === 'CTU') {
      const current = this.host.memory.getCounter(key)
      const pv = num('PV', current.PV, 2)
      const c = this.host.memory.updateCtuCounter(key, bool('CU', false, 0), bool('R', false, 1), pv)
      out('Q', c.QU, 3)
      out('QU', c.QU)
      out('QD', c.QD)
      out('CV', c.CV, 4)
    } else if (kind === 'CTD') {
      const current = this.host.memory.getCounter(key)
      const pv = num('PV', current.PV, 2)
      const c = this.host.memory.updateCtdCounter(key, bool('CD', false, 0), bool('LD', false, 1), pv)
      out('Q', c.QD, 3)
      out('QU', c.QU)
      out('QD', c.QD)
      out('CV', c.CV, 4)
    } else {
      const current = this.host.memory.getCounter(key)
      const pv = num('PV', current.PV, 4)
      const c = this.host.memory.updateCtudCounter(
        key,
        bool('CU', false, 0),
        bool('CD', false, 1),
        bool('R', false, 2),
        bool('LD', false, 3),
        pv
      )
      out('Q', c.QU)
      out('QU', c.QU, 5)
      out('QD', c.QD, 6)
      out('CV', c.CV, 7)
    }
  }

  public declaredBuiltinKind(upperKey: string): BuiltinInstanceKind | undefined {
    for (const entry of this.host.getDbEntries()) {
      if (entry.name.toUpperCase() === upperKey && entry.builtin) return entry.builtin
    }

    const findInNodes = (nodes: LadderNode[]): BuiltinInstanceKind | undefined => {
      for (const n of nodes) {
        if (n.kind === 'counter') {
          const db = (n.instanceDb || '').replace(/^["']|["']$/g, '').trim().toUpperCase()
          if (db === upperKey || upperKey.endsWith(`.${db}`)) return n.counterType
        } else if (n.kind === 'timer') {
          const db = (n.instanceDb || '').replace(/^["']|["']$/g, '').trim().toUpperCase()
          if (db === upperKey || upperKey.endsWith(`.${db}`)) return n.timerType
        } else if (n.kind === 'parallel') {
          for (const branch of n.branches) {
            const found = findInNodes(branch)
            if (found) return found
          }
        }
      }
      return undefined
    }

    for (const lad of this.host.getLiveLadBlocks()) {
      for (const net of lad.networks || []) {
        const found = findInNodes(net.nodes || [])
        if (found) return found
      }
    }

    const tail = upperKey.split('.').pop() || upperKey
    for (const scl of this.host.getLiveSclBlocks()) {
      const iface = this.host.interfaceOf(scl)
      for (const v of [...iface.static, ...iface.inOut, ...iface.input, ...iface.output]) {
        if (v.name.toUpperCase() === tail || v.name.toUpperCase() === upperKey) {
          const kind = builtinInstanceKind(v.dataType)
          if (kind) return kind
        }
      }
    }

    return undefined
  }

  public isDeclaredEdge(upperKey: string): boolean {
    if (this.host.memory.edgeStates.has(upperKey)) return true
    const declared = this.declaredBuiltinKind(upperKey)
    return declared === 'R_TRIG' || declared === 'F_TRIG'
  }

  public readInstanceField(key: string, field: string): unknown {
    const upperKey = key.toUpperCase()
    if (this.isDeclaredEdge(upperKey)) {
      if (!this.host.memory.edgeStates.has(upperKey)) return false
      const e = this.host.memory.getEdge(upperKey)
      return field === 'CLK' ? e.CLK : e.Q
    }
    const declared = this.declaredBuiltinKind(upperKey)
    const isCounter =
      !this.host.memory.timerStates.has(upperKey) &&
      (this.host.memory.counterStates.has(upperKey) ||
        ['QU', 'QD', 'CV', 'PV', 'CU', 'CD', 'R', 'LD'].includes(field) ||
        declared === 'CTU' ||
        declared === 'CTD' ||
        declared === 'CTUD')
    if (isCounter) {
      const c = this.host.memory.getCounter(upperKey)
      const isCtd = c.kind === 'CTD' || declared === 'CTD'
      const values: Record<string, unknown> = {
        Q: isCtd ? c.QD : c.QU,
        QU: c.QU,
        QD: c.QD,
        CV: c.CV,
        PV: c.PV,
        CU: c.CU,
        CD: c.CD,
        R: c.R,
        LD: c.LD
      }
      return values[field]
    }
    const t = this.host.memory.getTimer(upperKey)
    const values: Record<string, unknown> = { Q: t.Q, ET: Math.round(t.ET), IN: t.IN, PT: t.PT }
    return values[field]
  }

  public writeInstanceField(key: string, field: string, value: unknown): void {
    const upperKey = key.toUpperCase()
    const declared = this.declaredBuiltinKind(upperKey)
    const isCounter =
      this.host.memory.counterStates.has(upperKey) ||
      ['QU', 'QD', 'CV', 'PV', 'CU', 'CD', 'R', 'LD'].includes(field) ||
      declared === 'CTU' ||
      declared === 'CTD' ||
      declared === 'CTUD'
    if (isCounter) {
      const c = this.host.memory.getCounter(upperKey)
      const isCtd = c.kind === 'CTD' || declared === 'CTD'
      const rec = c as unknown as Record<string, unknown>
      if (field === 'Q') {
        if (isCtd) c.QD = !!value
        else c.QU = !!value
      } else {
        rec[field] = typeof rec[field] === 'boolean' ? !!value : Number(value) || 0
      }
      this.syncInstanceStates()
      return
    }
    const t = this.host.memory.getTimer(upperKey) as unknown as Record<string, unknown>
    if (field in t) t[field] = typeof t[field] === 'boolean' ? !!value : Number(value) || 0
    this.syncInstanceStates()
  }

  public isKnownInstance(name: string): boolean {
    const upper = name.toUpperCase()
    return (
      this.host.memory.timerStates.has(upper) ||
      this.host.memory.counterStates.has(upper) ||
      this.host.memory.edgeStates.has(upper)
    )
  }

  public instanceMemberType(member: string): string | undefined {
    const upper = member.toUpperCase()
    if (['IN', 'Q', 'QU', 'QD', 'CU', 'CD', 'R', 'LD', 'CLK'].includes(upper)) return 'BOOL'
    if (upper === 'PT' || upper === 'ET') return 'TIME'
    if (upper === 'CV' || upper === 'PV') return 'INT'
    return undefined
  }
}

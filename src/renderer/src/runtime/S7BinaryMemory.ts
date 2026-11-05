import { parseS7Address } from '@shared/constants/s7rules'
import { S7MemoryArea } from '@shared/types/s7types'

export interface S7TimerState {
  IN: boolean
  Q: boolean
  PT: number
  ET: number
  startTime: number
  lastTickTime: number
  running: boolean
}

export interface S7CounterState {
  CU: boolean
  CD: boolean
  R: boolean
  LD: boolean
  PV: number
  CV: number
  QU: boolean
  QD: boolean
  prevCu: boolean
  prevCd: boolean
}

export interface S7ResolvedAddress {
  area: 'I' | 'Q' | 'M' | 'DB'
  dbNumber?: number
  byteOffset: number
  bitOffset?: number
  sizeCategory: 'BIT' | 'BYTE' | 'WORD' | 'DWORD'
  raw: string
}

/**
 * Single-Source-of-Truth Siemens S7 Binary Memory Manager
 * Backed by contiguous Uint8Array + DataView buffers with big-endian S7 layout.
 */
export class S7BinaryMemory {
  // Contiguous binary memory buffers
  public pii: Uint8Array = new Uint8Array(128)      // Process Image Input: 128 Bytes (%I0.0 .. %I127.7)
  public piq: Uint8Array = new Uint8Array(128)      // Process Image Output: 128 Bytes (%Q0.0 .. %Q127.7)
  public merker: Uint8Array = new Uint8Array(512)   // Merker Bit Memory: 512 Bytes (%M0.0 .. %M511.7)
  public dataBlocks: Map<number, Uint8Array> = new Map()

  // Big-Endian S7 DataViews
  private piiView: DataView
  private piqView: DataView
  private merkerView: DataView
  private dbViews: Map<number, DataView> = new Map()

  // Persistent Timers and Counters
  public timerStates: Map<string, S7TimerState> = new Map()
  public counterStates: Map<string, S7CounterState> = new Map()

  // Forced overrides map (uppercase key -> value)
  public forceOverrides: Map<string, unknown> = new Map()

  constructor() {
    this.piiView = new DataView(this.pii.buffer)
    this.piqView = new DataView(this.piq.buffer)
    this.merkerView = new DataView(this.merker.buffer)
  }

  /**
   * Resets all memory buffers, timers, counters, and overrides to initial state (zeroed).
   */
  public reset(): void {
    this.pii.fill(0)
    this.piq.fill(0)
    this.merker.fill(0)
    for (const buf of this.dataBlocks.values()) {
      buf.fill(0)
    }
    this.timerStates.clear()
    this.counterStates.clear()
    this.forceOverrides.clear()
  }

  /**
   * Allocates or retrieves an authentic contiguous S7 DataBlock byte buffer.
   */
  public ensureDbBuffer(dbNumber: number, sizeBytes: number = 1024): Uint8Array {
    let buf = this.dataBlocks.get(dbNumber)
    if (!buf || buf.length < sizeBytes) {
      const newBuf = new Uint8Array(Math.max(1024, sizeBytes))
      if (buf) newBuf.set(buf)
      this.dataBlocks.set(dbNumber, newBuf)
      this.dbViews.set(dbNumber, new DataView(newBuf.buffer))
      buf = newBuf
    }
    return buf
  }

  private getBufferAndView(
    area: 'I' | 'Q' | 'M' | 'DB',
    dbNumber?: number
  ): { buf: Uint8Array; view: DataView } | null {
    if (area === 'I') return { buf: this.pii, view: this.piiView }
    if (area === 'Q') return { buf: this.piq, view: this.piqView }
    if (area === 'M') return { buf: this.merker, view: this.merkerView }
    if (area === 'DB') {
      const num = dbNumber || 1
      this.ensureDbBuffer(num)
      return { buf: this.dataBlocks.get(num)!, view: this.dbViews.get(num)! }
    }
    return null
  }

  // =========================================================================
  // 1. BIT OPERATIONS
  // =========================================================================

  public readBit(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, bitOffset: number, dbNumber?: number): boolean {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset >= target.buf.length || bitOffset < 0 || bitOffset > 7) return false
    return (target.buf[byteOffset] & (1 << bitOffset)) !== 0
  }

  public writeBit(
    area: 'I' | 'Q' | 'M' | 'DB',
    byteOffset: number,
    bitOffset: number,
    val: boolean,
    dbNumber?: number
  ): void {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset >= target.buf.length || bitOffset < 0 || bitOffset > 7) return
    if (val) {
      target.buf[byteOffset] |= 1 << bitOffset
    } else {
      target.buf[byteOffset] &= ~(1 << bitOffset)
    }
  }

  // =========================================================================
  // 2. BYTE OPERATIONS
  // =========================================================================

  public readByte(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, dbNumber?: number): number {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset >= target.buf.length) return 0
    return target.buf[byteOffset]
  }

  public writeByte(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, val: number, dbNumber?: number): void {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset >= target.buf.length) return
    target.buf[byteOffset] = val & 0xff
  }

  // =========================================================================
  // 3. WORD & INT OPERATIONS (16-bit Big-Endian S7 Standard)
  // =========================================================================

  public readWord(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, dbNumber?: number): number {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 1 >= target.buf.length) return 0
    return target.view.getUint16(byteOffset, false) // Big-Endian
  }

  public writeWord(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, val: number, dbNumber?: number): void {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 1 >= target.buf.length) return
    target.view.setUint16(byteOffset, val & 0xffff, false)
  }

  public readInt(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, dbNumber?: number): number {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 1 >= target.buf.length) return 0
    return target.view.getInt16(byteOffset, false)
  }

  public writeInt(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, val: number, dbNumber?: number): void {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 1 >= target.buf.length) return
    target.view.setInt16(byteOffset, val, false)
  }

  // =========================================================================
  // 4. DWORD & DINT OPERATIONS (32-bit Big-Endian S7 Standard)
  // =========================================================================

  public readDWord(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, dbNumber?: number): number {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 3 >= target.buf.length) return 0
    return target.view.getUint32(byteOffset, false)
  }

  public writeDWord(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, val: number, dbNumber?: number): void {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 3 >= target.buf.length) return
    target.view.setUint32(byteOffset, val >>> 0, false)
  }

  public readDInt(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, dbNumber?: number): number {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 3 >= target.buf.length) return 0
    return target.view.getInt32(byteOffset, false)
  }

  public writeDInt(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, val: number, dbNumber?: number): void {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 3 >= target.buf.length) return
    target.view.setInt32(byteOffset, val, false)
  }

  // =========================================================================
  // 5. REAL OPERATIONS (32-bit IEEE 754 Float Big-Endian)
  // =========================================================================

  public readReal(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, dbNumber?: number): number {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 3 >= target.buf.length) return 0
    return target.view.getFloat32(byteOffset, false)
  }

  public writeReal(area: 'I' | 'Q' | 'M' | 'DB', byteOffset: number, val: number, dbNumber?: number): void {
    const target = this.getBufferAndView(area, dbNumber)
    if (!target || byteOffset + 3 >= target.buf.length) return
    target.view.setFloat32(byteOffset, val, false)
  }

  // =========================================================================
  // 6. UNIFIED ADDRESS & SYMBOL RESOLVER
  // =========================================================================

  public resolveAddress(addressStr: string): S7ResolvedAddress | null {
    if (!addressStr) return null
    let raw = addressStr.trim().toUpperCase()

    // German syntax support: %E -> %I, %A -> %Q
    if (raw.startsWith('%E') || raw.startsWith('E')) {
      raw = raw.replace(/^%?E/, '%I')
    } else if (raw.startsWith('%A') || raw.startsWith('A')) {
      raw = raw.replace(/^%?A/, '%Q')
    }

    // DB pattern: %DB1.DBX0.0 or DB1.DBW2 or %DB1.DBD4
    const dbMatch = raw.match(/^%?DB(\d+)\.DB([XBWD])(\d+)(?:\.([0-7]))?$/)
    if (dbMatch) {
      const dbNum = parseInt(dbMatch[1], 10)
      const typeCode = dbMatch[2]
      const byteOffset = parseInt(dbMatch[3], 10)
      const bitOffset = dbMatch[4] !== undefined ? parseInt(dbMatch[4], 10) : 0
      const sizeCategory =
        typeCode === 'X' ? 'BIT' : typeCode === 'B' ? 'BYTE' : typeCode === 'W' ? 'WORD' : 'DWORD'
      return { area: 'DB', dbNumber: dbNum, byteOffset, bitOffset, sizeCategory, raw }
    }

    const parsed = parseS7Address(raw)
    if (parsed.isValid) {
      return {
        area: parsed.area as 'I' | 'Q' | 'M',
        byteOffset: parsed.byteAddress,
        bitOffset: parsed.bitAddress,
        sizeCategory: parsed.sizeCategory,
        raw: parsed.raw
      }
    }

    return null
  }

  public getVariable(
    symbolOrAddress: string,
    tagResolver?: (name: string) => { address?: string; dataType?: string } | undefined
  ): unknown {
    if (!symbolOrAddress) return 0
    const raw = symbolOrAddress.trim()
    const cleanSym = raw.replace(/^"|"$/g, '').trim()
    const upper = cleanSym.toUpperCase()

    // 1. Force overrides check
    if (this.forceOverrides.has(upper)) {
      return this.forceOverrides.get(upper)
    }

    // 2. Native Timer member access (T1.Q, T1.ET, T1.IN, T1.PT or bare T1)
    const timerMatch = cleanSym.match(/^([A-Za-z0-9_]+)\.(Q|ET|IN|PT)$/i)
    if (timerMatch) {
      const inst = timerMatch[1].toUpperCase()
      const field = timerMatch[2].toUpperCase()
      const t = this.getTimer(inst)
      if (field === 'Q') return t.Q
      if (field === 'ET') return t.ET
      if (field === 'IN') return t.IN
      if (field === 'PT') return t.PT
    }
    if (/^T\d+$/i.test(cleanSym)) {
      return this.getTimer(cleanSym.toUpperCase()).Q
    }

    // 3. Native Counter member access (C1.QU, C1.QD, C1.CV, C1.PV or bare C1)
    const counterMatch = cleanSym.match(/^([A-Za-z0-9_]+)\.(QU|QD|CV|PV|CU|CD|R|LD|Q)$/i)
    if (counterMatch) {
      const inst = counterMatch[1].toUpperCase()
      const field = counterMatch[2].toUpperCase()
      const c = this.getCounter(inst)
      if (field === 'QU' || field === 'Q') return c.QU
      if (field === 'QD') return c.QD
      if (field === 'CV') return c.CV
      if (field === 'PV') return c.PV
    }
    if (/^C\d+$/i.test(cleanSym)) {
      return this.getCounter(cleanSym.toUpperCase()).QU
    }

    // 4. Physical address resolution
    const resolved = this.resolveAddress(cleanSym)
    if (resolved) {
      if (resolved.sizeCategory === 'BIT') {
        return this.readBit(resolved.area, resolved.byteOffset, resolved.bitOffset || 0, resolved.dbNumber)
      } else if (resolved.sizeCategory === 'BYTE') {
        return this.readByte(resolved.area, resolved.byteOffset, resolved.dbNumber)
      } else if (resolved.sizeCategory === 'WORD') {
        return this.readWord(resolved.area, resolved.byteOffset, resolved.dbNumber)
      } else if (resolved.sizeCategory === 'DWORD') {
        return this.readDWord(resolved.area, resolved.byteOffset, resolved.dbNumber)
      }
    }

    // 5. Symbol tag lookup
    if (tagResolver) {
      const tag = tagResolver(cleanSym)
      if (tag && tag.address) {
        if (this.forceOverrides.has(tag.address.toUpperCase())) {
          return this.forceOverrides.get(tag.address.toUpperCase())
        }
        return this.getVariable(tag.address, tagResolver)
      }
    }

    return 0
  }

  public setVariable(
    symbolOrAddress: string,
    value: unknown,
    tagResolver?: (name: string) => { address?: string; dataType?: string } | undefined
  ): void {
    if (!symbolOrAddress) return
    const raw = symbolOrAddress.trim()
    const cleanSym = raw.replace(/^"|"$/g, '').trim()
    const upper = cleanSym.toUpperCase()

    // 1. Timer field write
    const timerMatch = cleanSym.match(/^([A-Za-z0-9_]+)\.(Q|ET|IN|PT)$/i)
    if (timerMatch) {
      const inst = timerMatch[1].toUpperCase()
      const field = timerMatch[2].toUpperCase()
      const t = this.getTimer(inst)
      if (field === 'Q') t.Q = Boolean(value)
      else if (field === 'ET') t.ET = Number(value) || 0
      else if (field === 'IN') t.IN = Boolean(value)
      else if (field === 'PT') t.PT = Number(value) || 0
      return
    }

    // 2. Counter field write
    const counterMatch = cleanSym.match(/^([A-Za-z0-9_]+)\.(QU|QD|CV|PV|Q)$/i)
    if (counterMatch) {
      const inst = counterMatch[1].toUpperCase()
      const field = counterMatch[2].toUpperCase()
      const c = this.getCounter(inst)
      if (field === 'QU' || field === 'Q') c.QU = Boolean(value)
      else if (field === 'QD') c.QD = Boolean(value)
      else if (field === 'CV') c.CV = Number(value) || 0
      else if (field === 'PV') c.PV = Number(value) || 0
      return
    }

    // 3. Physical address write
    const resolved = this.resolveAddress(cleanSym)
    if (resolved) {
      if (resolved.sizeCategory === 'BIT') {
        this.writeBit(resolved.area, resolved.byteOffset, resolved.bitOffset || 0, Boolean(value), resolved.dbNumber)
      } else if (resolved.sizeCategory === 'BYTE') {
        this.writeByte(resolved.area, resolved.byteOffset, Number(value) || 0, resolved.dbNumber)
      } else if (resolved.sizeCategory === 'WORD') {
        this.writeWord(resolved.area, resolved.byteOffset, Number(value) || 0, resolved.dbNumber)
      } else if (resolved.sizeCategory === 'DWORD') {
        this.writeDWord(resolved.area, resolved.byteOffset, Number(value) || 0, resolved.dbNumber)
      }
      return
    }

    // 4. Symbol tag lookup
    if (tagResolver) {
      const tag = tagResolver(cleanSym)
      if (tag && tag.address) {
        this.setVariable(tag.address, value, tagResolver)
      }
    }
  }

  // =========================================================================
  // 7. REAL-TIME IEC TIMER & COUNTER ENGINE
  // =========================================================================

  public getTimer(name: string): S7TimerState {
    const key = name.replace(/^["']|["']$/g, '').trim().toUpperCase()
    let t = this.timerStates.get(key)
    if (!t) {
      t = {
        IN: false,
        Q: false,
        PT: 10000,
        ET: 0,
        startTime: 0,
        lastTickTime: Date.now(),
        running: false
      }
      this.timerStates.set(key, t)
    }
    return t
  }

  public updateTonTimer(name: string, rloIn: boolean, ptMs: number, nowMs: number): S7TimerState {
    const t = this.getTimer(name)
    t.PT = ptMs

    if (rloIn) {
      t.IN = true
      if (!t.running) {
        t.running = true
        t.startTime = nowMs
        t.lastTickTime = nowMs
        t.ET = 0
        t.Q = false
      } else {
        const dt = Math.max(10, nowMs - t.lastTickTime)
        t.lastTickTime = nowMs
        t.ET = Math.min(t.PT, t.ET + dt)
        t.Q = t.ET >= t.PT
      }
    } else {
      t.IN = false
      t.running = false
      t.ET = 0
      t.Q = false
      t.lastTickTime = nowMs
    }
    return t
  }

  public updateTofTimer(name: string, rloIn: boolean, ptMs: number, nowMs: number): S7TimerState {
    const t = this.getTimer(name)
    t.PT = ptMs

    if (rloIn) {
      t.IN = true
      t.running = false
      t.ET = 0
      t.Q = true
      t.lastTickTime = nowMs
    } else if (t.Q) {
      t.IN = false
      if (!t.running) {
        t.running = true
        t.startTime = nowMs
        t.lastTickTime = nowMs
        t.ET = 0
      } else {
        const dt = Math.max(10, nowMs - t.lastTickTime)
        t.lastTickTime = nowMs
        t.ET = Math.min(t.PT, t.ET + dt)
        if (t.ET >= t.PT) {
          t.Q = false
          t.running = false
        }
      }
    } else {
      t.IN = false
      t.running = false
      t.ET = 0
      t.Q = false
      t.lastTickTime = nowMs
    }
    return t
  }

  public updateTpTimer(name: string, rloIn: boolean, ptMs: number, nowMs: number): S7TimerState {
    const t = this.getTimer(name)
    t.PT = ptMs

    if (rloIn && !t.running && !t.Q) {
      t.IN = true
      t.running = true
      t.startTime = nowMs
      t.lastTickTime = nowMs
      t.ET = 0
      t.Q = true
    } else if (t.running) {
      t.IN = rloIn
      const dt = Math.max(10, nowMs - t.lastTickTime)
      t.lastTickTime = nowMs
      t.ET = Math.min(t.PT, t.ET + dt)
      if (t.ET >= t.PT) {
        t.Q = false
        t.running = false
      }
    } else {
      t.IN = rloIn
      t.Q = false
      t.lastTickTime = nowMs
    }
    return t
  }

  public getCounter(name: string): S7CounterState {
    const key = name.replace(/^["']|["']$/g, '').trim().toUpperCase()
    let c = this.counterStates.get(key)
    if (!c) {
      c = {
        CU: false,
        CD: false,
        R: false,
        LD: false,
        PV: 10,
        CV: 0,
        QU: false,
        QD: false,
        prevCu: false,
        prevCd: false
      }
      this.counterStates.set(key, c)
    }
    return c
  }

  public updateCtuCounter(name: string, cuRlo: boolean, reset: boolean, pv: number): S7CounterState {
    const c = this.getCounter(name)
    c.PV = pv
    c.R = reset
    c.CU = cuRlo

    if (reset) {
      c.CV = 0
      c.QU = false
      c.QD = true
    } else {
      if (!c.prevCu && cuRlo && c.CV < 32767) {
        c.CV++
      }
      c.QU = c.CV >= c.PV
      c.QD = c.CV <= 0
    }
    c.prevCu = cuRlo
    return c
  }

  public updateCtdCounter(name: string, cdRlo: boolean, load: boolean, pv: number): S7CounterState {
    const c = this.getCounter(name)
    c.PV = pv
    c.LD = load
    c.CD = cdRlo

    if (load) {
      c.CV = pv
      c.QD = c.CV <= 0
      c.QU = c.CV >= c.PV
    } else {
      if (!c.prevCd && cdRlo && c.CV > 0) {
        c.CV--
      }
      c.QD = c.CV <= 0
      c.QU = c.CV >= c.PV
    }
    c.prevCd = cdRlo
    return c
  }

  public updateCtudCounter(
    name: string,
    cuRlo: boolean,
    cdRlo: boolean,
    reset: boolean,
    load: boolean,
    pv: number
  ): S7CounterState {
    const c = this.getCounter(name)
    c.PV = pv
    c.R = reset
    c.LD = load
    c.CU = cuRlo
    c.CD = cdRlo

    if (reset) {
      c.CV = 0
      c.QU = false
      c.QD = true
    } else if (load) {
      c.CV = pv
      c.QU = c.CV >= c.PV
      c.QD = c.CV <= 0
    } else {
      if (!c.prevCu && cuRlo && c.CV < 32767) {
        c.CV++
      }
      if (!c.prevCd && cdRlo && c.CV > 0) {
        c.CV--
      }
      c.QU = c.CV >= c.PV
      c.QD = c.CV <= 0
    }
    c.prevCu = cuRlo
    c.prevCd = cdRlo
    return c
  }

  // =========================================================================
  // 8. SNAPSHOT EXPORT & IMPORT
  // =========================================================================

  public getSnapshot(): { pii: number[]; piq: number[]; merker: number[] } {
    return {
      pii: Array.from(this.pii),
      piq: Array.from(this.piq),
      merker: Array.from(this.merker)
    }
  }

  public loadSnapshot(pii: number[], piq: number[], merker: number[]): void {
    if (pii && pii.length > 0) this.pii.set(pii.slice(0, this.pii.length))
    if (piq && piq.length > 0) this.piq.set(piq.slice(0, this.piq.length))
    if (merker && merker.length > 0) this.merker.set(merker.slice(0, this.merker.length))
  }
}


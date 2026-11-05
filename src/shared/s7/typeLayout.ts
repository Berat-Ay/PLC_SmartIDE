// S7 data type model: parses type names, computes memory layout and converts values to and from bytes.
// Layout follows S7 standard access rules; optimized blocks use the same layout internally here,
// which is not observable because optimized blocks do not allow absolute addressing.
import { parseS7Time } from './time'

export type BuiltinInstanceKind = 'TON' | 'TOF' | 'TP' | 'CTU' | 'CTD' | 'CTUD' | 'R_TRIG' | 'F_TRIG'

export interface ElementaryType {
  kind: 'elementary'
  name: string
  byteSize: number // 0 means a single bit
}
export interface StringType {
  kind: 'string'
  maxLength: number
  byteSize: number
}
export interface ArrayType {
  kind: 'array'
  low: number
  high: number
  element: S7Type
  stride: number // bytes per element; 0 for packed BOOL arrays
  byteSize: number
}
export interface StructType {
  kind: 'struct'
  members: LayoutMember[]
  byName: Map<string, LayoutMember>
  byteSize: number
}
export interface InstanceType {
  kind: 'instance'
  builtin: BuiltinInstanceKind
  byteSize: 0
}
export interface FbInstanceType {
  kind: 'fbInstance'
  fbName: string
  layout: StructType
  byteSize: number
}
export type S7Type = ElementaryType | StringType | ArrayType | StructType | InstanceType | FbInstanceType

export interface LayoutMember {
  name: string
  type: S7Type
  byteOffset: number
  bitOffset: number
  defaultValue?: string
  source?: LayoutVariable
}

export interface LayoutVariable {
  name: string
  dataType: string
  defaultValue?: string
  members?: LayoutVariable[]
}

export interface TypeResolver {
  /** Returns members for a UDT with this name. */
  udt?: (name: string) => LayoutVariable[] | undefined
  /** Returns the instance interface for an FB with this name. */
  fb?: (name: string) => LayoutVariable[] | undefined
  onUnknownType?: (typeName: string) => void
}

const ELEMENTARY_SIZES: Record<string, number> = {
  BOOL: 0,
  BYTE: 1,
  SINT: 1,
  USINT: 1,
  CHAR: 1,
  WCHAR: 2,
  WORD: 2,
  INT: 2,
  UINT: 2,
  DATE: 2,
  DWORD: 4,
  DINT: 4,
  UDINT: 4,
  REAL: 4,
  TIME: 4,
  TIME_OF_DAY: 4,
  TOD: 4,
  S5TIME: 2,
  LWORD: 8,
  LINT: 8,
  ULINT: 8,
  LREAL: 8,
  LTIME: 8
}

const BUILTIN_INSTANCES: Record<string, BuiltinInstanceKind> = {
  TON: 'TON',
  TOF: 'TOF',
  TP: 'TP',
  TON_TIME: 'TON',
  TOF_TIME: 'TOF',
  TP_TIME: 'TP',
  IEC_TIMER: 'TON',
  CTU: 'CTU',
  CTD: 'CTD',
  CTUD: 'CTUD',
  CTU_INT: 'CTU',
  CTD_INT: 'CTD',
  CTUD_INT: 'CTUD',
  IEC_COUNTER: 'CTUD',
  R_TRIG: 'R_TRIG',
  F_TRIG: 'F_TRIG'
}

export function isElementaryTypeName(name: string): boolean {
  return name.toUpperCase() in ELEMENTARY_SIZES
}

export function isBuiltinInstanceTypeName(name: string): boolean {
  return name.toUpperCase() in BUILTIN_INSTANCES
}

export function builtinInstanceKind(name: string): BuiltinInstanceKind | undefined {
  return BUILTIN_INSTANCES[name.toUpperCase()]
}

/** Parses a type name such as Int, "UDT_Pump", String[20] or Array[0..9, 1..2] of Real. */
export function parseTypeName(rawName: string, resolver: TypeResolver = {}, members?: LayoutVariable[]): S7Type {
  const name = rawName.trim()

  if (/^struct$/i.test(name)) return buildLayout(members || [], resolver)

  const arrayMatch = name.match(/^array\s*\[(.+?)\]\s*of\s+(.+)$/i)
  if (arrayMatch) {
    const dims = arrayMatch[1].split(',').map((d) => {
      const m = d.trim().match(/^(-?\d+)\s*\.\.\s*(-?\d+)$/)
      return m ? { low: parseInt(m[1], 10), high: parseInt(m[2], 10) } : null
    })
    if (dims.some((d) => !d)) {
      resolver.onUnknownType?.(name)
      return { kind: 'elementary', name: 'WORD', byteSize: 2 }
    }
    let type = parseTypeName(arrayMatch[2], resolver, members)
    for (let i = dims.length - 1; i >= 0; i--) {
      type = makeArray(dims[i]!.low, dims[i]!.high, type)
    }
    return type
  }

  const stringMatch = name.match(/^string(?:\s*\[\s*(\d+)\s*\])?$/i)
  if (stringMatch) {
    const maxLength = stringMatch[1] ? parseInt(stringMatch[1], 10) : 254
    return { kind: 'string', maxLength, byteSize: maxLength + 2 }
  }

  const unquoted = name.replace(/^"|"$/g, '')
  const upper = unquoted.toUpperCase()

  if (upper in ELEMENTARY_SIZES && !name.startsWith('"')) {
    return { kind: 'elementary', name: upper, byteSize: ELEMENTARY_SIZES[upper] }
  }
  if (upper in BUILTIN_INSTANCES && !name.startsWith('"')) {
    return { kind: 'instance', builtin: BUILTIN_INSTANCES[upper], byteSize: 0 }
  }

  const udtMembers = resolver.udt?.(unquoted)
  if (udtMembers) return buildLayout(udtMembers, resolver)

  const fbInterface = resolver.fb?.(unquoted)
  if (fbInterface) {
    const layout = buildLayout(fbInterface, resolver)
    return { kind: 'fbInstance', fbName: unquoted, layout, byteSize: layout.byteSize }
  }

  resolver.onUnknownType?.(name)
  return { kind: 'elementary', name: 'WORD', byteSize: 2 }
}

function makeArray(low: number, high: number, element: S7Type): ArrayType {
  const count = Math.max(0, high - low + 1)
  if (element.kind === 'elementary' && element.byteSize === 0) {
    return { kind: 'array', low, high, element, stride: 0, byteSize: alignEven(Math.ceil(count / 8)) }
  }
  const stride = element.byteSize <= 1 ? element.byteSize : alignEven(element.byteSize)
  return { kind: 'array', low, high, element, stride, byteSize: alignEven(stride * count) }
}

function alignEven(n: number): number {
  return n % 2 === 0 ? n : n + 1
}

/** Computes member offsets using S7 standard access rules. */
export function buildLayout(variables: LayoutVariable[], resolver: TypeResolver = {}): StructType {
  const members: LayoutMember[] = []
  const byName = new Map<string, LayoutMember>()
  let byte = 0
  let bit = 0

  for (const variable of variables) {
    const type = parseTypeName(variable.dataType, resolver, variable.members)
    let member: LayoutMember

    if (type.kind === 'elementary' && type.byteSize === 0) {
      member = { name: variable.name, type, byteOffset: byte, bitOffset: bit, defaultValue: variable.defaultValue, source: variable }
      bit++
      if (bit === 8) {
        byte++
        bit = 0
      }
    } else {
      if (bit > 0) {
        byte++
        bit = 0
      }
      const needsEven =
        type.kind !== 'elementary' || type.byteSize >= 2 ? type.byteSize > 1 || type.kind !== 'elementary' : false
      if (needsEven && type.kind !== 'instance') byte = alignEven(byte)
      member = { name: variable.name, type, byteOffset: byte, bitOffset: 0, defaultValue: variable.defaultValue, source: variable }
      byte += type.byteSize
    }
    members.push(member)
    byName.set(variable.name.toLowerCase(), member)
  }

  if (bit > 0) byte++
  return { kind: 'struct', members, byName, byteSize: alignEven(byte) }
}

export interface ResolvedLocation {
  type: S7Type
  byteOffset: number
  bitOffset: number
  /** Dotted path from the root, used as the key of builtin timer/counter instances. */
  path: string
  /** Set when the path stops at a timer/counter instance: the requested member, e.g. Q. */
  instanceMember?: string
}

/** Splits Pump1.Limits[2].Max into segments, keeping indices with their member. */
export function splitPath(path: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  for (const ch of path) {
    if (ch === '[') depth++
    if (ch === ']') depth--
    if (ch === '.' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out.map((s) => s.replace(/^"|"$/g, ''))
}

/** Resolves a member path against a layout. Returns null if any segment does not exist. */
export function resolvePath(root: StructType, segments: string[], baseByte = 0, basePath = ''): ResolvedLocation | null {
  let type: S7Type = root
  let byteOffset = baseByte
  let bitOffset = 0
  let path = basePath

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]
    if (type.kind === 'instance') {
      if (segmentIndex !== segments.length - 1) return null
      return { type, byteOffset, bitOffset, path, instanceMember: segment.toUpperCase() }
    }
    const m = segment.match(/^([^[]+)((?:\[[^\]]*\])*)$/)
    if (!m) return null
    const struct: StructType | null =
      type.kind === 'struct' ? type : type.kind === 'fbInstance' ? type.layout : null
    if (!struct) return null
    const member = struct.byName.get(m[1].toLowerCase())
    if (!member) return null

    type = member.type
    byteOffset += member.byteOffset
    bitOffset = member.bitOffset
    path = path ? `${path}.${member.name}` : member.name

    const indices = [...m[2].matchAll(/\[([^\]]*)\]/g)].flatMap((im) => im[1].split(','))
    for (const rawIndex of indices) {
      if (type.kind !== 'array') return null
      const index = parseInt(rawIndex, 10)
      if (isNaN(index) || index < type.low || index > type.high) return null
      const offset = index - type.low
      if (type.stride === 0) {
        byteOffset += Math.floor((bitOffset + offset) / 8)
        bitOffset = (bitOffset + offset) % 8
      } else {
        byteOffset += offset * type.stride
      }
      path += `[${index}]`
      type = type.element
    }
  }
  return { type, byteOffset, bitOffset, path }
}

// ---------------------------------------------------------------------------
// Value codec
// ---------------------------------------------------------------------------

export function readValue(bytes: Uint8Array, view: DataView, type: S7Type, byteOffset: number, bitOffset = 0): unknown {
  switch (type.kind) {
    case 'elementary':
      return readElementary(bytes, view, type.name, byteOffset, bitOffset)
    case 'string': {
      const len = Math.min(bytes[byteOffset + 1] || 0, type.maxLength)
      let s = ''
      for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[byteOffset + 2 + i])
      return s
    }
    case 'array': {
      const out: unknown[] = []
      for (let i = type.low; i <= type.high; i++) {
        const offset = i - type.low
        if (type.stride === 0) {
          const absBit = bitOffset + offset
          out.push(readValue(bytes, view, type.element, byteOffset + Math.floor(absBit / 8), absBit % 8))
        } else {
          out.push(readValue(bytes, view, type.element, byteOffset + offset * type.stride, 0))
        }
      }
      return out
    }
    case 'struct':
    case 'fbInstance': {
      const layout = type.kind === 'struct' ? type : type.layout
      const out: Record<string, unknown> = {}
      for (const m of layout.members) {
        if (m.type.kind === 'instance') continue
        out[m.name] = readValue(bytes, view, m.type, byteOffset + m.byteOffset, m.bitOffset)
      }
      return out
    }
    case 'instance':
      return undefined
  }
}

function readElementary(bytes: Uint8Array, view: DataView, name: string, off: number, bit: number): unknown {
  switch (name) {
    case 'BOOL':
      return (bytes[off] & (1 << bit)) !== 0
    case 'BYTE':
    case 'USINT':
    case 'CHAR':
      return view.getUint8(off)
    case 'SINT':
      return view.getInt8(off)
    case 'WORD':
    case 'UINT':
    case 'WCHAR':
    case 'DATE':
    case 'S5TIME':
      return view.getUint16(off, false)
    case 'INT':
      return view.getInt16(off, false)
    case 'DWORD':
    case 'UDINT':
    case 'TIME_OF_DAY':
    case 'TOD':
      return view.getUint32(off, false)
    case 'DINT':
    case 'TIME':
      return view.getInt32(off, false)
    case 'REAL':
      return view.getFloat32(off, false)
    case 'LREAL':
      return view.getFloat64(off, false)
    case 'LWORD':
    case 'ULINT':
      return Number(view.getBigUint64(off, false))
    case 'LINT':
    case 'LTIME':
      return Number(view.getBigInt64(off, false))
    default:
      return 0
  }
}

export function writeValue(
  bytes: Uint8Array,
  view: DataView,
  type: S7Type,
  byteOffset: number,
  bitOffset: number,
  value: unknown
): void {
  switch (type.kind) {
    case 'elementary':
      writeElementary(bytes, view, type.name, byteOffset, bitOffset, value)
      return
    case 'string': {
      const s = String(value ?? '').slice(0, type.maxLength)
      bytes[byteOffset] = type.maxLength & 0xff
      bytes[byteOffset + 1] = s.length
      for (let i = 0; i < s.length; i++) bytes[byteOffset + 2 + i] = s.charCodeAt(i) & 0xff
      return
    }
    case 'array': {
      if (!Array.isArray(value)) return
      for (let i = type.low; i <= type.high; i++) {
        const offset = i - type.low
        if (offset >= value.length) break
        if (type.stride === 0) {
          const absBit = bitOffset + offset
          writeValue(bytes, view, type.element, byteOffset + Math.floor(absBit / 8), absBit % 8, value[offset])
        } else {
          writeValue(bytes, view, type.element, byteOffset + offset * type.stride, 0, value[offset])
        }
      }
      return
    }
    case 'struct':
    case 'fbInstance': {
      if (!value || typeof value !== 'object') return
      const layout = type.kind === 'struct' ? type : type.layout
      const obj = value as Record<string, unknown>
      for (const m of layout.members) {
        if (m.type.kind !== 'instance' && m.name in obj) {
          writeValue(bytes, view, m.type, byteOffset + m.byteOffset, m.bitOffset, obj[m.name])
        }
      }
      return
    }
    case 'instance':
      return
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  const n = Number(value)
  return isNaN(n) ? 0 : n
}

/** Rounds to the nearest integer, ties to even, as S7 REAL to integer conversion does. */
export function roundHalfEven(n: number): number {
  const floor = Math.floor(n)
  const diff = n - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

function writeElementary(bytes: Uint8Array, view: DataView, name: string, off: number, bit: number, value: unknown): void {
  const raw = toNumber(value)
  const n = name === 'REAL' || name === 'LREAL' || Number.isInteger(raw) || !isFinite(raw) ? raw : roundHalfEven(raw)
  switch (name) {
    case 'BOOL':
      if (typeof value === 'number' ? value !== 0 : !!value) bytes[off] |= 1 << bit
      else bytes[off] &= ~(1 << bit)
      return
    case 'BYTE':
    case 'USINT':
    case 'CHAR':
    case 'SINT':
      view.setUint8(off, Math.trunc(n) & 0xff)
      return
    case 'WORD':
    case 'UINT':
    case 'INT':
    case 'WCHAR':
    case 'DATE':
    case 'S5TIME':
      view.setUint16(off, Math.trunc(n) & 0xffff, false)
      return
    case 'DWORD':
    case 'UDINT':
    case 'DINT':
    case 'TIME':
    case 'TIME_OF_DAY':
    case 'TOD':
      view.setUint32(off, Math.trunc(n) >>> 0, false)
      return
    case 'REAL':
      view.setFloat32(off, n, false)
      return
    case 'LREAL':
      view.setFloat64(off, n, false)
      return
    case 'LWORD':
    case 'ULINT':
    case 'LINT':
    case 'LTIME':
      view.setBigInt64(off, BigInt(Math.trunc(n)), false)
      return
  }
}

/** Parses a start value such as TRUE, 4.5, 16#FF or T#5s for the given type. */
export function parseStartValue(raw: string | undefined, type: S7Type): unknown {
  if (raw === undefined || raw === null) return undefined
  const text = String(raw).trim()
  if (text === '') return undefined

  if (type.kind === 'string') return text.replace(/^'|'$/g, '')
  if (type.kind !== 'elementary') return undefined

  const upper = text.toUpperCase()
  if (upper === 'TRUE') return true
  if (upper === 'FALSE') return false
  if (/^(LTIME|TIME|LT|T)#/i.test(text)) return parseS7Time(text) ?? undefined

  const stripped = text.replace(/^[A-Z_]+#(?=\d|16#|8#|2#)/i, '')
  const radix = stripped.match(/^(16|8|2)#([0-9A-Fa-f_]+)$/)
  if (radix) return parseInt(radix[2].replace(/_/g, ''), parseInt(radix[1], 10))
  const n = Number(stripped)
  return isNaN(n) ? undefined : n
}

/** Applies start values recursively; members without one stay zero. */
export function applyStartValues(bytes: Uint8Array, view: DataView, layout: StructType, base = 0): void {
  for (const m of layout.members) {
    const offset = base + m.byteOffset
    if (m.type.kind === 'struct') {
      applyStartValues(bytes, view, m.type, offset)
    } else if (m.type.kind === 'fbInstance') {
      applyStartValues(bytes, view, m.type.layout, offset)
    } else if (m.type.kind === 'string') {
      const parsed = parseStartValue(m.defaultValue, m.type)
      writeValue(bytes, view, m.type, offset, 0, parsed ?? '')
    } else if (m.type.kind === 'array' && m.type.element.kind === 'struct') {
      for (let i = 0; i <= m.type.high - m.type.low; i++) {
        applyStartValues(bytes, view, m.type.element, offset + i * m.type.stride)
      }
    } else if (m.type.kind === 'elementary') {
      const parsed = parseStartValue(m.defaultValue, m.type)
      if (parsed !== undefined) writeValue(bytes, view, m.type, offset, m.bitOffset, parsed)
    }
  }
}

/** Clears and re-initializes members without RETAIN, as a CPU does on the STOP to RUN transition. */
export function reinitNonRetain(bytes: Uint8Array, view: DataView, layout: StructType): void {
  for (const m of layout.members) {
    if ((m.source as { retain?: boolean } | undefined)?.retain) continue
    if (m.type.kind === 'elementary' && m.type.byteSize === 0) {
      const parsed = parseStartValue(m.defaultValue, m.type)
      writeValue(bytes, view, m.type, m.byteOffset, m.bitOffset, parsed ?? false)
      continue
    }
    bytes.fill(0, m.byteOffset, m.byteOffset + m.type.byteSize)
    applyStartValues(bytes, view, { kind: 'struct', members: [m], byName: new Map(), byteSize: layout.byteSize })
  }
}

import {
  applyStartValues,
  buildLayout,
  BuiltinInstanceKind,
  builtinInstanceKind,
  LayoutVariable,
  readValue,
  StructType,
  TypeResolver
} from '@shared/s7/typeLayout'
import type { BlockInterface, DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import type { UdtDefinition } from '@shared/types/types'
import type { S7BinaryMemory } from '../S7BinaryMemory'

type CodeBlock = LadBlockDefinition | SclBlockDefinition

export interface DbEntry {
  def: DataBlockDefinition
  name: string
  number: number
  layout: StructType
  bytes: Uint8Array
  view: DataView
  signature: string
  builtin?: BuiltinInstanceKind
}

export interface DbRegistryHost {
  memory: S7BinaryMemory
  getLiveDataBlocks: () => DataBlockDefinition[]
  getLiveUdts: () => UdtDefinition[]
  findBlock: (name: string) => CodeBlock | undefined
  interfaceOf: (block: CodeBlock) => BlockInterface
  instanceVariables: (iface: BlockInterface) => LayoutVariable[]
  reportOnce: (message: string, severity: 'info' | 'warning' | 'error') => void
}

/**
 * Tracks compiled Data Block layouts and reconciles their binary backing memory in S7BinaryMemory.
 */
export class DbRegistry {
  public entries = new Map<string, DbEntry>()

  constructor(private readonly host: DbRegistryHost) {}

  public typeResolver(): TypeResolver {
    return {
      udt: (name) =>
        this.host.getLiveUdts().find((u) => u.name.toLowerCase() === name.toLowerCase())?.members as
          | LayoutVariable[]
          | undefined,
      fb: (name) => {
        const block = this.host.findBlock(name)
        return block && block.blockType === 'FB' ? this.host.instanceVariables(this.host.interfaceOf(block)) : undefined
      },
      onUnknownType: (typeName) => this.host.reportOnce(`Unknown data type '${typeName}'`, 'error')
    }
  }

  public collectTypeDependencies(
    variables: LayoutVariable[],
    resolver: TypeResolver,
    seen = new Set<string>()
  ): unknown[] {
    const deps: unknown[] = []
    for (const v of variables) {
      if (v.members && v.members.length > 0) {
        deps.push(v.name, this.collectTypeDependencies(v.members, resolver, seen))
      }
      const rawType = (v.dataType || '').trim()
      const arrayMatch = rawType.match(/^array\s*\[.+?\]\s*of\s+(.+)$/i)
      const baseName = (arrayMatch ? arrayMatch[1] : rawType).replace(/^"|"$/g, '').trim()
      const upper = baseName.toUpperCase()
      if (!upper || seen.has(upper)) continue
      const udtMembers = resolver.udt?.(baseName)
      if (udtMembers) {
        seen.add(upper)
        deps.push(['UDT', upper, udtMembers, this.collectTypeDependencies(udtMembers, resolver, seen)])
        continue
      }
      const fbMembers = resolver.fb?.(baseName)
      if (fbMembers) {
        seen.add(upper)
        deps.push(['FB', upper, fbMembers, this.collectTypeDependencies(fbMembers, resolver, seen)])
      }
    }
    return deps
  }

  public entryMemory(entry: DbEntry): { bytes: Uint8Array; view: DataView } {
    const bytes = this.host.memory.getDbBuffer(entry.number)
    const view = this.host.memory.getDbView(entry.number)
    if (bytes && view) {
      entry.bytes = bytes
      entry.view = view
      return { bytes, view }
    }
    return { bytes: entry.bytes, view: entry.view }
  }

  public syncDataBlocks(): void {
    const resolver = this.typeResolver()
    const defs = this.host.getLiveDataBlocks()
    const next = new Map<string, DbEntry>()
    let autoNumber = defs.reduce((max, d) => Math.max(max, d.blockNumber || 0), 0)

    for (const def of defs) {
      const parent = def.dbType === 'Instance' ? def.parentFbName : undefined
      const builtin = parent ? builtinInstanceKind(parent) : undefined
      const fb = parent && !builtin ? this.host.findBlock(parent) : undefined
      const variables: LayoutVariable[] = fb
        ? this.host.instanceVariables(this.host.interfaceOf(fb))
        : def.variables || []
      const number = def.blockNumber || ++autoNumber
      const depSig = this.collectTypeDependencies(variables, resolver)
      const signature = JSON.stringify([number, parent || '', variables, depSig])
      const key = def.name.toLowerCase()

      const existing = this.entries.get(key)
      if (existing && existing.signature === signature) {
        const mem = this.entryMemory(existing)
        next.set(key, { ...existing, ...mem, def })
        continue
      }

      const layout = buildLayout(variables, resolver)
      const { bytes, view } = this.host.memory.allocateDb(number, Math.max(layout.byteSize, 1))
      applyStartValues(bytes, view, layout)
      next.set(key, { def, name: def.name, number, layout, bytes, view, signature, builtin })
    }
    this.entries = next
  }

  public get(name: string): DbEntry | undefined {
    return this.entries.get(name.toLowerCase())
  }

  public values(): IterableIterator<DbEntry> {
    return this.entries.values()
  }

  public refreshViews(): void {
    for (const entry of this.entries.values()) {
      this.entryMemory(entry)
    }
  }

  public exportDbBytes(): Record<number, Uint8Array> {
    const out: Record<number, Uint8Array> = {}
    for (const entry of this.entries.values()) {
      out[entry.number] = this.entryMemory(entry).bytes.slice()
    }
    return out
  }

  public decodeDataBlocks(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const entry of this.entries.values()) {
      const { bytes, view } = this.entryMemory(entry)
      out[entry.name] = readValue(bytes, view, entry.layout, 0, 0) as Record<string, unknown>
    }
    return out
  }

  public clear(): void {
    this.entries.clear()
  }
}

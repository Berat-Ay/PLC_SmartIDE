import type { TagDefinition } from '@shared/types/tags'
import type { S7BinaryMemory, S7ResolvedAddress } from '../S7BinaryMemory'

/**
 * Manages canonical online force overrides synchronized with S7BinaryMemory.
 */
export class SymbolForceTable {
  public readonly map = new Map<string, unknown>()

  constructor(private readonly memory: S7BinaryMemory) {}

  public addressKey(resolved: S7ResolvedAddress): string {
    if (resolved.sizeCategory === 'BIT') return `%${resolved.area}${resolved.byteOffset}.${resolved.bitOffset}`
    const prefix =
      resolved.sizeCategory === 'BYTE' ? 'B' : resolved.sizeCategory === 'WORD' ? 'W' : 'D'
    return `%${resolved.area}${prefix}${resolved.byteOffset}`
  }

  public normalizeForceKey(addressOrSymbol: string): string {
    const clean = addressOrSymbol.trim().replace(/^"|"$/g, '').trim()
    const resolved = this.memory.resolveAddress(clean)
    if (resolved) return this.addressKey(resolved)
    return clean.toUpperCase()
  }

  public setForce(addressOrSymbol: string, value: unknown, active: boolean): void {
    const key = this.normalizeForceKey(addressOrSymbol)
    const rawKey = addressOrSymbol.trim().toUpperCase()
    if (active) {
      this.map.set(key, value)
      this.memory.forceOverrides.set(key, value)
    } else {
      this.map.delete(key)
      this.map.delete(rawKey)
      this.memory.forceOverrides.delete(key)
      this.memory.forceOverrides.delete(rawKey)
    }
  }

  public lookupForce(
    clean: string,
    tagByName: Map<string, TagDefinition>,
    tagByAddress: Map<string, TagDefinition>,
    normalizeAddress: (addr: string) => string
  ): { found: boolean; value?: unknown } {
    if (this.map.size === 0) return { found: false }
    const normKey = this.normalizeForceKey(clean)
    if (this.map.has(normKey)) return { found: true, value: this.map.get(normKey) }
    const upper = clean.toUpperCase()
    if (this.map.has(upper)) return { found: true, value: this.map.get(upper) }

    const tag = tagByName.get(clean.toLowerCase())
    if (tag?.address) {
      const tagNorm = this.normalizeForceKey(tag.address)
      if (this.map.has(tagNorm)) return { found: true, value: this.map.get(tagNorm) }
      if (this.map.has(tag.address.toUpperCase())) return { found: true, value: this.map.get(tag.address.toUpperCase()) }
    }
    const byAddress = tagByAddress.get(normalizeAddress(clean))
    if (byAddress && this.map.has(byAddress.name.toUpperCase())) {
      return { found: true, value: this.map.get(byAddress.name.toUpperCase()) }
    }
    return { found: false }
  }

  public clearAll(): void {
    this.map.clear()
    this.memory.forceOverrides.clear()
  }
}

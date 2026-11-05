import { S7MemoryArea } from '@shared/types/s7types'
import { parseS7Address, getOccupiedCoordinates, getCategoryForType, formatS7Address } from '@shared/constants/s7rules'
import { TagDefinition, TagTable, TagMemoryCollision } from '@shared/types/tags'
import { CpuConfig } from '@shared/types/hardware'
import { DiagnosticMessage } from '@shared/types/diagnostics'

export interface MemoryOccupant {
  id: string
  name: string
  type: 'Tag' | 'ClockMemory' | 'SystemMemory' | 'HardwareIO'
  address: string
  area: S7MemoryArea
  bytes: number[]
  sourceFile?: string
}

export interface BitOccupancy {
  bitIndex: number
  state: 'FREE' | 'OCCUPIED' | 'COLLIDING'
  occupants: MemoryOccupant[]
}

export interface ByteOccupancy {
  byteIndex: number
  bits: BitOccupancy[]
  byteState: 'FREE' | 'PARTIAL' | 'FULL' | 'COLLIDING'
  occupantNames: string[]
}

export interface OverlapEngineAnalysis {
  collisions: Map<string, TagMemoryCollision> // tagId -> collision details
  diagnostics: DiagnosticMessage[]
  totalCollisionCount: number
}

export class MemoryOverlapEngine {
  /**
   * Builds the bit-level occupancy map from all active project sources
   */
  public static buildBitMap(
    tagTables: TagTable[],
    cpuConfig?: CpuConfig
  ): Map<string, MemoryOccupant[]> {
    const bitMap = new Map<string, MemoryOccupant[]>()

    const registerOccupant = (occupant: MemoryOccupant) => {
      const parsed = parseS7Address(occupant.address)
      if (!parsed.isValid) return

      const coords = getOccupiedCoordinates(parsed)
      for (const coord of coords) {
        const key = `${coord.area}:${coord.byte}:${coord.bit}`
        const list = bitMap.get(key) || []
        list.push(occupant)
        bitMap.set(key, list)
      }
    }

    // 1. Register CPU System Memory Byte (e.g. MB1)
    if (cpuConfig?.systemMemory?.enabled) {
      const byte = cpuConfig.systemMemory.byteAddress
      registerOccupant({
        id: 'cpu_system_memory_byte',
        name: 'CPU System Memory (FirstScan, DiagStatus, AlwaysTrue, AlwaysFalse)',
        type: 'SystemMemory',
        address: `%MB${byte}`,
        area: 'M',
        bytes: [byte]
      })
    }

    // 2. Register CPU Clock Memory Byte (e.g. MB0)
    if (cpuConfig?.clockMemory?.enabled) {
      const byte = cpuConfig.clockMemory.byteAddress
      registerOccupant({
        id: 'cpu_clock_memory_byte',
        name: 'CPU Clock Memory (10Hz..0.5Hz square waves)',
        type: 'ClockMemory',
        address: `%MB${byte}`,
        area: 'M',
        bytes: [byte]
      })
    }

    // 3. Register Hardware I/O Modules
    if (cpuConfig?.digitalIO) {
      for (const di of cpuConfig.digitalIO.diChannels) {
        if (di.address) {
          registerOccupant({
            id: `hw_di_${di.channelIndex}`,
            name: di.name || `DI Channel ${di.channelIndex}`,
            type: 'HardwareIO',
            address: di.address,
            area: 'I',
            bytes: [parseS7Address(di.address).byteAddress]
          })
        }
      }
      for (const dq of cpuConfig.digitalIO.dqChannels) {
        if (dq.address) {
          registerOccupant({
            id: `hw_dq_${dq.channelIndex}`,
            name: dq.name || `DQ Channel ${dq.channelIndex}`,
            type: 'HardwareIO',
            address: dq.address,
            area: 'Q',
            bytes: [parseS7Address(dq.address).byteAddress]
          })
        }
      }
    }

    if (cpuConfig?.analogIO) {
      for (const ai of cpuConfig.analogIO.aiChannels) {
        if (ai.address) {
          const parsed = parseS7Address(ai.address)
          registerOccupant({
            id: `hw_ai_${ai.channelIndex}`,
            name: ai.name || `AI Channel ${ai.channelIndex}`,
            type: 'HardwareIO',
            address: ai.address,
            area: 'I',
            bytes: parsed.occupiedBytes
          })
        }
      }
      for (const aq of cpuConfig.analogIO.aqChannels) {
        if (aq.address) {
          const parsed = parseS7Address(aq.address)
          registerOccupant({
            id: `hw_aq_${aq.channelIndex}`,
            name: aq.name || `AQ Channel ${aq.channelIndex}`,
            type: 'HardwareIO',
            address: aq.address,
            area: 'Q',
            bytes: parsed.occupiedBytes
          })
        }
      }
    }

    // 4. Register all User Tags across all Tag Tables (deduplicated by normalized name and address)
    const seenTags = new Set<string>()
    for (const table of tagTables) {
      for (const tag of table.tags) {
        if (tag.address) {
          const dedupeKey = `${tag.id || ''}::${tag.name.trim().toLowerCase()}::${tag.address.trim().toUpperCase()}`
          if (seenTags.has(dedupeKey)) continue
          seenTags.add(dedupeKey)

          const parsed = parseS7Address(tag.address)
          const validId = tag.id || `tag_${table.id || 'tbl'}_${tag.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')}_${Math.random().toString(36).substring(2, 7)}`
          if (!tag.id) {
            tag.id = validId
          }
          registerOccupant({
            id: validId,
            name: tag.name,
            type: 'Tag',
            address: tag.address,
            area: parsed.area,
            bytes: parsed.occupiedBytes,
            sourceFile: table.fileName
          })
        }
      }
    }

    return bitMap
  }

  /**
   * Scans the bit map to identify all collisions and generates diagnostic messages
   */
  public static analyzeCollisions(
    tagTables: TagTable[],
    cpuConfig?: CpuConfig
  ): OverlapEngineAnalysis {
    const bitMap = this.buildBitMap(tagTables, cpuConfig)
    const rawCollisions = new Map<string, TagMemoryCollision>()
    const diagnostics: DiagnosticMessage[] = []

    // Check each bit coordinate
    for (const [key, occupants] of bitMap.entries()) {
      if (occupants.length <= 1) continue

      const [area, byteStr, bitStr] = key.split(':')
      const byte = parseInt(byteStr, 10)
      const bit = parseInt(bitStr, 10)
      const locStr = `%${area}${byte}.${bit}`

      // For every pair of occupants in this bit, report collision
      for (let i = 0; i < occupants.length; i++) {
        const occA = occupants[i]
        for (let j = 0; j < occupants.length; j++) {
          if (i === j) continue
          const occB = occupants[j]

          // Never report a collision between an occupant and itself (by id or fallback to normalized name if no id)
          if (occA.id && occB.id) {
            if (occB.id === occA.id) continue
          } else if (occA.name.trim().toLowerCase() === occB.name.trim().toLowerCase()) {
            continue
          }

          // A User Tag assigned to its corresponding physical Hardware IO channel is symbolic naming, NOT a collision
          if (
            (occA.type === 'HardwareIO' && occB.type === 'Tag') ||
            (occA.type === 'Tag' && occB.type === 'HardwareIO')
          ) {
            continue
          }

          if (!rawCollisions.has(occA.id)) {
            rawCollisions.set(occA.id, {
              tagId: occA.id,
              tagName: occA.name,
              address: occA.address,
              conflictsWith: []
            })
          }

          const record = rawCollisions.get(occA.id)!
          const exists = record.conflictsWith.some(
            (c) =>
              (c.id && occB.id && c.id === occB.id && c.overlapArea === locStr) ||
              (c.name.trim().toLowerCase() === occB.name.trim().toLowerCase() && c.overlapArea === locStr)
          )
          if (!exists) {
            record.conflictsWith.push({
              type: occB.type,
              id: occB.id,
              name: occB.name,
              address: occB.address,
              overlapArea: locStr
            })
          }
        }
      }
    }

    // Filter out any phantom collisions where no other distinct tags conflict
    const finalCollisions = new Map<string, TagMemoryCollision>()
    for (const [tagId, collision] of rawCollisions.entries()) {
      const validConflicts = collision.conflictsWith.filter((c) => {
        if (c.id && collision.tagId) {
          return c.id !== collision.tagId
        }
        return c.name.trim().toLowerCase() !== collision.tagName.trim().toLowerCase()
      })
      if (validConflicts.length === 0) continue

      collision.conflictsWith = validConflicts
      finalCollisions.set(tagId, collision)
      if (collision.tagName) {
        finalCollisions.set(collision.tagName.trim().toLowerCase(), collision)
      }

      const conflictNamesSet = new Set<string>()
      for (const c of validConflicts) {
        if (c.id && collision.tagId ? c.id !== collision.tagId : c.name.trim().toLowerCase() !== collision.tagName.trim().toLowerCase()) {
          conflictNamesSet.add(`'${c.name}' (${c.address})`)
        }
      }
      if (conflictNamesSet.size === 0) continue

      const otherNames = Array.from(conflictNamesSet).join(', ')
      const locations = Array.from(new Set(validConflicts.map((c) => c.overlapArea))).join(', ')

      diagnostics.push({
        id: `diag_overlap_${collision.tagId}`,
        severity: 'Error',
        code: 'ERR_MEMORY_OVERLAP',
        source: 'Memory Overlap Guard',
        message: `Tag '${collision.tagName}' (${collision.address}) collides at ${locations} with ${otherNames}.`,
        targetId: collision.tagId,
        targetSymbol: collision.tagName,
        targetAddress: collision.address,
        autoFixable: true,
        fixAction: 'AUTO_ASSIGN_ADDRESS',
        fixLabel: 'Auto-Assign Safe Address',
        timestamp: Date.now()
      })
    }

    const distinctCollidingTagIds = new Set<string>()
    for (const col of finalCollisions.values()) {
      if (col.tagId) distinctCollidingTagIds.add(col.tagId)
    }

    return {
      collisions: finalCollisions,
      diagnostics,
      totalCollisionCount: distinctCollidingTagIds.size
    }
  }

  /**
   * Finds the next safe, non-overlapping S7 address for a given data type and area
   */
  public static findNextSafeAddress(
    area: S7MemoryArea,
    dataType: string,
    tagTables: TagTable[],
    cpuConfig?: CpuConfig,
    excludeTagId?: string,
    startFromByte = 0
  ): string {
    const bitMap = this.buildBitMap(tagTables, cpuConfig)
    const category = getCategoryForType(dataType)

    const isBitFree = (byte: number, bit: number): boolean => {
      const key = `${area}:${byte}:${bit}`
      const occupants = bitMap.get(key)
      if (!occupants || occupants.length === 0) return true
      if (excludeTagId && occupants.length === 1 && occupants[0].id === excludeTagId) {
        return true
      }
      return false
    }

    if (category === 'BIT') {
      for (let byte = startFromByte; byte < 65535; byte++) {
        for (let bit = 0; bit < 8; bit++) {
          if (isBitFree(byte, bit)) {
            return formatS7Address(area, 'BIT', byte, bit)
          }
        }
      }
    } else if (category === 'BYTE') {
      for (let byte = startFromByte; byte < 65535; byte++) {
        let allFree = true
        for (let bit = 0; bit < 8; bit++) {
          if (!isBitFree(byte, bit)) {
            allFree = false
            break
          }
        }
        if (allFree) {
          return formatS7Address(area, 'BYTE', byte)
        }
      }
    } else if (category === 'WORD') {
      // Must align to even byte boundary
      let start = startFromByte
      if (start % 2 !== 0) start++
      for (let byte = start; byte < 65535; byte += 2) {
        let allFree = true
        for (let b = 0; b < 2; b++) {
          for (let bit = 0; bit < 8; bit++) {
            if (!isBitFree(byte + b, bit)) {
              allFree = false
              break
            }
          }
          if (!allFree) break
        }
        if (allFree) {
          return formatS7Address(area, 'WORD', byte)
        }
      }
    } else if (category === 'DWORD') {
      // Must align to even byte boundary (4 bytes)
      let start = startFromByte
      if (start % 2 !== 0) start++
      for (let byte = start; byte < 65535; byte += 2) {
        let allFree = true
        for (let b = 0; b < 4; b++) {
          for (let bit = 0; bit < 8; bit++) {
            if (!isBitFree(byte + b, bit)) {
              allFree = false
              break
            }
          }
          if (!allFree) break
        }
        if (allFree) {
          return formatS7Address(area, 'DWORD', byte)
        }
      }
    }

    return formatS7Address(area, category, 100)
  }

  /**
   * Generates a memory occupancy visual representation for the Memory Map Visualizer tab
   */
  public static getMemoryOccupancy(
    area: S7MemoryArea,
    byteCount = 64,
    startByte = 0,
    tagTables: TagTable[],
    cpuConfig?: CpuConfig
  ): ByteOccupancy[] {
    const bitMap = this.buildBitMap(tagTables, cpuConfig)
    const result: ByteOccupancy[] = []

    for (let b = startByte; b < startByte + byteCount; b++) {
      const bits: BitOccupancy[] = []
      let occupiedCount = 0
      let hasCollision = false
      const occupantNames = new Set<string>()

      for (let bit = 0; bit < 8; bit++) {
        const key = `${area}:${b}:${bit}`
        const occs = bitMap.get(key) || []
        let state: 'FREE' | 'OCCUPIED' | 'COLLIDING' = 'FREE'

        if (occs.length === 1) {
          state = 'OCCUPIED'
          occupiedCount++
          occupantNames.add(occs[0].name)
        } else if (occs.length > 1) {
          // Exclude HardwareIO <-> Tag symbolic pairing on same address
          const normalizedKeys = new Set(
            occs.map((o) => (o.type === 'HardwareIO' ? 'sym_' + o.address : o.name.trim().toLowerCase()))
          )
          if (normalizedKeys.size > 1) {
            state = 'COLLIDING'
            occupiedCount++
            hasCollision = true
            occs.forEach((o) => occupantNames.add(o.name))
          } else {
            state = 'OCCUPIED'
            occupiedCount++
            occupantNames.add(occs[0].name)
          }
        }

        bits.push({
          bitIndex: bit,
          state,
          occupants: occs
        })
      }

      let byteState: 'FREE' | 'PARTIAL' | 'FULL' | 'COLLIDING' = 'FREE'
      if (hasCollision) {
        byteState = 'COLLIDING'
      } else if (occupiedCount === 8) {
        byteState = 'FULL'
      } else if (occupiedCount > 0) {
        byteState = 'PARTIAL'
      }

      result.push({
        byteIndex: b,
        bits,
        byteState,
        occupantNames: Array.from(occupantNames)
      })
    }

    return result
  }
}

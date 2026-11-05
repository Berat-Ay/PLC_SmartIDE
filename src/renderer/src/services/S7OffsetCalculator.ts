import { BlockVariable } from '@shared/types/blocks'
import { UdtDefinition } from '@shared/types/types'
import { S7_PRIMITIVE_SPECS, S7PrimitiveType } from '@shared/types/s7types'

/**
 * Siemens S7 Standard Access (Non-Optimized) Offset Calculator
 * Accurately calculates Byte.Bit offsets according to Siemens S7 memory alignment and padding rules:
 * - Consecutive BOOLs pack into bits 0..7 of the current byte
 * - Transition from BOOL to any multi-bit type rounds up to the next byte boundary
 * - Multi-byte types (INT, WORD, REAL, DINT, etc.) align to EVEN byte boundaries (word alignment)
 * - Nested UDTs / Structs start on an even byte boundary, pad their inner members, and finish on an even boundary
 */
export class S7OffsetCalculator {
  /**
   * Calculates offsets for an array of block variables (e.g. in a DB or Block Interface)
   */
  public static calculateVariableOffsets(
    variables: BlockVariable[],
    udtLookup: Map<string, UdtDefinition> = new Map()
  ): BlockVariable[] {
    let currentByte = 0
    let currentBit = 0

    return variables.map((variable) => {
      const typeUpper = variable.dataType.toUpperCase()

      if (typeUpper === 'BOOL') {
        const offset = `${currentByte}.${currentBit}`
        currentBit++
        if (currentBit >= 8) {
          currentByte++
          currentBit = 0
        }
        return {
          ...variable,
          calculatedOffset: offset
        }
      }

      // If we were tracking bits in a byte and hit a non-BOOL type, round up to the next whole byte
      if (currentBit > 0) {
        currentByte++
        currentBit = 0
      }

      // Check if it's a known UDT
      const udt = udtLookup.get(variable.dataType)
      if (udt) {
        // Structs / UDTs align to an even byte boundary in S7
        if (currentByte % 2 !== 0) {
          currentByte++
        }
        const offset = `${currentByte}.0`
        const udtByteSize = this.calculateUdtSize(udt, udtLookup)
        currentByte += udtByteSize
        // S7 structs pad to an even byte boundary
        if (currentByte % 2 !== 0) {
          currentByte++
        }
        return {
          ...variable,
          calculatedOffset: offset
        }
      }

      // Check primitive specs
      const spec = S7_PRIMITIVE_SPECS[typeUpper as S7PrimitiveType]
      if (spec) {
        // Check alignment
        if (spec.alignment >= 2 && currentByte % 2 !== 0) {
          currentByte++
        }
        const offset = `${currentByte}.0`
        currentByte += spec.byteSize
        return {
          ...variable,
          calculatedOffset: offset
        }
      }

      // Default fallback (e.g. unknown type treated as 2-byte word)
      if (currentByte % 2 !== 0) {
        currentByte++
      }
      const offset = `${currentByte}.0`
      currentByte += 2
      return {
        ...variable,
        calculatedOffset: offset
      }
    })
  }

  /**
   * Recursively calculates the byte size of a UDT in Siemens S7 standard layout
   */
  public static calculateUdtSize(
    udt: UdtDefinition,
    udtLookup: Map<string, UdtDefinition> = new Map()
  ): number {
    let currentByte = 0
    let currentBit = 0

    for (const member of udt.members) {
      const typeUpper = member.dataType.toUpperCase()

      if (typeUpper === 'BOOL') {
        currentBit++
        if (currentBit >= 8) {
          currentByte++
          currentBit = 0
        }
        continue
      }

      if (currentBit > 0) {
        currentByte++
        currentBit = 0
      }

      const nestedUdt = udtLookup.get(member.dataType)
      if (nestedUdt && nestedUdt.name !== udt.name) {
        if (currentByte % 2 !== 0) {
          currentByte++
        }
        currentByte += this.calculateUdtSize(nestedUdt, udtLookup)
        if (currentByte % 2 !== 0) {
          currentByte++
        }
        continue
      }

      const spec = S7_PRIMITIVE_SPECS[typeUpper as S7PrimitiveType]
      if (spec) {
        if (spec.alignment >= 2 && currentByte % 2 !== 0) {
          currentByte++
        }
        currentByte += spec.byteSize
      } else {
        if (currentByte % 2 !== 0) {
          currentByte++
        }
        currentByte += 2
      }
    }

    if (currentBit > 0) {
      currentByte++
      currentBit = 0
    }

    // Align total struct size to even boundary
    if (currentByte % 2 !== 0) {
      currentByte++
    }

    return currentByte
  }
}

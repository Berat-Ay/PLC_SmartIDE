import { ParsedS7Address, S7MemoryArea, S7PrimitiveType, S7_PRIMITIVE_SPECS, MemoryCoordinate } from '../types/s7types'

/**
 * Parses a Siemens S7 address (e.g., %I0.0, %MW10, %QD4, MB1, etc.)
 */
export function parseS7Address(addressStr: string): ParsedS7Address {
  const clean = addressStr.trim().toUpperCase()
  const normalized = clean.startsWith('%') ? clean.slice(1) : clean

  // Regex patterns:
  // Bit: I0.0, Q1.7, M11.4
  const bitRegex = /^([IQM])(\d+)\.([0-7])$/
  // Byte: IB0, QB10, MB1
  const byteRegex = /^([IQM])B(\d+)$/
  // Word: IW64, QW80, MW10
  const wordRegex = /^([IQM])W(\d+)$/
  // DWord: ID0, QD10, MD10
  const dwordRegex = /^([IQM])D(\d+)$/

  let match = normalized.match(bitRegex)
  if (match) {
    const area = match[1] as S7MemoryArea
    const byteAddress = parseInt(match[2], 10)
    const bitAddress = parseInt(match[3], 10)
    return {
      raw: clean,
      area,
      sizeCategory: 'BIT',
      byteAddress,
      bitAddress,
      bitLength: 1,
      occupiedBytes: [byteAddress],
      isValid: true
    }
  }

  match = normalized.match(byteRegex)
  if (match) {
    const area = match[1] as S7MemoryArea
    const byteAddress = parseInt(match[2], 10)
    return {
      raw: clean,
      area,
      sizeCategory: 'BYTE',
      byteAddress,
      bitLength: 8,
      occupiedBytes: [byteAddress],
      isValid: true
    }
  }

  match = normalized.match(wordRegex)
  if (match) {
    const area = match[1] as S7MemoryArea
    const byteAddress = parseInt(match[2], 10)
    return {
      raw: clean,
      area,
      sizeCategory: 'WORD',
      byteAddress,
      bitLength: 16,
      occupiedBytes: [byteAddress, byteAddress + 1],
      isValid: true
    }
  }

  match = normalized.match(dwordRegex)
  if (match) {
    const area = match[1] as S7MemoryArea
    const byteAddress = parseInt(match[2], 10)
    return {
      raw: clean,
      area,
      sizeCategory: 'DWORD',
      byteAddress,
      bitLength: 32,
      occupiedBytes: [byteAddress, byteAddress + 1, byteAddress + 2, byteAddress + 3],
      isValid: true
    }
  }

  return {
    raw: clean,
    area: 'M',
    sizeCategory: 'BIT',
    byteAddress: 0,
    bitLength: 0,
    occupiedBytes: [],
    isValid: false,
    error: `Invalid Siemens S7 address format: "${addressStr}". Expected formats: %I0.0, %MW10, %QD4, %MB1, etc.`
  }
}

/**
 * Expands any parsed S7 address into all occupied (area, byte, bit) coordinates.
 * Siemens S7 rules:
 * - Bit %M10.2 -> (M, 10, 2)
 * - Byte %MB10 -> (M, 10, 0..7)
 * - Word %MW10 -> (M, 10, 0..7) and (M, 11, 0..7)
 * - DWord %MD10 -> (M, 10, 0..7), (M, 11, 0..7), (M, 12, 0..7), and (M, 13, 0..7)
 */
export function getOccupiedCoordinates(address: ParsedS7Address): MemoryCoordinate[] {
  if (!address.isValid) return []

  const coords: MemoryCoordinate[] = []
  const { area, byteAddress, bitAddress, sizeCategory } = address

  if (sizeCategory === 'BIT' && bitAddress !== undefined) {
    coords.push({ area, byte: byteAddress, bit: bitAddress })
    return coords
  }

  const byteCount = sizeCategory === 'BYTE' ? 1 : sizeCategory === 'WORD' ? 2 : 4
  for (let b = 0; b < byteCount; b++) {
    const currentByte = byteAddress + b
    for (let bit = 0; bit < 8; bit++) {
      coords.push({ area, byte: currentByte, bit })
    }
  }

  return coords
}

/**
 * Returns canonical S7 address string with leading '%'
 */
export function formatS7Address(area: S7MemoryArea, sizeCategory: 'BIT' | 'BYTE' | 'WORD' | 'DWORD', byte: number, bit: number = 0): string {
  switch (sizeCategory) {
    case 'BIT':
      return `%${area}${byte}.${bit}`
    case 'BYTE':
      return `%${area}B${byte}`
    case 'WORD':
      return `%${area}W${byte}`
    case 'DWORD':
      return `%${area}D${byte}`
  }
}

/**
 * Maps a primitive data type to its appropriate S7 address size category
 */
export function getCategoryForType(dataType: string): 'BIT' | 'BYTE' | 'WORD' | 'DWORD' {
  const upper = dataType.toUpperCase()
  if (upper === 'BOOL') return 'BIT'
  if (upper === 'BYTE' || upper === 'CHAR' || upper === 'SINT' || upper === 'USINT') return 'BYTE'
  if (upper === 'WORD' || upper === 'INT' || upper === 'UINT') return 'WORD'
  if (upper === 'DWORD' || upper === 'DINT' || upper === 'UDINT' || upper === 'REAL' || upper === 'TIME') return 'DWORD'
  return 'WORD'
}

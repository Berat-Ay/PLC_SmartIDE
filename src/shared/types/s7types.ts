// Siemens S7 Data Types and Memory Specifications

export type S7PrimitiveType =
  | 'BOOL'
  | 'BYTE'
  | 'SINT'
  | 'USINT'
  | 'CHAR'
  | 'WORD'
  | 'INT'
  | 'UINT'
  | 'DWORD'
  | 'DINT'
  | 'UDINT'
  | 'REAL'
  | 'TIME'
  | 'STRING'

export type S7DataType = S7PrimitiveType | string // Can be a custom UDT name

export type S7MemoryArea = 'I' | 'Q' | 'M' | 'DB'

export interface S7TypeInfo {
  name: S7PrimitiveType
  bitSize: number
  byteSize: number
  alignment: number // in bytes
  prefixArea: {
    bit: ''
    byte: 'B'
    word: 'W'
    dword: 'D'
  }
}

export const S7_PRIMITIVE_SPECS: Record<S7PrimitiveType, S7TypeInfo> = {
  BOOL: { name: 'BOOL', bitSize: 1, byteSize: 0.125, alignment: 1, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  BYTE: { name: 'BYTE', bitSize: 8, byteSize: 1, alignment: 1, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  SINT: { name: 'SINT', bitSize: 8, byteSize: 1, alignment: 1, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  USINT: { name: 'USINT', bitSize: 8, byteSize: 1, alignment: 1, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  CHAR: { name: 'CHAR', bitSize: 8, byteSize: 1, alignment: 1, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  WORD: { name: 'WORD', bitSize: 16, byteSize: 2, alignment: 2, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  INT: { name: 'INT', bitSize: 16, byteSize: 2, alignment: 2, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  UINT: { name: 'UINT', bitSize: 16, byteSize: 2, alignment: 2, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  DWORD: { name: 'DWORD', bitSize: 32, byteSize: 4, alignment: 4, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  DINT: { name: 'DINT', bitSize: 32, byteSize: 4, alignment: 4, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  UDINT: { name: 'UDINT', bitSize: 32, byteSize: 4, alignment: 4, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  REAL: { name: 'REAL', bitSize: 32, byteSize: 4, alignment: 4, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  TIME: { name: 'TIME', bitSize: 32, byteSize: 4, alignment: 4, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } },
  STRING: { name: 'STRING', bitSize: 256 * 8, byteSize: 256, alignment: 2, prefixArea: { bit: '', byte: 'B', word: 'W', dword: 'D' } }
}

export interface ParsedS7Address {
  raw: string
  area: S7MemoryArea
  sizeCategory: 'BIT' | 'BYTE' | 'WORD' | 'DWORD'
  byteAddress: number
  bitAddress?: number
  bitLength: number
  occupiedBytes: number[]
  isValid: boolean
  error?: string
}

export interface MemoryCoordinate {
  area: S7MemoryArea
  byte: number
  bit: number
}

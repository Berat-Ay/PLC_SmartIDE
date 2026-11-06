import { S7DataType, S7MemoryArea } from '../types/s7types'

export interface S7AddressNormalizationResult {
  formatted: string
  address: string
  isValid: boolean
  dataTypeDefault?: S7DataType
  inferredDataType?: S7DataType
  error?: string
  area?: S7MemoryArea
  sizeCategory?: 'BIT' | 'BYTE' | 'WORD' | 'DWORD'
  byteAddress?: number
  bitAddress?: number
}

/**
 * Normalizes user-entered S7 addresses with case-insensitivity,
 * missing '%' prepending, German/IEC alias translation (E->I, A->Q),
 * and strict 0..7 bit index validation.
 *
 * Examples:
 *   q0.5   -> %Q0.5 (BOOL)
 *   i0.0   -> %I0.0 (BOOL)
 *   m10.2  -> %M10.2 (BOOL)
 *   e0.0   -> %I0.0 (BOOL - German Eingang)
 *   a0.5   -> %Q0.5 (BOOL - German Ausgang)
 *   ib0    -> %IB0 (BYTE)
 *   qb1    -> %QB1 (BYTE)
 *   mb10   -> %MB10 (BYTE)
 *   iw64   -> %IW64 (INT)
 *   qw80   -> %QW80 (INT)
 *   mw20   -> %MW20 (INT)
 *   id10   -> %ID10 (DINT)
 *   qd20   -> %QD20 (DINT)
 *   md40   -> %MD40 (DINT)
 *   q0.8   -> Invalid: bit index must be 0..7
 */
export function normalizeS7Address(rawInput: string): S7AddressNormalizationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      formatted: '',
      address: '',
      isValid: false,
      error: 'Address cannot be empty.'
    }
  }

  let clean = rawInput.trim().toUpperCase()
  if (clean.startsWith('%')) {
    clean = clean.slice(1)
  }

  // 1a. Native Timer / Counter Instance Sub-bit & Sub-word Addressing (as in TIA Portal)
  // Timers: T1, T1.Q, T1.IN, T1.ET, T1.PT or IEC_Timer_0_DB.Q
  const timerSubMatch = clean.match(/^([A-Za-z0-9_]+)\.(Q|IN|ET|PT)$/i)
  if (timerSubMatch) {
    const inst = timerSubMatch[1].toUpperCase()
    const member = timerSubMatch[2].toUpperCase()
    const addr = `${inst}.${member}`
    const isTime = member === 'ET' || member === 'PT'
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      sizeCategory: isTime ? 'DWORD' : 'BIT',
      dataTypeDefault: isTime ? 'TIME' : 'BOOL',
      inferredDataType: isTime ? 'TIME' : 'BOOL'
    }
  }

  // Bare Timer shorthand: T1 or T2 on contact implies T1.Q
  const bareTimerMatch = clean.match(/^T(\d+)$/i)
  if (bareTimerMatch) {
    const addr = `T${bareTimerMatch[1]}.Q`
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      sizeCategory: 'BIT',
      dataTypeDefault: 'BOOL',
      inferredDataType: 'BOOL'
    }
  }

  // Counters: C1, C1.QU, C1.QD, C1.CV, C1.PV, C1.CU, C1.CD, C1.R, C1.LD
  const counterSubMatch = clean.match(/^([A-Za-z0-9_]+)\.(QU|QD|CV|PV|CU|CD|R|LD)$/i)
  if (counterSubMatch) {
    const inst = counterSubMatch[1].toUpperCase()
    const member = counterSubMatch[2].toUpperCase()
    const addr = `${inst}.${member}`
    const isInt = member === 'CV' || member === 'PV'
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      sizeCategory: isInt ? 'WORD' : 'BIT',
      dataTypeDefault: isInt ? 'INT' : 'BOOL',
      inferredDataType: isInt ? 'INT' : 'BOOL'
    }
  }

  // Bare Counter shorthand: C1 or C2 on contact implies C1.QU
  const bareCounterMatch = clean.match(/^C(\d+)$/i)
  if (bareCounterMatch) {
    const addr = `C${bareCounterMatch[1]}.QU`
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      sizeCategory: 'BIT',
      dataTypeDefault: 'BOOL',
      inferredDataType: 'BOOL'
    }
  }

  // 1b. German / IEC alias translation (E -> I, A -> Q)
  // Bit addresses: E0.0 -> I0.0, A0.5 -> Q0.5
  if (clean.startsWith('E') && !clean.startsWith('EB') && !clean.startsWith('EW') && !clean.startsWith('ED')) {
    clean = 'I' + clean.slice(1)
  } else if (clean.startsWith('EB')) {
    clean = 'IB' + clean.slice(2)
  } else if (clean.startsWith('EW')) {
    clean = 'IW' + clean.slice(2)
  } else if (clean.startsWith('ED')) {
    clean = 'ID' + clean.slice(2)
  } else if (clean.startsWith('A') && !clean.startsWith('AB') && !clean.startsWith('AW') && !clean.startsWith('AD')) {
    clean = 'Q' + clean.slice(1)
  } else if (clean.startsWith('AB')) {
    clean = 'QB' + clean.slice(2)
  } else if (clean.startsWith('AW')) {
    clean = 'QW' + clean.slice(2)
  } else if (clean.startsWith('AD')) {
    clean = 'QD' + clean.slice(2)
  }

  // 2. Regex matching
  // Bit pattern: %[IQM]<byte>.<bit>
  const bitMatch = clean.match(/^([IQM])(\d+)\.(\d+)$/)
  if (bitMatch) {
    const area = bitMatch[1] as S7MemoryArea
    const byteAddress = parseInt(bitMatch[2], 10)
    const bitIndex = parseInt(bitMatch[3], 10)
    const addr = `%${area}${byteAddress}.${bitIndex}`

    if (bitIndex < 0 || bitIndex > 7) {
      return {
        formatted: addr,
        address: addr,
        isValid: false,
        error: `Invalid S7 bit index (.${bitIndex}). Bit index must be 0..7.`,
        area,
        sizeCategory: 'BIT',
        byteAddress,
        bitAddress: bitIndex,
        dataTypeDefault: 'BOOL',
        inferredDataType: 'BOOL'
      }
    }

    return {
      formatted: addr,
      address: addr,
      isValid: true,
      area,
      sizeCategory: 'BIT',
      byteAddress,
      bitAddress: bitIndex,
      dataTypeDefault: 'BOOL',
      inferredDataType: 'BOOL'
    }
  }

  // Byte pattern: %[IQM]B<byte>
  const byteMatch = clean.match(/^([IQM])B(\d+)$/)
  if (byteMatch) {
    const area = byteMatch[1] as S7MemoryArea
    const byteAddress = parseInt(byteMatch[2], 10)
    const addr = `%${area}B${byteAddress}`
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      area,
      sizeCategory: 'BYTE',
      byteAddress,
      dataTypeDefault: 'BYTE',
      inferredDataType: 'BYTE'
    }
  }

  // Word pattern: %[IQM]W<byte>
  const wordMatch = clean.match(/^([IQM])W(\d+)$/)
  if (wordMatch) {
    const area = wordMatch[1] as S7MemoryArea
    const byteAddress = parseInt(wordMatch[2], 10)
    const addr = `%${area}W${byteAddress}`
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      area,
      sizeCategory: 'WORD',
      byteAddress,
      dataTypeDefault: 'INT',
      inferredDataType: 'INT'
    }
  }

  // DWord pattern: %[IQM]D<byte>
  const dwordMatch = clean.match(/^([IQM])D(\d+)$/)
  if (dwordMatch) {
    const area = dwordMatch[1] as S7MemoryArea
    const byteAddress = parseInt(dwordMatch[2], 10)
    const addr = `%${area}D${byteAddress}`
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      area,
      sizeCategory: 'DWORD',
      byteAddress,
      dataTypeDefault: 'DINT',
      inferredDataType: 'DINT'
    }
  }

  // DB Address patterns (e.g. DB1.DBX0.0, DB1.DBW2, DB1.DBD4)
  const dbBitMatch = clean.match(/^DB(\d+)\.DBX(\d+)\.(\d+)$/)
  if (dbBitMatch) {
    const dbNum = dbBitMatch[1]
    const byteAddress = parseInt(dbBitMatch[2], 10)
    const bitIndex = parseInt(dbBitMatch[3], 10)
    const addr = `%DB${dbNum}.DBX${byteAddress}.${bitIndex}`
    if (bitIndex < 0 || bitIndex > 7) {
      return {
        formatted: addr,
        address: addr,
        isValid: false,
        error: `Invalid S7 bit index (.${bitIndex}). Bit index must be 0..7.`,
        area: 'DB',
        sizeCategory: 'BIT',
        byteAddress,
        bitAddress: bitIndex,
        dataTypeDefault: 'BOOL',
        inferredDataType: 'BOOL'
      }
    }
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      area: 'DB',
      sizeCategory: 'BIT',
      byteAddress,
      bitAddress: bitIndex,
      dataTypeDefault: 'BOOL',
      inferredDataType: 'BOOL'
    }
  }

  const dbWordMatch = clean.match(/^DB(\d+)\.DB(W|D|B)(\d+)$/)
  if (dbWordMatch) {
    const dbNum = dbWordMatch[1]
    const typeChar = dbWordMatch[2]
    const byteAddress = parseInt(dbWordMatch[3], 10)
    const sizeCat = typeChar === 'B' ? 'BYTE' : typeChar === 'W' ? 'WORD' : 'DWORD'
    const defaultType = typeChar === 'B' ? 'BYTE' : typeChar === 'W' ? 'INT' : 'DINT'
    const addr = `%DB${dbNum}.DB${typeChar}${byteAddress}`
    return {
      formatted: addr,
      address: addr,
      isValid: true,
      area: 'DB',
      sizeCategory: sizeCat,
      byteAddress,
      dataTypeDefault: defaultType,
      inferredDataType: defaultType
    }
  }

  const fallbackAddr = rawInput.trim().startsWith('%') ? rawInput.trim().toUpperCase() : `%${rawInput.trim().toUpperCase()}`
  return {
    formatted: fallbackAddr,
    address: fallbackAddr,
    isValid: false,
    error: `Invalid Siemens S7 address format: "${rawInput}". Examples: %I0.0, %Q0.5, %MW10, %DB1.DBX0.0`
  }
}


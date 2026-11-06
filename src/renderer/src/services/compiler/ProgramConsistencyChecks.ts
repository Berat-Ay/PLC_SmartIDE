// Program checks that TIA Portal's compiler would also reject: unknown symbols, invalid literals,
// addresses beyond the selected CPU, absolute access to optimized blocks and bad block references.
import { TagTable } from '@shared/types/tags'
import { CpuConfig } from '@shared/types/hardware'
import { UdtDefinition } from '@shared/types/types'
import { BlockInterface, DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import { LadderNode } from '@shared/types/ladder'
import { CpuProfile, getCpuProfile } from '@shared/constants/cpuProfiles'
import { parseS7Address } from '@shared/constants/s7rules'
import { parseS7Time } from '@shared/s7/time'
import { LayoutVariable, parseTypeName, splitPath, TypeResolver } from '@shared/s7/typeLayout'
import { SclLexer } from '@shared/scl/lexer'
import { SclToken } from '@shared/scl/ast'
import { effectiveInterface, emptyInterface, parseSourceBlock } from '@shared/scl/sourceBlock'

export interface ProgramCheckInput {
  tagTables: TagTable[]
  ladBlocks: LadBlockDefinition[]
  sclBlocks: SclBlockDefinition[]
  dataBlocks: DataBlockDefinition[]
  udts: UdtDefinition[]
  cpuConfig?: CpuConfig
}

export interface ProgramFinding {
  iecCode: string
  message: string
  blockName?: string
  blockFileName?: string
  networkNumber?: number
  nodeId?: string
  line?: number
  tagName?: string
}

/** New timer and counter boxes show their pin name until an output is connected. */
const BOX_PIN_PLACEHOLDER = /^(Q|ET|QU|QD|CV)$/i
const TIMER_FIELD = /\.(Q|ET|IN|PT|QU|QD|CV|PV|CU|CD|R|LD|CLK)$/i

class Checker {
  public readonly findings: ProgramFinding[] = []
  private readonly tagNames = new Set<string>()
  private readonly dbByName = new Map<string, DataBlockDefinition>()
  private readonly dbByNumber = new Map<number, DataBlockDefinition>()
  private readonly codeBlocks = new Map<string, LadBlockDefinition | SclBlockDefinition>()
  private readonly profile?: CpuProfile
  private readonly resolver: TypeResolver

  constructor(private readonly input: ProgramCheckInput) {
    this.profile = getCpuProfile(input.cpuConfig?.general?.targetCpu || input.cpuConfig?.general?.cpuName)
    for (const table of input.tagTables) {
      for (const tag of table.tags || []) this.tagNames.add((tag.name || '').toLowerCase())
    }
    for (const db of input.dataBlocks) {
      this.dbByName.set(db.name.toLowerCase(), db)
      this.dbByNumber.set(db.blockNumber, db)
    }
    for (const b of [...input.ladBlocks, ...input.sclBlocks]) this.codeBlocks.set(b.name.toLowerCase(), b)
    this.resolver = {
      udt: (name) => input.udts.find((u) => u.name.toLowerCase() === name.toLowerCase())?.members as LayoutVariable[] | undefined,
      fb: (name) => {
        const block = this.codeBlocks.get(name.toLowerCase())
        if (!block || block.blockType !== 'FB') return undefined
        return [...this.interfaceOf(block).input, ...this.interfaceOf(block).static]
      }
    }
  }

  private interfaceOf(block: LadBlockDefinition | SclBlockDefinition): BlockInterface {
    if ('code' in block) return effectiveInterface(block)
    return { ...emptyInterface(), ...(block.interface || {}) }
  }

  private add(finding: ProgramFinding): void {
    this.findings.push(finding)
  }

  private checkType(dataType: string, where: Omit<ProgramFinding, 'iecCode' | 'message'>, owner: string, members?: LayoutVariable[]): void {
    parseTypeName(dataType, {
      ...this.resolver,
      onUnknownType: (name) => this.add({ ...where, iecCode: 'S7-TYP-007', message: `[S7-TYP-007] ${owner}: unknown data type '${name}'.` })
    }, members)
  }

  private checkInterface(iface: BlockInterface, where: Omit<ProgramFinding, 'iecCode' | 'message'>, owner: string): void {
    for (const section of [iface.input, iface.output, iface.inOut, iface.static, iface.temp, iface.constant]) {
      for (const v of section || []) this.checkType(v.dataType, where, `${owner}.${v.name}`, v.members)
    }
  }

  public checkBlocksAndData(): void {
    const seen = new Map<string, string>()
    const blocks = [...this.input.ladBlocks, ...this.input.sclBlocks, ...this.input.dataBlocks]
    for (const block of blocks) {
      if (!block.blockNumber) continue
      const key = `${block.blockType}${block.blockNumber}`
      const other = seen.get(key)
      if (other && other !== block.name) {
        this.add({
          iecCode: 'S7-BLK-006',
          blockName: block.name,
          blockFileName: block.fileName,
          message: `[S7-BLK-006] ${block.blockType} number ${block.blockNumber} is used by both '${other}' and '${block.name}'.`
        })
      }
      seen.set(key, block.name)
    }

    for (const db of this.input.dataBlocks) {
      const where = { blockName: db.name, blockFileName: db.fileName }
      if (db.dbType === 'Instance' && db.parentFbName) {
        const parent = this.codeBlocks.get(db.parentFbName.toLowerCase())
        const isBuiltin = parseTypeName(db.parentFbName).kind === 'instance'
        if (!isBuiltin && parent?.blockType !== 'FB') {
          this.add({ ...where, iecCode: 'S7-BLK-006', message: `[S7-BLK-006] Instance DB '${db.name}' refers to function block '${db.parentFbName}', which does not exist.` })
        }
      }
      for (const v of db.variables || []) this.checkType(v.dataType, where, `${db.name}.${v.name}`, v.members)
    }

    for (const table of this.input.tagTables) {
      for (const tag of table.tags || []) {
        this.checkType(tag.dataType, { tagName: tag.name }, `Tag ${tag.name}`)
        this.checkAddress(tag.address, { tagName: tag.name })
      }
    }
  }

  private checkAddress(address: string | undefined, where: Omit<ProgramFinding, 'iecCode' | 'message'>): void {
    if (!address || !this.profile) return
    const parsed = parseS7Address(address)
    if (!parsed.isValid) return
    const size = parsed.sizeCategory === 'DWORD' ? 4 : parsed.sizeCategory === 'WORD' ? 2 : 1
    const limit =
      parsed.area === 'I' ? this.profile.inputBytes : parsed.area === 'Q' ? this.profile.outputBytes : this.profile.merkerBytes
    if (parsed.byteAddress + size > limit) {
      this.add({
        ...where,
        iecCode: 'S7-MEM-002',
        message: `[S7-MEM-002] Address ${address} is outside the ${limit}-byte ${parsed.area} area of ${this.profile.name}.`
      })
    }
  }

  private checkAbsoluteDb(symbol: string, where: Omit<ProgramFinding, 'iecCode' | 'message'>): void {
    const match = symbol.toUpperCase().match(/^%?DB(\d+)\.DB[XBWD]\d+/)
    if (!match) return
    const db = this.dbByNumber.get(parseInt(match[1], 10))
    if (!db) {
      this.add({ ...where, iecCode: 'S7-DB-008', message: `[S7-DB-008] ${symbol} refers to DB${match[1]}, which does not exist.` })
    } else if (db.optimizedAccess) {
      this.add({
        ...where,
        iecCode: 'S7-DB-008',
        message: `[S7-DB-008] ${symbol}: '${db.name}' uses optimized access, so absolute addressing is not allowed.`
      })
    }
  }

  private knownGlobal(name: string): boolean {
    const first = splitPath(name)[0].toLowerCase()
    return this.tagNames.has(name.toLowerCase()) || this.tagNames.has(first) || this.dbByName.has(first) || this.codeBlocks.has(first)
  }

  private knownLocal(iface: BlockInterface, name: string, blockName: string): boolean {
    const first = splitPath(name.replace(/^#/, ''))[0].replace(/\[.*$/, '').toLowerCase()
    if (first === blockName.toLowerCase() || first === 'ret_val') return true
    return [iface.input, iface.output, iface.inOut, iface.static, iface.temp, iface.constant].some((section) =>
      (section || []).some((v) => v.name.toLowerCase() === first)
    )
  }

  /** Scans the statements of an SCL body. The block's own header is skipped. */
  private checkSclTokens(
    code: string,
    iface: BlockInterface,
    blockName: string,
    base: Omit<ProgramFinding, 'iecCode' | 'message'>
  ): void {
    const { tokens } = SclLexer.tokenize(code)
    const beginIndex = tokens.findIndex((t) => t.type === 'KEYWORD' && t.value === 'BEGIN')
    const body: SclToken[] = beginIndex >= 0 ? tokens.slice(beginIndex + 1) : tokens

    body.forEach((token, index) => {
      const where = { ...base, line: token.line }
      if (token.type === 'TIME' && parseS7Time(token.value) === null) {
        this.add({ ...where, iecCode: 'S7-TMR-004', message: `[S7-TMR-004] ${blockName}: invalid time literal '${token.value}'.` })
        return
      }
      if (token.type !== 'IDENTIFIER') return
      // The member in "DB"."Member" is checked with its block at run time
      if (body[index - 1]?.value === '.') return

      if (token.quoted) {
        const next = body[index + 1]
        if (next?.value === '(') this.checkCallTarget(token.value, where, blockName, body[index + 2])
        if (!this.knownGlobal(token.value)) {
          this.add({ ...where, iecCode: 'S7-SCL-009', message: `[S7-SCL-009] ${blockName}: '"${token.value}"' is not a tag or block in this project.` })
        }
        return
      }
      if (token.value.startsWith('#')) {
        if (!this.knownLocal(iface, token.value, blockName)) {
          this.add({ ...where, iecCode: 'S7-SCL-009', message: `[S7-SCL-009] ${blockName}: '${token.value}' is not declared in the block interface.` })
        }
        return
      }
      if (token.value.startsWith('%')) {
        this.checkAddress(token.value, where)
        this.checkAbsoluteDb(token.value, where)
      }
    })
  }

  private checkCallTarget(name: string, where: Omit<ProgramFinding, 'iecCode' | 'message'>, blockName: string, _firstArg?: SclToken): void {
    const lower = name.toLowerCase()
    const block = this.codeBlocks.get(lower)
    if (block?.blockType === 'FB') {
      this.add({ ...where, iecCode: 'S7-SCL-010', message: `[S7-SCL-010] ${blockName}: function block '${name}' must be called through an instance DB.` })
      return
    }
    const db = this.dbByName.get(lower)
    if (db && db.dbType !== 'Instance') {
      this.add({ ...where, iecCode: 'S7-SCL-010', message: `[S7-SCL-010] ${blockName}: global DB '${name}' cannot be called.` })
    }
  }

  public checkSclBlocks(): void {
    for (const block of this.input.sclBlocks) {
      const base = { blockName: block.name, blockFileName: block.fileName }
      const parsed = parseSourceBlock(block.code || '')
      for (const err of parsed.errors) {
        this.add({ ...base, iecCode: 'S7-SCL-005', message: `[S7-SCL-005] ${block.name}: ${err}` })
      }
      if (parsed.hasHeader && parsed.kind && parsed.kind !== block.blockType) {
        this.add({ ...base, iecCode: 'S7-SCL-005', message: `[S7-SCL-005] ${block.name}: source declares a ${parsed.kind} but the block is a ${block.blockType}.` })
      }
      const iface = effectiveInterface(block)
      this.checkInterface(iface, base, block.name)
      this.checkSclTokens(block.code || '', iface, block.name, base)
    }
  }

  private checkLadOperand(raw: string | undefined, iface: BlockInterface, base: Omit<ProgramFinding, 'iecCode' | 'message'>, blockName: string): void {
    const trimmed = (raw || '').trim()
    if (!trimmed || trimmed === '???' || trimmed.includes('???')) return // Reported as S7-LAD-002
    if (BOX_PIN_PLACEHOLDER.test(trimmed)) return
    if (/^-?\d+(\.\d+)?$/.test(trimmed) || /^(TRUE|FALSE)$/i.test(trimmed)) return

    const quoted = trimmed.startsWith('"')
    const clean = trimmed.replace(/"/g, '')
    if (/^(LTIME|TIME|LT|T)#/i.test(clean)) {
      if (parseS7Time(clean) === null) {
        this.add({ ...base, iecCode: 'S7-TMR-004', message: `[S7-TMR-004] ${blockName}: invalid time literal '${clean}'.` })
      }
      return
    }
    if (clean.startsWith('%')) {
      this.checkAddress(clean, base)
      this.checkAbsoluteDb(clean, base)
      return
    }
    if (/^DB\d+\.DB[XBWD]\d+/i.test(clean)) {
      this.checkAbsoluteDb(clean, base)
      return
    }
    if (!quoted && (clean.startsWith('#') || this.knownLocal(iface, clean, blockName))) {
      if (!this.knownLocal(iface, clean, blockName)) {
        this.add({ ...base, iecCode: 'S7-LAD-011', message: `[S7-LAD-011] ${blockName}: '${clean}' is not declared in the block interface.` })
      }
      return
    }
    if (this.knownGlobal(clean) || TIMER_FIELD.test(clean) || /^[TC]\d+$/i.test(clean)) return
    this.add({ ...base, iecCode: 'S7-LAD-011', message: `[S7-LAD-011] ${blockName}: '${clean}' is not a tag or block in this project.` })
  }

  private walkLad(nodes: LadderNode[], visit: (node: LadderNode) => void): void {
    for (const node of nodes || []) {
      visit(node)
      if (node.kind === 'parallel') {
        for (const branch of node.branches) this.walkLad(branch, visit)
      }
    }
  }

  public checkLadBlocks(): void {
    for (const block of this.input.ladBlocks) {
      const iface = this.interfaceOf(block)
      this.checkInterface(iface, { blockName: block.name, blockFileName: block.fileName }, block.name)

      for (const net of block.networks || []) {
        const netBase = { blockName: block.name, blockFileName: block.fileName, networkNumber: net.networkNumber }
        if (net.isSclNetwork && net.sclCode) {
          this.checkSclTokens(net.sclCode, iface, block.name, netBase)
          continue
        }
        this.walkLad((net.nodes || []) as LadderNode[], (node) => {
          const base = { ...netBase, nodeId: node.id }
          const n = node as unknown as Record<string, string | undefined>
          const operand = node.kind === 'contact' || node.kind === 'coil' ? n.address || n.operand : undefined
          this.checkLadOperand(operand, iface, base, block.name)
          if (node.kind === 'timer') {
            this.checkLadOperand(n.ptOperand, iface, base, block.name)
            this.checkLadOperand(n.qOperand, iface, base, block.name)
            this.checkLadOperand(n.etOperand, iface, base, block.name)
          }
          if (node.kind === 'counter') {
            for (const key of ['pvOperand', 'rLdOperand', 'cuOperand', 'cdOperand', 'qOperand', 'cvOperand']) {
              this.checkLadOperand(n[key], iface, base, block.name)
            }
          }
          if (node.kind === 'math') {
            this.checkLadOperand(n.out, iface, base, block.name)
          }
        })
      }
    }
  }
}

export function runProgramChecks(input: ProgramCheckInput): ProgramFinding[] {
  const checker = new Checker(input)
  checker.checkBlocksAndData()
  checker.checkSclBlocks()
  checker.checkLadBlocks()
  return checker.findings
}

/**
 * I/O bits with no channel on the configured CPU. TIA Portal accepts them because they are inside the
 * process image, but nothing is wired there: an output never reaches a lamp and an input never changes.
 */
export function findIoBitsWithoutChannel(tagTables: TagTable[], cpuConfig?: CpuConfig): ProgramFinding[] {
  const inputs = (cpuConfig?.digitalIO?.diChannels || []).map((c) => c.address.toUpperCase())
  const outputs = (cpuConfig?.digitalIO?.dqChannels || []).map((c) => c.address.toUpperCase())
  const findings: ProgramFinding[] = []
  for (const table of tagTables) {
    for (const tag of table.tags || []) {
      const parsed = parseS7Address(tag.address || '')
      if (!parsed.isValid || parsed.sizeCategory !== 'BIT') continue
      const channels = parsed.area === 'I' ? inputs : parsed.area === 'Q' ? outputs : []
      if (channels.length === 0 || channels.includes(tag.address.toUpperCase())) continue
      findings.push({
        iecCode: 'S7-IO-009',
        tagName: tag.name,
        message: `[S7-IO-009] Tag '${tag.name}' uses ${tag.address}, but this CPU has no channel there (${channels[0]}..${channels[channels.length - 1]}).`
      })
    }
  }
  return findings
}

export type DiagnosticSeverity = 'Error' | 'Warning' | 'Info'

export interface DiagnosticMessage {
  id: string
  severity: DiagnosticSeverity
  code: string
  source: string // e.g. 'Memory Overlap Guard', 'Compiler', 'Hardware Config'
  message: string
  timestamp: number
  targetFile?: string
  targetId?: string
  targetSymbol?: string
  targetAddress?: string
  autoFixable?: boolean
  fixAction?: 'AUTO_ASSIGN_ADDRESS' | 'RESOLVE_ALL_OVERLAPS' | 'ALIGN_BOUNDARY'
  fixLabel?: string
}

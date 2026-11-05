export type CrossRefAccessType = 'Read' | 'Write' | 'Read/Write' | 'Declaration'
export type CrossRefSourceType = 'OB' | 'FB' | 'FC' | 'DB' | 'TagTable' | 'UDT' | 'Hardware'

export interface CrossReferenceItem {
  id: string
  targetSymbol: string
  targetAddress?: string
  sourceObject: string
  sourceObjectId: string
  sourceType: CrossRefSourceType
  location: string
  accessType: CrossRefAccessType
  networkNumber?: number
  lineNumber?: number
  snippet?: string
}

export interface CrossRefQueryResult {
  symbol: string
  address?: string
  totalCount: number
  references: CrossReferenceItem[]
}

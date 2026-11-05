import { S7DataType } from './s7types'

export interface UdtMember {
  id: string
  name: string
  dataType: S7DataType
  defaultValue?: string
  comment?: string
  arrayDimension?: number
  calculatedOffset?: string // S7 Standard Access Byte.Bit (e.g. 0.0, 2.0)
}

export interface UdtDefinition {
  id: string
  name: string // e.g. UDT_Pump
  fileName: string // e.g. UDT_Pump.udt.json
  description?: string
  members: UdtMember[]
  calculatedSizeInBytes?: number
}

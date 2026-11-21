import { BlockVariable } from '@shared/types/blocks'
import { UdtDefinition } from '@shared/types/types'
import { buildLayout, LayoutVariable, S7Type, StructType, TypeResolver } from '@shared/s7/typeLayout'

export type FbVariableLookup =
  | Map<string, LayoutVariable[]>
  | ((name: string) => LayoutVariable[] | undefined)

function createResolver(
  udtLookup: Map<string, UdtDefinition> = new Map(),
  fbLookup?: FbVariableLookup
): TypeResolver {
  const udtByLower = new Map<string, UdtDefinition>()
  for (const [key, def] of udtLookup.entries()) {
    udtByLower.set(key.toLowerCase(), def)
    if (def.name) udtByLower.set(def.name.toLowerCase(), def)
  }

  let fbByLower: Map<string, LayoutVariable[]> | undefined
  if (fbLookup instanceof Map) {
    fbByLower = new Map<string, LayoutVariable[]>()
    for (const [key, vars] of fbLookup.entries()) {
      fbByLower.set(key.toLowerCase(), vars)
    }
  }

  return {
    udt: (name) => udtByLower.get(name.toLowerCase())?.members as LayoutVariable[] | undefined,
    fb: (name) => {
      if (!fbLookup) return undefined
      if (typeof fbLookup === 'function') return fbLookup(name)
      return fbByLower?.get(name.toLowerCase())
    }
  }
}

function annotateNestedStructMembers(
  members: BlockVariable[] | undefined,
  structType: S7Type,
  baseByte: number
): BlockVariable[] | undefined {
  if (!members || structType.kind !== 'struct') return members
  return members.map((member, idx) => {
    const layoutMember = structType.members[idx]
    if (!layoutMember) return member
    const absByte = baseByte + layoutMember.byteOffset
    return {
      ...member,
      calculatedOffset: `${absByte}.${layoutMember.bitOffset}`,
      members: annotateNestedStructMembers(member.members, layoutMember.type, absByte)
    }
  })
}

/**
 * Siemens S7 Standard Access (Non-Optimized) Offset Calculator.
 * Delegates layout computation directly to shared/s7/typeLayout.ts so UI offsets and
 * byte sizes match the binary runtime layout identically across primitives, STRING[n],
 * nested Structs, multi-dimensional ARRAYs, UDTs, and FB instances.
 */
export class S7OffsetCalculator {
  public static calculateLayout(
    variables: LayoutVariable[],
    udtLookup: Map<string, UdtDefinition> = new Map(),
    fbLookup?: FbVariableLookup
  ): StructType {
    return buildLayout(variables, createResolver(udtLookup, fbLookup))
  }

  /**
   * Calculates offsets for an array of block variables (e.g. in a DB or Block Interface)
   */
  public static calculateVariableOffsets(
    variables: BlockVariable[],
    udtLookup: Map<string, UdtDefinition> = new Map(),
    fbLookup?: FbVariableLookup
  ): BlockVariable[] {
    const layout = buildLayout(variables as LayoutVariable[], createResolver(udtLookup, fbLookup))
    return variables.map((variable, idx) => {
      const member = layout.members[idx]
      if (!member) return variable
      return {
        ...variable,
        calculatedOffset: `${member.byteOffset}.${member.bitOffset}`,
        members: annotateNestedStructMembers(variable.members, member.type, member.byteOffset)
      }
    })
  }

  /**
   * Recursively calculates the byte size of a UDT in Siemens S7 standard layout
   */
  public static calculateUdtSize(
    udt: UdtDefinition,
    udtLookup: Map<string, UdtDefinition> = new Map(),
    fbLookup?: FbVariableLookup
  ): number {
    const layout = buildLayout(udt.members as LayoutVariable[], createResolver(udtLookup, fbLookup))
    return layout.byteSize
  }
}

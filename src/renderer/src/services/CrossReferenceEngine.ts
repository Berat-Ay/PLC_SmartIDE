import { CrossReferenceItem, CrossRefQueryResult } from '@shared/types/crossref'
import { TagTable } from '@shared/types/tags'
import { CpuConfig } from '@shared/types/hardware'
import { UdtDefinition } from '@shared/types/types'
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'

export class CrossReferenceEngine {
  private static index = new Map<string, CrossReferenceItem[]>()

  /**
   * Rebuilds the entire cross-reference graph across all project files
   */
  public static rebuildIndex(params: {
    cpuConfig?: CpuConfig
    tagTables: TagTable[]
    udts: UdtDefinition[]
    dataBlocks: DataBlockDefinition[]
    ladBlocks: LadBlockDefinition[]
    sclBlocks: SclBlockDefinition[]
  }): void {
    const newIndex = new Map<string, CrossReferenceItem[]>()

    const addRef = (key: string, item: CrossReferenceItem) => {
      if (!key) return
      const normalized = key.trim().toUpperCase()
      const list = newIndex.get(normalized) || []
      list.push(item)
      newIndex.set(normalized, list)
    }

    const { cpuConfig, tagTables, udts, dataBlocks, ladBlocks, sclBlocks } = params

    // 1. Index Tag Tables (Declarations)
    for (const table of tagTables) {
      for (const tag of table.tags) {
        const item: CrossReferenceItem = {
          id: `xref_tag_${tag.id}`,
          targetSymbol: tag.name,
          targetAddress: tag.address,
          sourceObject: table.name || table.fileName,
          sourceObjectId: table.id,
          sourceType: 'TagTable',
          location: `Tag Table [${table.name}]`,
          accessType: 'Declaration',
          snippet: `${tag.name} : ${tag.dataType} AT ${tag.address}`
        }
        addRef(tag.name, item)
        if (tag.address) {
          addRef(tag.address, item)
        }
      }
    }

    // 2. Index CPU Hardware Parameters
    if (cpuConfig) {
      if (cpuConfig.systemMemory.enabled) {
        const byte = cpuConfig.systemMemory.byteAddress
        const sysTags = [
          { name: 'FirstScan', addr: `%M${byte}.0` },
          { name: 'DiagStatusUpdate', addr: `%M${byte}.1` },
          { name: 'AlwaysTrue', addr: `%M${byte}.2` },
          { name: 'AlwaysFalse', addr: `%M${byte}.3` }
        ]
        for (const st of sysTags) {
          const item: CrossReferenceItem = {
            id: `xref_sys_${st.name}`,
            targetSymbol: st.name,
            targetAddress: st.addr,
            sourceObject: 'Hardware Configuration',
            sourceObjectId: 'cpu_config',
            sourceType: 'Hardware',
            location: 'CPU System Memory Byte',
            accessType: 'Declaration',
            snippet: `System Memory Tag: ${st.name} at ${st.addr}`
          }
          addRef(st.name, item)
          addRef(st.addr, item)
        }
      }

      if (cpuConfig.clockMemory.enabled) {
        const byte = cpuConfig.clockMemory.byteAddress
        const clockTags = [
          { name: 'Clock_10Hz', addr: `%M${byte}.0` },
          { name: 'Clock_5Hz', addr: `%M${byte}.1` },
          { name: 'Clock_2.5Hz', addr: `%M${byte}.2` },
          { name: 'Clock_2Hz', addr: `%M${byte}.3` },
          { name: 'Clock_1.25Hz', addr: `%M${byte}.4` },
          { name: 'Clock_1Hz', addr: `%M${byte}.5` },
          { name: 'Clock_0.625Hz', addr: `%M${byte}.6` },
          { name: 'Clock_0.5Hz', addr: `%M${byte}.7` }
        ]
        for (const ct of clockTags) {
          const item: CrossReferenceItem = {
            id: `xref_clock_${ct.name}`,
            targetSymbol: ct.name,
            targetAddress: ct.addr,
            sourceObject: 'Hardware Configuration',
            sourceObjectId: 'cpu_config',
            sourceType: 'Hardware',
            location: 'CPU Clock Memory Byte',
            accessType: 'Declaration',
            snippet: `Clock Memory Tag: ${ct.name} at ${ct.addr}`
          }
          addRef(ct.name, item)
          addRef(ct.addr, item)
        }
      }

      // DI channels
      for (const di of cpuConfig.digitalIO.diChannels) {
        const item: CrossReferenceItem = {
          id: `xref_di_${di.channelIndex}`,
          targetSymbol: di.name || `DI Channel ${di.channelIndex}`,
          targetAddress: di.address,
          sourceObject: 'Device Configuration',
          sourceObjectId: 'cpu_config',
          sourceType: 'Hardware',
          location: `DI 16x24VDC Channel ${di.channelIndex}`,
          accessType: 'Declaration',
          snippet: `${di.name} [${di.address}] Filter: ${di.filterDelay}`
        }
        if (di.name) addRef(di.name, item)
        if (di.address) addRef(di.address, item)
      }

      // DQ channels
      for (const dq of cpuConfig.digitalIO.dqChannels) {
        const item: CrossReferenceItem = {
          id: `xref_dq_${dq.channelIndex}`,
          targetSymbol: dq.name || `DQ Channel ${dq.channelIndex}`,
          targetAddress: dq.address,
          sourceObject: 'Device Configuration',
          sourceObjectId: 'cpu_config',
          sourceType: 'Hardware',
          location: `DQ 16x24VDC Channel ${dq.channelIndex}`,
          accessType: 'Declaration',
          snippet: `${dq.name} [${dq.address}]`
        }
        if (dq.name) addRef(dq.name, item)
        if (dq.address) addRef(dq.address, item)
      }

      // AI channels
      for (const ai of cpuConfig.analogIO.aiChannels) {
        const item: CrossReferenceItem = {
          id: `xref_ai_${ai.channelIndex}`,
          targetSymbol: ai.name || `AI Channel ${ai.channelIndex}`,
          targetAddress: ai.address,
          sourceObject: 'Device Configuration',
          sourceObjectId: 'cpu_config',
          sourceType: 'Hardware',
          location: `AI 4xU/I Channel ${ai.channelIndex}`,
          accessType: 'Declaration',
          snippet: `${ai.name} [${ai.address}] ${ai.measurementType}`
        }
        if (ai.name) addRef(ai.name, item)
        if (ai.address) addRef(ai.address, item)
      }
    }

    // 3. Index UDTs
    for (const udt of udts) {
      // Declaration of UDT
      addRef(udt.name, {
        id: `xref_udt_decl_${udt.id}`,
        targetSymbol: udt.name,
        sourceObject: udt.name,
        sourceObjectId: udt.id,
        sourceType: 'UDT',
        location: 'Data Type Definition',
        accessType: 'Declaration',
        snippet: `TYPE "${udt.name}"`
      })

      for (const member of udt.members) {
        // If member uses another UDT
        addRef(member.dataType, {
          id: `xref_udt_mem_${udt.id}_${member.id}`,
          targetSymbol: member.dataType,
          sourceObject: udt.name,
          sourceObjectId: udt.id,
          sourceType: 'UDT',
          location: `Member "${member.name}"`,
          accessType: 'Read',
          snippet: `${member.name} : ${member.dataType}`
        })
      }
    }

    // 4. Index Data Blocks (DBs)
    for (const db of dataBlocks) {
      const dbId = db.id || db.fileName
      addRef(db.name, {
        id: `xref_db_decl_${dbId}`,
        targetSymbol: db.name,
        sourceObject: db.name,
        sourceObjectId: dbId,
        sourceType: 'DB',
        location: `DB${db.blockNumber} [${db.dbType}]`,
        accessType: 'Declaration',
        snippet: `DATA_BLOCK "${db.name}" (DB${db.blockNumber})`
      })

      for (const v of db.variables) {
        const fullPath = `"${db.name}".${v.name}`
        const item: CrossReferenceItem = {
          id: `xref_db_var_${dbId}_${v.id}`,
          targetSymbol: fullPath,
          sourceObject: db.name,
          sourceObjectId: dbId,
          sourceType: 'DB',
          location: `Offset ${v.calculatedOffset || 'auto'}`,
          accessType: 'Declaration',
          snippet: `${v.name} : ${v.dataType}`
        }
        addRef(fullPath, item)
        addRef(v.name, item)
        // If variable references a UDT
        addRef(v.dataType, {
          id: `xref_db_udt_use_${dbId}_${v.id}`,
          targetSymbol: v.dataType,
          sourceObject: db.name,
          sourceObjectId: dbId,
          sourceType: 'DB',
          location: `Variable "${v.name}"`,
          accessType: 'Read',
          snippet: `Instance of ${v.dataType}`
        })
      }
    }

    // 5. Index Ladder Logic Blocks (LAD)
    for (const lad of ladBlocks) {
      // Interface variables
      const checkVars = (vars: typeof lad.interface.input, sectionName: string) => {
        for (const v of vars) {
          addRef(v.name, {
            id: `xref_lad_if_${lad.name}_${v.id}`,
            targetSymbol: v.name,
            sourceObject: lad.name,
            sourceObjectId: lad.fileName,
            sourceType: lad.blockType,
            location: `Interface (${sectionName})`,
            accessType: 'Declaration',
            snippet: `${v.name} : ${v.dataType}`
          })
          if (v.dataType) {
            addRef(v.dataType, {
              id: `xref_lad_if_type_${lad.name}_${v.id}`,
              targetSymbol: v.dataType,
              sourceObject: lad.name,
              sourceObjectId: lad.fileName,
              sourceType: lad.blockType,
              location: `Interface (${sectionName})`,
              accessType: 'Read',
              snippet: `${v.name} uses type ${v.dataType}`
            })
          }
        }
      }

      checkVars(lad.interface.input, 'Input')
      checkVars(lad.interface.output, 'Output')
      checkVars(lad.interface.inOut, 'InOut')
      checkVars(lad.interface.static, 'Static')
      checkVars(lad.interface.temp, 'Temp')
      checkVars(lad.interface.constant, 'Constant')

      // Networks
      for (const net of lad.networks) {
        if (net.elements && net.elements.length > 0) {
          for (const el of net.elements) {
            if (el.kind === 'contact') {
              const c = el.data as { operand: string; type: string }
              addRef(c.operand, {
                id: `xref_net_contact_${lad.name}_${el.id}`,
                targetSymbol: c.operand,
                sourceObject: lad.name,
                sourceObjectId: lad.fileName,
                sourceType: lad.blockType,
                location: `Network ${net.networkNumber} [Contact ${c.type}]`,
                accessType: 'Read',
                networkNumber: net.networkNumber,
                snippet: `Network ${net.networkNumber}: -| ${c.operand} |-`
              })
            } else if (el.kind === 'coil') {
              const c = el.data as { operand: string; type: string }
              addRef(c.operand, {
                id: `xref_net_coil_${lad.name}_${el.id}`,
                targetSymbol: c.operand,
                sourceObject: lad.name,
                sourceObjectId: lad.fileName,
                sourceType: lad.blockType,
                location: `Network ${net.networkNumber} [Coil ${c.type}]`,
                accessType: 'Write',
                networkNumber: net.networkNumber,
                snippet: `Network ${net.networkNumber}: -( ${c.operand} )-`
              })
            } else if (el.kind === 'box') {
              const b = el.data as { boxType: string; parameters: Record<string, string>; instanceDbName?: string }
              if (b.instanceDbName) {
                addRef(b.instanceDbName, {
                  id: `xref_net_box_inst_${lad.name}_${el.id}`,
                  targetSymbol: b.instanceDbName,
                  sourceObject: lad.name,
                  sourceObjectId: lad.fileName,
                  sourceType: lad.blockType,
                  location: `Network ${net.networkNumber} [${b.boxType} Call]`,
                  accessType: 'Read/Write',
                  networkNumber: net.networkNumber,
                  snippet: `Instance DB "${b.instanceDbName}"`
                })
              }
              for (const [param, val] of Object.entries(b.parameters)) {
                addRef(val, {
                  id: `xref_net_box_${lad.name}_${el.id}_${param}`,
                  targetSymbol: val,
                  sourceObject: lad.name,
                  sourceObjectId: lad.fileName,
                  sourceType: lad.blockType,
                  location: `Network ${net.networkNumber} [${b.boxType} .${param}]`,
                  accessType: param === 'OUT' || param === 'ET' ? 'Write' : 'Read',
                  networkNumber: net.networkNumber,
                  snippet: `${b.boxType}.${param} := ${val}`
                })
              }
            }
          }
        } else if (net.nodes) {
          const scanNodes = (nodes: any[]) => {
            for (const n of nodes) {
              if (n.kind === 'contact') {
                addRef(n.operand, {
                  id: `xref_net_contact_${lad.name}_${n.id}`,
                  targetSymbol: n.operand,
                  sourceObject: lad.name,
                  sourceObjectId: lad.fileName,
                  sourceType: lad.blockType,
                  location: `Network ${net.networkNumber} [Contact]`,
                  accessType: 'Read',
                  networkNumber: net.networkNumber,
                  snippet: `Network ${net.networkNumber}: -| ${n.operand} |-`
                })
              } else if (n.kind === 'coil') {
                addRef(n.operand, {
                  id: `xref_net_coil_${lad.name}_${n.id}`,
                  targetSymbol: n.operand,
                  sourceObject: lad.name,
                  sourceObjectId: lad.fileName,
                  sourceType: lad.blockType,
                  location: `Network ${net.networkNumber} [Coil]`,
                  accessType: 'Write',
                  networkNumber: net.networkNumber,
                  snippet: `Network ${net.networkNumber}: -( ${n.operand} )-`
                })
              } else if (n.kind === 'parallel' && n.branches) {
                for (const b of n.branches) scanNodes(b)
              }
            }
          }
          scanNodes(net.nodes)
        }
      }
    }

    // 6. Index SCL Blocks
    for (const scl of sclBlocks) {
      // Interface
      const checkVars = (vars: typeof scl.interface.input, sectionName: string) => {
        for (const v of vars) {
          addRef(v.name, {
            id: `xref_scl_if_${scl.name}_${v.id}`,
            targetSymbol: v.name,
            sourceObject: scl.name,
            sourceObjectId: scl.fileName,
            sourceType: scl.blockType,
            location: `Interface (${sectionName})`,
            accessType: 'Declaration',
            snippet: `${v.name} : ${v.dataType}`
          })
        }
      }
      checkVars(scl.interface.input, 'Input')
      checkVars(scl.interface.output, 'Output')
      checkVars(scl.interface.inOut, 'InOut')
      checkVars(scl.interface.static, 'Static')
      checkVars(scl.interface.temp, 'Temp')

      // Simple regex scan of SCL lines for symbol references
      const lines = scl.code.split('\n')
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx].trim()
        if (!line || line.startsWith('//') || line.startsWith('(*')) continue

        // Check assignments: target := expr;
        const assignMatch = line.match(/^([a-zA-Z0-9_%."]+)\s*:=/i)
        if (assignMatch) {
          const lhs = assignMatch[1].replace(/"/g, '')
          addRef(lhs, {
            id: `xref_scl_line_${scl.name}_${lineIdx}_w`,
            targetSymbol: lhs,
            sourceObject: scl.name,
            sourceObjectId: scl.fileName,
            sourceType: scl.blockType,
            location: `Line ${lineIdx + 1}`,
            accessType: 'Write',
            lineNumber: lineIdx + 1,
            snippet: line
          })
        }

        // Scan identifiers on the line
        const identifiers = line.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []
        for (const id of identifiers) {
          if (['IF', 'THEN', 'ELSE', 'END_IF', 'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE', 'CASE', 'OF', 'RETURN', 'AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'VAR', 'END_VAR'].includes(id.toUpperCase())) {
            continue
          }
          if (assignMatch && id === assignMatch[1].replace(/"/g, '')) continue

          addRef(id, {
            id: `xref_scl_line_${scl.name}_${lineIdx}_r_${id}`,
            targetSymbol: id,
            sourceObject: scl.name,
            sourceObjectId: scl.fileName,
            sourceType: scl.blockType,
            location: `Line ${lineIdx + 1}`,
            accessType: 'Read',
            lineNumber: lineIdx + 1,
            snippet: line
          })
        }
      }
    }

    this.index = newIndex
  }

  /**
   * 0ms query of any symbol name, address, or DB field
   */
  public static query(queryStr: string): CrossRefQueryResult {
    if (!queryStr) {
      return { symbol: '', totalCount: 0, references: [] }
    }

    const clean = queryStr.trim().replace(/^"/, '').replace(/"$/, '')
    const normalized = clean.toUpperCase()

    // Direct lookup
    let results = this.index.get(normalized) || []

    // If query has % prefix or missing %, check alternate
    if (results.length === 0) {
      if (normalized.startsWith('%')) {
        results = this.index.get(normalized.slice(1)) || []
      } else {
        results = this.index.get(`%${normalized}`) || []
      }
    }

    return {
      symbol: clean,
      totalCount: results.length,
      references: results
    }
  }
}

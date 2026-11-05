import { TagTable } from '@shared/types/tags'
import { CpuConfig } from '@shared/types/hardware'
import { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
import { UdtDefinition } from '@shared/types/types'
import {
  ProjectCompilerEngine,
  type CompileMessage,
  type CompileResult
} from './compiler/ProjectCompilerEngine'

export type { CompileMessage, CompileResult }
export { ProjectCompilerEngine }

export class CompileEngine {
  public static runFullProjectCompilation(
    tagTables?: TagTable[],
    ladBlocks?: LadBlockDefinition[],
    sclBlocks?: SclBlockDefinition[],
    cpuConfig?: CpuConfig,
    dataBlocks?: DataBlockDefinition[],
    udts?: UdtDefinition[]
  ): CompileResult {
    return ProjectCompilerEngine.runFullProjectCompilation(
      tagTables,
      ladBlocks,
      sclBlocks,
      cpuConfig,
      dataBlocks,
      udts
    )
  }
}

import { TagTable } from '@shared/types/tags'
import { CpuConfig } from '@shared/types/hardware'
import { LadBlockDefinition, SclBlockDefinition } from '@shared/types/blocks'
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
    cpuConfig?: CpuConfig
  ): CompileResult {
    return ProjectCompilerEngine.runFullProjectCompilation(
      tagTables,
      ladBlocks,
      sclBlocks,
      cpuConfig
    )
  }
}

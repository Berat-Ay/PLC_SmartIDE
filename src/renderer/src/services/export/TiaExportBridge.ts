// Connects the project stores to the TIA export and import modules in shared/tia.
import { useTagStore } from '../../stores/useTagStore'
import { useBlockStore } from '../../stores/useBlockStore'
import { useProjectStore } from '../../stores/useProjectStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { ProjectLoadPayload } from '@shared/types/ipc'
import { buildTiaBundle, TiaBundle } from '@shared/tia/bundle'
import { mergeTiaImport, TiaMergeResult } from '@shared/tia/merge'
import { readTiaFolder, TiaImportFile } from '@shared/tia/readers'

export interface TiaExportSummary {
  sclFilesCount: number
  dbFilesCount: number
  udtFilesCount: number
  skippedBlocksCount: number
  totalTagsExported: number
}

export interface TiaExportBundle extends TiaBundle {
  targetCpu: string
  summary: TiaExportSummary
}

export class TiaExportBridge {
  private static currentProject(): ProjectLoadPayload {
    const project = useProjectStore.getState()
    const blocks = useBlockStore.getState()
    return {
      projectPath: project.projectPath || '',
      metadata: project.metadata as ProjectLoadPayload['metadata'],
      hardware: useHardwareStore.getState().config,
      tagTables: useTagStore.getState().tagTables,
      udts: blocks.udts,
      dataBlocks: blocks.dataBlocks,
      ladBlocks: blocks.ladBlocks,
      sclBlocks: blocks.sclBlocks
    }
  }

  public static generateBundle(): TiaExportBundle {
    const payload = this.currentProject()
    const bundle = buildTiaBundle(payload)
    const count = (type: string): number => bundle.files.filter((f) => f.type === type).length
    return {
      ...bundle,
      targetCpu: bundle.manifest.cpu?.name || 'Unknown CPU',
      summary: {
        sclFilesCount: count('scl'),
        dbFilesCount: count('db'),
        udtFilesCount: count('udt'),
        skippedBlocksCount: bundle.manifest.skipped.length,
        totalTagsExported: payload.tagTables.reduce((sum, table) => sum + (table.tags || []).filter((t) => t.address).length, 0)
      }
    }
  }

  /** Works out what an import would change without changing anything. */
  public static previewImport(files: TiaImportFile[]): TiaMergeResult {
    const blocks = useBlockStore.getState()
    return mergeTiaImport(
      {
        udts: blocks.udts,
        dataBlocks: blocks.dataBlocks,
        ladBlocks: blocks.ladBlocks,
        sclBlocks: blocks.sclBlocks,
        tagTables: useTagStore.getState().tagTables
      },
      readTiaFolder(files)
    )
  }

  public static applyImport(merge: TiaMergeResult): void {
    const { udts, dataBlocks, ladBlocks, sclBlocks, tagTables } = merge.next
    useBlockStore.getState().setBlocks({ udts, dataBlocks, ladBlocks, sclBlocks })
    useTagStore.getState().setTagTables(tagTables)
    useProjectStore.getState().markDirty(true)
  }
}

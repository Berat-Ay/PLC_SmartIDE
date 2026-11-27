import { useHardwareStore } from './useHardwareStore'
import { useTagStore, registerTagStoreHooks } from './useTagStore'
import { useBlockStore } from './useBlockStore'
import { useCrossRefStore, registerCrossRefSources } from './useCrossRefStore'

let initialized = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingWorkerSync = false
let workerSyncHook: (() => void) | null = null
let physicsAttachHook: (() => void) | null = null

const REINDEX_DEBOUNCE_MS = 100

export function registerWorkerSyncHook(fn: () => void): void {
  workerSyncHook = fn
}

export function registerPhysicsAttachHook(fn: () => void): void {
  physicsAttachHook = fn
  if (initialized) {
    physicsAttachHook()
  }
}

function runFlush(withWorkerSync: boolean): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  useTagStore.getState().recalculateCollisions()
  useCrossRefStore.getState().reindex()
  if (withWorkerSync) {
    pendingWorkerSync = false
    workerSyncHook?.()
  }
}

export function flushProjectCoordinator(withWorkerSync: boolean = true): void {
  runFlush(withWorkerSync || pendingWorkerSync)
}

function scheduleUpdate(includeWorkerSync: boolean): void {
  useCrossRefStore.getState().markIndexDirty()
  if (includeWorkerSync) pendingWorkerSync = true
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    runFlush(pendingWorkerSync)
  }, REINDEX_DEBOUNCE_MS)
}

/**
 * Wires non-circular cross-store reads and debounces expensive overlap/cross-ref/worker updates.
 */
export function initProjectCoordinator(): void {
  if (initialized) return
  initialized = true

  registerTagStoreHooks({
    getCpuConfig: () => useHardwareStore.getState().config,
    onSelectTagName: (name: string) => useCrossRefStore.getState().setQuery(name)
  })

  registerCrossRefSources(() => {
    const cpuConfig = useHardwareStore.getState().config
    const tagTables = useTagStore.getState().tagTables
    const { udts, dataBlocks, ladBlocks, sclBlocks } = useBlockStore.getState()
    return { cpuConfig, tagTables, udts, dataBlocks, ladBlocks, sclBlocks }
  })

  useBlockStore.subscribe((state, prev) => {
    if (
      state.dataBlocks === prev.dataBlocks &&
      state.ladBlocks === prev.ladBlocks &&
      state.sclBlocks === prev.sclBlocks &&
      state.udts === prev.udts
    ) {
      return
    }
    scheduleUpdate(true)
  })

  useTagStore.subscribe((state, prev) => {
    if (state.tagTables === prev.tagTables) return
    scheduleUpdate(true)
  })

  useHardwareStore.subscribe((state, prev) => {
    if (state.config === prev.config) return
    useTagStore.getState().recalculateCollisions()
    scheduleUpdate(true)
  })

  physicsAttachHook?.()
}

initProjectCoordinator()

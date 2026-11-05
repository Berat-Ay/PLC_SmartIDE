import { create } from 'zustand'
import {
  CpuConfig,
  DigitalInputChannel,
  DigitalOutputChannel,
  AnalogInputChannel,
  AnalogOutputChannel,
  OrganizationBlockConfig
} from '@shared/types/hardware'
import { CpuProfile } from '@shared/constants/cpuProfiles'
import { getDefaultCpuConfig } from '@shared/constants/hardwareDefaults'
import { useTagStore } from './useTagStore'
import { useCrossRefStore } from './useCrossRefStore'

interface HardwareStoreState {
  config: CpuConfig

  setConfig: (config: CpuConfig) => void
  applyCpuProfile: (profile: CpuProfile) => void
  updateGeneral: (updates: Partial<CpuConfig['general']>) => void
  updateSystemMemory: (enabled: boolean, byteAddress: number) => void
  updateClockMemory: (enabled: boolean, byteAddress: number) => void
  updateDiChannel: (index: number, updates: Partial<DigitalInputChannel>) => void
  updateDqChannel: (index: number, updates: Partial<DigitalOutputChannel>) => void
  updateAiChannel: (index: number, updates: Partial<AnalogInputChannel>) => void
  updateAqChannel: (index: number, updates: Partial<AnalogOutputChannel>) => void
  updateOb: (blockNumber: number, updates: Partial<OrganizationBlockConfig>) => void
  addOb: (ob: OrganizationBlockConfig) => void
  removeOb: (blockNumber: number) => void
}

export const useHardwareStore = create<HardwareStoreState>((set, get) => ({
  config: getDefaultCpuConfig(),

  setConfig: (config: CpuConfig) => set({ config }),

  applyCpuProfile: (profile: CpuProfile) => {
    set((state) => ({
      config: {
        ...state.config,
        general: {
          ...state.config.general,
          cpuName: profile.name,
          targetCpu: profile.family === 'S7-1200' ? 'Virtual S7-1200' : 'Virtual S7-1500'
        },
        digitalIO: {
          diStartByte: state.config.digitalIO.diStartByte,
          dqStartByte: state.config.digitalIO.dqStartByte,
          diChannels: profile.defaultDiChannels,
          dqChannels: profile.defaultDqChannels
        },
        analogIO: {
          aiChannels: profile.defaultAiChannels,
          aqChannels: profile.defaultAqChannels
        }
      }
    }))
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  updateGeneral: (updates) => {
    set((state) => ({
      config: {
        ...state.config,
        general: { ...state.config.general, ...updates }
      }
    }))
  },

  updateSystemMemory: (enabled, byteAddress) => {
    set((state) => ({
      config: {
        ...state.config,
        systemMemory: { enabled, byteAddress }
      }
    }))
    // System memory changed -> re-scan overlaps & cross-references
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  updateClockMemory: (enabled, byteAddress) => {
    set((state) => ({
      config: {
        ...state.config,
        clockMemory: { enabled, byteAddress }
      }
    }))
    // Clock memory changed -> re-scan overlaps & cross-references
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  updateDiChannel: (index, updates) => {
    set((state) => {
      const diChannels = [...state.config.digitalIO.diChannels]
      if (diChannels[index]) {
        diChannels[index] = { ...diChannels[index], ...updates }
      }
      return {
        config: {
          ...state.config,
          digitalIO: { ...state.config.digitalIO, diChannels }
        }
      }
    })
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  updateDqChannel: (index, updates) => {
    set((state) => {
      const dqChannels = [...state.config.digitalIO.dqChannels]
      if (dqChannels[index]) {
        dqChannels[index] = { ...dqChannels[index], ...updates }
      }
      return {
        config: {
          ...state.config,
          digitalIO: { ...state.config.digitalIO, dqChannels }
        }
      }
    })
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  updateAiChannel: (index, updates) => {
    set((state) => {
      const aiChannels = [...state.config.analogIO.aiChannels]
      if (aiChannels[index]) {
        aiChannels[index] = { ...aiChannels[index], ...updates }
      }
      return {
        config: {
          ...state.config,
          analogIO: { ...state.config.analogIO, aiChannels }
        }
      }
    })
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  updateAqChannel: (index, updates) => {
    set((state) => {
      const aqChannels = [...state.config.analogIO.aqChannels]
      if (aqChannels[index]) {
        aqChannels[index] = { ...aqChannels[index], ...updates }
      }
      return {
        config: {
          ...state.config,
          analogIO: { ...state.config.analogIO, aqChannels }
        }
      }
    })
    useTagStore.getState().recalculateCollisions()
    useCrossRefStore.getState().reindex()
  },

  updateOb: (blockNumber, updates) => {
    set((state) => ({
      config: {
        ...state.config,
        organizationBlocks: state.config.organizationBlocks.map((ob) =>
          ob.blockNumber === blockNumber ? { ...ob, ...updates } : ob
        )
      }
    }))
  },

  addOb: (ob) => {
    set((state) => ({
      config: {
        ...state.config,
        organizationBlocks: [...state.config.organizationBlocks, ob]
      }
    }))
  },

  removeOb: (blockNumber) => {
    set((state) => ({
      config: {
        ...state.config,
        organizationBlocks: state.config.organizationBlocks.filter((ob) => ob.blockNumber !== blockNumber)
      }
    }))
  }
}))

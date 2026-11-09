import { create } from 'zustand'
import type { AcceptanceSummary } from '../services/scenarios/ScenarioAcceptance'

export type TabType = 'hardware' | 'tagTable' | 'allTags' | 'db' | 'udt' | 'lad' | 'scl' | 'simulation' | 'trace'

export interface EditorTab {
  id: string
  title: string
  type: TabType
  targetId?: string // e.g. tableId, udtId, db fileName, block fileName
  isDirty?: boolean
}

export interface AgentChatMessage {
  id: string
  sender: 'user' | 'agent'
  text: string
  timestamp: number
  tier?: 'fast-flash' | 'deep-pro'
  ragRulesConsulted?: string[]
  rawTraceSnippet?: string
  rawJson?: string
  isError?: boolean
  errorDetails?: string
  /** The acceptance result of a built-in scenario, when the request was one */
  acceptanceReport?: AcceptanceSummary
}

interface UIStoreState {
  tabs: EditorTab[]
  activeTabId: string | null
  splitTabId: string | null
  isSplitView: boolean

  // Portal View / Startup Wizard
  isPortalViewOpen: boolean

  // Docks
  leftDockCollapsed: boolean
  leftDockWidth: number
  rightDockCollapsed: boolean
  rightDockWidth: number
  rightActiveTab: 'instructions' | 'agent'
  bottomDockCollapsed: boolean
  bottomDockHeight: number
  bottomActiveTab: 'compile' | 'crossref' | 'memoryMap' | 'trace'

  // Add Block Modal
  isAddBlockModalOpen: boolean

  // Circuit patterns and notes modal
  isBookTrainerOpen: boolean

  // Black-Box Flight Recorder / Telemetry Log Modal
  isDebugLogModalOpen: boolean

  // Ladder Canvas Zoom Level (1.0 = 100%)
  canvasZoom: number

  // AI Agent Shell
  agentMode: 'auto-apply' | 'diff-view'
  agentTier: 'fast-flash' | 'deep-pro'
  agentMessages: AgentChatMessage[]
  activePrompt: string

  // Actions
  setCanvasZoom: (zoom: number) => void
  setBookTrainerOpen: (open: boolean) => void
  setDebugLogModalOpen: (open: boolean) => void
  openTab: (tab: EditorTab) => void
  closeTab: (tabId: string) => void
  setTabs: (tabs: EditorTab[]) => void
  setActiveTab: (tabId: string | null) => void
  setSplitTab: (tabId: string | null) => void
  toggleSplitView: () => void
  setPortalViewOpen: (open: boolean) => void
  setBottomActiveTab: (tab: 'compile' | 'crossref' | 'memoryMap' | 'trace') => void
  toggleLeftDock: () => void
  toggleRightDock: () => void
  toggleBottomDock: () => void
  setLeftDockCollapsed: (c: boolean) => void
  setRightDockCollapsed: (c: boolean) => void
  setBottomDockCollapsed: (c: boolean) => void
  setLeftDockWidth: (w: number) => void
  setRightDockWidth: (w: number) => void
  setRightActiveTab: (tab: 'instructions' | 'agent') => void
  setBottomDockHeight: (height: number) => void
  setAddBlockModalOpen: (open: boolean) => void
  setAgentMode: (mode: 'auto-apply' | 'diff-view') => void
  setAgentTier: (tier: 'fast-flash' | 'deep-pro') => void
  sendAgentMessage: (
    text: string,
    sender?: 'user' | 'agent',
    ragRulesConsulted?: string[],
    rawTrace?: { snippet?: string; rawJson?: string; isError?: boolean; errorDetails?: string; acceptanceReport?: AcceptanceSummary }
  ) => void
  clearAgentMessages: () => void
}

export const useUIStore = create<UIStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  splitTabId: null,
  isSplitView: false,

  isPortalViewOpen: false,

  leftDockCollapsed: false,
  leftDockWidth: 240,
  rightDockCollapsed: false,
  rightDockWidth: 320,
  rightActiveTab: 'instructions',
  bottomDockCollapsed: false,
  bottomDockHeight: 230,
  bottomActiveTab: 'compile',

  isAddBlockModalOpen: false,
  isBookTrainerOpen: false,
  isDebugLogModalOpen: false,
  canvasZoom: 1.0,

  setCanvasZoom: (zoom) => set({ canvasZoom: Math.max(0.5, Math.min(2.0, Math.round(zoom * 100) / 100)) }),
  setBookTrainerOpen: (open) => set({ isBookTrainerOpen: open }),
  setDebugLogModalOpen: (open) => set({ isDebugLogModalOpen: open }),

  agentMode: 'auto-apply',
  agentTier: 'fast-flash',
  agentMessages: [
    {
      id: 'msg_welcome',
      sender: 'agent',
      text: 'Rungline S7 Engineering Agent online. I am observing project ASTs, S7 memory layouts, and hardware allocation in real-time.',
      timestamp: Date.now(),
      tier: 'fast-flash'
    }
  ],
  activePrompt: '',

  openTab: (tab) => {
    const { tabs } = get()
    const existing = tabs.find(
      (t) => t.id === tab.id || (Boolean(tab.targetId) && t.targetId === tab.targetId && t.type === tab.type)
    )
    if (!existing) {
      set({
        tabs: [...tabs, tab],
        activeTabId: tab.id
      })
    } else {
      set({ activeTabId: existing.id })
    }
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId, splitTabId } = get()
    const newTabs = tabs.filter((t) => t.id !== tabId)
    let newActive = activeTabId
    let newSplit = splitTabId

    if (activeTabId === tabId) {
      newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
    }
    if (splitTabId === tabId) {
      newSplit = null
    }

    set({
      tabs: newTabs,
      activeTabId: newActive,
      splitTabId: newSplit,
      isSplitView: newSplit !== null && newTabs.length > 1
    })
  },

  setActiveTab: (activeTabId) => set({ activeTabId }),

  setSplitTab: (splitTabId) => {
    set({
      splitTabId,
      isSplitView: splitTabId !== null
    })
  },

  toggleSplitView: () => {
    const { isSplitView, tabs, activeTabId } = get()
    if (!isSplitView) {
      // Find another tab to split
      const otherTab = tabs.find((t) => t.id !== activeTabId)
      if (otherTab) {
        set({ isSplitView: true, splitTabId: otherTab.id })
      }
    } else {
      set({ isSplitView: false, splitTabId: null })
    }
  },

  setBottomActiveTab: (bottomActiveTab) => {
    set({ bottomActiveTab, bottomDockCollapsed: false })
  },

  setTabs: (tabs) => set({ tabs }),
  setPortalViewOpen: (isPortalViewOpen) => set({ isPortalViewOpen }),

  toggleLeftDock: () => set((s) => ({ leftDockCollapsed: !s.leftDockCollapsed })),
  toggleRightDock: () => set((s) => ({ rightDockCollapsed: !s.rightDockCollapsed })),
  toggleBottomDock: () => set((s) => ({ bottomDockCollapsed: !s.bottomDockCollapsed })),
  setLeftDockCollapsed: (leftDockCollapsed) => set({ leftDockCollapsed }),
  setRightDockCollapsed: (rightDockCollapsed) => set({ rightDockCollapsed }),
  setBottomDockCollapsed: (bottomDockCollapsed) => set({ bottomDockCollapsed }),
  setLeftDockWidth: (leftDockWidth) => set({ leftDockWidth }),
  setRightDockWidth: (rightDockWidth) => set({ rightDockWidth }),
  setRightActiveTab: (rightActiveTab) => set({ rightActiveTab }),
  setBottomDockHeight: (bottomDockHeight) => set({ bottomDockHeight }),

  setAddBlockModalOpen: (isAddBlockModalOpen) => set({ isAddBlockModalOpen }),

  setAgentMode: (agentMode) => set({ agentMode }),
  setAgentTier: (agentTier) => set({ agentTier }),

  sendAgentMessage: (
    text,
    sender = 'user',
    ragRulesConsulted,
    rawTrace?: { snippet?: string; rawJson?: string; isError?: boolean; errorDetails?: string; acceptanceReport?: AcceptanceSummary }
  ) => {
    if (!text || !text.trim()) return
    const msg: AgentChatMessage = {
      id: `msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      sender,
      text: text.trim(),
      timestamp: Date.now(),
      tier: get().agentTier,
      ragRulesConsulted,
      rawTraceSnippet: rawTrace?.snippet,
      rawJson: rawTrace?.rawJson,
      isError: rawTrace?.isError,
      errorDetails: rawTrace?.errorDetails,
      acceptanceReport: rawTrace?.acceptanceReport
    }

    set((state) => ({
      agentMessages: [...state.agentMessages, msg]
    }))
  },

  clearAgentMessages: () => {
    set({ agentMessages: [] })
  }
}))

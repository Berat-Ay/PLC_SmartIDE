import { create } from 'zustand'
import { PlantPhysicsEngine, PlantEngineeringMetrics, ChannelFaultState } from '../runtime/PlantPhysicsEngine'
import { SimScenarioSandbox } from '../runtime/SimScenarioSandbox'
import { useRuntimeStore } from './useRuntimeStore'
import { useProjectStore } from './useProjectStore'
import { useUIStore } from './useUIStore'
import { registerPhysicsAttachHook } from './projectCoordinator'

export type SimulationSubTab = 'rack' | 'mimic' | 'scenario' | 'trace'

interface SimulationStoreState {
  physics: PlantPhysicsEngine
  activeSubTab: SimulationSubTab
  tankLevelRaw: number
  reactorTempRaw: number
  outflowValvePct: number
  closedLoopActive: boolean
  faults: Record<string, ChannelFaultState>
  metrics: PlantEngineeringMetrics
  scenarioCode: string
  scenarioError: string | null

  // Actions
  setActiveSubTab: (tab: SimulationSubTab) => void
  setOutflowValvePct: (val: number) => void
  setClosedLoopActive: (active: boolean) => void
  injectFault: (channel: string, faultType: 'wireBreak' | 'overflow' | 'noise') => void
  clearFaults: (channel: string) => void
  setDigitalInput: (byte: number, bit: number, value: boolean) => void
  setAnalogInputRaw: (channel: string, rawValue: number) => void
  setScenarioCode: (code: string) => void
  applyScenarioScript: (code: string) => Promise<{ ok: boolean; error?: string }>
  refreshMetrics: () => void
}

const defaultScenarioCode = `// ============================================================
// Phase 3: Closed-Loop Plant Physics & Fault Injection Scenario
// Target: Chemical_Plant_Unit4 (Siemens S7-1200 / 1500)
// ============================================================

export default function definePlantSimulation(physics, runtime, dt) {
  // 1. Read actuator outputs driven by PLC logic
  const pumpRunning = !!runtime.getVariable('%Q0.1') || !!runtime.getVariable('HydraulicPump_Run')
  const heaterActive = !!runtime.getVariable('%Q0.2') || !!runtime.getVariable('TankHeater_Enable')

  // 2. Liquid Mass-Balance Differential Equation: dL/dt = Fin - Fout
  const inflow = pumpRunning ? physics.fillRateRawPerSec * dt : 0
  const outflow = (physics.outflowValvePct / 100) * physics.drainRateRawPerSec * dt
  physics.tankLevelRaw = Math.max(0, Math.min(27648, physics.tankLevelRaw + inflow - outflow))

  // 3. Thermodynamic Reaction Vessel Temperature (20°C ambient to 120°C max)
  if (heaterActive) {
    physics.reactorTempRaw = Math.min(27648, physics.reactorTempRaw + 380 * dt)
  } else {
    physics.reactorTempRaw = Math.max(5530, physics.reactorTempRaw - 160 * dt)
  }

  // 4. Digital Limit Switches (IEC High & Low Level Sensors)
  const highLevel = physics.tankLevelRaw >= 24500 // ~9.0m
  const lowLevel = physics.tankLevelRaw <= 2000   // ~0.8m

  runtime.setBit('I', 0, 2, highLevel)
  runtime.setVariable('TankLevel_HighSwitch', highLevel)

  runtime.setBit('I', 0, 3, lowLevel)
  runtime.setVariable('TankLevel_LowSwitch', lowLevel)
}
`

const physicsInstance = new PlantPhysicsEngine()
const scenarioSandbox = new SimScenarioSandbox()
let physicsAttached = false
let lastSimUiSyncAt = 0
const SIM_UI_SYNC_INTERVAL_MS = 100

function isSimulationUiVisible(): boolean {
  const { tabs, activeTabId, splitTabId, isSplitView } = useUIStore.getState()
  const active = tabs.find((t) => t.id === activeTabId)
  if (active && (active.type === 'simulation' || active.type === 'trace')) return true
  if (isSplitView && splitTabId) {
    const split = tabs.find((t) => t.id === splitTabId)
    if (split && (split.type === 'simulation' || split.type === 'trace')) return true
  }
  return false
}

export function attachPhysicsToRuntime(): void {
  if (physicsAttached) return
  physicsAttached = true
  const runtimeEngine = useRuntimeStore.getState().engine
  runtimeEngine.setPhysicsHook((dtSeconds, runtime) => {
    physicsInstance.step(dtSeconds, runtime)

    // Sync state for UI subscription at ~10 Hz and only while simulation/trace view is open
    if (!isSimulationUiVisible()) return
    const now = Date.now()
    if (now - lastSimUiSyncAt < SIM_UI_SYNC_INTERVAL_MS) return
    lastSimUiSyncAt = now
    useSimulationStore.setState({
      tankLevelRaw: physicsInstance.tankLevelRaw,
      reactorTempRaw: physicsInstance.reactorTempRaw,
      outflowValvePct: physicsInstance.outflowValvePct,
      closedLoopActive: physicsInstance.closedLoopActive,
      faults: { ...physicsInstance.faults },
      metrics: physicsInstance.getEngineeringValues(runtime)
    })
  })
}

export const useSimulationStore = create<SimulationStoreState>((set) => {
  scenarioSandbox.setOnRuntimeError((error) => {
    physicsInstance.setScenarioRunner(undefined)
    set({ scenarioError: error })
  })

  return {
    physics: physicsInstance,
    activeSubTab: 'rack',
    tankLevelRaw: physicsInstance.tankLevelRaw,
    reactorTempRaw: physicsInstance.reactorTempRaw,
    outflowValvePct: 15,
    closedLoopActive: true,
    faults: { ...physicsInstance.faults },
    metrics: physicsInstance.getEngineeringValues(),
    scenarioCode: defaultScenarioCode,
    scenarioError: null,

    setActiveSubTab: (activeSubTab) => set({ activeSubTab }),

    setOutflowValvePct: (val) => {
      physicsInstance.setOutflowValvePct(val)
      set({ outflowValvePct: physicsInstance.outflowValvePct })
    },

    setClosedLoopActive: (closedLoopActive) => {
      physicsInstance.setClosedLoopActive(closedLoopActive)
      set({ closedLoopActive })
    },

    injectFault: (channel, faultType) => {
      const runtime = useRuntimeStore.getState().engine
      physicsInstance.injectFault(channel, faultType, runtime)
      set({ faults: { ...physicsInstance.faults } })
    },

    clearFaults: (channel) => {
      const runtime = useRuntimeStore.getState().engine
      physicsInstance.clearFaults(channel, runtime)
      set({ faults: { ...physicsInstance.faults } })
    },

    setDigitalInput: (byte, bit, value) => {
      const runtime = useRuntimeStore.getState().engine
      runtime.setBit('I', byte, bit, value)
    },

    setAnalogInputRaw: (channel, rawValue) => {
      const runtime = useRuntimeStore.getState().engine
      if (channel === '%IW64') {
        physicsInstance.tankLevelRaw = Math.max(0, Math.min(27648, rawValue))
      } else if (channel === '%IW66') {
        physicsInstance.reactorTempRaw = Math.max(0, Math.min(27648, rawValue))
      }
      runtime.setVariable(channel, rawValue)
    },

    setScenarioCode: (scenarioCode) => {
      set({ scenarioCode })
      // An edited scenario is saved back to the project's own file, if it has one
      const projectState = useProjectStore.getState()
      const { simulationScripts } = projectState
      if (simulationScripts.length > 0) {
        useProjectStore.setState({
          simulationScripts: [{ ...simulationScripts[0], code: scenarioCode }, ...simulationScripts.slice(1)]
        })
        projectState.markDirty(true)
      }
    },

    applyScenarioScript: async (code: string) => {
      const result = await scenarioSandbox.compile(code)
      if (!result.ok) {
        physicsInstance.setScenarioRunner(undefined)
        const error = result.error || 'Failed to compile simulation script'
        set({ scenarioError: error })
        return { ok: false, error }
      }

      physicsInstance.setScenarioRunner((physics, runtime, dt) => {
        scenarioSandbox.step(physics, runtime, dt)
      })
      set({ scenarioCode: code, scenarioError: null })
      return { ok: true }
    },

    refreshMetrics: () => {
      const runtime = useRuntimeStore.getState().engine
      set({ metrics: physicsInstance.getEngineeringValues(runtime) })
    }
  }
})

// A project's scenario file is shown in the editor. It runs only when the user applies it.
useProjectStore.subscribe((state, previous) => {
  if (state.simulationScripts !== previous.simulationScripts && state.simulationScripts[0]) {
    const code = state.simulationScripts[0].code
    if (useSimulationStore.getState().scenarioCode !== code) useSimulationStore.setState({ scenarioCode: code })
  }
})

registerPhysicsAttachHook(attachPhysicsToRuntime)
attachPhysicsToRuntime()

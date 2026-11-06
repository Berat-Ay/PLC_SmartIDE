import { create } from 'zustand'
import { PlantPhysicsEngine, PlantEngineeringMetrics, ChannelFaultState } from '../runtime/PlantPhysicsEngine'
import { useRuntimeStore } from './useRuntimeStore'
import { useProjectStore } from './useProjectStore'

export type SimulationSubTab = 'rack' | 'mimic' | 'scenario' | 'trace'

interface SimulationStoreState {
  physics: PlantPhysicsEngine
  activeSubTab: SimulationSubTab
  tankLevelRaw: number
  reactorTempRaw: number
  conveyorPosition: number
  outflowValvePct: number
  closedLoopActive: boolean
  noiseEnabled: boolean
  faults: Record<string, ChannelFaultState>
  metrics: PlantEngineeringMetrics
  scenarioCode: string

  // Actions
  setActiveSubTab: (tab: SimulationSubTab) => void
  setOutflowValvePct: (val: number) => void
  setClosedLoopActive: (active: boolean) => void
  setNoiseEnabled: (enabled: boolean) => void
  injectFault: (channel: string, faultType: 'wireBreak' | 'overflow' | 'noise') => void
  clearFaults: (channel: string) => void
  setDigitalInput: (byte: number, bit: number, value: boolean) => void
  setAnalogInputRaw: (channel: string, rawValue: number) => void
  setScenarioCode: (code: string) => void
  applyScenarioScript: (code: string) => void
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

export const useSimulationStore = create<SimulationStoreState>((set, get) => {
  // Wire physics engine to virtual PLC runtime cyclic hook
  const runtimeEngine = useRuntimeStore.getState().engine
  runtimeEngine.setPhysicsHook((dtSeconds, runtime) => {
    physicsInstance.step(dtSeconds, runtime)

    // Sync state for UI subscription
    set({
      tankLevelRaw: physicsInstance.tankLevelRaw,
      reactorTempRaw: physicsInstance.reactorTempRaw,
      conveyorPosition: physicsInstance.conveyorPosition,
      outflowValvePct: physicsInstance.outflowValvePct,
      closedLoopActive: physicsInstance.closedLoopActive,
      noiseEnabled: physicsInstance.noiseEnabled,
      faults: { ...physicsInstance.faults },
      metrics: physicsInstance.getEngineeringValues(runtime)
    })
  })

  return {
    physics: physicsInstance,
    activeSubTab: 'rack',
    tankLevelRaw: physicsInstance.tankLevelRaw,
    reactorTempRaw: physicsInstance.reactorTempRaw,
    conveyorPosition: 0,
    outflowValvePct: 15,
    closedLoopActive: true,
    noiseEnabled: false,
    faults: { ...physicsInstance.faults },
    metrics: physicsInstance.getEngineeringValues(),
    scenarioCode: defaultScenarioCode,

    setActiveSubTab: (activeSubTab) => set({ activeSubTab }),

    setOutflowValvePct: (val) => {
      physicsInstance.setOutflowValvePct(val)
      set({ outflowValvePct: physicsInstance.outflowValvePct })
    },

    setClosedLoopActive: (closedLoopActive) => {
      physicsInstance.setClosedLoopActive(closedLoopActive)
      set({ closedLoopActive })
    },

    setNoiseEnabled: (noiseEnabled) => {
      physicsInstance.setNoiseEnabled(noiseEnabled)
      set({ noiseEnabled })
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
      const { simulationScripts } = useProjectStore.getState()
      if (simulationScripts.length > 0) {
        useProjectStore.setState({
          simulationScripts: [{ ...simulationScripts[0], code: scenarioCode }, ...simulationScripts.slice(1)]
        })
      }
    },

    applyScenarioScript: (code: string) => {
      try {
        // Dynamically instantiate function from user script body
        // Extracts the inner function body or wraps it
        const cleanCode = code
          .replace(/export\s+default\s+function\s*\w*\s*\([^)]*\)\s*\{/, '')
          .replace(/\}\s*$/, '')

        const runner = new Function('physics', 'runtime', 'dt', cleanCode) as (
          physics: PlantPhysicsEngine,
          runtime: any,
          dt: number
        ) => void

        physicsInstance.setScenarioRunner(runner)
        set({ scenarioCode: code })
      } catch (err) {
        console.error('Failed to compile simulation script:', err)
      }
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

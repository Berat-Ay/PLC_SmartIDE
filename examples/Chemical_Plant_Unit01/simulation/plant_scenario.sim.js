// ============================================================
// Phase 3: Closed-Loop Plant Physics & Fault Injection Scenario
// Target: Chemical_Plant_Unit4 (Siemens S7-1200 / 1500)
// ============================================================

/**
 * Plant Physics Integration Hook
 * @param {import('../src/renderer/src/runtime/PlantPhysicsEngine').PlantPhysicsEngine} physics
 * @param {import('../src/renderer/src/runtime/PlcRuntimeEngine').PlcRuntimeEngine} runtime
 * @param {number} dt Scan delta time in seconds (nominal 0.01s = 10ms)
 */
export default function definePlantSimulation(physics, runtime, dt) {
  // 1. Read actuator outputs driven by PLC logic
  const pumpRunning = !!runtime.getVariable('%Q0.1') || !!runtime.getVariable('HydraulicPump_Run')
  const conveyorRunning = !!runtime.getVariable('%Q0.0') || !!runtime.getVariable('MainConveyor_Run')
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

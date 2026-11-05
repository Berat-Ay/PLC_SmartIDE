import { PlcRuntimeEngine } from './PlcRuntimeEngine'

export interface ChannelFaultState {
  wireBreak?: boolean
  overflow?: boolean
  noise?: boolean
}

export interface PlantEngineeringMetrics {
  tankLevelMeters: number
  tankPressureBar: number
  reactorTempC: number
  outflowValvePct: number
  pumpActive: boolean
  conveyorActive: boolean
  heaterActive: boolean
  highLevelSwitch: boolean
  lowLevelSwitch: boolean
  wireBreakActive: boolean
}

export class PlantPhysicsEngine {
  // Chemical process parameters
  public tankLevelRaw = 6500 // Initial level (~2.35m / 2.35 Bar)
  public fillRateRawPerSec = 450 // +450 counts/sec when pump is running
  public drainRateRawPerSec = 350 // -350 counts/sec at 100% valve opening
  public outflowValvePct = 15 // 15% standard process outflow drain
  public reactorTempRaw = 6000 // ~22°C ambient
  public conveyorPosition = 0 // 0..100% cyclic belt position

  // Simulation controls
  public closedLoopActive = true
  public noiseEnabled = false

  // Channel fault injection map (e.g. '%IW64', '%IW66')
  public faults: Record<string, ChannelFaultState> = {}

  // Optional custom user scenario runner function loaded from /simulation/plant_scenario.sim.js
  private scenarioRunner?: (physics: PlantPhysicsEngine, runtime: PlcRuntimeEngine, dt: number) => void

  constructor() {
    this.faults['%IW64'] = {}
    this.faults['%IW66'] = {}
  }

  /**
   * Executes one physics integration step
   */
  public step(dtSeconds: number, runtime: PlcRuntimeEngine): void {
    // 1. Read actuator outputs driven by PLC logic
    const pumpActive =
      !!runtime.getVariable('%Q0.1') ||
      !!runtime.getVariable('HydraulicPump_Run')

    const conveyorActive =
      !!runtime.getVariable('%Q0.0') ||
      !!runtime.getVariable('MainConveyor_Run')

    const heaterActive =
      !!runtime.getVariable('%Q0.2') ||
      !!runtime.getVariable('TankHeater_Enable')

    // 2. Closed-Loop Mass-Balance Differential: dL/dt = Fin - Fout
    if (this.closedLoopActive) {
      if (this.scenarioRunner) {
        try {
          this.scenarioRunner(this, runtime, dtSeconds)
        } catch (err) {
          console.error('Custom scenario script error, falling back to built-in physics:', err)
          this.runDefaultPhysics(pumpActive, heaterActive, dtSeconds)
        }
      } else {
        this.runDefaultPhysics(pumpActive, heaterActive, dtSeconds)
      }
    }

    // 3. Conveyor visual kinematics
    if (conveyorActive) {
      this.conveyorPosition = (this.conveyorPosition + dtSeconds * 35) % 100
    }

    // 4. Update Limit Switches (Trip Points: High >= 24,500 (~9.0m), Low <= 2,000 (~0.8m))
    const highLimit = this.tankLevelRaw >= 24500
    const lowLimit = this.tankLevelRaw <= 2000

    runtime.setBit('I', 0, 2, highLimit)
    runtime.setVariable('TankLevel_HighSwitch', highLimit)

    runtime.setBit('I', 0, 3, lowLimit)
    runtime.setVariable('TankLevel_LowSwitch', lowLimit)

    // 5. Apply Analog Channel Inputs with Fault Injection
    this.applyAnalogChannel('%IW64', 'TankLevel_Raw', this.tankLevelRaw, runtime)
    this.applyAnalogChannel('%IW66', 'ReactorTemp_Raw', this.reactorTempRaw, runtime)
  }

  private runDefaultPhysics(pumpActive: boolean, heaterActive: boolean, dt: number): void {
    // Liquid level integration
    const inflow = pumpActive ? this.fillRateRawPerSec * dt : 0
    const outflow = (this.outflowValvePct / 100) * this.drainRateRawPerSec * dt
    this.tankLevelRaw = Math.max(0, Math.min(27648, this.tankLevelRaw + inflow - outflow))

    // Thermodynamic heating integration
    if (heaterActive) {
      // Heat up towards 100°C (raw ~27648)
      this.reactorTempRaw = Math.min(27648, this.reactorTempRaw + 380 * dt)
    } else {
      // Natural ambient cooling towards 20°C (raw ~5530)
      this.reactorTempRaw = Math.max(5530, this.reactorTempRaw - 160 * dt)
    }
  }

  private applyAnalogChannel(
    address: string,
    symbol: string,
    baseValue: number,
    runtime: PlcRuntimeEngine
  ): void {
    const fault = this.faults[address] || {}
    let outputVal = Math.round(baseValue)

    if (fault.wireBreak) {
      // Siemens S7 standard out-of-range wire-break code: 16#7FFF (32767)
      outputVal = 32767
      // Set System Memory Diagnostic bit %M1.1
      runtime.setBit('M', 1, 1, true)
    } else if (fault.overflow) {
      // Overflow (>20mA): 32767
      outputVal = 32767
    } else if (this.noiseEnabled || fault.noise) {
      // Industrial electrical sensor ripple: ±2% random walk
      const ripple = (Math.random() - 0.5) * 0.04 * 27648
      outputVal = Math.max(0, Math.min(27648, Math.round(outputVal + ripple)))
    }

    runtime.setVariable(address, outputVal)
    runtime.setVariable(symbol, outputVal)
  }

  /**
   * Injects hardware faults onto physical I/O channels
   */
  public injectFault(
    channel: string,
    faultType: 'wireBreak' | 'overflow' | 'noise',
    runtime?: PlcRuntimeEngine
  ): void {
    if (!this.faults[channel]) {
      this.faults[channel] = {}
    }

    if (faultType === 'wireBreak') {
      this.faults[channel].wireBreak = true
      this.faults[channel].overflow = false
      if (runtime) {
        runtime.injectHardwareFault(channel)
      }
    } else if (faultType === 'overflow') {
      this.faults[channel].overflow = true
      this.faults[channel].wireBreak = false
      if (runtime) {
        runtime.injectHardwareFault(channel)
      }
    } else if (faultType === 'noise') {
      this.faults[channel].noise = true
    }
  }

  /**
   * Restores nominal channel operation and clears CPU diagnostic status
   */
  public clearFaults(channel: string, runtime?: PlcRuntimeEngine): void {
    this.faults[channel] = {}
    if (runtime) {
      runtime.clearHardwareFault(channel)
    }
  }

  public setOutflowValvePct(val: number): void {
    this.outflowValvePct = Math.max(0, Math.min(100, Math.round(val)))
  }

  public setClosedLoopActive(active: boolean): void {
    this.closedLoopActive = active
  }

  public setNoiseEnabled(enabled: boolean): void {
    this.noiseEnabled = enabled
  }

  public setScenarioRunner(
    fn?: (physics: PlantPhysicsEngine, runtime: PlcRuntimeEngine, dt: number) => void
  ): void {
    this.scenarioRunner = fn
  }

  /**
   * Returns human-readable engineering unit representations
   */
  public getEngineeringValues(runtime?: PlcRuntimeEngine): PlantEngineeringMetrics {
    const levelFraction = Math.max(0, Math.min(1, this.tankLevelRaw / 27648))
    const tempFraction = Math.max(0, Math.min(1, (this.reactorTempRaw - 5530) / (27648 - 5530)))

    const pumpActive = runtime
      ? !!runtime.getVariable('%Q0.1') || !!runtime.getVariable('HydraulicPump_Run')
      : false

    const conveyorActive = runtime
      ? !!runtime.getVariable('%Q0.0') || !!runtime.getVariable('MainConveyor_Run')
      : false

    const heaterActive = runtime
      ? !!runtime.getVariable('%Q0.2') || !!runtime.getVariable('TankHeater_Enable')
      : false

    const isWireBreak = !!this.faults['%IW64']?.wireBreak

    return {
      tankLevelMeters: Math.round(levelFraction * 10 * 100) / 100,
      tankPressureBar: Math.round(levelFraction * 10 * 100) / 100,
      reactorTempC: Math.round((20 + tempFraction * 100) * 10) / 10,
      outflowValvePct: this.outflowValvePct,
      pumpActive,
      conveyorActive,
      heaterActive,
      highLevelSwitch: this.tankLevelRaw >= 24500,
      lowLevelSwitch: this.tankLevelRaw <= 2000,
      wireBreakActive: isWireBreak
    }
  }
}


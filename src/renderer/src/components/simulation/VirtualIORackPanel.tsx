import React, { useState } from 'react'
import {
  Cpu,
  Flame,
  Activity,
  Zap,
  RotateCcw,
  Code,
  Gauge,
  Waves,
  Save,
  CheckCircle2
} from 'lucide-react'
import { useRuntimeStore } from '../../stores/useRuntimeStore'
import { useSimulationStore } from '../../stores/useSimulationStore'
import { useTagStore } from '../../stores/useTagStore'
import { TraceOscilloscope } from './TraceOscilloscope'

export const VirtualIORackPanel: React.FC = () => {
  const { currentSnapshot, forceOverrides } = useRuntimeStore()
  const {
    activeSubTab,
    setActiveSubTab,
    tankLevelRaw,
    reactorTempRaw,
    outflowValvePct,
    closedLoopActive,
    faults,
    metrics,
    scenarioCode,
    setOutflowValvePct,
    setClosedLoopActive,
    injectFault,
    clearFaults,
    setDigitalInput,
    setAnalogInputRaw,
    setScenarioCode,
    applyScenarioScript
  } = useSimulationStore()
  const { tagTables } = useTagStore()

  const [scriptSavedMessage, setScriptSavedMessage] = useState(false)

  // Map symbols from tag tables
  const findTagForAddress = (address: string): string => {
    for (const table of tagTables) {
      const tag = table.tags.find(
        (t) => t.address.toUpperCase() === address.toUpperCase()
      )
      if (tag) return tag.name
    }
    return ''
  }

  // Handle momentary pushbutton mousedown/mouseup
  const handleMomentaryPress = (byte: number, bit: number, pressed: boolean) => {
    setDigitalInput(byte, bit, pressed)
  }

  // Digital Inputs (%IB0..%IB1 = 16 channels)
  const diChannels = Array.from({ length: 16 }, (_, idx) => {
    const byte = Math.floor(idx / 8)
    const bit = idx % 8
    const address = `%I${byte}.${bit}`
    const symbol = findTagForAddress(address) || `DI_${byte}.${bit}`
    const piiByte = currentSnapshot?.pii[byte] || 0
    const isActive = (piiByte & (1 << bit)) !== 0
    const isForced = forceOverrides.has(address)
    return { byte, bit, address, symbol, isActive, isForced }
  })

  // Digital Outputs (%QB0..%QB1 = 16 channels)
  const dqChannels = Array.from({ length: 16 }, (_, idx) => {
    const byte = Math.floor(idx / 8)
    const bit = idx % 8
    const address = `%Q${byte}.${bit}`
    const symbol = findTagForAddress(address) || `DQ_${byte}.${bit}`
    const piqByte = currentSnapshot?.piq[byte] || 0
    const isActive = (piqByte & (1 << bit)) !== 0
    return { byte, bit, address, symbol, isActive }
  })

  return (
    <div className="cq flex-1 flex flex-col h-full bg-industrial-950 select-none overflow-hidden text-industrial-100">
      {/* Top Simulation Workbench Navigation Bar */}
      <div className="h-10 shrink-0 bg-industrial-900 border-b border-industrial-800 flex items-center justify-between gap-2 px-3 text-xs overflow-hidden">
        <div className="flex items-center gap-1 h-full min-w-0 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveSubTab('rack')}
            className={`h-full flex items-center gap-2 px-3 border-b-2 font-semibold transition-colors ${
              activeSubTab === 'rack'
                ? 'border-siemens-cyan text-cyan-400 bg-industrial-950/70'
                : 'border-transparent text-industrial-400 hover:text-industrial-200'
            }`}
          >
            <Cpu className="under-720:hidden w-4 h-4 text-cyan-400" />
            <span title="Virtual I/O Rack & Faults">I/O Rack</span>
          </button>

          <button
            onClick={() => setActiveSubTab('mimic')}
            className={`h-full flex items-center gap-2 px-3 border-b-2 font-semibold transition-colors ${
              activeSubTab === 'mimic'
                ? 'border-emerald-500 text-emerald-400 bg-industrial-950/70'
                : 'border-transparent text-industrial-400 hover:text-industrial-200'
            }`}
          >
            <Gauge className="under-720:hidden w-4 h-4 text-emerald-400" />
            <span title="2D Process Mimic (Chemical Tank)">Mimic</span>
          </button>

          <button
            onClick={() => setActiveSubTab('scenario')}
            className={`h-full flex items-center gap-2 px-3 border-b-2 font-semibold transition-colors ${
              activeSubTab === 'scenario'
                ? 'border-purple-500 text-purple-400 bg-industrial-950/70'
                : 'border-transparent text-industrial-400 hover:text-industrial-200'
            }`}
          >
            <Code className="under-720:hidden w-4 h-4 text-purple-400" />
            <span title="Plant Scenario Script (.sim.js)">Scenario</span>
          </button>

          <button
            onClick={() => setActiveSubTab('trace')}
            className={`h-full flex items-center gap-2 px-3 border-b-2 font-semibold transition-colors ${
              activeSubTab === 'trace'
                ? 'border-amber-500 text-amber-400 bg-industrial-950/70'
                : 'border-transparent text-industrial-400 hover:text-industrial-200'
            }`}
          >
            <Activity className="under-720:hidden w-4 h-4 text-amber-400" />
            <span title="Trace Oscilloscope">Trace</span>
          </button>
        </div>

        {/* Global Closed-Loop Toggle */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setClosedLoopActive(!closedLoopActive)}
            title="Closed-Loop Physics"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-none text-[11px] font-bold border transition-all ${
              closedLoopActive
                ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                : 'bg-industrial-800 text-industrial-400 border-industrial-700'
            }`}
          >
            <RotateCcw className={`w-3.5 h-3.5 ${closedLoopActive ? 'animate-spin' : ''}`} style={{ animationDuration: '6s' }} />
            <span>
              <span className="under-720:hidden">Closed-Loop Physics: </span>
              {closedLoopActive ? 'ACTIVE' : 'PAUSED'}
            </span>
          </button>
        </div>
      </div>

      {/* Main Panel Content */}
      <div className="flex-1 overflow-auto p-4">
        {/* SUB-TAB 1: Virtual I/O Rack & Faults */}
        {activeSubTab === 'rack' && (
          <div className="space-y-6 max-w-7xl mx-auto">
            {/* 1. Digital Inputs Module (%IB0..%IB1) */}
            <div className="bg-industrial-900 border border-industrial-800 rounded-none p-4 shadow-lg">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-3 mb-3 border-b border-industrial-800">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 bg-cyan-400" />
                  <h3 className="font-semibold text-sm text-industrial-100">
                    Digital Inputs Module — DI 16x24VDC (%IB0..%IB1)
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-industrial-400">
                  Toggle Latch + Hold Pushbutton Controls
                </span>
              </div>

              <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
                {diChannels.map((ch) => (
                  <div
                    key={ch.address}
                    className={`p-2.5 rounded-none border transition-all flex flex-col justify-between gap-2 ${
                      ch.isActive
                        ? 'bg-emerald-950/40 border-emerald-700/80 shadow-md shadow-emerald-950/50'
                        : 'bg-industrial-950 border-industrial-800'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono font-bold text-xs text-cyan-400">{ch.address}</span>
                        <div
                          className={`w-3 h-3 transition-all ${
                            ch.isActive
                              ? 'bg-emerald-400 shadow-[0_0_8px_#10b981]'
                              : 'bg-slate-700'
                          }`}
                        />
                      </div>
                      <div className="text-[11px] font-medium text-industrial-300 min-h-[2.2em] leading-tight [overflow-wrap:anywhere]" title={ch.symbol}>
                        {ch.symbol}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      {/* Toggle Latch */}
                      <button
                        onClick={() => setDigitalInput(ch.byte, ch.bit, !ch.isActive)}
                        className={`w-full py-1 text-[10px] font-bold rounded-none border transition-colors ${
                          ch.isActive
                            ? 'bg-emerald-600 text-white border-emerald-500'
                            : 'bg-industrial-800 text-industrial-300 border-industrial-700 hover:bg-industrial-750'
                        }`}
                      >
                        {ch.isActive ? 'LATCHED ON' : 'LATCH OFF'}
                      </button>

                      {/* Momentary Pushbutton */}
                      <button
                        onMouseDown={() => handleMomentaryPress(ch.byte, ch.bit, true)}
                        onMouseUp={() => handleMomentaryPress(ch.byte, ch.bit, false)}
                        onMouseLeave={() => handleMomentaryPress(ch.byte, ch.bit, false)}
                        className="w-full py-1 text-[10px] font-semibold rounded-none bg-industrial-850 hover:bg-cyan-900/60 active:bg-cyan-600 active:text-white border border-industrial-750 text-industrial-300 transition-colors"
                      >
                        Hold PB
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. Digital Outputs Module (%QB0..%QB1) */}
            <div className="bg-industrial-900 border border-industrial-800 rounded-none p-4 shadow-lg">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-3 mb-3 border-b border-industrial-800">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 bg-emerald-400" />
                  <h3 className="font-semibold text-sm text-industrial-100">
                    Digital Outputs Module — DQ 16x24VDC (%QB0..%QB1)
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-industrial-400">
                  Process Image Output (PIQ) Live Indicators
                </span>
              </div>

              <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
                {dqChannels.map((ch) => (
                  <div
                    key={ch.address}
                    className={`p-2.5 rounded-none border transition-all flex flex-col justify-between gap-2 ${
                      ch.isActive
                        ? 'bg-emerald-950/60 border-emerald-600 shadow-lg shadow-emerald-950/60'
                        : 'bg-industrial-950 border-industrial-800'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono font-bold text-xs text-emerald-400">{ch.address}</span>
                        <div
                          className={`w-3.5 h-3.5 transition-all ${
                            ch.isActive
                              ? 'bg-emerald-400 shadow-[0_0_10px_#10b981]'
                              : 'bg-slate-700'
                          }`}
                        />
                      </div>
                      <div className="text-[11px] font-medium text-industrial-300 min-h-[2.2em] leading-tight [overflow-wrap:anywhere]" title={ch.symbol}>
                        {ch.symbol}
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-none ${
                          ch.isActive
                            ? 'bg-emerald-900/80 text-emerald-300'
                            : 'bg-industrial-850 text-industrial-500'
                        }`}
                      >
                        {ch.isActive ? 'ENERGIZED' : 'OFF'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 3. Analog I/O & Hardware Fault Injection */}
            <div className="bg-industrial-900 border border-industrial-800 rounded-none p-4 shadow-lg space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-industrial-800">
                <div className="flex items-center gap-2">
                  <Flame className="w-4 h-4 text-amber-500" />
                  <h3 className="font-semibold text-sm text-industrial-100">
                    Analog Input Modules & Hardware Fault-Injection Rack
                  </h3>
                </div>
                <span className="text-[11px] font-mono text-industrial-400">
                  Standard S7 Range: 0..27648 ADC (0..10V / 4..20mA)
                </span>
              </div>

              {/* Channel 1: %IW64 TankLevel_Raw */}
              <div className="p-4 rounded-none bg-industrial-950 border border-industrial-800 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-purple-400 text-sm">%IW64</span>
                      <span className="font-semibold text-industrial-200">TankLevel_Raw</span>
                      {faults['%IW64']?.wireBreak && (
                        <span className="px-2 py-0.5 rounded-none text-[10px] font-bold bg-red-950 text-red-400 border border-red-800">
                          ⚡ WIRE-BREAK (16#7FFF)
                        </span>
                      )}
                      {faults['%IW64']?.overflow && (
                        <span className="px-2 py-0.5 rounded-none text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-800">
                          [OVERFLOW (&gt;20mA)]
                        </span>
                      )}
                      {faults['%IW64']?.noise && (
                        <span className="px-2 py-0.5 rounded-none text-[10px] font-bold bg-blue-950 text-blue-400 border border-blue-800">
                          [SENSOR NOISE ACTIVE]
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-industrial-400 mt-0.5">
                      Chemical Mixing Vessel Hydrostatic Level Sensor
                    </div>
                  </div>

                  <div className="flex items-center gap-4 font-mono text-xs">
                    <div className="px-2 py-1 rounded-none bg-industrial-900 border border-industrial-750">
                      <span className="text-industrial-400">Raw Count: </span>
                      <span className="text-cyan-400 font-bold">{tankLevelRaw}</span>
                    </div>
                    <div className="px-2 py-1 rounded-none bg-industrial-900 border border-industrial-750">
                      <span className="text-industrial-400">Scaled Level: </span>
                      <span className="text-emerald-400 font-bold">{metrics.tankLevelMeters} m</span>
                    </div>
                    <div className="px-2 py-1 rounded-none bg-industrial-900 border border-industrial-750">
                      <span className="text-industrial-400">Pressure: </span>
                      <span className="text-purple-400 font-bold">{metrics.tankPressureBar} Bar</span>
                    </div>
                  </div>
                </div>

                {/* Slider with S7 Tick Marks */}
                <div className="space-y-1">
                  <input
                    type="range"
                    min="0"
                    max="27648"
                    step="100"
                    value={tankLevelRaw}
                    onChange={(e) => setAnalogInputRaw('%IW64', parseInt(e.target.value, 10))}
                    className="w-full h-2 bg-industrial-800 rounded-none appearance-none cursor-pointer accent-cyan-400"
                  />
                  <div className="flex justify-between text-[10px] font-mono text-industrial-500">
                    <span>0 (0.0m / 4mA)</span>
                    <span>6912 (2.5m)</span>
                    <span>13824 (5.0m / 12mA)</span>
                    <span>20736 (7.5m)</span>
                    <span>27648 (10.0m / 20mA)</span>
                  </div>
                </div>

                {/* Fault Injection Button Bar */}
                <div className="flex items-center gap-2 pt-2 border-t border-industrial-850 flex-wrap">
                  <span className="text-xs font-semibold text-industrial-300">Fault Injection:</span>

                  <button
                    onClick={() => injectFault('%IW64', 'wireBreak')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-none bg-red-950 hover:bg-red-900 border border-red-800 text-red-300 text-xs font-semibold transition-colors"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>⚡ Inject Wire-Break (32767 / 16#7FFF)</span>
                  </button>

                  <button
                    onClick={() => injectFault('%IW64', 'overflow')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-none bg-amber-950 hover:bg-amber-900 border border-amber-800 text-amber-300 text-xs font-semibold transition-colors"
                  >
                    <Flame className="w-3.5 h-3.5" />
                    <span>Inject Overflow (&gt;20mA)</span>
                  </button>

                  <button
                    onClick={() => injectFault('%IW64', 'noise')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-none bg-blue-950 hover:bg-blue-900 border border-blue-800 text-blue-300 text-xs font-semibold transition-colors"
                  >
                    <Waves className="w-3.5 h-3.5" />
                    <span>Inject Signal Noise (±2%)</span>
                  </button>

                  <button
                    onClick={() => clearFaults('%IW64')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-none bg-emerald-950 hover:bg-emerald-900 border border-emerald-800 text-emerald-300 text-xs font-semibold transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Clear Channel Faults</span>
                  </button>
                </div>
              </div>

              {/* Channel 2: %IW66 ReactorTemp_Raw */}
              <div className="p-4 rounded-none bg-industrial-950 border border-industrial-800 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-sky-400 text-sm">%IW66</span>
                      <span className="font-semibold text-industrial-200">ReactorTemp_Raw</span>
                    </div>
                    <div className="text-[11px] text-industrial-400 mt-0.5">
                      Process Vessel Thermocouple Temperature Sensor (20°C..120°C)
                    </div>
                  </div>

                  <div className="flex items-center gap-4 font-mono text-xs">
                    <div className="px-2 py-1 rounded-none bg-industrial-900 border border-industrial-750">
                      <span className="text-industrial-400">Raw Count: </span>
                      <span className="text-cyan-400 font-bold">{reactorTempRaw}</span>
                    </div>
                    <div className="px-2 py-1 rounded-none bg-industrial-900 border border-industrial-750">
                      <span className="text-industrial-400">Scaled Temp: </span>
                      <span className="text-amber-400 font-bold">{metrics.reactorTempC} °C</span>
                    </div>
                  </div>
                </div>

                <input
                  type="range"
                  min="5530"
                  max="27648"
                  step="100"
                  value={reactorTempRaw}
                  onChange={(e) => setAnalogInputRaw('%IW66', parseInt(e.target.value, 10))}
                  className="w-full h-2 bg-industrial-800 rounded-none appearance-none cursor-pointer accent-sky-400"
                />
              </div>
            </div>
          </div>
        )}

        {/* SUB-TAB 2: 2D Plant Process Mimic */}
        {activeSubTab === 'mimic' && (
          <div className="space-y-6 max-w-6xl mx-auto">
            <div className="bg-industrial-900 border border-industrial-800 rounded-none p-4 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-4 mb-4 border-b border-industrial-800">
                <div>
                  <h3 className="font-bold text-base text-industrial-100 flex items-center gap-2">
                    <Gauge className="w-5 h-5 text-emerald-400" />
                    <span>Chemical Plant Unit 4 — Mixing & Storage Vessel Process Mimic</span>
                  </h3>
                  <p className="text-xs text-industrial-400 mt-1">
                    Closed-loop real-time simulation driven by virtual S7-1200 CPU I/O images.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <span
                    className={`whitespace-nowrap px-2.5 py-1 rounded-none text-xs font-mono font-bold ${
                      closedLoopActive
                        ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                        : 'bg-industrial-800 text-industrial-400'
                    }`}
                  >
                    ● {closedLoopActive ? 'PHYSICS RUNNING' : 'PHYSICS FROZEN'}
                  </span>
                </div>
              </div>

              {/* 2D SCADA SVG Visualizer */}
              <div className="flex flex-wrap gap-6 items-center justify-center p-4 bg-industrial-950 rounded-none border border-industrial-850">
                {/* SVG Mimic Schematic */}
                <div className="relative flex-1 basis-[320px] min-w-0 max-w-lg">
                  <svg viewBox="0 0 460 360" className="w-full h-auto overflow-visible">
                    {/* Tank Outer Shell */}
                    <rect
                      x="140"
                      y="40"
                      width="180"
                      height="260"
                      rx="16"
                      fill="#0f172a"
                      stroke="#475569"
                      strokeWidth="4"
                    />

                    {/* Tank Liquid Fill (Dynamic level) */}
                    {(() => {
                      const maxFillH = 240
                      const fillPct = Math.max(0, Math.min(1, tankLevelRaw / 27648))
                      const curH = fillPct * maxFillH
                      const curY = 40 + (maxFillH - curH) + 10
                      return (
                        <rect
                          x="144"
                          y={curY}
                          width="172"
                          height={curH}
                          rx="6"
                          fill="url(#liquidGradient)"
                          opacity="0.85"
                        />
                      )
                    })()}

                    <defs>
                      <linearGradient id="liquidGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#38bdf8" />
                        <stop offset="100%" stopColor="#0369a1" />
                      </linearGradient>
                    </defs>

                    {/* Level Scale Ticks */}
                    {[10, 8, 6, 4, 2, 0].map((m, idx) => {
                      const y = 50 + idx * 48
                      return (
                        <g key={m}>
                          <line x1="130" y1={y} x2="140" y2={y} stroke="#64748b" strokeWidth="2" />
                          <text x="122" y={y + 3} fill="#64748b" fontSize="9" fontFamily="monospace" textAnchor="end">
                            {m}m
                          </text>
                        </g>
                      )
                    })}

                    {/* High-Level Sensor %I0.2 */}
                    <g transform="translate(325, 75)">
                      <circle
                        cx="12"
                        cy="12"
                        r="8"
                        fill={metrics.highLevelSwitch ? '#ef4444' : '#1e293b'}
                        stroke="#ef4444"
                        strokeWidth="2"
                      />
                      <text x="26" y="16" fill="#cbd5e1" fontSize="10" fontFamily="monospace" fontWeight="bold">
                        %I0.2 High Limit {metrics.highLevelSwitch ? '(TRIPPED)' : ''}
                      </text>
                    </g>

                    {/* Low-Level Sensor %I0.3 */}
                    <g transform="translate(325, 270)">
                      <circle
                        cx="12"
                        cy="12"
                        r="8"
                        fill={metrics.lowLevelSwitch ? '#f59e0b' : '#1e293b'}
                        stroke="#f59e0b"
                        strokeWidth="2"
                      />
                      <text x="26" y="16" fill="#cbd5e1" fontSize="10" fontFamily="monospace" fontWeight="bold">
                        %I0.3 Low Limit {metrics.lowLevelSwitch ? '(TRIPPED)' : ''}
                      </text>
                    </g>

                    {/* Immersion Heater %Q0.2 */}
                    <path
                      d="M 180 280 L 220 280 L 230 270 L 240 280 L 250 270 L 260 280 L 280 280"
                      fill="none"
                      stroke={metrics.heaterActive ? '#f97316' : '#475569'}
                      strokeWidth={metrics.heaterActive ? '4' : '3'}
                      strokeLinecap="round"
                    />

                    {/* Hydraulic Feed Pump %Q0.1 & Inflow Pipe */}
                    <path d="M 40 100 L 140 100" fill="none" stroke="#475569" strokeWidth="6" />
                    {metrics.pumpActive && (
                      <path
                        d="M 40 100 L 140 100"
                        fill="none"
                        stroke="#38bdf8"
                        strokeWidth="4"
                        strokeDasharray="8 4"
                      />
                    )}
                    <circle
                      cx="50"
                      cy="100"
                      r="22"
                      fill="#1e293b"
                      stroke={metrics.pumpActive ? '#10b981' : '#475569'}
                      strokeWidth="3"
                    />
                    <text
                      x="50"
                      y="104"
                      fill={metrics.pumpActive ? '#10b981' : '#94a3b8'}
                      fontSize="10"
                      fontWeight="bold"
                      textAnchor="middle"
                      fontFamily="monospace"
                    >
                      %Q0.1
                    </text>

                    {/* Outflow Pipe & Drain Valve */}
                    <path d="M 230 300 L 230 340 L 360 340" fill="none" stroke="#475569" strokeWidth="6" />
                    {outflowValvePct > 0 && (
                      <path
                        d="M 230 300 L 230 340 L 360 340"
                        fill="none"
                        stroke="#38bdf8"
                        strokeWidth="4"
                        strokeDasharray="6 4"
                      />
                    )}
                  </svg>
                </div>

                {/* Right Process Stats & Drain Valve Slider */}
                <div className="flex-1 basis-[260px] min-w-0 max-w-sm space-y-4">
                  {/* Status Cards */}
                  <div className="p-3.5 rounded-none bg-industrial-900 border border-industrial-800 space-y-2 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-industrial-400">Tank Level:</span>
                      <span className="text-cyan-400 font-bold">{metrics.tankLevelMeters} m ({tankLevelRaw})</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-industrial-400">Vessel Pressure:</span>
                      <span className="text-purple-400 font-bold">{metrics.tankPressureBar} Bar</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-industrial-400">Reactor Temp:</span>
                      <span className="text-amber-400 font-bold">{metrics.reactorTempC} °C</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-industrial-400">Feed Pump (%Q0.1):</span>
                      <span className={metrics.pumpActive ? 'text-emerald-400 font-bold' : 'text-industrial-500'}>
                        {metrics.pumpActive ? 'PUMPING (+450/s)' : 'STOPPED'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-industrial-400">Conveyor (%Q0.0):</span>
                      <span className={metrics.conveyorActive ? 'text-emerald-400 font-bold' : 'text-industrial-500'}>
                        {metrics.conveyorActive ? 'RUNNING' : 'STOPPED'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-industrial-400">Heater (%Q0.2):</span>
                      <span className={metrics.heaterActive ? 'text-orange-400 font-bold' : 'text-industrial-500'}>
                        {metrics.heaterActive ? 'HEATING' : 'COOLING'}
                      </span>
                    </div>
                  </div>

                  {/* Outflow Drain Valve Slider */}
                  <div className="p-3.5 rounded-none bg-industrial-900 border border-industrial-800 space-y-2">
                    <div className="flex justify-between items-center text-xs font-semibold">
                      <span>Outflow Drain Valve</span>
                      <span className="font-mono text-cyan-400 font-bold">{outflowValvePct}% Open</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={outflowValvePct}
                      onChange={(e) => setOutflowValvePct(parseInt(e.target.value, 10))}
                      className="w-full h-2 bg-industrial-800 rounded-none appearance-none cursor-pointer accent-emerald-400"
                    />
                    <div className="flex justify-between text-[10px] text-industrial-500 font-mono">
                      <span>0% (Closed)</span>
                      <span>50%</span>
                      <span>100% (Max Drain)</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SUB-TAB 3: Plant Scenario Script (Code Editor) */}
        {activeSubTab === 'scenario' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-industrial-100 flex items-center gap-2">
                  <Code className="w-4 h-4 text-purple-400" />
                  <span>/simulation/plant_scenario.sim.js</span>
                </h3>
                <p className="text-xs text-industrial-400 mt-0.5">
                  Live editable plant physics scenario script. Instant hot-reload updates the simulation runner.
                </p>
              </div>

              <div className="flex items-center gap-2">
                {scriptSavedMessage && (
                  <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold animate-pulse">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Script Compiled & Hot-Reloaded!</span>
                  </span>
                )}
                <button
                  onClick={() => {
                    applyScenarioScript(scenarioCode)
                    setScriptSavedMessage(true)
                    setTimeout(() => setScriptSavedMessage(false), 2500)
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-none bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs shadow-md transition-all"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Apply & Hot-Reload Scenario</span>
                </button>
              </div>
            </div>

            <textarea
              value={scenarioCode}
              onChange={(e) => setScenarioCode(e.target.value)}
              className="w-full h-[520px] bg-industrial-950 text-industrial-100 font-mono text-xs p-4 rounded-none border border-industrial-800 focus:border-purple-500 focus:outline-hidden leading-relaxed resize-none shadow-inner"
              spellCheck={false}
            />
          </div>
        )}

        {/* SUB-TAB 4: Embedded Trace Oscilloscope */}
        {activeSubTab === 'trace' && (
          <div className="h-[580px] rounded-none border border-industrial-800 overflow-hidden shadow-xl">
            <TraceOscilloscope />
          </div>
        )}
      </div>
    </div>
  )
}

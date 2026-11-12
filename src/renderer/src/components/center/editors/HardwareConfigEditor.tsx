import React, { useState } from 'react'
import {
  Cpu,
  Clock,
  Binary,
  Gauge,
  Layers,
  Info
} from 'lucide-react'
import { useHardwareStore } from '../../../stores/useHardwareStore'
import { useProjectStore } from '../../../stores/useProjectStore'
import { ALL_CPU_PROFILES } from '@shared/constants/cpuProfiles'
import {
  InputFilterDelay,
  AnalogMeasurementType,
  AnalogSmoothingFilter,
  AnalogOutputType
} from '@shared/types/hardware'

export const HardwareConfigEditor: React.FC = () => {
  const {
    config,
    applyCpuProfile,
    updateGeneral,
    updateSystemMemory,
    updateClockMemory,
    updateDiChannel,
    updateDqChannel,
    updateAiChannel,
    updateAqChannel,
    updateOb
  } = useHardwareStore()
  const { markDirty } = useProjectStore()

  const [activeTab, setActiveTab] = useState<'general' | 'memory' | 'digital' | 'analog' | 'obs'>('general')

  const currentProfile = ALL_CPU_PROFILES.find((p) => p.name === config.general.cpuName) || ALL_CPU_PROFILES[0]

  return (
    <div className="cq h-full flex flex-col bg-industrial-900 select-none text-xs overflow-hidden">
      {/* Header */}
      <div className="shrink-0 bg-industrial-950 border-b border-industrial-800 whitespace-nowrap">
        <div className="h-10 px-4 flex items-center gap-3 overflow-hidden">
          <div className="under-600:hidden flex items-center gap-2 shrink-0">
            <Cpu className="w-4 h-4 text-cyan-400" />
            <span className="font-semibold text-industrial-100 font-mono text-sm">
              Device Configuration
            </span>
          </div>

          {/* CPU Profile Switcher */}
          <div className="flex items-center gap-1.5 bg-industrial-900 border border-industrial-750 rounded px-2 py-1 min-w-0">
            <span className="text-[11px] text-industrial-400">Profile:</span>
            <select
              value={currentProfile.id}
              onChange={(e) => {
                const profile = ALL_CPU_PROFILES.find((p) => p.id === e.target.value)
                if (profile) {
                  applyCpuProfile(profile)
                  markDirty(true)
                }
              }}
              className="bg-transparent text-cyan-300 font-mono text-xs focus:outline-hidden cursor-pointer min-w-0 truncate"
            >
              {ALL_CPU_PROFILES.map((p) => (
                <option key={p.id} value={p.id} className="bg-industrial-950 text-industrial-100">
                  {p.name} ({p.firmwareVersion}) - {p.family}
                </option>
              ))}
            </select>
          </div>

          <span className="under-900:hidden text-[11px] text-cyan-300 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800 font-mono">
            {config.general.targetCpu?.includes('1200') || config.general.cpuName.includes('12')
              ? 'S7-1200 Virtual Rack'
              : 'S7-1500 Virtual Rack'}
          </span>
        </div>

        {/* Sub-tab Navigation */}
        <div className="px-4 pb-1.5">
        <div className="inline-flex flex-wrap items-center bg-industrial-900 border border-industrial-800 rounded p-0.5">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-3 py-1 rounded transition-colors ${
              activeTab === 'general'
                ? 'bg-industrial-750 text-white font-medium'
                : 'text-industrial-400 hover:text-industrial-200'
            }`}
          >
            General & Watchdog
          </button>
          <button
            onClick={() => setActiveTab('memory')}
            className={`px-3 py-1 rounded transition-colors ${
              activeTab === 'memory'
                ? 'bg-industrial-750 text-white font-medium'
                : 'text-industrial-400 hover:text-industrial-200'
            }`}
          >
            System & Clock Memory
          </button>
          <button
            onClick={() => setActiveTab('digital')}
            className={`px-3 py-1 rounded transition-colors ${
              activeTab === 'digital'
                ? 'bg-industrial-750 text-white font-medium'
                : 'text-industrial-400 hover:text-industrial-200'
            }`}
          >
            DI {config.digitalIO.diChannels.length} / DQ {config.digitalIO.dqChannels.length}
          </button>
          <button
            onClick={() => setActiveTab('analog')}
            className={`px-3 py-1 rounded transition-colors ${
              activeTab === 'analog'
                ? 'bg-industrial-750 text-white font-medium'
                : 'text-industrial-400 hover:text-industrial-200'
            }`}
          >
            AI {config.analogIO.aiChannels.length} / AQ {config.analogIO.aqChannels.length}
          </button>
          <button
            onClick={() => setActiveTab('obs')}
            className={`px-3 py-1 rounded transition-colors ${
              activeTab === 'obs'
                ? 'bg-industrial-750 text-white font-medium'
                : 'text-industrial-400 hover:text-industrial-200'
            }`}
          >
            OB Execution Table
          </button>
        </div>
        </div>
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-auto p-4">
        {/* 1. General & Watchdog */}
        {activeTab === 'general' && (
          <div className="max-w-3xl space-y-4">
            <div className="p-4 rounded bg-industrial-950 border border-industrial-800 space-y-3">
              <h3 className="text-sm font-semibold text-industrial-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-400" />
                CPU General Parameters
              </h3>
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="block text-industrial-400 mb-1">CPU Name / Identifier</label>
                  <input
                    type="text"
                    value={config.general.cpuName}
                    onChange={(e) => {
                      updateGeneral({ cpuName: e.target.value })
                      markDirty(true)
                    }}
                    className="w-full bg-industrial-900 border border-industrial-700 rounded px-2.5 py-1.5 text-industrial-100 focus:border-cyan-500 focus:outline-hidden"
                  />
                </div>
                <div>
                  <label className="block text-industrial-400 mb-1">Target Architecture</label>
                  <input
                    type="text"
                    disabled
                    value={`Siemens ${currentProfile.name} (${currentProfile.firmwareVersion})`}
                    className="w-full bg-industrial-900/50 border border-industrial-800 rounded px-2.5 py-1.5 text-cyan-300 font-mono cursor-not-allowed"
                  />
                </div>
              </div>

              {/* Hardware Specifications Strip */}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 pt-2 text-[11px] font-mono">
                <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                  <div className="text-industrial-400 text-[10px]">Order Number</div>
                  <div className="text-industrial-200 font-semibold">{currentProfile.orderNumber}</div>
                </div>
                <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                  <div className="text-industrial-400 text-[10px]">Work Memory</div>
                  <div className="text-cyan-400 font-semibold">{currentProfile.workMemory}</div>
                </div>
                <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                  <div className="text-industrial-400 text-[10px]">Load Memory</div>
                  <div className="text-industrial-200 font-semibold">{currentProfile.loadMemory}</div>
                </div>
                <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                  <div className="text-industrial-400 text-[10px]">Retentive Memory</div>
                  <div className="text-industrial-200 font-semibold">{currentProfile.retentiveMemory}</div>
                </div>
              </div>
            </div>

            <div className="p-4 rounded bg-industrial-950 border border-industrial-800 space-y-3">
              <h3 className="text-sm font-semibold text-industrial-100 flex items-center gap-2">
                <Clock className="w-4 h-4 text-cyan-400" />
                Scan Cycle Watchdog & Retentive Range
              </h3>
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="block text-industrial-400 mb-1">Cycle Watchdog Time (ms)</label>
                  <input
                    type="number"
                    min={1}
                    max={60000}
                    value={config.general.cycleWatchdogTimeMs}
                    onChange={(e) => {
                      updateGeneral({ cycleWatchdogTimeMs: parseInt(e.target.value, 10) || 150 })
                      markDirty(true)
                    }}
                    className="w-full bg-industrial-900 border border-industrial-700 rounded px-2.5 py-1.5 text-industrial-100 font-mono focus:border-cyan-500 focus:outline-hidden"
                  />
                  <span className="text-[10px] text-industrial-500 mt-1 block">Default: 150 ms watchdog timeout</span>
                </div>
                <div>
                  <label className="block text-industrial-400 mb-1">Minimum Cycle Time (ms)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={config.general.minCycleTimeEnabled}
                      onChange={(e) => {
                        updateGeneral({ minCycleTimeEnabled: e.target.checked })
                        markDirty(true)
                      }}
                      className="h-4 w-4 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                    />
                    <input
                      type="number"
                      disabled={!config.general.minCycleTimeEnabled}
                      value={config.general.minCycleTimeMs}
                      onChange={(e) => {
                        updateGeneral({ minCycleTimeMs: parseInt(e.target.value, 10) || 1 })
                        markDirty(true)
                      }}
                      className="w-full bg-industrial-900 border border-industrial-700 disabled:opacity-50 rounded px-2.5 py-1.5 text-industrial-100 font-mono focus:border-cyan-500 focus:outline-hidden"
                    />
                  </div>
                  <span className="text-[10px] text-industrial-500 mt-1 block">Prevents cycle scan rate from exceeding maximum</span>
                </div>
              </div>

              <div className="pt-3 border-t border-industrial-850">
                <label className="block text-industrial-400 mb-1">Retentive Memory Allocation (M-Area)</label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-[11px] text-industrial-400">Start Byte:</span>
                    <input
                      type="number"
                      value={config.general.retentiveMemory.startByte}
                      onChange={(e) => {
                        updateGeneral({
                          retentiveMemory: {
                            ...config.general.retentiveMemory,
                            startByte: parseInt(e.target.value, 10) || 0
                          }
                        })
                        markDirty(true)
                      }}
                      className="w-full bg-industrial-900 border border-industrial-700 rounded px-2.5 py-1 text-industrial-100 font-mono focus:border-cyan-500 focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <span className="text-[11px] text-industrial-400">Byte Count:</span>
                    <input
                      type="number"
                      value={config.general.retentiveMemory.byteCount}
                      onChange={(e) => {
                        updateGeneral({
                          retentiveMemory: {
                            ...config.general.retentiveMemory,
                            byteCount: parseInt(e.target.value, 10) || 2048
                          }
                        })
                        markDirty(true)
                      }}
                      className="w-full bg-industrial-900 border border-industrial-700 rounded px-2.5 py-1 text-industrial-100 font-mono focus:border-cyan-500 focus:outline-hidden"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 2. System & Clock Memory */}
        {activeTab === 'memory' && (
          <div className="max-w-3xl space-y-4">
            <div className="p-3 bg-cyan-950/30 border border-cyan-800/60 rounded flex items-center gap-2 text-cyan-200">
              <Info className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>
                <strong>Crucial Memory Overlap Guard Integration:</strong> Enabling System or Clock Memory claims bytes in `%M`. Any overlapping user tags (e.g. `%MW0` or `%M1.2`) will immediately be flagged with collision warnings!
              </span>
            </div>

            {/* System Memory Byte */}
            <div className="p-4 rounded bg-industrial-950 border border-industrial-800 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-industrial-100">Enable System Memory Byte</h3>
                  <div className="text-[11px] text-industrial-400">
                    Provides FirstScan, DiagStatusUpdate, AlwaysTrue, AlwaysFalse bits.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.systemMemory.enabled}
                  onChange={(e) => {
                    updateSystemMemory(e.target.checked, config.systemMemory.byteAddress)
                    markDirty(true)
                  }}
                  className="h-4 w-4 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                />
              </div>

              {config.systemMemory.enabled && (
                <div className="pt-2 border-t border-industrial-850 space-y-2">
                  <div className="flex items-center gap-3">
                    <label className="text-industrial-300 font-medium">Byte Address: %MB</label>
                    <input
                      type="number"
                      min={0}
                      max={65535}
                      value={config.systemMemory.byteAddress}
                      onChange={(e) => {
                        updateSystemMemory(true, parseInt(e.target.value, 10) || 0)
                        markDirty(true)
                      }}
                      className="w-24 bg-industrial-900 border border-industrial-700 rounded px-2 py-1 text-industrial-100 font-mono focus:border-cyan-500 focus:outline-hidden"
                    />
                  </div>

                  <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 pt-2 text-[11px] font-mono">
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">FirstScan</div>
                      <div className="text-industrial-400">%M{config.systemMemory.byteAddress}.0</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">DiagStatusUpdate</div>
                      <div className="text-industrial-400">%M{config.systemMemory.byteAddress}.1</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">AlwaysTrue</div>
                      <div className="text-industrial-400">%M{config.systemMemory.byteAddress}.2</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">AlwaysFalse</div>
                      <div className="text-industrial-400">%M{config.systemMemory.byteAddress}.3</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Clock Memory Byte */}
            <div className="p-4 rounded bg-industrial-950 border border-industrial-800 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-industrial-100">Enable Clock Memory Byte</h3>
                  <div className="text-[11px] text-industrial-400">
                    Provides 8 square-wave pulse generators (10 Hz down to 0.5 Hz).
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config.clockMemory.enabled}
                  onChange={(e) => {
                    updateClockMemory(e.target.checked, config.clockMemory.byteAddress)
                    markDirty(true)
                  }}
                  className="h-4 w-4 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                />
              </div>

              {config.clockMemory.enabled && (
                <div className="pt-2 border-t border-industrial-850 space-y-2">
                  <div className="flex items-center gap-3">
                    <label className="text-industrial-300 font-medium">Byte Address: %MB</label>
                    <input
                      type="number"
                      min={0}
                      max={65535}
                      value={config.clockMemory.byteAddress}
                      onChange={(e) => {
                        updateClockMemory(true, parseInt(e.target.value, 10) || 0)
                        markDirty(true)
                      }}
                      className="w-24 bg-industrial-900 border border-industrial-700 rounded px-2 py-1 text-industrial-100 font-mono focus:border-cyan-500 focus:outline-hidden"
                    />
                  </div>

                  <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 pt-2 text-[11px] font-mono">
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">10 Hz (0.1s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.0</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">5 Hz (0.2s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.1</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">2.5 Hz (0.4s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.2</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">2.0 Hz (0.5s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.3</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">1.25 Hz (0.8s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.4</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">1.0 Hz (1.0s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.5</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">0.625 Hz (1.6s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.6</div>
                    </div>
                    <div className="p-2 rounded bg-industrial-900 border border-industrial-800">
                      <div className="text-cyan-400 font-bold">0.5 Hz (2.0s)</div>
                      <div className="text-industrial-400">%M{config.clockMemory.byteAddress}.7</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 3. Digital I/O Channels */}
        {activeTab === 'digital' && (
          <div className="space-y-6">
            {/* DI 16 */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-industrial-100 flex items-center gap-2">
                <Binary className="w-4 h-4 text-cyan-400" />
                Digital Inputs (DI 16x24VDC)
              </h3>
              <div className="rounded border border-industrial-800 overflow-x-auto">
                <table className="w-full text-left font-mono">
                  <thead className="bg-industrial-950 text-industrial-400 border-b border-industrial-800 text-[10px] uppercase">
                    <tr>
                      <th className="py-2 px-3 w-16">Channel</th>
                      <th className="py-2 px-3 w-28">Address</th>
                      <th className="py-2 px-3 w-1/4">Symbol Name</th>
                      <th className="py-2 px-3 w-36">Input Filter Delay</th>
                      <th className="py-2 px-3 w-32 text-center">Rising Edge Int</th>
                      <th className="py-2 px-3 w-32 text-center">Falling Edge Int</th>
                      <th className="py-2 px-3 min-w-[200px]">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
                    {config.digitalIO.diChannels.map((di, idx) => (
                      <tr key={di.channelIndex} className="hover:bg-industrial-850">
                        <td className="py-1.5 px-3 text-industrial-500">Ch {di.channelIndex}</td>
                        <td className="py-1.5 px-3 text-cyan-400 font-bold">{di.address}</td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={di.name}
                            onChange={(e) => {
                              updateDiChannel(idx, { name: e.target.value })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden"
                          />
                        </td>
                        <td className="py-1 px-3">
                          <select
                            value={di.filterDelay}
                            onChange={(e) => {
                              updateDiChannel(idx, { filterDelay: e.target.value as InputFilterDelay })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1 py-0.5 text-industrial-200 focus:outline-hidden cursor-pointer"
                          >
                            <option value="0.1 ms">0.1 ms</option>
                            <option value="0.8 ms">0.8 ms</option>
                            <option value="1.6 ms">1.6 ms</option>
                            <option value="3.2 ms">3.2 ms</option>
                            <option value="6.4 ms">6.4 ms</option>
                            <option value="12.8 ms">12.8 ms</option>
                          </select>
                        </td>
                        <td className="py-1 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={di.enableRisingEdgeInterrupt}
                            onChange={(e) => {
                              updateDiChannel(idx, { enableRisingEdgeInterrupt: e.target.checked })
                              markDirty(true)
                            }}
                            className="h-3.5 w-3.5 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                          />
                        </td>
                        <td className="py-1 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={di.enableFallingEdgeInterrupt}
                            onChange={(e) => {
                              updateDiChannel(idx, { enableFallingEdgeInterrupt: e.target.checked })
                              markDirty(true)
                            }}
                            className="h-3.5 w-3.5 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                          />
                        </td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={di.comment || ''}
                            onChange={(e) => {
                              updateDiChannel(idx, { comment: e.target.value })
                              markDirty(true)
                            }}
                            placeholder="DI Description..."
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-300 font-sans focus:outline-hidden"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* DQ 16 */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-industrial-100 flex items-center gap-2">
                <Binary className="w-4 h-4 text-emerald-400" />
                Digital Outputs (DQ 16x24VDC)
              </h3>
              <div className="rounded border border-industrial-800 overflow-x-auto">
                <table className="w-full text-left font-mono">
                  <thead className="bg-industrial-950 text-industrial-400 border-b border-industrial-800 text-[10px] uppercase">
                    <tr>
                      <th className="py-2 px-3 w-16">Channel</th>
                      <th className="py-2 px-3 w-28">Address</th>
                      <th className="py-2 px-3 w-1/3">Symbol Name</th>
                      <th className="py-2 px-3 min-w-[200px]">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
                    {config.digitalIO.dqChannels.map((dq, idx) => (
                      <tr key={dq.channelIndex} className="hover:bg-industrial-850">
                        <td className="py-1.5 px-3 text-industrial-500">Ch {dq.channelIndex}</td>
                        <td className="py-1.5 px-3 text-emerald-400 font-bold">{dq.address}</td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={dq.name}
                            onChange={(e) => {
                              updateDqChannel(idx, { name: e.target.value })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden"
                          />
                        </td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={dq.comment || ''}
                            onChange={(e) => {
                              updateDqChannel(idx, { comment: e.target.value })
                              markDirty(true)
                            }}
                            placeholder="DQ Description..."
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-300 font-sans focus:outline-hidden"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 4. Analog I/O Channels */}
        {activeTab === 'analog' && (
          <div className="space-y-6">
            {/* AI 4 */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-industrial-100 flex items-center gap-2">
                <Gauge className="w-4 h-4 text-cyan-400" />
                Analog Inputs (AI 4xU/I)
              </h3>
              <div className="rounded border border-industrial-800 overflow-x-auto">
                <table className="w-full text-left font-mono">
                  <thead className="bg-industrial-950 text-industrial-400 border-b border-industrial-800 text-[10px] uppercase">
                    <tr>
                      <th className="py-2 px-3 w-16">Channel</th>
                      <th className="py-2 px-3 w-28">Address</th>
                      <th className="py-2 px-3 w-1/4">Symbol Name</th>
                      <th className="py-2 px-3 w-32">Signal Range</th>
                      <th className="py-2 px-3 w-28">Smoothing</th>
                      <th className="py-2 px-3 w-28 text-center">Wire Break</th>
                      <th className="py-2 px-3 w-32 text-center">Trigger OB82</th>
                      <th className="py-2 px-3 min-w-[200px]">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
                    {config.analogIO.aiChannels.map((ai, idx) => (
                      <tr key={ai.channelIndex} className="hover:bg-industrial-850">
                        <td className="py-1.5 px-3 text-industrial-500">Ch {ai.channelIndex}</td>
                        <td className="py-1.5 px-3 text-cyan-400 font-bold">{ai.address}</td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={ai.name}
                            onChange={(e) => {
                              updateAiChannel(idx, { name: e.target.value })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden"
                          />
                        </td>
                        <td className="py-1 px-3">
                          <select
                            value={ai.measurementType}
                            onChange={(e) => {
                              updateAiChannel(idx, { measurementType: e.target.value as AnalogMeasurementType })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1 py-0.5 text-cyan-300 focus:outline-hidden cursor-pointer"
                          >
                            <option value="4..20 mA">4..20 mA</option>
                            <option value="0..10 V">0..10 V</option>
                            <option value="±10 V">±10 V</option>
                            <option value="Deactivated">Deactivated</option>
                          </select>
                        </td>
                        <td className="py-1 px-3">
                          <select
                            value={ai.smoothing}
                            onChange={(e) => {
                              updateAiChannel(idx, { smoothing: e.target.value as AnalogSmoothingFilter })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1 py-0.5 text-industrial-200 focus:outline-hidden cursor-pointer"
                          >
                            <option value="None">None</option>
                            <option value="Weak">Weak</option>
                            <option value="Medium">Medium</option>
                            <option value="Strong">Strong</option>
                          </select>
                        </td>
                        <td className="py-1 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={ai.wireBreakCheck}
                            onChange={(e) => {
                              updateAiChannel(idx, { wireBreakCheck: e.target.checked })
                              markDirty(true)
                            }}
                            className="h-3.5 w-3.5 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                          />
                        </td>
                        <td className="py-1 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={ai.triggerOb82OnFault}
                            onChange={(e) => {
                              updateAiChannel(idx, { triggerOb82OnFault: e.target.checked })
                              markDirty(true)
                            }}
                            className="h-3.5 w-3.5 rounded border-industrial-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer"
                          />
                        </td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={ai.comment || ''}
                            onChange={(e) => {
                              updateAiChannel(idx, { comment: e.target.value })
                              markDirty(true)
                            }}
                            placeholder="AI Sensor details..."
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-300 font-sans focus:outline-hidden"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* AQ 2 */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-industrial-100 flex items-center gap-2">
                <Gauge className="w-4 h-4 text-emerald-400" />
                Analog Outputs (AQ 2xU/I)
              </h3>
              <div className="rounded border border-industrial-800 overflow-x-auto">
                <table className="w-full text-left font-mono">
                  <thead className="bg-industrial-950 text-industrial-400 border-b border-industrial-800 text-[10px] uppercase">
                    <tr>
                      <th className="py-2 px-3 w-16">Channel</th>
                      <th className="py-2 px-3 w-28">Address</th>
                      <th className="py-2 px-3 w-1/3">Symbol Name</th>
                      <th className="py-2 px-3 w-36">Output Type</th>
                      <th className="py-2 px-3 min-w-[200px]">Comment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
                    {config.analogIO.aqChannels.map((aq, idx) => (
                      <tr key={aq.channelIndex} className="hover:bg-industrial-850">
                        <td className="py-1.5 px-3 text-industrial-500">Ch {aq.channelIndex}</td>
                        <td className="py-1.5 px-3 text-emerald-400 font-bold">{aq.address}</td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={aq.name}
                            onChange={(e) => {
                              updateAqChannel(idx, { name: e.target.value })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden"
                          />
                        </td>
                        <td className="py-1 px-3">
                          <select
                            value={aq.outputType}
                            onChange={(e) => {
                              updateAqChannel(idx, { outputType: e.target.value as AnalogOutputType })
                              markDirty(true)
                            }}
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1 py-0.5 text-emerald-300 focus:outline-hidden cursor-pointer"
                          >
                            <option value="4..20 mA">4..20 mA</option>
                            <option value="0..10 V">0..10 V</option>
                            <option value="Deactivated">Deactivated</option>
                          </select>
                        </td>
                        <td className="py-1 px-3">
                          <input
                            type="text"
                            value={aq.comment || ''}
                            onChange={(e) => {
                              updateAqChannel(idx, { comment: e.target.value })
                              markDirty(true)
                            }}
                            placeholder="AQ Actuator details..."
                            className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-300 font-sans focus:outline-hidden"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 5. Organization Blocks Table */}
        {activeTab === 'obs' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-industrial-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-purple-400" />
              Organization Block (OB) Execution Management
            </h3>
            <div className="rounded border border-industrial-800 overflow-x-auto">
              <table className="w-full text-left font-mono">
                <thead className="bg-industrial-950 text-industrial-400 border-b border-industrial-800 text-[10px] uppercase">
                  <tr>
                    <th className="py-2 px-3 w-16 text-center">Active</th>
                    <th className="py-2 px-3 w-24">Block #</th>
                    <th className="py-2 px-3 w-1/4">Name</th>
                    <th className="py-2 px-3 w-36">Event Class</th>
                    <th className="py-2 px-3 w-32">Execution Time</th>
                    <th className="py-2 px-3 w-20 text-center">Priority</th>
                    <th className="py-2 px-3">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-industrial-800/60 text-industrial-200">
                  {config.organizationBlocks.map((ob) => (
                    <tr key={ob.blockNumber} className="hover:bg-industrial-850">
                      <td className="py-1.5 px-3 text-center">
                        <input
                          type="checkbox"
                          checked={ob.enabled}
                          onChange={(e) => {
                            updateOb(ob.blockNumber, { enabled: e.target.checked })
                            markDirty(true)
                          }}
                          className="h-3.5 w-3.5 rounded border-industrial-600 text-purple-600 focus:ring-purple-500 cursor-pointer"
                        />
                      </td>
                      <td className="py-1.5 px-3 text-purple-400 font-bold">OB{ob.blockNumber}</td>
                      <td className="py-1 px-3">
                        <input
                          type="text"
                          value={ob.name}
                          onChange={(e) => {
                            updateOb(ob.blockNumber, { name: e.target.value })
                            markDirty(true)
                          }}
                          className="w-full bg-transparent border border-transparent hover:border-industrial-700 focus:border-cyan-500 focus:bg-industrial-950 rounded px-1.5 py-0.5 text-industrial-100 font-sans focus:outline-hidden"
                        />
                      </td>
                      <td className="py-1 px-3">
                        <span className="px-2 py-0.5 rounded text-[10px] bg-industrial-800 text-industrial-300 border border-industrial-700">
                          {ob.type}
                        </span>
                      </td>
                      <td className="py-1 px-3">
                        {ob.type === 'CyclicInterrupt' ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              value={ob.cycleTimeMs || 100}
                              onChange={(e) => {
                                updateOb(ob.blockNumber, { cycleTimeMs: parseInt(e.target.value, 10) || 100 })
                                markDirty(true)
                              }}
                              className="w-16 bg-industrial-950 border border-industrial-700 rounded px-1.5 py-0.5 text-cyan-300 font-mono text-center focus:outline-hidden"
                            />
                            <span className="text-industrial-400">ms</span>
                          </div>
                        ) : (
                          <span className="text-industrial-500 italic">Continuous / Event</span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 text-center font-bold text-industrial-300">
                        {ob.priority}
                      </td>
                      <td className="py-1 px-3 text-industrial-400 font-sans">
                        {ob.description}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

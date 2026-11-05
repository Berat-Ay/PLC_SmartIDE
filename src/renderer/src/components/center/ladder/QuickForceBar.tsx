import React, { useState } from 'react'
import { Zap } from 'lucide-react'
import { useRuntimeStore } from '../../../stores/useRuntimeStore'
import { useTagStore } from '../../../stores/useTagStore'

export const QuickForceBar: React.FC = () => {
  const { engine, forceValue } = useRuntimeStore()
  const { tagTables } = useTagStore()

  const [analogVal, setAnalogVal] = useState<number>(13824)

  // 1. Gather all tags across all tables
  const allTags = tagTables.flatMap((t) => t.tags)

  // 2. Digital Input tags (%I and %M booleans)
  const digitalInputs = allTags.filter(
    (t) =>
      t.dataType === 'BOOL' &&
      (t.address.toUpperCase().startsWith('%I') || t.address.toUpperCase().startsWith('%M'))
  )

  // 3. Fallback if 0 tags exist yet: default hardware inputs %I0.0 .. %I0.7
  const displayDigital =
    digitalInputs.length > 0
      ? digitalInputs.map((t) => ({
          name: t.name,
          address: t.address
        }))
      : [0, 1, 2, 3, 4, 5, 6, 7].map((bit) => ({
          name: `DI_0.${bit}`,
          address: `%I0.${bit}`
        }))

  // 4. Analog input tag (%IW or %ID)
  const analogTag = allTags.find(
    (t) =>
      t.address.toUpperCase().startsWith('%IW') ||
      t.address.toUpperCase().startsWith('%ID')
  ) || { name: 'TankLevel', address: '%IW64' }

  const handleToggleDigital = (address: string, name: string) => {
    const current = !!engine.getVariable(address)
    const nextVal = !current
    engine.setVariable(address, nextVal)
    engine.setVariable(name, nextVal)
    forceValue(address, nextVal, true)
    forceValue(name, nextVal, true)
  }

  const handleAnalogChange = (address: string, val: number) => {
    setAnalogVal(val)
    engine.setVariable(address, val)
    forceValue(address, val, true)
  }

  return (
    <div
      data-testid="quick-force-bar"
      className="h-8 bg-industrial-950 border-b border-industrial-800 px-3 flex items-center justify-between text-xs select-none gap-4 rounded-none overflow-x-auto"
    >
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-1.5 text-industrial-400 font-mono text-[11px] shrink-0">
          <Zap className="w-3 h-3 text-amber-400" />
          <span>Quick I/O Simulation Force:</span>
        </div>

        {/* Dynamic Digital Input Toggles */}
        <div className="flex items-center gap-2">
          {displayDigital.map((di) => {
            const isHigh = !!engine.getVariable(di.address)
            return (
              <button
                key={di.address}
                data-testid={`quick-force-btn-${di.name}`}
                data-force-address={di.address}
                onClick={() => handleToggleDigital(di.address, di.name)}
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded-none text-[11px] font-mono transition-all border ${
                  isHigh
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-600 font-bold shadow-xs'
                    : 'bg-industrial-900 text-industrial-400 border-industrial-800 hover:text-industrial-200 hover:border-industrial-700'
                }`}
                title={`Toggle ${di.name} (${di.address}): currently ${isHigh ? 'TRUE' : 'FALSE'}`}
              >
                <span>{di.name} ({di.address})</span>
                <span
                  className={`w-2 h-2 rounded-none border ${
                    isHigh ? 'bg-emerald-400 border-emerald-300 animate-pulse' : 'bg-industrial-800 border-industrial-700'
                  }`}
                />
              </button>
            )
          })}
        </div>
      </div>

      {/* Analog Slider */}
      <div className="flex items-center gap-2 font-mono text-[11px] text-industrial-400 shrink-0">
        <span>{analogTag.address} ({analogTag.name}):</span>
        <input
          type="range"
          min={0}
          max={27648}
          step={500}
          value={analogVal}
          onChange={(e) => handleAnalogChange(analogTag.address, parseInt(e.target.value, 10))}
          className="w-24 accent-cyan-500 cursor-pointer h-1 bg-industrial-800 rounded-none"
        />
        <span className="text-cyan-300 font-bold w-12 text-right">{analogVal}</span>
      </div>
    </div>
  )
}

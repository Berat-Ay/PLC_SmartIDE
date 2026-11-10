import React, { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { MemoryOverlapEngine, ByteOccupancy } from '../../services/MemoryOverlapEngine'
import { useTagStore } from '../../stores/useTagStore'
import { useHardwareStore } from '../../stores/useHardwareStore'
import { useUIStore } from '../../stores/useUIStore'
import { S7MemoryArea } from '@shared/types/s7types'

export const MemoryMapVisualizer: React.FC = () => {
  const { tagTables, selectTag } = useTagStore()
  const { config } = useHardwareStore()
  const { openTab } = useUIStore()

  const [activeArea, setActiveArea] = useState<S7MemoryArea>('M')
  const [startByte, setStartByte] = useState<number>(0)
  const [byteCount, setByteCount] = useState<number>(32)
  const [hoveredByte, setHoveredByte] = useState<ByteOccupancy | null>(null)

  const occupancy = MemoryOverlapEngine.getMemoryOccupancy(
    activeArea,
    byteCount,
    startByte,
    tagTables,
    config
  )

  const handleByteClick = (byte: ByteOccupancy) => {
    // If occupants exist, select the first tag occupant
    for (const bit of byte.bits) {
      const tagOcc = bit.occupants.find((o) => o.type === 'Tag')
      if (tagOcc) {
        selectTag(tagOcc.id)
        openTab({
          id: 'tab_all_tags',
          title: 'All PLC Tags',
          type: 'allTags'
        })
        break
      }
    }
  }

  return (
    <div className="h-full flex flex-col bg-industrial-900 select-none text-xs">
      {/* Visualizer Controls */}
      <div className="h-8 px-3 bg-industrial-950 border-b border-industrial-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-industrial-900 border border-industrial-800 rounded p-0.5">
            <button
              onClick={() => setActiveArea('I')}
              className={`px-2.5 py-0.5 rounded text-xs transition-colors ${
                activeArea === 'I'
                  ? 'bg-cyan-600 text-white font-bold'
                  : 'text-industrial-400 hover:text-industrial-200'
              }`}
            >
              Inputs (%I)
            </button>
            <button
              onClick={() => setActiveArea('Q')}
              className={`px-2.5 py-0.5 rounded text-xs transition-colors ${
                activeArea === 'Q'
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'text-industrial-400 hover:text-industrial-200'
              }`}
            >
              Outputs (%Q)
            </button>
            <button
              onClick={() => setActiveArea('M')}
              className={`px-2.5 py-0.5 rounded text-xs transition-colors ${
                activeArea === 'M'
                  ? 'bg-purple-600 text-white font-bold'
                  : 'text-industrial-400 hover:text-industrial-200'
              }`}
            >
              Bit Memory (%M)
            </button>
          </div>

          <div className="flex items-center gap-2 text-industrial-400 text-[11px]">
            <span>Start Byte:</span>
            <input
              type="number"
              min={0}
              value={startByte}
              onChange={(e) => setStartByte(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-14 bg-industrial-900 border border-industrial-700 rounded px-1.5 py-0.5 text-industrial-100 font-mono text-center focus:outline-hidden"
            />
          </div>

          <div className="flex items-center gap-2 text-industrial-400 text-[11px]">
            <span>Length:</span>
            <select
              value={byteCount}
              onChange={(e) => setByteCount(parseInt(e.target.value, 10))}
              className="bg-industrial-900 border border-industrial-700 rounded px-1.5 py-0.5 text-industrial-100 font-mono focus:outline-hidden"
            >
              <option value="16">16 Bytes</option>
              <option value="32">32 Bytes</option>
              <option value="64">64 Bytes</option>
              <option value="128">128 Bytes</option>
            </select>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-[10px] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-industrial-800 border border-industrial-700" />
            <span className="text-industrial-400">Free Bit</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500" />
            <span className="text-emerald-400">Occupied</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-red-500 animate-pulse" />
            <span className="text-red-400 font-bold">Collision (Overlap)</span>
          </div>
        </div>
      </div>

      {/* Grid Strip */}
      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-8 gap-2">
          {occupancy.map((byte) => {
            const hasCollision = byte.byteState === 'COLLIDING'

            return (
              <div
                key={byte.byteIndex}
                onClick={() => handleByteClick(byte)}
                onMouseEnter={() => setHoveredByte(byte)}
                onMouseLeave={() => setHoveredByte(null)}
                className={`p-2 rounded border cursor-pointer transition-all ${
                  hasCollision
                    ? 'bg-red-950/40 border-red-600 shadow-sm shadow-red-950 hover:bg-red-900/40'
                    : byte.byteState === 'FULL'
                    ? 'bg-industrial-950 border-emerald-700/80 hover:bg-industrial-850'
                    : byte.byteState === 'PARTIAL'
                    ? 'bg-industrial-950 border-cyan-800/80 hover:bg-industrial-850'
                    : 'bg-industrial-950 border-industrial-800 hover:border-industrial-700'
                }`}
              >
                {/* Byte Header */}
                <div className="flex items-center justify-between text-[11px] font-mono mb-1.5">
                  <span className={`font-bold ${hasCollision ? 'text-red-400' : 'text-industrial-200'}`}>
                    %{activeArea}B{byte.byteIndex}
                  </span>
                  {hasCollision && (
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 animate-pulse" />
                  )}
                </div>

                {/* 8 Bits Visual Boxes */}
                <div className="grid grid-cols-8 gap-0.5">
                  {byte.bits.map((bit) => (
                    <div
                      key={bit.bitIndex}
                      title={`%${activeArea}${byte.byteIndex}.${bit.bitIndex} : ${bit.state}\n${bit.occupants.map((o) => `${o.name} (${o.address})`).join('\n')}`}
                      className={`h-4 rounded-xs transition-colors ${
                        bit.state === 'COLLIDING'
                          ? 'bg-red-500 shadow-xs shadow-red-500'
                          : bit.state === 'OCCUPIED'
                          ? 'bg-emerald-500'
                          : 'bg-industrial-800'
                      }`}
                    />
                  ))}
                </div>

                {/* Occupant Preview */}
                <div className="mt-1 text-[10px] text-industrial-400 truncate font-sans">
                  {byte.occupantNames.length > 0 ? (
                    <span className={hasCollision ? 'text-red-300 font-semibold' : ''}>
                      {byte.occupantNames.join(', ')}
                    </span>
                  ) : (
                    <span className="text-industrial-600 italic">Free</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Hover Info Footer */}
      {hoveredByte && (
        <div className="h-7 px-3 bg-industrial-950 border-t border-industrial-800 flex items-center justify-between text-[11px] font-mono">
          <div className="flex items-center gap-2">
            <span className="text-industrial-400">Byte:</span>
            <strong className="text-industrial-100">%{activeArea}B{hoveredByte.byteIndex}</strong>
            <span className="text-industrial-400 ml-2">State:</span>
            <span className={`font-bold ${hoveredByte.byteState === 'COLLIDING' ? 'text-red-400' : 'text-industrial-200'}`}>
              {hoveredByte.byteState}
            </span>
          </div>

          <div className="text-industrial-300 truncate max-w-md">
            {hoveredByte.occupantNames.length > 0
              ? `Occupants: ${hoveredByte.occupantNames.join(', ')}`
              : 'All 8 bits available'}
          </div>
        </div>
      )}
    </div>
  )
}

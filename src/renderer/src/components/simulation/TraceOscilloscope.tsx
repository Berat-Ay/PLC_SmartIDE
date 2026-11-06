import React, { useState, useEffect, useRef } from 'react'
import {
  Play,
  Pause,
  RotateCcw,
  Download,
  Crosshair,
  Sliders,
  Flame,
  Activity,
  Layers,
  ChevronDown
} from 'lucide-react'
import { useRuntimeStore } from '../../stores/useRuntimeStore'
import { RuntimeMemorySnapshot } from '@shared/types/runtime'

export interface TraceChannel {
  id: string
  name: string
  address: string
  type: 'BOOL' | 'INT' | 'REAL'
  color: string
  enabled: boolean
}

export type TriggerMode = 'FREE_RUN' | 'RISING_EDGE' | 'OB82_FAULT'
export type TriggerState = 'RUNNING' | 'ARMED' | 'TRIGGERED' | 'STOPPED'

interface SamplePoint {
  timestamp: number
  cycle: number
  triggeringOb: number
  values: Record<string, number | boolean>
}

const DEFAULT_CHANNELS: TraceChannel[] = [
  { id: 'ch1', name: 'EmergencyStop', address: '%I0.0', type: 'BOOL', color: '#06b6d4', enabled: true },
  { id: 'ch2', name: 'HydraulicPump_Run', address: '%Q0.1', type: 'BOOL', color: '#10b981', enabled: true },
  { id: 'ch3', name: 'MainConveyor_Run', address: '%Q0.0', type: 'BOOL', color: '#f59e0b', enabled: true },
  { id: 'ch4', name: 'TankLevel_HighSwitch', address: '%I0.2', type: 'BOOL', color: '#f43f5e', enabled: true },
  { id: 'ch5', name: 'TankLevel_Raw', address: '%IW64', type: 'INT', color: '#8b5cf6', enabled: true },
  { id: 'ch6', name: 'ReactorTemp_Raw', address: '%IW66', type: 'INT', color: '#38bdf8', enabled: true }
]

export const TraceOscilloscope: React.FC = () => {
  const { currentSnapshot, engine } = useRuntimeStore()

  // Trace channels state
  const [channels, setChannels] = useState<TraceChannel[]>(DEFAULT_CHANNELS)
  const [timebaseMs, setTimebaseMs] = useState<number>(10000) // 10s default
  const [sampleRateMs, setSampleRateMs] = useState<number>(10) // 10ms (1x scan)
  const [triggerMode, setTriggerMode] = useState<TriggerMode>('FREE_RUN')
  const [triggerChannelId, setTriggerChannelId] = useState<string>('ch1')
  const [triggerState, setTriggerState] = useState<TriggerState>('RUNNING')

  // Dual measurement cursors (in fraction 0..1 of timebase)
  const [cursorA, setCursorA] = useState<number>(0.25)
  const [cursorB, setCursorB] = useState<number>(0.75)
  const [activeCursorDrag, setActiveCursorDrag] = useState<'A' | 'B' | null>(null)

  // Trace buffer
  const samplesRef = useRef<SamplePoint[]>([])
  const lastSampleTimeRef = useRef<number>(0)
  const lastTriggerBitValRef = useRef<boolean>(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // The drawing buffer follows the element's size, or the plot and its labels get stretched and blurred
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const fit = (): void => {
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        canvas.width = canvas.clientWidth
        canvas.height = canvas.clientHeight
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  // Listen for runtime cyclic ticks and push samples
  useEffect(() => {
    if (!currentSnapshot || triggerState === 'STOPPED') return

    const now = performance.now()
    if (now - lastSampleTimeRef.current < sampleRateMs) return
    lastSampleTimeRef.current = now

    // Extract values for all channels from engine/snapshot
    const vals: Record<string, number | boolean> = {}
    channels.forEach((ch) => {
      const val = engine.getVariable(ch.address)
      if (ch.type === 'BOOL') {
        vals[ch.id] = !!val
      } else {
        vals[ch.id] = typeof val === 'number' ? val : Number(val) || 0
      }
    })

    const sample: SamplePoint = {
      timestamp: Date.now(),
      cycle: currentSnapshot.cycleNumber,
      triggeringOb: currentSnapshot.triggeringOb,
      values: vals
    }

    // Trigger condition evaluation
    if (triggerState === 'ARMED') {
      if (triggerMode === 'RISING_EDGE') {
        const curBit = !!vals[triggerChannelId]
        if (!lastTriggerBitValRef.current && curBit) {
          setTriggerState('TRIGGERED')
        }
        lastTriggerBitValRef.current = curBit
      } else if (triggerMode === 'OB82_FAULT') {
        if (currentSnapshot.triggeringOb === 82) {
          setTriggerState('TRIGGERED')
        }
      }
    }

    samplesRef.current.push(sample)

    // Limit buffer to 4,000 samples (~40s at 10ms)
    if (samplesRef.current.length > 4000) {
      samplesRef.current.shift()
    }
  }, [currentSnapshot, triggerState, channels, sampleRateMs, triggerMode, triggerChannelId, engine])

  // Continuous 60 FPS Canvas Drawing Loop
  useEffect(() => {
    let animId: number

    const render = () => {
      drawTrace()
      animId = requestAnimationFrame(render)
    }

    animId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animId)
  }, [timebaseMs, cursorA, cursorB, channels, triggerState])

  const drawTrace = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)

    // Background
    ctx.fillStyle = '#0a0d14'
    ctx.fillRect(0, 0, width, height)

    // Layout division: Top 40% Digital lanes, Bottom 60% Analog plot
    const digitalHeight = height * 0.42
    const analogHeight = height - digitalHeight
    const analogY0 = digitalHeight

    // 1. Grid lines (Vertical time grid)
    const divisions = 10
    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = 1
    for (let i = 0; i <= divisions; i++) {
      const x = (i / divisions) * width
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()

      // Time labels at bottom
      const timeSec = ((divisions - i) * (timebaseMs / 1000) / divisions).toFixed(1)
      ctx.fillStyle = '#64748b'
      ctx.font = '10px monospace'
      ctx.fillText(`-${timeSec}s`, x + 4, height - 6)
    }

    // Divider line between digital and analog
    ctx.strokeStyle = '#334155'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(0, digitalHeight)
    ctx.lineTo(width, digitalHeight)
    ctx.stroke()

    // Analog horizontal grid lines: 0, 13824, 27648
    const analogGrid = [
      { val: 27648, label: '27648 (10V / 20mA)' },
      { val: 13824, label: '13824 (5V / 12mA)' },
      { val: 0, label: '0 (0V / 4mA)' }
    ]
    analogGrid.forEach((g) => {
      const y = analogY0 + analogHeight - (g.val / 27648) * (analogHeight - 30) - 20
      ctx.strokeStyle = '#1e293b'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = '#475569'
      ctx.font = '9px monospace'
      ctx.fillText(g.label, 8, y - 4)
    })

    // Filter samples in current timebase window
    const samples = samplesRef.current
    if (samples.length === 0) return

    const now = samples[samples.length - 1].timestamp
    const windowStart = now - timebaseMs
    const visibleSamples = samples.filter((s) => s.timestamp >= windowStart)

    // 2. Render Digital Lanes (BOOL channels)
    const boolChannels = channels.filter((c) => c.type === 'BOOL' && c.enabled)
    const laneHeight = digitalHeight / Math.max(1, boolChannels.length)

    boolChannels.forEach((ch, laneIdx) => {
      const laneTop = laneIdx * laneHeight
      const highY = laneTop + 8
      const lowY = laneTop + laneHeight - 8

      // Baseline for lane
      ctx.strokeStyle = '#161e2e'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, lowY)
      ctx.lineTo(width, lowY)
      ctx.stroke()

      // Channel label
      ctx.fillStyle = ch.color
      ctx.font = 'bold 10px monospace'
      ctx.fillText(ch.name, 8, laneTop + 14)

      if (visibleSamples.length < 2) return

      ctx.strokeStyle = ch.color
      ctx.lineWidth = 2
      ctx.beginPath()

      visibleSamples.forEach((sample, idx) => {
        const x = ((sample.timestamp - windowStart) / timebaseMs) * width
        const y = sample.values[ch.id] ? highY : lowY

        if (idx === 0) {
          ctx.moveTo(x, y)
        } else {
          // Square wave step
          const prevY = visibleSamples[idx - 1].values[ch.id] ? highY : lowY
          ctx.lineTo(x, prevY)
          ctx.lineTo(x, y)
        }
      })
      ctx.stroke()
    })

    // 3. Render Analog Curves (INT / REAL channels)
    const analogChannels = channels.filter((c) => c.type !== 'BOOL' && c.enabled)
    analogChannels.forEach((ch) => {
      if (visibleSamples.length < 2) return

      ctx.strokeStyle = ch.color
      ctx.lineWidth = 2.5
      ctx.beginPath()

      visibleSamples.forEach((sample, idx) => {
        const x = ((sample.timestamp - windowStart) / timebaseMs) * width
        const raw = Number(sample.values[ch.id]) || 0
        const clamped = Math.max(0, Math.min(27648, raw))
        const y = analogY0 + analogHeight - (clamped / 27648) * (analogHeight - 30) - 20

        if (idx === 0) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
      })
      ctx.stroke()
    })

    // 4. Render Measurement Cursors
    const xA = cursorA * width
    const xB = cursorB * width

    // Cursor A (Cyan)
    ctx.strokeStyle = '#06b6d4'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(xA, 0)
    ctx.lineTo(xA, height)
    ctx.stroke()
    ctx.fillStyle = '#06b6d4'
    ctx.fillRect(xA - 14, 2, 28, 14)
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 10px monospace'
    ctx.fillText('A', xA - 3, 13)

    // Cursor B (Amber)
    ctx.strokeStyle = '#f59e0b'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(xB, 0)
    ctx.lineTo(xB, height)
    ctx.stroke()
    ctx.fillStyle = '#f59e0b'
    ctx.fillRect(xB - 14, 2, 28, 14)
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 10px monospace'
    ctx.fillText('B', xB - 3, 13)
  }

  // Handle cursor dragging
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width

    const distA = Math.abs(frac - cursorA)
    const distB = Math.abs(frac - cursorB)

    if (distA < 0.05) {
      setActiveCursorDrag('A')
    } else if (distB < 0.05) {
      setActiveCursorDrag('B')
    } else if (distA < distB) {
      setCursorA(Math.max(0, Math.min(1, frac)))
      setActiveCursorDrag('A')
    } else {
      setCursorB(Math.max(0, Math.min(1, frac)))
      setActiveCursorDrag('B')
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!activeCursorDrag) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))

    if (activeCursorDrag === 'A') setCursorA(frac)
    else if (activeCursorDrag === 'B') setCursorB(frac)
  }

  const handleMouseUp = () => {
    setActiveCursorDrag(null)
  }

  // Delta calculation between Cursor A and Cursor B
  const deltaT = Math.abs(cursorB - cursorA) * timebaseMs
  const freqHz = deltaT > 0 ? (1000 / deltaT).toFixed(2) : '0'

  // Export Trace CSV
  const exportCsv = () => {
    const samples = samplesRef.current
    if (samples.length === 0) return

    const headers = ['timestamp_ms', 'cycle', 'triggeringOb', ...channels.map((c) => c.name)]
    const rows = samples.map((s) => {
      const vals = channels.map((c) => s.values[c.id])
      return [s.timestamp, s.cycle, s.triggeringOb, ...vals].join(',')
    })

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n')
    const encodedUri = encodeURI(csvContent)
    const link = document.createElement('a')
    link.setAttribute('href', encodedUri)
    link.setAttribute('download', `S7_Trace_Export_${Date.now()}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div className="cq flex-1 flex flex-col h-full bg-industrial-950 select-none overflow-hidden text-industrial-100">
      {/* Top Scope Toolbar */}
      <div className="shrink-0 px-3 py-1 bg-industrial-900 border-b border-industrial-800 flex items-center justify-between gap-x-3 gap-y-2 text-xs flex-wrap whitespace-nowrap">
        {/* Run/Arm/Stop buttons */}
        <div className="flex items-center gap-1.5">
          {triggerState === 'RUNNING' || triggerState === 'ARMED' ? (
            <button
              onClick={() => setTriggerState('STOPPED')}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold transition-all"
            >
              <Pause className="w-3.5 h-3.5" />
              <span>Pause Scope</span>
            </button>
          ) : (
            <button
              onClick={() => setTriggerState(triggerMode === 'FREE_RUN' ? 'RUNNING' : 'ARMED')}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-all"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{triggerMode === 'FREE_RUN' ? 'Run Free' : 'Arm Trigger'}</span>
            </button>
          )}

          <button
            onClick={() => {
              samplesRef.current = []
            }}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-industrial-800 hover:bg-industrial-700 text-industrial-300 transition-all"
            title="Clear Trace Buffer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>

          <span
            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
              triggerState === 'RUNNING'
                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                : triggerState === 'ARMED'
                ? 'bg-amber-950 text-amber-400 border border-amber-800 animate-pulse'
                : triggerState === 'TRIGGERED'
                ? 'bg-blue-950 text-blue-400 border border-blue-800'
                : 'bg-industrial-800 text-industrial-400'
            }`}
          >
            STATUS: {triggerState}
          </span>
        </div>

        {/* Trigger Mode Selector */}
        <div className="flex items-center gap-2">
          <span className="text-industrial-400 text-[11px]">Trigger:</span>
          <select
            value={triggerMode}
            onChange={(e) => {
              const m = e.target.value as TriggerMode
              setTriggerMode(m)
              setTriggerState(m === 'FREE_RUN' ? 'RUNNING' : 'ARMED')
            }}
            className="bg-industrial-950 border border-industrial-750 text-industrial-200 rounded px-2 py-1 text-xs focus:outline-hidden"
          >
            <option value="FREE_RUN">Continuous Free-Run</option>
            <option value="RISING_EDGE">Rising Edge (P_TRIG)</option>
            <option value="OB82_FAULT">Trigger on OB82 Fault</option>
          </select>

          {triggerMode === 'RISING_EDGE' && (
            <select
              value={triggerChannelId}
              onChange={(e) => setTriggerChannelId(e.target.value)}
              className="bg-industrial-950 border border-industrial-750 text-industrial-200 rounded px-2 py-1 text-xs focus:outline-hidden"
            >
              {channels
                .filter((c) => c.type === 'BOOL')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.address})
                  </option>
                ))}
            </select>
          )}
        </div>

        {/* Timebase & Sample Rate */}
        <div className="flex items-center gap-2">
          <span className="text-industrial-400 text-[11px]">Timebase:</span>
          <div className="flex items-center bg-industrial-950 rounded border border-industrial-800 p-0.5">
            {[5000, 10000, 30000, 60000].map((t) => (
              <button
                key={t}
                onClick={() => setTimebaseMs(t)}
                className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                  timebaseMs === t
                    ? 'bg-siemens-cyan text-industrial-950 font-bold'
                    : 'text-industrial-400 hover:text-industrial-200'
                }`}
              >
                {t / 1000}s
              </button>
            ))}
          </div>

          <button
            onClick={exportCsv}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-industrial-800 hover:bg-industrial-700 text-industrial-200 border border-industrial-750 transition-all font-semibold"
            title="Download CSV trace samples"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Main Canvas Plotter */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <canvas
          ref={canvasRef}
          width={1000}
          height={380}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className="absolute inset-0 w-full h-full cursor-crosshair block"
        />
      </div>

      {/* Bottom Cursors HUD & Channel Legend */}
      <div className="shrink-0 px-3 py-1 bg-industrial-900 border-t border-industrial-800 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs font-mono whitespace-nowrap">
        {/* Cursor Δt and Frequency */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5 text-cyan-400">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
            <span><span className="under-1100:hidden">Cursor </span>A: {(cursorA * (timebaseMs / 1000)).toFixed(2)}s</span>
          </div>

          <div className="flex items-center gap-1.5 text-amber-400">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
            <span><span className="under-1100:hidden">Cursor </span>B: {(cursorB * (timebaseMs / 1000)).toFixed(2)}s</span>
          </div>

          <div className="px-2 py-0.5 rounded bg-industrial-950 border border-industrial-800 text-industrial-200">
            <span className="text-industrial-400">Δt: </span>
            <span className="text-emerald-400 font-bold">{Math.round(deltaT)} ms</span>
            <span className="text-industrial-500 mx-1.5">|</span>
            <span className="text-industrial-400">Freq: </span>
            <span className="text-purple-400 font-bold">{freqHz} Hz</span>
          </div>
        </div>

        {/* Channel Toggles & Values */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => {
                setChannels((chs) =>
                  chs.map((c) => (c.id === ch.id ? { ...c, enabled: !c.enabled } : c))
                )
              }}
              className={`flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded transition-opacity ${
                ch.enabled ? 'opacity-100' : 'opacity-40 line-through'
              }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ch.color }} />
              <span style={{ color: ch.color }}>{ch.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}


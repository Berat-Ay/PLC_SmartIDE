import React, { useState, useEffect, useRef } from 'react'
import { Search, Tag, Database, HardDrive, Check, X } from 'lucide-react'
import { useTagStore } from '../../../stores/useTagStore'
import { useBlockStore } from '../../../stores/useBlockStore'
import { BlockInterface } from '@shared/types/blocks'

interface TagAutocompleteComboboxProps {
  currentValue: string
  blockInterface?: BlockInterface
  onSelect: (value: string) => void
  onClose: () => void
  position?: { x: number; y: number }
}

interface SymbolOption {
  symbol: string
  address?: string
  type: string
  source: 'Tag' | 'DB' | 'Local'
  comment?: string
}

export const TagAutocompleteCombobox: React.FC<TagAutocompleteComboboxProps> = ({
  currentValue,
  blockInterface,
  onSelect,
  onClose,
  position
}) => {
  const { tagTables } = useTagStore()
  const { dataBlocks } = useBlockStore()

  const [query, setQuery] = useState(currentValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Collect all available symbols
  const options: SymbolOption[] = []

  // 1. Local interface variables
  if (blockInterface) {
    const addSection = (vars: typeof blockInterface.input, section: string) => {
      for (const v of vars) {
        options.push({
          symbol: `#${v.name}`,
          type: v.dataType,
          source: 'Local',
          comment: `Local ${section} variable`
        })
      }
    }
    addSection(blockInterface.input, 'Input')
    addSection(blockInterface.output, 'Output')
    addSection(blockInterface.inOut, 'InOut')
    addSection(blockInterface.static, 'Static')
    addSection(blockInterface.temp, 'Temp')
    addSection(blockInterface.constant, 'Constant')
  }

  // 2. PLC Tag Tables
  for (const table of tagTables) {
    for (const tag of table.tags) {
      options.push({
        symbol: tag.name,
        address: tag.address,
        type: tag.dataType,
        source: 'Tag',
        comment: tag.comment || `Tag Table [${table.name}]`
      })
    }
  }

  // 3. Data Blocks
  for (const db of dataBlocks) {
    for (const v of db.variables) {
      options.push({
        symbol: `"${db.name}".${v.name}`,
        type: v.dataType,
        source: 'DB',
        comment: `Offset ${v.calculatedOffset || 'auto'}`
      })
    }
  }

  // 4. Native IEC Timers & Counters Sub-Bits (T1.Q, T1.IN, T1.ET, C1.QU, C1.CV)
  const timerInstances = new Set<string>(['T1'])
  const counterInstances = new Set<string>(['C1'])
  const { ladBlocks } = useBlockStore.getState()
  for (const lb of ladBlocks) {
    for (const net of lb.networks || []) {
      const scanNodes = (nList: any[]) => {
        for (const n of nList) {
          if (n.kind === 'timer') {
            timerInstances.add(n.instanceDb || 'T1')
          } else if (n.kind === 'counter') {
            counterInstances.add(n.instanceDb || 'C1')
          } else if (n.kind === 'parallel') {
            for (const b of n.branches || []) scanNodes(b)
          }
        }
      }
      scanNodes(net.nodes || [])
    }
  }

  for (const tInst of timerInstances) {
    options.push({
      symbol: `${tInst}.Q`,
      address: `${tInst}.Q`,
      type: 'BOOL',
      source: 'Local',
      comment: `IEC Timer [${tInst}] Done Output (BOOL)`
    })
    options.push({
      symbol: `${tInst}.IN`,
      address: `${tInst}.IN`,
      type: 'BOOL',
      source: 'Local',
      comment: `IEC Timer [${tInst}] Enable Bit (BOOL)`
    })
    options.push({
      symbol: `${tInst}.ET`,
      address: `${tInst}.ET`,
      type: 'TIME',
      source: 'Local',
      comment: `IEC Timer [${tInst}] Elapsed Time (TIME)`
    })
  }

  for (const cInst of counterInstances) {
    options.push({
      symbol: `${cInst}.QU`,
      address: `${cInst}.QU`,
      type: 'BOOL',
      source: 'Local',
      comment: `IEC Counter [${cInst}] Count-Up Done Output (BOOL)`
    })
    options.push({
      symbol: `${cInst}.CV`,
      address: `${cInst}.CV`,
      type: 'INT',
      source: 'Local',
      comment: `IEC Counter [${cInst}] Current Count Value (INT)`
    })
  }

  const filtered = options.filter(
    (opt) =>
      opt.symbol.toLowerCase().includes(query.toLowerCase()) ||
      (opt.address && opt.address.toLowerCase().includes(query.toLowerCase())) ||
      (opt.comment && opt.comment.toLowerCase().includes(query.toLowerCase()))
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'Enter') {
      if (filtered.length > 0) {
        onSelect(filtered[0].symbol)
      } else if (query.trim()) {
        onSelect(query.trim())
      }
      onClose()
    }
  }

  return (
    <div
      data-testid="tag-autocomplete-combobox"
      style={{
        position: position ? 'fixed' : 'relative',
        left: position ? `${position.x}px` : undefined,
        top: position ? `${position.y}px` : undefined,
        zIndex: 50
      }}
      className="w-72 bg-industrial-950 border border-cyan-500 rounded-none shadow-2xl overflow-hidden text-xs font-mono"
    >
      <div className="p-2 border-b border-industrial-800 flex items-center gap-2 bg-industrial-900">
        <Search className="w-3.5 h-3.5 text-cyan-400" />
        <input
          ref={inputRef}
          data-testid="tag-autocomplete-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search Tag, DB or #Local..."
          className="w-full bg-transparent text-industrial-100 placeholder-industrial-500 focus:outline-hidden text-xs"
        />
        <button onClick={onClose} className="text-industrial-400 hover:text-white">
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="max-h-56 overflow-y-auto divide-y divide-industrial-850">
        {filtered.length === 0 ? (
          <div
            onClick={() => {
              if (query.trim()) onSelect(query.trim())
              onClose()
            }}
            className="p-3 text-center text-industrial-400 cursor-pointer hover:bg-industrial-900"
          >
            Use custom address: <strong className="text-cyan-300 font-bold">{query}</strong>
          </div>
        ) : (
          filtered.slice(0, 30).map((opt) => (
            <div
              key={opt.symbol}
              onClick={() => {
                onSelect(opt.symbol)
                onClose()
              }}
              className="px-2.5 py-1.5 hover:bg-industrial-850 cursor-pointer transition-colors flex items-center justify-between group"
            >
              <div className="flex items-center gap-2 truncate">
                {opt.source === 'Tag' ? (
                  <Tag className="w-3 h-3 text-cyan-400 shrink-0" />
                ) : opt.source === 'DB' ? (
                  <Database className="w-3 h-3 text-amber-400 shrink-0" />
                ) : (
                  <HardDrive className="w-3 h-3 text-purple-400 shrink-0" />
                )}
                <div className="truncate">
                  <div className="text-industrial-100 font-semibold group-hover:text-cyan-300 truncate">
                    {opt.symbol}
                  </div>
                  {opt.address && (
                    <div className="text-[10px] text-industrial-400 font-mono">{opt.address}</div>
                  )}
                </div>
              </div>

              <span className="text-[10px] text-industrial-500 font-mono px-1 py-0.2 rounded bg-industrial-900 border border-industrial-800">
                {opt.type}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}


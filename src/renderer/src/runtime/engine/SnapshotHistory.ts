import type { RuntimeMemorySnapshot } from '@shared/types/runtime'

/**
 * O(1) circular ring buffer storing up to MAX_HISTORY PLC scan snapshots.
 */
export class SnapshotHistory {
  public readonly maxHistory: number
  private slots: Array<RuntimeMemorySnapshot | undefined>
  private head = 0
  private count = 0

  constructor(maxHistory: number = 1000) {
    this.maxHistory = maxHistory
    this.slots = new Array(maxHistory)
  }

  public get length(): number {
    return this.count
  }

  public push(snapshot: RuntimeMemorySnapshot): void {
    this.slots[this.head] = snapshot
    this.head = (this.head + 1) % this.maxHistory
    if (this.count < this.maxHistory) {
      this.count++
    }
  }

  public at(logicalIndex: number): RuntimeMemorySnapshot | undefined {
    if (logicalIndex < 0 || logicalIndex >= this.count) return undefined
    const oldestSlot = this.count < this.maxHistory ? 0 : this.head
    return this.slots[(oldestSlot + logicalIndex) % this.maxHistory]
  }

  public getAll(): RuntimeMemorySnapshot[] {
    const out: RuntimeMemorySnapshot[] = new Array(this.count)
    for (let i = 0; i < this.count; i++) {
      out[i] = this.at(i)!
    }
    return out
  }

  public getRecent(count: number): RuntimeMemorySnapshot[] {
    if (count <= 0 || this.count === 0) return []
    const take = Math.min(count, this.count)
    const start = this.count - take
    const out: RuntimeMemorySnapshot[] = new Array(take)
    for (let i = 0; i < take; i++) {
      out[i] = this.at(start + i)!
    }
    return out
  }

  public getSince(afterCycleNumber: number): RuntimeMemorySnapshot[] {
    if (this.count === 0) return []
    const out: RuntimeMemorySnapshot[] = []
    for (let i = this.count - 1; i >= 0; i--) {
      const snap = this.at(i)
      if (!snap || snap.cycleNumber <= afterCycleNumber) break
      out.push(snap)
    }
    out.reverse()
    return out
  }

  public getAtCycle(cycleNumber: number): RuntimeMemorySnapshot | undefined {
    for (let i = this.count - 1; i >= 0; i--) {
      const snap = this.at(i)
      if (snap && snap.cycleNumber === cycleNumber) return snap
    }
    return undefined
  }

  public clear(): void {
    this.slots = new Array(this.maxHistory)
    this.head = 0
    this.count = 0
  }
}

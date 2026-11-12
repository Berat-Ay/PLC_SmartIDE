/**
 * 2D Cellular Matrix Layout Engine (Grid[Row][Col])
 *
 * Implements deterministic 2D cellular grid layout for Siemens S7 Ladder Logic networks.
 * Computes exact coordinate bounding boxes, orthogonal wire routing, parallel branch fork/join matrices,
 * right-aligned output zones, and cell-based magnetic drop zones with zero visual overlaps.
 */

import {
  LadderNode,
  LadderParallelBranchNode,
  LadderSeriesNode
} from '@shared/types/ladder'
import { LadNetwork } from '@shared/types/blocks'

export interface DropZoneTarget {
  netIdx: number
  branchId?: string
  branchIndex?: number
  insertIndex: number
}

export interface NodeLayout {
  id: string
  node: LadderNode
  row: number
  col: number
  x: number // Cell start X
  y: number // Center wire Y
  boxX: number // Bounding box top-left X
  boxY: number // Bounding box top-left Y
  width: number
  height: number
  entryWireX: number
  exitWireX: number
  branchContext?: {
    branchId: string
    branchIndex: number
    isFirstInBranch: boolean
    isLastInBranch: boolean
  }
}

export interface WireSegment {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  kind: 'horizontal_main' | 'horizontal_branch' | 'vertical_fork' | 'vertical_join' | 'terminal_lead'
  branchId?: string
  branchIndex?: number
}

export interface ParallelForkJoin {
  id: string
  branchId: string
  forkX: number
  forkTopY: number
  forkBottomY: number
  joinX: number
  joinTopY: number
  joinBottomY: number
  branchRowYs: number[]
}

export interface CellDropZone {
  id: string
  x: number
  y: number
  row: number
  col: number
  target: DropZoneTarget
}

export interface NetworkLayoutResult {
  networkNumber: number
  svgWidth: number
  svgHeight: number
  leftRailX: number
  rightRailX: number
  coilX: number
  coilCol: number
  maxRow: number
  maxCol: number
  nodeLayouts: Map<string, NodeLayout>
  orderedNodes: NodeLayout[]
  wireSegments: WireSegment[]
  forkJoins: ParallelForkJoin[]
  dropZones: CellDropZone[]
}

/** A short rung stays small enough to fit next to both docks without scrolling. */
export const LADDER_MIN_WIDTH = 720

export class LadderGridLayoutEngine {
  // Grid layout dimensional constants
  public static readonly CELL_WIDTH = 180 // standard contact/coil cell
  public static readonly BOX_CELL_WIDTH = 220 // function blocks (TON, CTU, MATH, NORM_X, etc.)
  public static readonly ROW_HEIGHT = 110 // standard contact row
  public static readonly LEFT_RAIL_X = 48
  // The selection toolbar of a contact or coil sits 84 above its wire and must stay inside the SVG
  public static readonly TOP_PADDING = 90
  public static readonly BOTTOM_PADDING = 55
  public static readonly RIGHT_MARGIN = 60

  /**
   * Computes the deterministic 2D cellular layout for a single Ladder Network.
   */
  public static layoutNetwork(
    net: LadNetwork,
    netIdx: number,
    containerWidth: number = 1100
  ): NetworkLayoutResult {
    const nodes = net.nodes || []
    const nodeLayouts = new Map<string, NodeLayout>()
    const orderedNodes: NodeLayout[] = []
    const wireSegments: WireSegment[] = []
    const forkJoins: ParallelForkJoin[] = []
    const dropZones: CellDropZone[] = []

    let maxRowReached = 0
    let maxColReached = 0

    // Helper to determine width and height of an individual node
    const getNodeDimensions = (node: LadderNode): { width: number; height: number; isBox: boolean } => {
      if (['timer', 'counter', 'comparator', 'math'].includes(node.kind)) {
        return { width: LadderGridLayoutEngine.BOX_CELL_WIDTH, height: 110, isBox: true }
      }
      if (node.kind === 'emptyBox') {
        return { width: 140, height: 80, isBox: true }
      }
      return { width: LadderGridLayoutEngine.CELL_WIDTH, height: 70, isBox: false }
    }

    // Helper to calculate X from Column
    const colToX = (col: number): number => {
      return LadderGridLayoutEngine.LEFT_RAIL_X + col * LadderGridLayoutEngine.CELL_WIDTH
    }

    // Helper to calculate wire Y from Row
    const rowToY = (row: number): number => {
      return LadderGridLayoutEngine.TOP_PADDING + row * LadderGridLayoutEngine.ROW_HEIGHT
    }

    // Empty Network handling
    if (nodes.length === 0) {
      const svgWidth = Math.max(containerWidth, LADDER_MIN_WIDTH)
      const svgHeight = 160
      const rightRailX = svgWidth - LadderGridLayoutEngine.RIGHT_MARGIN
      const wireY = LadderGridLayoutEngine.TOP_PADDING

      // Main horizontal wire
      wireSegments.push({
        id: `wire_empty_${netIdx}`,
        x1: LadderGridLayoutEngine.LEFT_RAIL_X,
        y1: wireY,
        x2: rightRailX,
        y2: wireY,
        kind: 'horizontal_main'
      })

      // Single centered drop zone for empty rung
      dropZones.push({
        id: `drop_empty_${netIdx}`,
        x: Math.round(svgWidth / 2),
        y: wireY,
        row: 0,
        col: 0,
        target: { netIdx, insertIndex: 0 }
      })

      return {
        networkNumber: net.networkNumber,
        svgWidth,
        svgHeight,
        leftRailX: LadderGridLayoutEngine.LEFT_RAIL_X,
        rightRailX,
        coilX: rightRailX - 175,
        coilCol: 4,
        maxRow: 0,
        maxCol: 0,
        nodeLayouts,
        orderedNodes,
        wireSegments,
        forkJoins,
        dropZones
      }
    }

    // Initial drop target before first node in network
    dropZones.push({
      id: `drop_start_net_${netIdx}`,
      x: LadderGridLayoutEngine.LEFT_RAIL_X + 16,
      y: rowToY(0),
      row: 0,
      col: 0,
      target: { netIdx, insertIndex: 0 }
    })

    // Recursive placement of nodes
    const placeNodes = (
      nodeList: LadderSeriesNode[],
      startRow: number,
      startCol: number,
      branchCtx?: { branchId: string; branchIndex: number }
    ): { endRow: number; endCol: number } => {
      let currentCol = startCol
      let currentRow = startRow

      for (let idx = 0; idx < nodeList.length; idx++) {
        const node = nodeList[idx]
        const isFirstInBranch = idx === 0
        const isLastInBranch = idx === nodeList.length - 1

        if (node.kind === 'parallel') {
          const p = node as LadderParallelBranchNode
          const forkCol = currentCol
          const forkX = colToX(forkCol)
          const forkTopY = rowToY(startRow)
          let branchMaxEndCol = forkCol
          let branchMaxRow = currentRow
          const branchRowYs: number[] = []

          // Place each branch leg
          p.branches.forEach((branchLeg, bIdx) => {
            const legRow = bIdx === 0 ? currentRow : branchMaxRow + 1
            if (legRow > branchMaxRow) branchMaxRow = legRow
            if (legRow > maxRowReached) maxRowReached = legRow

            const legY = rowToY(legRow)
            branchRowYs.push(legY)

            // If empty branch leg, place a drop target
            if (!branchLeg || branchLeg.length === 0) {
              dropZones.push({
                id: `drop_empty_leg_${p.id}_${bIdx}`,
                x: forkX + 60,
                y: legY,
                row: legRow,
                col: forkCol,
                target: { netIdx, branchId: p.id, branchIndex: bIdx, insertIndex: 0 }
              })
              branchMaxEndCol = Math.max(branchMaxEndCol, forkCol + 1)
            } else {
              // Initial drop target inside branch before its first node
              dropZones.push({
                id: `drop_branch_start_${p.id}_${bIdx}`,
                x: forkX + 24,
                y: legY,
                row: legRow,
                col: forkCol,
                target: { netIdx, branchId: p.id, branchIndex: bIdx, insertIndex: 0 }
              })

              const legResult = placeNodes(branchLeg, legRow, forkCol, {
                branchId: p.id,
                branchIndex: bIdx
              })
              branchMaxEndCol = Math.max(branchMaxEndCol, legResult.endCol)
            }
          })

          const joinCol = branchMaxEndCol
          const joinX = colToX(joinCol) + 30
          const forkLineX = forkX - 14

          // Register Parallel Fork/Join geometry
          forkJoins.push({
            id: `forkjoin_${p.id}`,
            branchId: p.id,
            forkX: forkLineX,
            forkTopY,
            forkBottomY: rowToY(branchMaxRow),
            joinX,
            joinTopY: forkTopY,
            joinBottomY: rowToY(branchMaxRow),
            branchRowYs
          })

          // Vertical fork wire
          wireSegments.push({
            id: `wire_fork_${p.id}`,
            x1: forkLineX,
            y1: forkTopY,
            x2: forkLineX,
            y2: rowToY(branchMaxRow),
            kind: 'vertical_fork',
            branchId: p.id
          })

          // Vertical join wire
          wireSegments.push({
            id: `wire_join_${p.id}`,
            x1: joinX,
            y1: forkTopY,
            x2: joinX,
            y2: rowToY(branchMaxRow),
            kind: 'vertical_join',
            branchId: p.id
          })

          // Connect each leg to the fork and join lines
          p.branches.forEach((branchLeg, bIdx) => {
            const legY = branchRowYs[bIdx]

            // Fork horizontal infeed wire to leg
            wireSegments.push({
              id: `wire_leg_in_${p.id}_${bIdx}`,
              x1: forkLineX,
              y1: legY,
              x2: forkX,
              y2: legY,
              kind: 'horizontal_branch',
              branchId: p.id,
              branchIndex: bIdx
            })

            // Join horizontal exit wire from leg
            const lastNodeInLeg = branchLeg && branchLeg.length > 0 ? branchLeg[branchLeg.length - 1] : null
            const lastNodeLayout = lastNodeInLeg ? nodeLayouts.get(lastNodeInLeg.id) : null
            const legExitX = lastNodeLayout ? lastNodeLayout.exitWireX : forkX + 60

            if (legExitX < joinX) {
              wireSegments.push({
                id: `wire_leg_out_${p.id}_${bIdx}`,
                x1: legExitX,
                y1: legY,
                x2: joinX,
                y2: legY,
                kind: 'horizontal_branch',
                branchId: p.id,
                branchIndex: bIdx
              })
            }
          })

          // Next series element starts after the join line
          currentCol = joinCol + 1
          if (currentCol > maxColReached) maxColReached = currentCol

          // Drop target after parallel branch
          dropZones.push({
            id: `drop_after_parallel_${p.id}`,
            x: joinX + 24,
            y: forkTopY,
            row: startRow,
            col: currentCol,
            target: {
              netIdx,
              branchId: branchCtx?.branchId,
              branchIndex: branchCtx?.branchIndex,
              insertIndex: idx + 1
            }
          })

          continue
        }

        // Standard Node (Contact, Coil, Box)
        const dims = getNodeDimensions(node)
        const nodeX = colToX(currentCol)
        const nodeY = rowToY(currentRow)

        const layout: NodeLayout = {
          id: node.id,
          node,
          row: currentRow,
          col: currentCol,
          x: nodeX,
          y: nodeY,
          boxX: nodeX,
          boxY: nodeY - dims.height / 2,
          width: dims.width,
          height: dims.height,
          entryWireX: nodeX,
          exitWireX: nodeX + dims.width,
          branchContext: branchCtx
            ? {
                branchId: branchCtx.branchId,
                branchIndex: branchCtx.branchIndex,
                isFirstInBranch,
                isLastInBranch
              }
            : undefined
        }

        nodeLayouts.set(node.id, layout)
        orderedNodes.push(layout)

        // Drop target after this node
        dropZones.push({
          id: `drop_after_${node.id}`,
          x: layout.exitWireX + 16,
          y: nodeY,
          row: currentRow,
          col: currentCol + 1,
          target: {
            netIdx,
            branchId: branchCtx?.branchId,
            branchIndex: branchCtx?.branchIndex,
            insertIndex: idx + 1
          }
        })

        currentCol += dims.isBox ? 2 : 1
        if (currentCol > maxColReached) maxColReached = currentCol
        if (currentRow > maxRowReached) maxRowReached = currentRow
      }

      return { endRow: currentRow, endCol: currentCol }
    }

    // Separate main rung nodes into pre-coil and coils/terminal boxes
    const lastNode = nodes[nodes.length - 1]
    const hasTrailingOutput =
      lastNode &&
      (lastNode.kind === 'coil' ||
        (lastNode.kind === 'timer' && nodes.length > 1) ||
        (lastNode.kind === 'counter' && nodes.length > 1))

    const mainNodesToPlace = hasTrailingOutput ? nodes.slice(0, nodes.length - 1) : nodes
    const placeResult = placeNodes(mainNodesToPlace, 0, 0)

    // Compute coil placement
    // Output coil is guaranteed placed at coilCol = Math.max(3, totalSeriesColumns + 1)
    let coilCol = mainNodesToPlace.length > 0 ? Math.max(3, placeResult.endCol + 1) : 3
    let coilLayout: NodeLayout | null = null

    if (hasTrailingOutput) {
      const coilNode = lastNode
      const coilDims = getNodeDimensions(coilNode)
      const coilX = colToX(coilCol)
      const coilY = rowToY(0)

      coilLayout = {
        id: coilNode.id,
        node: coilNode,
        row: 0,
        col: coilCol,
        x: coilX,
        y: coilY,
        boxX: coilX,
        boxY: coilY - coilDims.height / 2,
        width: coilDims.width,
        height: coilDims.height,
        entryWireX: coilX,
        exitWireX: coilX + coilDims.width
      }

      nodeLayouts.set(coilNode.id, coilLayout)
      orderedNodes.push(coilLayout)

      // Drop target before the output coil
      dropZones.push({
        id: `drop_before_coil_${coilNode.id}`,
        x: coilX - 16,
        y: coilY,
        row: 0,
        col: coilCol,
        target: { netIdx, insertIndex: nodes.length - 1 }
      })
    }

    // Connect infeed wire from left rail to first node
    const firstLayout = orderedNodes[0]
    if (firstLayout) {
      const firstEntryX = forkJoins.length > 0 && forkJoins[0].forkX < firstLayout.entryWireX
        ? forkJoins[0].forkX
        : firstLayout.entryWireX

      if (LadderGridLayoutEngine.LEFT_RAIL_X < firstEntryX) {
        wireSegments.push({
          id: `wire_rail_to_first_${netIdx}`,
          x1: LadderGridLayoutEngine.LEFT_RAIL_X,
          y1: rowToY(0),
          x2: firstEntryX,
          y2: rowToY(0),
          kind: 'horizontal_main'
        })
      }
    }

    // Connect wire from end of series logic to output coil (or terminal lead)
    const rightRailX = colToX(coilCol) + LadderGridLayoutEngine.CELL_WIDTH + 20
    const lastPrecedingX =
      mainNodesToPlace.length > 0
        ? (forkJoins.length > 0 && forkJoins[forkJoins.length - 1].joinX > colToX(placeResult.endCol - 1)
            ? forkJoins[forkJoins.length - 1].joinX
            : colToX(placeResult.endCol))
        : LadderGridLayoutEngine.LEFT_RAIL_X

    if (coilLayout && lastPrecedingX < coilLayout.entryWireX) {
      wireSegments.push({
        id: `wire_to_coil_${netIdx}`,
        x1: lastPrecedingX,
        y1: rowToY(0),
        x2: coilLayout.entryWireX,
        y2: rowToY(0),
        kind: 'horizontal_main'
      })
    }

    // Terminal wire from coil exit to right terminal bar (-|)
    const terminalStartX = coilLayout ? coilLayout.exitWireX : lastPrecedingX
    if (terminalStartX < rightRailX) {
      wireSegments.push({
        id: `wire_terminal_lead_${netIdx}`,
        x1: terminalStartX,
        y1: rowToY(0),
        x2: rightRailX,
        y2: rowToY(0),
        kind: 'terminal_lead'
      })
    }

    // Calculate total SVG canvas dimensions
    const calculatedWidth = Math.max(rightRailX, colToX(maxColReached + 1)) + 20
    const svgWidth = Math.max(containerWidth, Math.max(LADDER_MIN_WIDTH, calculatedWidth))

    // Only an instruction box hangs far below its wire. A contact or coil rung needs no extra row
    const hasBox = (nodes: LadderNode[]): boolean =>
      nodes.some((n) =>
        n.kind === 'parallel'
          ? (n as LadderParallelBranchNode).branches.some((b) => hasBox(b || []))
          : n.kind !== 'contact' && n.kind !== 'coil'
      )
    const calculatedHeight =
      LadderGridLayoutEngine.TOP_PADDING +
      maxRowReached * LadderGridLayoutEngine.ROW_HEIGHT +
      (hasBox(net.nodes || []) ? LadderGridLayoutEngine.ROW_HEIGHT : 10) +
      LadderGridLayoutEngine.BOTTOM_PADDING
    const svgHeight = Math.max(160, calculatedHeight)

    return {
      networkNumber: net.networkNumber,
      svgWidth,
      svgHeight,
      leftRailX: LadderGridLayoutEngine.LEFT_RAIL_X,
      rightRailX,
      coilX: coilLayout ? coilLayout.x : rightRailX - 175,
      coilCol,
      maxRow: maxRowReached,
      maxCol: Math.max(coilCol + 2, maxColReached + 2),
      nodeLayouts,
      orderedNodes,
      wireSegments,
      forkJoins,
      dropZones
    }
  }

  /**
   * Finds the closest magnetic cell drop target to cursor (x, y) within snapRadius.
   */
  public static findNearestDropTarget(
    dropZones: CellDropZone[],
    x: number,
    y: number,
    snapRadius: number = 60
  ): CellDropZone | null {
    let closest: CellDropZone | null = null
    let minDistance = snapRadius

    for (const zone of dropZones) {
      const dist = Math.hypot(zone.x - x, zone.y - y)
      if (dist < minDistance) {
        minDistance = dist
        closest = zone
      }
    }

    return closest
  }
}

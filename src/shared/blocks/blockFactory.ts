import { BlockInterface, BlockVariable, DataBlockDefinition, DbType } from '../types/blocks'
import { LadderNetwork, createNetworkId } from '../types/ladder'

/** Creates a valid initial single-network list for a newly created LAD block. */
export function createInitialLadNetworks(): LadderNetwork[] {
  return [
    {
      id: createNetworkId(),
      networkNumber: 1,
      title: 'Network 1',
      nodes: []
    }
  ]
}

function cloneVariable(v: BlockVariable, id: string): BlockVariable {
  return {
    ...v,
    id,
    members: v.members ? v.members.map((m, idx) => cloneVariable(m, `${id}_m${idx}`)) : undefined
  }
}

/**
 * Derives instance DB variables from an FB's non-temporary interface sections
 * (Input, Output, InOut, Static) in declaration order.
 */
export function deriveInstanceDbVariables(iface: BlockInterface): BlockVariable[] {
  const sourceVars = [
    ...(iface.input || []),
    ...(iface.output || []),
    ...(iface.inOut || []),
    ...(iface.static || [])
  ]
  return sourceVars.map((v, idx) => cloneVariable(v, `inst_${idx}_${v.name}`))
}

/**
 * Creates a DataBlockDefinition for Global or Instance DBs.
 * Instance DBs require a parent FB and inherit its instance interface variables.
 */
export function createDataBlockDefinition(params: {
  blockNumber: number
  name: string
  dbType: DbType
  optimizedAccess: boolean
  parentFb?: { name: string; interface: BlockInterface }
}): DataBlockDefinition {
  const { blockNumber, name, dbType, optimizedAccess, parentFb } = params
  if (dbType === 'Instance' && !parentFb) {
    throw new Error('An Instance DB requires a parent Function Block (FB).')
  }

  const variables = dbType === 'Instance' && parentFb ? deriveInstanceDbVariables(parentFb.interface) : []

  return {
    blockType: 'DB',
    blockNumber,
    name,
    fileName: `${name}.db.json`,
    dbType,
    parentFbName: dbType === 'Instance' ? parentFb!.name : undefined,
    optimizedAccess,
    variables,
    comment:
      dbType === 'Instance' && parentFb
        ? `Instance Data Block for ${parentFb.name}`
        : `User created ${dbType} Data Block`
  }
}

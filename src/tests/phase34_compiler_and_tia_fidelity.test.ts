// Phase 34 regression suite: SCL lexer/parser/sourceBlock, compiler & consistency checks,
// MemoryOverlap, DoubleCoil, CrossReference, LadderDSL roundtrip, and TIA export/import fidelity.
import { SclLexer } from '../shared/scl/lexer'
import { SclParser } from '../shared/scl/parser'
import { emptyInterface, parseSourceBlock } from '../shared/scl/sourceBlock'
import { ProjectCompilerEngine } from '../renderer/src/services/compiler/ProjectCompilerEngine'
import { StlListingGenerator } from '../renderer/src/services/compiler/StlListingGenerator'
import { MemoryOverlapEngine } from '../renderer/src/services/MemoryOverlapEngine'
import { DoubleCoilDetector } from '../renderer/src/services/DoubleCoilDetector'
import { CrossReferenceEngine } from '../renderer/src/services/CrossReferenceEngine'
import { LadderDslCompiler } from '../renderer/src/services/compiler/LadderDslCompiler'
import { writeDataBlock, tiaTypeName } from '../shared/tia/writers'
import { qualifySclBody } from '../shared/tia/sclQualify'
import { buildTiaBundle } from '../shared/tia/bundle'
import { transpileLadToScl } from '../shared/tia/ladToScl'
import { readTagTableXml, readTiaFolder } from '../shared/tia/readers'
import { getDefaultCpuConfig } from '../shared/constants/hardwareDefaults'
import { buildInitialProjectPayload } from '../shared/project/createProjectPayload'
import type { DataBlockDefinition, LadBlockDefinition, SclBlockDefinition } from '../shared/types/blocks'
import type { TagTable } from '../shared/types/tags'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`✅ PASS: ${name}`)
  } else {
    failed++
    console.error(`❌ FAIL: ${name}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`)
  }
}

function makeLad(name: string, networks: LadBlockDefinition['networks'], blockType: 'OB' | 'FB' = 'OB', blockNumber = 1): LadBlockDefinition {
  return {
    blockType,
    blockNumber,
    name,
    fileName: `${name}.lad.json`,
    optimizedAccess: true,
    schemaVersion: '1.0',
    interface: emptyInterface(),
    networks
  }
}

function run(): void {
  console.log('=== PHASE 34: COMPILER, ANALYSIS & TIA FIDELITY ===\n')

  // 1. SclLexer & SclParser
  {
    const lexRes = SclLexer.tokenize(
      `REGION "Init"\n  #A := INT#-5 + 1_000;\n  #T := T#-5s;\n  #S := 'it$'s';\n  #B := TRUE & FALSE;\nEND_REGION;`
    )
    check(
      'SclLexer handles INT#-5, 1_000, T#-5s, S7 $ string escape, &, REGION/END_REGION cleanly',
      lexRes.errors.length === 0 &&
        lexRes.tokens.some((t) => t.type === 'NUMBER' && t.value === '-5') &&
        lexRes.tokens.some((t) => t.type === 'NUMBER' && t.value === '1000') &&
        lexRes.tokens.some((t) => t.type === 'TIME' && t.value === 'T#-5s') &&
        lexRes.tokens.some((t) => t.type === 'STRING' && t.value === "it's") &&
        lexRes.tokens.some((t) => t.type === 'OPERATOR' && t.value === '&'),
      lexRes
    )

    const badRadix = SclLexer.tokenize(`#X := 2#102; #Y := 8#9;`)
    check('SclLexer rejects invalid digits for base 2 and base 8 literals', badRadix.errors.length === 2, badRadix.errors)

    const parserRes = new SclParser(
      SclLexer.tokenize(
        `REGION "Cases"\nCASE #Mode OF\n  -5: #Out := 1;\n  -10..-1: #Out := 2;\n  ELSE: #Out := 0;\nEND_CASE;\nEND_REGION`
      ).tokens
    )
    const stmts = parserRes.parseProgram()
    check(
      'SclParser parses negative CASE labels/ranges, ELSE:, and REGION blocks without error',
      parserRes.errors.length === 0 && stmts.length === 1 && stmts[0].kind === 'case' && stmts[0].cases[1].values.length === 1,
      { errors: parserRes.errors, stmts }
    )

    const unclosedIdx = new SclParser(SclLexer.tokenize(`#Arr[#i := 1;`).tokens)
    unclosedIdx.parseProgram()
    check('SclParser reports unclosed [ index bracket', unclosedIdx.errors.some((e) => e.includes("Unclosed '['")), unclosedIdx.errors)
  }

  // 2. sourceBlock header & declarations
  {
    const src = `FUNCTION_BLOCK "FB_Test"
(* multi-line
   block comment *)
VAR_INPUT
  a, b : Int := 7; (* inline *)
  Msg : String[20] := 'a;b';
END_VAR
VAR_CONSTANT
  PI_VAL : Real := 3.14;
END_VAR
VAR
  Items : Array[0..1] of Struct
    Id : Int;
  END_STRUCT;
END_VAR
BEGIN
  #Msg := 'ok';
END_FUNCTION_BLOCK`
    const parsed = parseSourceBlock(src)
    check(
      'sourceBlock handles multi-line (* *), multi-var line, string ;, Array of Struct, VAR_CONSTANT',
      parsed.errors.length === 0 &&
        parsed.interface.input.length === 3 &&
        parsed.interface.input[0].name === 'a' &&
        parsed.interface.input[1].name === 'b' &&
        parsed.interface.input[1].defaultValue === '7' &&
        parsed.interface.input[2].defaultValue === "'a;b'" &&
        parsed.interface.constant.length === 1 &&
        parsed.interface.static[0]?.members?.length === 1,
      { errors: parsed.errors, iface: parsed.interface }
    )
  }

  // 3. ProjectCompilerEngine, ProgramConsistencyChecks & StlListingGenerator
  {
    const tags: TagTable[] = [
      {
        id: 't1',
        name: 'Tags',
        fileName: 'Tags.tags.json',
        tags: [
          { id: 'tag_in', name: 'InBit', dataType: 'BOOL', address: '%I0.0' },
          { id: 'tag_out', name: 'OutBit', dataType: 'BOOL', address: '%Q0.0' },
          { id: 'tag_rst', name: 'RstBit', dataType: 'BOOL', address: '%I0.1' }
        ]
      }
    ]
    const tonDb: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 1,
      name: 'DB_TonInst',
      fileName: 'DB_TonInst.db.json',
      dbType: 'Instance',
      parentFbName: 'TONR',
      optimizedAccess: true,
      variables: []
    }
    const globalDb: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 2,
      name: 'DB_Global',
      fileName: 'DB_Global.db.json',
      dbType: 'Global',
      optimizedAccess: true,
      variables: [{ id: 'v1', name: 'Q', dataType: 'BOOL', defaultValue: 'FALSE', retain: false, accessibleFromHMI: true }]
    }
    const obClean = makeLad('Main', [
      {
        id: 'n1',
        networkNumber: 1,
        title: 'Timers and Global DB Q',
        nodes: [
          { id: 'c1', kind: 'contact', contactType: 'NO_CONTACT', operand: '"DB_TonInst".Q' },
          { id: 'c2', kind: 'contact', contactType: 'NO_CONTACT', operand: '"DB_Global".Q' },
          { id: 'q1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'OutBit' }
        ]
      }
    ])
    const resClean = ProjectCompilerEngine.runFullProjectCompilation(tags, [obClean], [], getDefaultCpuConfig(), [tonDb, globalDb], [])
    check(
      'Compiler does NOT emit false S7-TMR-004 for TONR Instance DB or Global DB .Q member',
      !resClean.diagnostics.some((d) => d.iecCode === 'S7-TMR-004'),
      resClean.diagnostics
    )

    const obBadBoxes = makeLad('BadBoxes', [
      {
        id: 'nb1',
        networkNumber: 1,
        title: 'Bad Cmp & Empty Box',
        nodes: [
          { id: 'cmp1', kind: 'comparator', comparatorType: 'CMP_GT', op1: 'UnknownVar', op2: '5', dataType: 'INT' },
          { id: 'eb1', kind: 'emptyBox', instruction: '???' }
        ]
      }
    ])
    const resBad = ProjectCompilerEngine.runFullProjectCompilation(tags, [obBadBoxes], [], getDefaultCpuConfig(), [], [])
    check(
      'Compiler flags unknown comparator operand and incomplete emptyBox',
      resBad.diagnostics.some((d) => d.iecCode === 'S7-LAD-011' && d.message.includes('UnknownVar')) &&
        resBad.diagnostics.some((d) => d.iecCode === 'S7-LAD-002' && d.message.includes('Incomplete box')),
      resBad.diagnostics
    )

    const stl = StlListingGenerator.forLadBlock(
      makeLad('TonrCtud', [
        {
          id: 'nt1',
          networkNumber: 1,
          title: 'TONR and CTUD',
          nodes: [
            { id: 'tm1', kind: 'timer', timerType: 'TONR', instanceDb: 'T_Ret', inOperand: '', rOperand: 'RstBit', ptOperand: 'T#2s', qOperand: '', etOperand: '' },
            { id: 'ct1', kind: 'counter', counterType: 'CTUD', instanceDb: 'C_Ud', cuCdOperand: '', rLdOperand: 'RstBit', ldOperand: 'InBit', pvOperand: '5', qOperand: '', quOperand: 'OutBit', qdOperand: '%Q0.1', cvOperand: '' }
          ]
        }
      ])
    )
    check(
      'STL generator includes R for TONR and LD/QU/QD for CTUD',
      stl.listingText.includes('R     := RstBit') &&
        stl.listingText.includes('LD    := InBit') &&
        stl.listingText.includes('QU    := OutBit') &&
        stl.listingText.includes('QD    := %Q0.1'),
      stl.listingText
    )
  }

  // 4. MemoryOverlapEngine, DoubleCoilDetector, CrossReferenceEngine, LadderDslCompiler
  {
    const idLessTags: TagTable[] = [
      {
        id: 'tbl1',
        name: 'T1',
        fileName: 'T1.tags.json',
        tags: [{ id: '', name: 'SigA', dataType: 'BOOL', address: '%I0.0' }]
      }
    ]
    MemoryOverlapEngine.buildBitMap(idLessTags, getDefaultCpuConfig())
    check('MemoryOverlapEngine.buildBitMap does not mutate input tag.id', idLessTags[0].tags[0].id === '')

    const occ = MemoryOverlapEngine.getMemoryOccupancy('I', 4, 0, idLessTags, getDefaultCpuConfig())
    check('HardwareIO + single paired Tag shows OCCUPIED, not COLLIDING', occ[0].bits[0].state === 'OCCUPIED', occ[0].bits[0])

    // DoubleCoil: parallel branches + symbol/%Q0.0 equivalence + parallel autoRefactor
    const dblTags: TagTable[] = [
      {
        id: 't1',
        name: 'T',
        fileName: 'T.tags.json',
        tags: [{ id: 'm1', name: 'Motor_Run', dataType: 'BOOL', address: '%Q0.0' }]
      }
    ]
    const dblBlock = makeLad('DblTest', [
      {
        id: 'n1',
        networkNumber: 1,
        title: 'N1',
        nodes: [
          { id: 'p1', kind: 'parallel', branches: [[{ id: 'q1', kind: 'coil', coilType: 'OUTPUT_COIL', operand: 'Motor_Run' }]] }
        ]
      },
      {
        id: 'n2',
        networkNumber: 2,
        title: 'N2',
        nodes: [{ id: 'q2', kind: 'coil', coilType: 'OUTPUT_COIL', operand: '%Q0.0' }]
      }
    ])
    const conflicts = DoubleCoilDetector.detectConflicts(dblBlock, dblTags)
    const refactored = DoubleCoilDetector.autoRefactorBlock(dblBlock, undefined, dblTags)
    check(
      'DoubleCoilDetector catches symbolic Motor_Run + %Q0.0 across parallel branch & refactors cleanly',
      conflicts.length === 1 && DoubleCoilDetector.detectConflicts(refactored, dblTags).length === 0,
      { conflicts, remaining: DoubleCoilDetector.detectConflicts(refactored, dblTags) }
    )

    // CrossReferenceEngine: AQ, LAD math/timer, SCL tokenized (ignores comments, captures %I0.0)
    const sclBlk: SclBlockDefinition = {
      blockType: 'OB',
      blockNumber: 1,
      name: 'Main',
      fileName: 'Main.scl',
      optimizedAccess: false,
      interface: emptyInterface(),
      code: `ORGANIZATION_BLOCK "Main"\nBEGIN\n  // SecretCommentTag := FALSE;\n  %Q0.0 := %I0.0;\n  "DB_Plant".Level := 10;\nEND_ORGANIZATION_BLOCK`
    }
    const ladBoxBlk = makeLad('BoxXref', [
      {
        id: 'nx',
        networkNumber: 1,
        title: 'Box refs',
        nodes: [
          { id: 'tx', kind: 'timer', timerType: 'TONR', instanceDb: 'T_Ref', inOperand: '', rOperand: 'RstSig', ptOperand: 'T#1s', qOperand: '', etOperand: '' },
          { id: 'mx', kind: 'math', boxType: 'MOVE', in1: 'SrcVal', out: 'DstVal' }
        ]
      }
    ], 'FB', 2)
    CrossReferenceEngine.rebuildIndex({
      cpuConfig: getDefaultCpuConfig(),
      tagTables: [],
      udts: [],
      dataBlocks: [],
      ladBlocks: [ladBoxBlk],
      sclBlocks: [sclBlk]
    })
    check(
      'CrossReference indexes LAD timer/math, SCL %I0.0/"DB_Plant".Level, ignores comments',
      CrossReferenceEngine.query('RstSig').totalCount >= 1 &&
        CrossReferenceEngine.query('SrcVal').totalCount >= 1 &&
        CrossReferenceEngine.query('DstVal').totalCount >= 1 &&
        CrossReferenceEngine.query('%I0.0').references.some((r) => r.accessType === 'Read') &&
        CrossReferenceEngine.query('DB_Plant').totalCount >= 1 &&
        CrossReferenceEngine.query('SecretCommentTag').totalCount === 0,
      {
        rst: CrossReferenceEngine.query('RstSig').totalCount,
        comment: CrossReferenceEngine.query('SecretCommentTag').totalCount
      }
    )

    // LadderDslCompiler: MOVE 2-arg roundtrip, TONR, CTD LD=, multi-byte reservation
    const dslInput = `TAG WordTag %MW10 WORD\nTAG BitTag %M10.3 BOOL\nNW 1 "Test": SERIES( NO(BitTag), TONR(T1, PT=T#5s, R=In1), MOVE(InVal, OutVal), CTD(C1, PV=4, LD=LoadIn), COIL(OutQ) )`
    const compiledDsl = LadderDslCompiler.compileLadderDslToAst(dslInput)
    const regenerated = LadderDslCompiler.generateLadderDslFromAst(compiledDsl.networks, compiledDsl.tags)
    const recompiled = LadderDslCompiler.compileLadderDslToAst(regenerated)
    check(
      'LadderDslCompiler reserves all %MW10 bits and roundtrips TONR, CTD LD=, and 2-arg MOVE',
      compiledDsl.success &&
        compiledDsl.addressMoves.some((m) => m.name === 'BitTag' && m.from === '%M10.3' && !m.to.startsWith('%M10.') && !m.to.startsWith('%M11.')) &&
        regenerated.includes('MOVE(InVal, OutVal)') &&
        regenerated.includes('TONR(T1, PT=T#5s, R=In1)') &&
        recompiled.success,
      { moves: compiledDsl.addressMoves, regenerated, errors: recompiled.errors }
    )
  }

  // 5. TIA Export / Import Fidelity
  {
    const tonrDb: DataBlockDefinition = {
      blockType: 'DB',
      blockNumber: 5,
      name: 'DB_Tonr',
      fileName: 'DB_Tonr.db.json',
      dbType: 'Instance',
      parentFbName: 'TONR',
      optimizedAccess: true,
      variables: []
    }
    const dbSrc = writeDataBlock(tonrDb)
    check(
      'writers.ts exports TONR type as TONR_TIME and TONR instance DB as IEC_TIMER',
      tiaTypeName('TONR') === 'TONR_TIME' && dbSrc.content.includes('IEC_TIMER'),
      dbSrc.content
    )

    const qRes = qualifySclBody(
      `Msg := 'it$'s OK'; Motor := TRUE;`,
      emptyInterface(),
      'OB1',
      { globals: new Set(['motor']) }
    )
    check('sclQualify preserves S7 $ string escape and qualifies trailing identifiers', qRes === `Msg := 'it$'s OK'; "Motor" := TRUE;`, qRes)

    // Bundle duplicate sanitized filename deduplication
    const proj = buildInitialProjectPayload({
      name: 'DupNames',
      targetPath: '/tmp/DupNames',
      cpuProfileId: 'cpu-1214c',
      defaultLanguage: 'SCL'
    })
    proj.sclBlocks = [
      { blockType: 'FC', blockNumber: 1, name: 'Motor A', fileName: 'MotorA.scl', optimizedAccess: true, interface: emptyInterface(), code: 'FUNCTION "Motor A" : Void\nBEGIN\nEND_FUNCTION\n' },
      { blockType: 'FC', blockNumber: 2, name: 'Motor-A', fileName: 'MotorDashA.scl', optimizedAccess: true, interface: emptyInterface(), code: 'FUNCTION "Motor-A" : Void\nBEGIN\nEND_FUNCTION\n' }
    ]
    const bundle = buildTiaBundle(proj)
    const sclSteps = bundle.manifest.steps.filter((s) => s.kind === 'fc')
    check('buildTiaBundle deduplicates colliding sanitized filenames', sclSteps[0].file !== sclSteps[1].file, sclSteps)

    // ladToScl CTD uses ldOperand and gates cdOperand with rlo
    const ctdLad = makeLad('CtdBlk', [
      {
        id: 'nc',
        networkNumber: 1,
        title: 'CTD',
        nodes: [
          { id: 'c_en', kind: 'contact', contactType: 'NO_CONTACT', operand: 'EnableBit' },
          { id: 'cnt', kind: 'counter', counterType: 'CTD', instanceDb: 'C_Dn', cuCdOperand: '', cdOperand: 'PulseBit', ldOperand: 'LoadBit', rLdOperand: 'WrongR', pvOperand: '3', qOperand: '', cvOperand: '' }
        ]
      }
    ])
    const transpiled = transpileLadToScl(ctdLad)
    check(
      'ladToScl CTD uses ldOperand (LoadBit) and gates cdOperand with RLO',
      transpiled.sclBlock.code.includes('CD := "EnableBit" AND "PulseBit"') &&
        transpiled.sclBlock.code.includes('LD := "LoadBit"'),
      transpiled.sclBlock.code
    )

    // readers: readTagTableXml extracts table Name (even when a tag appears or without picking tag Name) + nested DB start values
    const xmlWithNestedTag = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList><Name>MyTable</Name></AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1"><AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I0.0</LogicalAddress><Name>FirstTag</Name></AttributeList></SW.Tags.PlcTag>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>`
    const parsedTbl = readTagTableXml(xmlWithNestedTag, 'Fallback.xml')
    const importedNestedDb = readTiaFolder([
      {
        path: 'sources/DB10.db',
        content: `DATA_BLOCK "DB10"\nVERSION : 0.1\n   VAR\n      Cfg : Struct\n         Limit : Real;\n      END_STRUCT;\n   END_VAR\nBEGIN\n   Cfg.Limit := 5.0;\nEND_DATA_BLOCK\n`
      }
    ])
    check(
      'readers parses table Name from PlcTagTable AttributeList and nested DB Struct start values',
      parsedTbl?.name === 'MyTable' &&
        importedNestedDb.dataBlocks[0]?.variables[0]?.members?.[0]?.defaultValue === '5.0' &&
        importedNestedDb.warnings.length === 0,
      { tableName: parsedTbl?.name, db: importedNestedDb }
    )
  }

  console.log(`\nPhase 34 Summary: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()

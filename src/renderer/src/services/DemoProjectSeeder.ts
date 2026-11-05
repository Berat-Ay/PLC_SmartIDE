import { ProjectLoadPayload } from '@shared/types/ipc'
import { UdtDefinition } from '@shared/types/types'
import { S7OffsetCalculator } from './S7OffsetCalculator'
import {
  LadderContactNode,
  LadderCoilNode,
  LadderTimerNode,
  LadderMathNode,
  LadderNetwork
} from '@shared/types/ladder'
import { CPU_1214C_PROFILE } from '@shared/constants/cpuProfiles'

export class DemoProjectSeeder {
  public static createDemoProject(projectDir: string = 'C:/Projects/Virtual_S7_Plant'): ProjectLoadPayload {
    const udtPump: UdtDefinition = {
      id: 'udt_pump_01',
      name: 'UDT_Pump',
      fileName: 'UDT_Pump.udt.json',
      description: 'Standard industrial centrifugal pump data structure',
      members: [
        { id: 'm1', name: 'StartCmd', dataType: 'BOOL', defaultValue: 'FALSE', comment: 'Remote run command' },
        { id: 'm2', name: 'StopCmd', dataType: 'BOOL', defaultValue: 'FALSE', comment: 'Remote stop command' },
        { id: 'm3', name: 'Fault', dataType: 'BOOL', defaultValue: 'FALSE', comment: 'Overload / dry-run fault bit' },
        { id: 'm4', name: 'PressureBar', dataType: 'REAL', defaultValue: '0.0', comment: 'Discharge pressure in bar' },
        { id: 'm5', name: 'SpeedRaw', dataType: 'INT', defaultValue: '0', comment: 'VFD feedback speed (0..27648)' }
      ]
    }

    const udtMap = new Map([[udtPump.name, udtPump]])
    const calculatedMembers = S7OffsetCalculator.calculateVariableOffsets(
      udtPump.members.map((m) => ({
        id: m.id,
        name: m.name,
        dataType: m.dataType,
        defaultValue: m.defaultValue,
        retain: false,
        accessibleFromHMI: true,
        comment: m.comment
      })),
      udtMap
    )
    udtPump.members = udtPump.members.map((m, idx) => ({
      ...m,
      calculatedOffset: calculatedMembers[idx]?.calculatedOffset
    }))
    udtPump.calculatedSizeInBytes = S7OffsetCalculator.calculateUdtSize(udtPump, udtMap)

    const rawDbVariables = [
      { id: 'v1', name: 'Pump1', dataType: 'UDT_Pump', defaultValue: '', retain: true, accessibleFromHMI: true, comment: 'Primary feed pump' },
      { id: 'v2', name: 'Pump2', dataType: 'UDT_Pump', defaultValue: '', retain: true, accessibleFromHMI: true, comment: 'Standby booster pump' },
      { id: 'v3', name: 'SystemPressureBar', dataType: 'REAL', defaultValue: '4.5', retain: false, accessibleFromHMI: true, comment: 'Header pressure' },
      { id: 'v4', name: 'MasterMode', dataType: 'INT', defaultValue: '1', retain: true, accessibleFromHMI: true, comment: '1=Auto, 2=Manual, 3=Maintenance' },
      { id: 'v5', name: 'MaintenanceRequired', dataType: 'BOOL', defaultValue: 'FALSE', retain: false, accessibleFromHMI: true, comment: 'Service reminder' },
      { id: 'v6', name: 'GlobalAlarm', dataType: 'BOOL', defaultValue: 'FALSE', retain: false, accessibleFromHMI: true, comment: 'Active plant horn' }
    ]

    const calculatedDbVariables = S7OffsetCalculator.calculateVariableOffsets(rawDbVariables, udtMap)

    // Phase 2 Rich Ladder Networks for OB1_Main
    const ob1Networks: LadderNetwork[] = [
      {
        id: 'net_1',
        networkNumber: 1,
        title: 'Main Safety Circuit & Conveyor Interlock',
        comment: 'Enables main conveyor only when E-Stop is intact (%I0.0) and plant is ready (%M10.0)',
        nodes: [
          {
            id: 'node_estop',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: 'EmergencyStop'
          } as LadderContactNode,
          {
            id: 'node_ready',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: 'Plant_Ready'
          } as LadderContactNode,
          {
            id: 'node_coil_conveyor_1',
            kind: 'coil',
            coilType: 'OUTPUT_COIL',
            operand: 'MainConveyor_Run'
          } as LadderCoilNode
        ],
        elements: [
          { id: 'el_1', kind: 'contact', data: { type: 'NO', operand: 'EmergencyStop' } },
          { id: 'el_2', kind: 'contact', data: { type: 'NO', operand: 'Plant_Ready' } },
          { id: 'el_3', kind: 'coil', data: { type: 'COIL', operand: 'MainConveyor_Run' } }
        ]
      },
      {
        id: 'net_2',
        networkNumber: 2,
        title: 'Hydraulic Startup Delay (IEC TON Timer)',
        comment: 'Starts hydraulic booster pump after 5-second startup delay',
        nodes: [
          {
            id: 'node_pump_start',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: 'HydraulicPump_Start'
          } as LadderContactNode,
          {
            id: 'node_ton_pump',
            kind: 'timer',
            timerType: 'TON',
            instanceDb: 'DB2_TON_Pump',
            inOperand: 'HydraulicPump_Start',
            ptOperand: 'T#5s',
            qOperand: 'HydraulicPump_Run',
            etOperand: 'T#0ms',
            timePreset: 'T#5s',
            timeElapsed: 'T#0ms'
          } as LadderTimerNode,
          {
            id: 'node_coil_pump',
            kind: 'coil',
            coilType: 'OUTPUT_COIL',
            operand: 'HydraulicPump_Run'
          } as LadderCoilNode
        ],
        elements: [
          { id: 'el_4', kind: 'contact', data: { type: 'NO', operand: 'HydraulicPump_Start' } },
          { id: 'el_box_ton', kind: 'box', data: { boxType: 'TON', parameters: { PT: 'T#5s', DB: 'DB2_TON_Pump' } } },
          { id: 'el_5', kind: 'coil', data: { type: 'COIL', operand: 'HydraulicPump_Run' } }
        ]
      },
      {
        id: 'net_3',
        networkNumber: 3,
        title: 'Manual Jog Mode (Intentional Double Coil for Auto-Refactor Demo)',
        comment: 'Drives MainConveyor_Run via manual jog command, creating classic Double Coil conflict with Network 1',
        nodes: [
          {
            id: 'node_jog_cmd',
            kind: 'contact',
            contactType: 'NO_CONTACT',
            operand: 'Manual_Jog_Cmd'
          } as LadderContactNode,
          {
            id: 'node_coil_conveyor_2',
            kind: 'coil',
            coilType: 'OUTPUT_COIL',
            operand: 'MainConveyor_Run'
          } as LadderCoilNode
        ],
        elements: [
          { id: 'el_6', kind: 'contact', data: { type: 'NO', operand: 'Manual_Jog_Cmd' } },
          { id: 'el_7', kind: 'coil', data: { type: 'COIL', operand: 'MainConveyor_Run' } }
        ]
      },
      {
        id: 'net_4',
        networkNumber: 4,
        title: 'Analog Tank Level Normalization & Pressure Scaling',
        comment: 'Normalizes raw analog channel %IW64 (0..27648) and scales to 0.0..10.0 Bar',
        nodes: [
          {
            id: 'node_norm_x',
            kind: 'math',
            boxType: 'NORM_X',
            in1: 'TankLevel_Raw',
            in2: '27648',
            out: 'TankPressure_Bar',
            dataType: 'REAL'
          } as LadderMathNode,
          {
            id: 'node_scale_x',
            kind: 'math',
            boxType: 'SCALE_X',
            in1: 'TankPressure_Bar',
            in2: '10.0',
            out: 'TankPressure_Bar',
            dataType: 'REAL'
          } as LadderMathNode
        ],
        elements: [
          { id: 'el_box_norm', kind: 'box', data: { boxType: 'NORM_X', parameters: { IN: 'TankLevel_Raw', MAX: '27648' } } },
          { id: 'el_box_scale', kind: 'box', data: { boxType: 'SCALE_X', parameters: { MAX: '10.0', OUT: 'TankPressure_Bar' } } }
        ]
      }
    ]

    return {
      projectPath: projectDir,
      metadata: {
        id: 'proj_industrial_demo',
        name: 'Chemical_Plant_Unit01',
        targetCpu: 'Virtual S7-1200',
        firmwareVersion: 'V4.6',
        schemaVersion: '1.0.0',
        author: 'Antigravity Principal Architect',
        description: 'Multi-pump chemical dosing and pressurized header control system with S7-1200 runtime & memory guard',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projectPath: projectDir
      },
      hardware: {
        general: {
          cpuName: CPU_1214C_PROFILE.name,
          cycleWatchdogTimeMs: 150,
          minCycleTimeEnabled: true,
          minCycleTimeMs: 1,
          retentiveMemory: {
            startByte: 0,
            byteCount: 2048
          }
        },
        systemMemory: {
          enabled: true,
          byteAddress: 1 // MB1 -> FirstScan, DiagStatusUpdate, AlwaysTrue, AlwaysFalse
        },
        clockMemory: {
          enabled: true,
          byteAddress: 0 // MB0 -> 10Hz, 5Hz, 2.5Hz, 2.0Hz, 1.25Hz, 1.0Hz, 0.625Hz, 0.5Hz
        },
        digitalIO: {
          diStartByte: 0,
          dqStartByte: 0,
          diChannels: CPU_1214C_PROFILE.defaultDiChannels,
          dqChannels: CPU_1214C_PROFILE.defaultDqChannels
        },
        analogIO: {
          aiChannels: CPU_1214C_PROFILE.defaultAiChannels,
          aqChannels: CPU_1214C_PROFILE.defaultAqChannels
        },
        organizationBlocks: [
          {
            blockNumber: 1,
            name: 'Main [OB1]',
            type: 'Cyclic',
            enabled: true,
            priority: 1,
            description: 'Main continuous cyclic program execution loop'
          },
          {
            blockNumber: 100,
            name: 'Startup [OB100]',
            type: 'Startup',
            enabled: true,
            priority: 1,
            description: 'Executed once upon transition from STOP to RUN'
          },
          {
            blockNumber: 30,
            name: 'Cyclic_Interrupt_100ms [OB30]',
            type: 'CyclicInterrupt',
            enabled: true,
            cycleTimeMs: 100,
            phaseOffsetMs: 0,
            priority: 7,
            description: 'Deterministic 100ms cyclic interrupt for PID header control'
          },
          {
            blockNumber: 82,
            name: 'Diag_Error_Interrupt [OB82]',
            type: 'DiagnosticInterrupt',
            enabled: true,
            priority: 24,
            description: 'Hardware diagnostic interrupt triggered by wire-break or analog overflow'
          }
        ]
      },
      tagTables: [
        {
          id: 'table_default',
          name: 'default_tags',
          fileName: 'default_tags.tags.json',
          tags: [
            { id: 't1', name: 'EmergencyStop', dataType: 'BOOL', address: '%I0.0', comment: 'Main Safety E-Stop button (NC)' },
            { id: 't2', name: 'MainConveyor_Run', dataType: 'BOOL', address: '%Q0.0', comment: 'Conveyor contactor coil' },
            { id: 't3', name: 'HydraulicPump_Start', dataType: 'BOOL', address: '%I0.1', comment: 'Hydraulic pump local push button' },
            { id: 't4', name: 'HydraulicPump_Run', dataType: 'BOOL', address: '%Q0.1', comment: 'Hydraulic pump motor output' },
            { id: 't5', name: 'TankLevel_Raw', dataType: 'INT', address: '%IW64', comment: 'Analog tank level transmitter 4..20mA' },
            { id: 't6', name: 'TankPressure_Bar', dataType: 'REAL', address: '%MD20', comment: 'Scaled tank discharge pressure (0..10.0 Bar)' },
            { id: 't7', name: 'Plant_Ready', dataType: 'BOOL', address: '%M12.0', comment: 'Plant interlock permissive flag' },
            { id: 't8', name: 'Manual_Jog_Cmd', dataType: 'BOOL', address: '%M12.1', comment: 'Manual jog command' },
            // INTENTIONAL TUTORIAL OVERLAP: MW10 occupies MB10..MB11, colliding with M11.2
            { id: 't9', name: 'Motor_Speed', dataType: 'INT', address: '%MW10', comment: 'Motor speed setpoint in RPM - occupies MB10..MB11' },
            { id: 't10', name: 'Alarm_Silenced', dataType: 'BOOL', address: '%M11.2', comment: 'HMI buzzer silence acknowledged bit (Collides with MW10 at Byte 11 Bit 2)' },
            { id: 't11', name: 'Cycle_Counter', dataType: 'DINT', address: '%MD24', comment: 'Total production batch cycle count' }
          ]
        }
      ],
      udts: [udtPump],
      dataBlocks: [
        {
          blockType: 'DB',
          blockNumber: 1,
          name: 'DB1_PlantData',
          fileName: 'DB1_PlantData.db.json',
          dbType: 'Global',
          optimizedAccess: false, // Standard Access to showcase Byte.Bit offset calculation
          variables: calculatedDbVariables,
          comment: 'Global process storage for pumps, headers, and supervisory interlocks'
        }
      ],
      ladBlocks: [
        {
          blockType: 'OB',
          blockNumber: 1,
          name: 'OB1_Main',
          fileName: 'OB1_Main.lad.json',
          optimizedAccess: true,
          interface: {
            input: [],
            output: [],
            inOut: [],
            static: [],
            temp: [
              { id: 'v_temp_1', name: 'CycleTemp', dataType: 'INT', retain: false, accessibleFromHMI: false, comment: 'Temporary scan index' }
            ],
            constant: []
          },
          networks: ob1Networks,
          schemaVersion: '1.0.0'
        },
        {
          blockType: 'OB',
          blockNumber: 82,
          name: 'OB82_DiagFault',
          fileName: 'OB82_DiagFault.lad.json',
          optimizedAccess: true,
          interface: {
            input: [],
            output: [],
            inOut: [],
            static: [],
            temp: [
              { id: 'v_diag_info', name: 'FaultChannel', dataType: 'INT', retain: false, accessibleFromHMI: false, comment: 'Channel reported by CPU' }
            ],
            constant: []
          },
          networks: [
            {
              id: 'net_82_1',
              networkNumber: 1,
              title: 'Analog Wire-Break Latch & Alarm Silence',
              comment: 'Latches fault indication when diagnostic interrupt triggers',
              nodes: [
                {
                  id: 'node_first_scan',
                  kind: 'contact',
                  contactType: 'NO_CONTACT',
                  operand: 'FirstScan'
                } as LadderContactNode,
                {
                  id: 'node_alarm_silenced',
                  kind: 'coil',
                  coilType: 'OUTPUT_COIL',
                  operand: 'Alarm_Silenced'
                } as LadderCoilNode
              ],
              elements: [
                { id: 'el_82_1', kind: 'contact', data: { type: 'NO', operand: 'FirstScan' } },
                { id: 'el_82_2', kind: 'coil', data: { type: 'COIL', operand: 'Alarm_Silenced' } }
              ]
            }
          ],
          schemaVersion: '1.0.0'
        }
      ],
      sclBlocks: [
        {
          blockType: 'OB',
          blockNumber: 30,
          name: 'OB30_PID_Cycle',
          fileName: 'OB30_PID_Cycle.scl',
          optimizedAccess: true,
          interface: {
            input: [],
            output: [],
            inOut: [],
            static: [],
            temp: [
              { id: 'scl_err', name: 'PressureError', dataType: 'REAL', retain: false, accessibleFromHMI: false, comment: 'Setpoint minus feedback' },
              { id: 'scl_out', name: 'PidOutput', dataType: 'REAL', retain: false, accessibleFromHMI: false, comment: 'Computed valve command' }
            ],
            constant: [
              { id: 'scl_kp', name: 'PROP_GAIN', dataType: 'REAL', defaultValue: '2.4', retain: false, accessibleFromHMI: false, comment: 'PID Proportional gain' }
            ]
          },
          code: `// ============================================================
// Block: OB30_PID_Cycle (Cyclic Interrupt 100ms)
// Description: Deterministic PID loop for Dosing Header Pressure
// ============================================================

ORGANIZATION_BLOCK "OB30_PID_Cycle"
TITLE = "Header Pressure Control"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1

VAR_TEMP
  PressureError : REAL;
  PidOutput : REAL;
END_VAR

VAR CONSTANT
  PROP_GAIN : REAL := 2.4;
END_VAR

BEGIN
  // Compute Pressure Error from Setpoint and Feedback
  #PressureError := 4.5 - "DB1_PlantData"."SystemPressureBar";
  #PidOutput := #PressureError * #PROP_GAIN;

  // Limit output command
  IF #PidOutput > 10.0 THEN
      #PidOutput := 10.0;
  ELSIF #PidOutput < 0.0 THEN
      #PidOutput := 0.0;
  END_IF;

  // Write to VFD Analog speed channel
  "TankPressure_Bar" := #PidOutput;
END_ORGANIZATION_BLOCK
`
        },
        {
          blockType: 'FB',
          blockNumber: 1,
          name: 'FB1_PumpControl',
          fileName: 'FB1_PumpControl.scl',
          optimizedAccess: true,
          interface: {
            input: [
              { id: 'fb_in1', name: 'AutoStart', dataType: 'BOOL', retain: false, accessibleFromHMI: true, comment: 'Automatic start request' },
              { id: 'fb_in2', name: 'AutoStop', dataType: 'BOOL', retain: false, accessibleFromHMI: true, comment: 'Automatic stop request' },
              { id: 'fb_in3', name: 'InterlockOk', dataType: 'BOOL', retain: false, accessibleFromHMI: true, comment: 'Upstream permissive ok' }
            ],
            output: [
              { id: 'fb_out1', name: 'RunCmd', dataType: 'BOOL', retain: false, accessibleFromHMI: true, comment: 'Physical motor output command' },
              { id: 'fb_out2', name: 'FaultActive', dataType: 'BOOL', retain: false, accessibleFromHMI: true, comment: 'Tripped alarm status' }
            ],
            inOut: [],
            static: [
              { id: 'fb_stat1', name: 'RunState', dataType: 'BOOL', retain: true, accessibleFromHMI: true, comment: 'Latched motor running state' },
              { id: 'fb_stat2', name: 'OperatingHours', dataType: 'DINT', retain: true, accessibleFromHMI: true, comment: 'Cumulative run seconds' }
            ],
            temp: [],
            constant: []
          },
          code: `// ============================================================
// Block: FB1_PumpControl
// Description: Reusable standard pump control function block
// ============================================================

FUNCTION_BLOCK "FB1_PumpControl"
TITLE = "Centrifugal Pump Sequencer"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1

VAR_INPUT
  AutoStart : BOOL;
  AutoStop : BOOL;
  InterlockOk : BOOL;
END_VAR

VAR_OUTPUT
  RunCmd : BOOL;
  FaultActive : BOOL;
END_VAR

VAR
  RunState : BOOL;
  OperatingHours : DINT;
END_VAR

BEGIN
  // Interlock verification
  IF NOT InterlockOk THEN
    RunState := FALSE;
    FaultActive := TRUE;
  ELSIF AutoStart AND NOT AutoStop THEN
    RunState := TRUE;
    FaultActive := FALSE;
  ELSIF AutoStop THEN
    RunState := FALSE;
  END_IF;

  RunCmd := RunState;
END_FUNCTION_BLOCK
`
        }
      ]
    }
  }
}

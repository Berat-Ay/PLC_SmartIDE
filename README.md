# Rungline

A modern, AI-assisted PLC IDE for Siemens S7-1200/S7-1500. It is a standalone application that opens separately from TIA Portal, not a plugin for it. You develop and simulate without TIA, and move the program to TIA when it is ready. Built with Electron, React and TypeScript. It includes a virtual S7 PLC. It does not connect to real hardware.

## Running

```
npm install
npm run dev
```

Example projects are in `examples/`. Open them from the app as a folder.

## Checks

```
npm run typecheck
npm test
npm run build
npm run test:gui    # Walks through the Electron UI with Playwright
npm run test:layout # Measures every screen at four window sizes for overflow and overlap
```

## TIA Portal

```
npm run tia:package -- examples/tia_smoke
```

This prepares a `tia-package` folder to take to a computer with TIA installed. The steps are in [tools/tia-bridge/README.md](tools/tia-bridge/README.md).

**Status: export and import have not been tried with real TIA Portal yet.** The file formats were written from documentation and general knowledge. The bridge has only run against a fake library that imitates TIA.

| Item | Export | Import |
|---|---|---|
| SCL blocks (OB, FB, FC) | Yes | Yes |
| Data blocks, UDTs | Yes | Yes. Nested start values are not imported, with a warning |
| Tag tables | SimaticML and CSV | SimaticML |
| LAD blocks | No, skipped with a warning | No, skipped with a warning |

## AI agent

Enter a Gemini key in the settings. The key is kept in the operating system's encrypted store.

The agent sees the current state of the project. It creates FBs, FCs, UDTs, global DBs and tags, adds ladder to OB1, and can read blocks. Each reply is applied as a whole, compiled and run on the simulator. With each ladder circuit the model sends a timeline: which input changes when, and what each output should be. If a new error appears or the circuit does not follow its timeline, the reply is undone, the error and what the program really did go back to the model, and it tries again, up to 6 requests. If that does not solve it, the project stays unchanged and the error is shown.

The agent can read 19 ready-made circuit patterns (seal-in, star-delta, timer chain, counters, step sequence...). The patterns were written for this project, and `npm test` runs each one on the simulator. They were not taken from a textbook or a standard, and they have not been tried on a real CPU.

It cannot change hardware settings or simulation scripts, and it cannot delete tags.

## Known limitations

Behaviour that differs from a real CPU or has not been verified:

**Simulator**

- Interrupt OBs do not interrupt the scan, they run between scans. Phase shift is ignored
- Only OB1 runs as a program cycle OB, OB123 and above do not run
- INT overflow wraps only when written to memory, not in intermediate results
- LAD power flow state is shared between instances of the same FB
- DATE and TOD constants are not supported
- Symbols that TIA adds by itself when system memory is on, such as `FirstScan`, do not exist. Use the address: `%M1.0`
- Rounding in an implicit assignment from REAL to an integer is an assumption
- CPU memory sizes and the watchdog STOP rule have not been compared with Siemens documentation

**Export to TIA**

- A source file cannot state an OB's type. Check the type of interrupt OBs such as OB30 in TIA
- Whether block numbers carry over has not been verified. If they do not, TIA assigns its own

**IDE**

- The files of deleted blocks, UDTs and tag tables move to the project's `.trash` folder. To restore one, move the file back by hand
- When the interface table rewrites a source, comments between declaration sections are lost

**AI agent**

- It does not work without an API key or an Ollama server. There are no built-in canned replies
- Gemini sends tags, block names and the source of the blocks it reads to Google. Read Google's terms before using it on a confidential project
- Only the Gemini path uses the tool loop. OpenAI and Ollama only add ladder to OB1, without the compiler check or the simulation test
- Ladder is written only to OB1. The agent can produce an FB or FC, but it cannot call it from ladder and cannot add a new OB
- Passing the simulation test does not prove that the circuit does what you asked. The model writes the test too, and the test can be incomplete. Check the timeline and the program yourself
- The simulation test runs only OB1 and the startup OBs, not cyclic interrupt OBs (OB30..OB38). When a reply also creates an FB or FC through tool calls, only the ladder circuit is tested
- If the model sends no test it is asked once. If it still sends none, the circuit is accepted with a "not verified" note
- In Diff-View the simulation test runs before approval, but it cannot run if the reply also has tool calls that create blocks or tags, and the reply says so. The compiler check runs after approval, and an error does not undo the change. Use Undo Turn for that
- Undo Turn does not delete new files the agent wrote to disk. Those blocks come back when the project is reopened

## Licence

[MIT](LICENSE)

Most of the code was written with AI tools (Claude). This is visible in the commit history through the `Co-Authored-By` lines.

## Feedback

If you have suggestions or find a bug, I would be very happy to hear about it in [Issues](https://github.com/Berat-Ay/PLC_SmartIDE/issues).

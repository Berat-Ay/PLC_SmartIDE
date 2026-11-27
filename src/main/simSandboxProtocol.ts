// Serves the isolated .sim.js execution sandbox on an opaque-origin custom protocol.
// Inside the sandboxed iframe (sandbox="allow-scripts" without allow-same-origin), simulation scripts
// run inside an internal Blob Web Worker with a 50 ms per-tick watchdog and connect-src 'none'.
import { protocol } from 'electron'

export function registerSimSandboxScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'rungline-sim',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false
      }
    }
  ])
}

const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

const SANDBOX_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body><script src="./runner.js"></script></body>
</html>`

const SANDBOX_RUNNER_JS = `
(function () {
  var worker = null;
  var workerUrl = null;
  var activeTimer = null;
  var currentStepId = null;

  function reply(msg) {
    window.parent.postMessage(msg, '*');
  }

  function disposeWorker() {
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    if (worker) {
      try { worker.terminate(); } catch (e) {}
      worker = null;
    }
    if (workerUrl) {
      try { URL.revokeObjectURL(workerUrl); } catch (e) {}
      workerUrl = null;
    }
  }

  function createWorkerWithBody(body) {
    disposeWorker();
    var workerSource = [
      "'use strict';",
      'var runnerFn = null;',
      'try {',
      '  runnerFn = new Function("physics", "runtime", "dt", ' + JSON.stringify(body) + ');',
      '  self.postMessage({ type: "compiled", ok: true });',
      '} catch (err) {',
      '  self.postMessage({ type: "compiled", ok: false, error: err && err.message ? err.message : String(err) });',
      '}',
      'self.onmessage = function (ev) {',
      '  var data = ev.data || {};',
      '  if (data.type !== "step") return;',
      '  if (!runnerFn) { self.postMessage({ type: "stepResult", id: data.id, ok: false, error: "Not compiled" }); return; }',
      '  var physics = Object.assign({}, data.physics);',
      '  var vars = data.vars || {};',
      '  var bitWrites = [];',
      '  var varWrites = [];',
      '  var runtimeProxy = {',
      '    getVariable: function (name) { return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined; },',
      '    setBit: function (area, byte, bit, value) { bitWrites.push({ area: String(area), byte: Number(byte), bit: Number(bit), value: Boolean(value) }); },',
      '    setVariable: function (name, value) { varWrites.push({ name: String(name), value: value }); }',
      '  };',
      '  try {',
      '    runnerFn(physics, runtimeProxy, Number(data.dt) || 0.01);',
      '    self.postMessage({',
      '      type: "stepResult",',
      '      id: data.id,',
      '      ok: true,',
      '      physicsPatch: {',
      '        tankLevelRaw: Number(physics.tankLevelRaw),',
      '        reactorTempRaw: Number(physics.reactorTempRaw),',
      '        conveyorPosition: Number(physics.conveyorPosition)',
      '      },',
      '      bitWrites: bitWrites,',
      '      varWrites: varWrites',
      '    });',
      '  } catch (err) {',
      '    self.postMessage({ type: "stepResult", id: data.id, ok: false, error: err && err.message ? err.message : String(err) });',
      '  }',
      '};'
    ].join('\\n');

    var blob = new Blob([workerSource], { type: 'text/javascript' });
    workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl);
    return worker;
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'compile') {
      var compileId = msg.id;
      try {
        var w = createWorkerWithBody(String(msg.body || ''));
        var compileDone = false;
        var compileTimeout = setTimeout(function () {
          if (compileDone) return;
          compileDone = true;
          disposeWorker();
          reply({ type: 'compileResult', id: compileId, ok: false, error: 'Script compilation timed out' });
        }, 1000);
        w.onmessage = function (ev) {
          var d = ev.data || {};
          if (d.type === 'compiled' && !compileDone) {
            compileDone = true;
            clearTimeout(compileTimeout);
            if (!d.ok) disposeWorker();
            reply({ type: 'compileResult', id: compileId, ok: Boolean(d.ok), error: d.error });
          } else if (d.type === 'stepResult') {
            if (d.id !== currentStepId) return;
            if (activeTimer !== null) {
              clearTimeout(activeTimer);
              activeTimer = null;
            }
            currentStepId = null;
            reply(d);
          }
        };
        w.onerror = function (err) {
          if (!compileDone) {
            compileDone = true;
            clearTimeout(compileTimeout);
            disposeWorker();
            reply({ type: 'compileResult', id: compileId, ok: false, error: err && err.message ? err.message : 'Worker syntax error' });
          } else if (currentStepId !== null) {
            var sid = currentStepId;
            currentStepId = null;
            disposeWorker();
            reply({ type: 'stepResult', id: sid, ok: false, error: err && err.message ? err.message : 'Worker runtime error' });
          }
        };
      } catch (err) {
        disposeWorker();
        reply({ type: 'compileResult', id: compileId, ok: false, error: err && err.message ? err.message : String(err) });
      }
      return;
    }

    if (msg.type === 'step') {
      if (!worker) {
        reply({ type: 'stepResult', id: msg.id, ok: false, error: 'No compiled simulation worker' });
        return;
      }
      if (activeTimer !== null) {
        clearTimeout(activeTimer);
      }
      currentStepId = msg.id;
      activeTimer = setTimeout(function () {
        var timedOutId = currentStepId;
        currentStepId = null;
        disposeWorker();
        reply({
          type: 'stepResult',
          id: timedOutId,
          ok: false,
          error: 'Simulation script exceeded 50ms step timeout (possible infinite loop)'
        });
      }, 50);
      worker.postMessage({ type: 'step', id: msg.id, physics: msg.physics, vars: msg.vars, dt: msg.dt });
    }
  });

  reply({ type: 'ready' });
})();
`

export function installSimSandboxProtocol(): void {
  protocol.handle('rungline-sim', (request) => {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }

    if (parsed.hostname !== 'sandbox') {
      return new Response('Not Found', { status: 404 })
    }

    if (parsed.pathname === '/index.html' || parsed.pathname === '/') {
      return new Response(SANDBOX_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': SANDBOX_CSP
        }
      })
    }

    if (parsed.pathname === '/runner.js') {
      return new Response(SANDBOX_RUNNER_JS, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Security-Policy': SANDBOX_CSP
        }
      })
    }

    return new Response('Not Found', { status: 404 })
  })
}

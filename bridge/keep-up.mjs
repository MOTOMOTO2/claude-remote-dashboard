// What the Windows task runs: the bridge, started again whenever it stops.
//
// Task Scheduler's "restart on failure" only covers a task that fails to
// *start*. A bridge that starts and later exits — the network was not up yet
// at boot, Supabase answered a sign-in with a 503, a bug — would stay down
// until the next reboot. So the task runs this, and this runs the bridge.
//
// It is also where the bridge's output goes. The task runs with no window,
// so everything bridge.mjs prints is written to bridge/bridge.log instead,
// and the previous megabyte is kept as bridge.log.1.
//
//   node bridge/keep-up.mjs            the bridge, for ever
//   node bridge/keep-up.mjs --once     anything after it is passed through
//
// BRIDGE_LOG moves the log, and BRIDGE_RETRY_MS sets the first wait.

import { spawn } from 'node:child_process';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LOG = process.env.BRIDGE_LOG || join(here, 'bridge.log');
const LOG_MAX = 1_000_000;
const FIRST_WAIT = Number(process.env.BRIDGE_RETRY_MS || 5_000);
const LONGEST_WAIT = 5 * 60_000;
const STEADY = 10 * 60_000;   // a run this long resets the wait

function write(text) {
  try {
    if (statSync(LOG).size > LOG_MAX) renameSync(LOG, `${LOG}.1`);
  } catch { /* no log yet */ }
  try { appendFileSync(LOG, text); } catch { /* nowhere to say it */ }
}

const note = (msg) => write(`\n── ${new Date().toISOString()} ${msg}\n`);

// The task may not hand its process the PATH a terminal would, and
// ASSISTANT_CMD usually starts with a bare `node`.
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
};

let wait = FIRST_WAIT;
for (;;) {
  const started = Date.now();
  // On Windows, Node puts what it spawns in a job that dies with it, so
  // stopping the task stops the bridge too — test/bridge.mjs checks that.
  const child = spawn(process.execPath, [join(here, 'bridge.mjs'), ...process.argv.slice(2)], {
    cwd: dirname(here),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  note(`started the bridge (pid ${child.pid})`);
  child.stdout.on('data', (d) => write(String(d)));
  child.stderr.on('data', (d) => write(String(d)));

  const code = await new Promise((r) => child.on('close', (c, signal) => r(c ?? signal)));
  if (Date.now() - started > STEADY) wait = FIRST_WAIT;
  note(`the bridge stopped (exit ${code}); starting again in ${Math.round(wait / 1000)}s`);
  await new Promise((r) => setTimeout(r, wait));
  wait = Math.min(wait * 2, LONGEST_WAIT);
}

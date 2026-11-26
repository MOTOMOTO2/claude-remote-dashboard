// Running Claude Code headless and reading what it says as it works.
//
// `claude -p --output-format stream-json` prints one JSON object per line:
// a `system/init` with the session id, `assistant` messages carrying text
// and tool calls, `rate_limit_event`s about the subscription, optional
// `stream_event`s with every token, and a final `result`. This turns that
// into callbacks and one summary at the end, and nothing else — what to do
// with each line is the runner's business.
//
// The prompt goes in on stdin and the extra system prompt in a file, so
// neither is bounded by the operating system's argument length.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export const NO_ATTRIBUTION = { includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } };

/** The flags for one run. Exported so the tests can check them. */
export function claudeArgs({ resume, model, effort, systemFile, partial = false } = {}) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    // Unattended: nobody is there to approve anything. The sandbox it runs
    // in is the boundary, which is what this mode is documented for.
    '--permission-mode', 'bypassPermissions',
    '--permission-prompts', 'none',
    // The work is committed as the account owner: no "Co-Authored-By" trailer
    // and no "Generated with" line. includeCoAuthoredBy is the older name of
    // the setting, attribution the newer one; each version reads its own.
    '--settings', JSON.stringify(NO_ATTRIBUTION),
  ];
  if (partial) args.push('--include-partial-messages');
  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  if (effort && EFFORTS.has(effort)) args.push('--effort', effort);
  if (systemFile) args.push('--append-system-prompt-file', systemFile);
  return args;
}

/**
 * Start one run. Returns `{ done, stop }`: `done` resolves with what came of
 * it, `stop()` ends the turn the way a person pressing Esc would (SIGINT),
 * and kills it if it does not listen.
 *
 * `bin` is `claude`, or a .mjs file to run with this Node (the tests' stand-in).
 */
export function runClaude({
  bin = 'claude', prompt = '', cwd, env = process.env, system = '',
  resume, model, effort, partial = false, onMessage = () => {},
}) {
  const scratch = mkdtempSync(join(tmpdir(), 'claude-run-'));
  let systemFile;
  if (system) {
    systemFile = join(scratch, 'system.md');
    writeFileSync(systemFile, system);
  }
  const args = claudeArgs({ resume, model, effort, systemFile, partial });
  const script = /\.(c|m)?js$/.test(bin);
  const child = spawn(script ? process.execPath : bin, script ? [bin, ...args] : args, {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });

  const out = {
    sessionId: resume ?? null,
    result: null,
    model: null,
    code: null,
    signal: null,
    stderr: '',
    texts: [],
  };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.session_id) out.sessionId = msg.session_id;
      if (msg.type === 'system' && msg.subtype === 'init') out.model = msg.model ?? null;
      if (msg.type === 'result') out.result = msg;
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) out.texts.push(block.text);
        }
      }
      try { onMessage(msg); } catch { /* a bad listener must not end the run */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { out.stderr = (out.stderr + d).slice(-4000); });

  child.stdin.on('error', () => {});
  child.stdin.end(String(prompt));

  const done = new Promise((resolve) => {
    child.on('error', (e) => {
      out.stderr += `\n${e.message}`;
      out.code = -1;
    });
    child.on('close', (code, signal) => {
      out.code = code;
      out.signal = signal;
      rmSync(scratch, { recursive: true, force: true });
      resolve(out);
    });
  });

  let stopping = false;
  const stop = () => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
    child.kill('SIGINT');
    setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), 15_000).unref();
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 30_000).unref();
  };

  return { done, stop, child };
}

/** The reason a run failed, in one line someone can act on. */
export function failure(out) {
  const r = out.result;
  if (r?.is_error) {
    const said = typeof r.result === 'string' && r.result.trim() ? r.result.trim() : '';
    const errs = Array.isArray(r.errors) ? r.errors.filter(Boolean).join('; ') : '';
    return said || errs || `Claude Code stopped: ${r.subtype}`;
  }
  if (!r) {
    const tail = out.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' · ');
    return tail || `Claude Code exited (${out.code ?? out.signal}) without a result`;
  }
  return '';
}

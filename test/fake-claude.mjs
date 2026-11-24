// A stand-in for `claude -p --output-format stream-json`, for test/host.mjs.
//
// It records how it was called (arguments, stdin, working directory) to
// FAKE_CLAUDE_LOG, then behaves according to FAKE_MODE:
//
//   work   edit a file, write CLAUDE.md, commit, report success
//   hang   start, then wait to be interrupted (a stop from the dashboard)
//   limit  get refused by the subscription's usage limit
//   lost   fail to resume a session it does not have (then work, if fresh)
//   chat   stream an answer token by token, with a tool call in the middle

import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const resume = at('--resume');
const session = resume ?? `sess-${process.pid}`;
const mode = process.env.FAKE_MODE ?? 'work';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({
    args, stdin, cwd: process.cwd(), mode,
    hasSupabase: Boolean(process.env.SUPABASE_SERVICE_KEY),
    hasGhToken: Boolean(process.env.GH_TOKEN),
    hasGitAuth: Boolean(process.env.GIT_CONFIG_VALUE_0),
    owner: process.env.OWNER_ID ?? null,
  })}\n`);
}

const say = (o) => process.stdout.write(`${JSON.stringify({ session_id: session, ...o })}\n`);
const result = (o) => say({
  type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.12, ...o,
});

say({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: [] });

if (mode === 'lost' && resume) {
  result({ subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}` });
  process.exit(1);
}

if (mode === 'work' || mode === 'lost') {
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 7200 } });
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Looking at the project.' }] } });
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(process.cwd(), 'feature.txt') } }] } });
  say({ type: 'assistant', parent_tool_use_id: 'tool-1', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  writeFileSync('feature.txt', `${stdin.split('\n').at(-1)}\n`);
  writeFileSync('CLAUDE.md', '# Notes\n\nRemembered.\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', 'work']);
  // Something left uncommitted, for the runner to sweep up.
  writeFileSync('leftover.txt', 'left\n');
  result({ result: 'Added the feature. Run `npm start` to see it.' });
  process.exit(0);
}

if (mode === 'hang') {
  process.on('SIGINT', () => {
    result({ subtype: 'error_during_execution', is_error: true, result: 'Interrupted' });
    process.exit(130);
  });
  say({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 999' } }] } });
  setInterval(() => {}, 1000);
}

if (mode === 'limit') {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  say({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt } });
  result({ subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${resetsAt}` });
  process.exit(1);
}

if (mode === 'chat') {
  const delta = (text) => say({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  say({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } });
  delta('Let me check');
  delta(' your dashboard.');
  say({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } });
  say({ type: 'stream_event', parent_tool_use_id: 'sub', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SUBAGENT NOISE' } } });
  say({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } });
  delta(resume ? 'Still here.' : 'All quiet.');
  result({ result: resume ? 'Still here.' : 'All quiet.' });
  process.exit(0);
}

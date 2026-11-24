// Vercel Sandbox, as the three things dispatch needs: start a job, start the
// Ask tab, and say whether a sandbox is still up.
//
// Each project has one persistent, named sandbox. Stopping it snapshots its
// disk (the clone, node_modules, Claude's saved sessions), and the next job
// on that project resumes from there, so nothing is cloned or installed
// twice and a follow-up can carry on the same Claude session.
//
// Inside, the runner is this repository at the commit that is deployed: the
// sandbox fetches it, then runs host/runner.mjs detached, so the function
// that started it can return straight away. The secrets go to that one
// command, not into the sandbox's saved configuration.

import { gitAuthEnv } from './git.mjs';
import { ASK_SANDBOX, sandboxName } from './dispatch.mjs';

/** Fetch the runner at the deployed commit and hand over to it. */
export const BOOT = [
  'set -e',
  ': "${HOME:=$(pwd)}"',
  'export HOME',
  'app="$HOME/.runner/app"',
  'mkdir -p "$HOME/.runner"',
  'if [ ! -d "$app/.git" ]; then git clone --quiet --filter=blob:none "$RUNNER_REPO" "$app"; fi',
  'cd "$app"',
  'git fetch --quiet --depth=1 origin "$RUNNER_REF"',
  'git checkout --quiet --force FETCH_HEAD',
  'echo "--- $(date -u +%FT%TZ) $*" >> "$HOME/.runner/runner.log"',
  'exec node host/runner.mjs "$@" >> "$HOME/.runner/runner.log" 2>&1',
].join('\n');

/** Only what the runner reads, from the function's own environment. */
export function runnerEnv(env, extra = {}) {
  const keep = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OWNER_ID', 'OWNER_NAME',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_OWNER',
    'RUNNER_SECRET', 'JOB_MODEL', 'CHAT_MODEL', 'SESSION_DAYS', 'CHAT_LINGER_MIN',
    'ASSISTANT_NAME', 'HOST_NAME',
  ];
  const out = {};
  for (const k of keep) if (env[k]) out[k] = String(env[k]);
  return {
    ...out,
    ...gitAuthEnv(env.GH_TOKEN),
    GIT_TERMINAL_PROMPT: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  };
}

/** Where the runner's code comes from: this repo, at the deployed commit. */
export function runnerSource(env) {
  const repo = env.RUNNER_REPO
    || (env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG
      ? `https://github.com/${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}.git`
      : '');
  return { repo, ref: env.RUNNER_REF || env.VERCEL_GIT_COMMIT_SHA || 'main' };
}

/**
 * @param Sandbox  the @vercel/sandbox class (a stand-in in the tests)
 * @param env      the function's environment
 * @param callback the URL the runner rings when it finishes
 */
export function makeSandboxes({ Sandbox, env = process.env, callback = '' }) {
  const minutes = Number(env.SANDBOX_MINUTES || 45);
  const timeout = minutes * 60_000;
  const vcpus = Number(env.SANDBOX_VCPUS || 2);
  const { repo, ref } = runnerSource(env);

  async function start(name, args) {
    if (!repo) throw new Error('RUNNER_REPO is not set and this deployment is not from GitHub.');
    const sandbox = await Sandbox.getOrCreate({
      name,
      resume: true,
      persistent: true,
      timeout,
      resources: { vcpus },
      keepLastSnapshots: { count: 1 },
      tags: { app: 'claude-remote' },
    });
    const deadline = sandbox.expiresAt ? new Date(sandbox.expiresAt).getTime() : Date.now() + timeout;
    await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', BOOT, 'boot', ...args],
      env: runnerEnv(env, {
        RUNNER_REPO: repo,
        RUNNER_REF: ref,
        RUNNER_CALLBACK: callback,
        SANDBOX_NAME: name,
        DEADLINE: String(deadline),
      }),
      detached: true,
    });
    return { name, deadline };
  }

  return {
    startJob: ({ slug, jobId, continuing }) =>
      start(sandboxName(slug), ['--job', String(jobId), ...(continuing ? ['--continue'] : [])]),
    startChat: () => start(ASK_SANDBOX, ['--chat']),

    async status(name) {
      try {
        const sandbox = await Sandbox.get({ name });
        return sandbox.status ?? 'unknown';
      } catch (e) {
        return /not.?found|404/i.test(String(e?.message ?? e)) ? 'missing' : 'unknown';
      }
    },

    async stop(name) {
      const sandbox = await Sandbox.get({ name });
      if (sandbox.status === 'stopped' || sandbox.status === 'stopping') return sandbox.status;
      await sandbox.stop();
      return 'stopped';
    },
  };
}

// The repository side of a job: get the project's code, and put the work
// back on GitHub afterwards.
//
// The GitHub token never touches the disk. Git is handed it per command as
// an extra HTTP header through GIT_CONFIG_* variables, the way
// actions/checkout does it, so no remote URL or config file holds it.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Environment that lets git talk to GitHub as you, for this one process. */
export function gitAuthEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Environment that makes git author and commit as `identity`; nothing without one. */
export function gitIdentityEnv(identity) {
  if (!identity?.name || !identity?.email) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/**
 * Who the work is committed as: GIT_NAME / GIT_EMAIL when set, otherwise the
 * GitHub account behind the token, with its private noreply address. That
 * address links each commit to the profile without publishing an email.
 */
export function identityFor(user, env = process.env) {
  const name = String(env.GIT_NAME || user?.name || user?.login || '').trim();
  const email = String(
    env.GIT_EMAIL || (user?.id && user?.login ? `${user.id}+${user.login}@users.noreply.github.com` : ''),
  ).trim();
  return name && email ? { name, email } : null;
}

/** `identity` may be a function, so it can be filled in after the runner asks GitHub. */
export function makeGit({ token = '', env = process.env, identity = null } = {}) {
  const base = () => ({
    ...env,
    ...gitAuthEnv(token),
    ...gitIdentityEnv(typeof identity === 'function' ? identity() : identity),
    GIT_TERMINAL_PROMPT: '0',
  });

  const run = (args, cwd) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: base(), maxBuffer: 20e6 }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message).trim().split('\n').slice(-3).join(' · ');
        reject(new Error(`git ${args[0]}: ${why}`));
      } else resolve(String(stdout).trim());
    });
  });

  const ok = (args, cwd) => run(args, cwd).then(() => true, () => false);

  return {
    run,

    /** Clone it, or bring an existing clone up to date if nothing is in the way. */
    async prepare(dir, url) {
      if (!existsSync(join(dir, '.git'))) {
        mkdirSync(dirname(dir), { recursive: true });
        await run(['clone', '--quiet', url, dir]);
        return 'cloned';
      }
      const dirty = await run(['status', '--porcelain'], dir);
      if (dirty) return 'kept local changes from the last run';
      if (!(await ok(['remote', 'get-url', 'origin'], dir))) return 'no remote';
      try {
        await run(['pull', '--quiet', '--ff-only'], dir);
        return 'pulled';
      } catch (e) {
        return `could not fast-forward (${e.message})`;
      }
    },

    async init(dir) {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, '.git'))) await run(['init', '--quiet', '-b', 'main'], dir);
    },

    /** Anything Claude left uncommitted, committed, so a push carries it. */
    async commitLeftovers(dir, message) {
      await run(['add', '-A'], dir);
      if (await ok(['diff', '--cached', '--quiet'], dir)) return false;
      await run(['commit', '--quiet', '-m', message], dir);
      return true;
    },

    hasRemote: (dir) => ok(['remote', 'get-url', 'origin'], dir),

    async hasCommits(dir) {
      return ok(['rev-parse', '--verify', 'HEAD'], dir);
    },

    /** Push the current branch; if the remote moved on, rebase onto it once. */
    async push(dir) {
      const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
      try {
        await run(['push', '--quiet', '-u', 'origin', branch], dir);
      } catch {
        await run(['pull', '--quiet', '--rebase', 'origin', branch], dir);
        await run(['push', '--quiet', '-u', 'origin', branch], dir);
      }
      return branch;
    },

    async addRemote(dir, url) {
      if (await ok(['remote', 'get-url', 'origin'], dir)) {
        await run(['remote', 'set-url', 'origin', url], dir);
      } else {
        await run(['remote', 'add', 'origin', url], dir);
      }
    },
  };
}

// ── GitHub ────────────────────────────────────────────────────────────

export function makeGitHub({ token = '', api = 'https://api.github.com', fetchImpl = fetch } = {}) {
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'claude-remote-runner',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, data };
  };

  return {
    async user() {
      const r = await call('/user');
      return r.ok ? r.data : null;
    },
    async exists(owner, name) {
      return (await call(`/repos/${owner}/${name}`)).ok;
    },
    /** A new repository on your account, empty, ready to be pushed to. */
    async create(name, { isPrivate = true, description = '' } = {}) {
      const r = await call('/user/repos', {
        method: 'POST',
        body: { name, private: isPrivate, description: description.slice(0, 340), auto_init: false },
      });
      if (!r.ok) throw new Error(`GitHub would not create ${name}: ${r.data?.message ?? r.status}`);
      return r.data;
    },
  };
}

// A stand-in assistant, so the bridge can be proved before yours is wired up.
//
//   ASSISTANT_CMD="node bridge/example-assistant.mjs" node bridge/bridge.mjs --try "hello"
//
// It is also the shape to copy. An ASSISTANT_CMD gets the question three
// ways — pick one — and anything it writes to stdout is the reply, streamed
// to your phone as it is written:
//
//   $ASSISTANT_PROMPT       the latest question
//   $ASSISTANT_TRANSCRIPT   the whole conversation as plain text
//   stdin                   {"messages":[{"role","content"}],"prompt":"…"}
//
// Exit non-zero and whatever you wrote to stderr becomes the error shown in
// the chat, so a broken assistant says why rather than going quiet.

const stdin = await new Promise((resolve) => {
  let text = '';
  if (process.stdin.isTTY) { resolve(''); return; }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { text += d; });
  process.stdin.on('end', () => resolve(text));
  setTimeout(() => resolve(text), 500);     // a caller that sends nothing
});

let payload = {};
try { payload = JSON.parse(stdin || '{}'); } catch { /* not JSON, fine */ }

const question = process.env.ASSISTANT_PROMPT || payload.prompt
  || payload.messages?.filter((m) => m.role === 'user').at(-1)?.content || '';
const turns = (payload.messages ?? []).length;

const reply = answer(question.toLowerCase(), question, turns);

// Written a word at a time, because that is what the dashboard draws: the
// reply grows in the bubble instead of appearing all at once.
for (const word of reply.split(' ')) {
  process.stdout.write(`${word} `);
  await new Promise((r) => setTimeout(r, 18));
}
process.stdout.write('\n');

function answer(q, original, turns) {
  if (!q) {
    return 'I am the example assistant — the placeholder the bridge ships with. '
      + 'Point `ASSISTANT_CMD` or `ASSISTANT_URL` at your own and this goes away.';
  }
  if (/^(hi|hello|hey|yo)\b/.test(q)) {
    return `Hello. I am running on your PC, reached through Supabase, which is why `
      + `your phone can talk to me at all.${turns > 1 ? ` We are ${turns} messages in.` : ''}`;
  }
  if (/who are you|what are you|your name/.test(q)) {
    return 'The example assistant in `bridge/example-assistant.mjs`. I exist so you can '
      + 'prove the relay works before wiring in the real thing. Replace me: set '
      + '`ASSISTANT_CMD` to your own script, or `ASSISTANT_URL` to its HTTP endpoint.';
  }
  if (/can you do|what can you/.test(q)) {
    return 'Not much — I am forty lines of `if`. What the *bridge* can do is matter: '
      + 'it keeps your own assistant reachable from your phone for as long as this PC '
      + 'is on, with nothing listening on your router.';
  }
  if (/\b(markdown|format)\b/.test(q)) {
    return '## Markdown works\n\nThe dashboard renders a reply as Markdown:\n\n'
      + '- **bold**, `code`, [links](https://example.com)\n- lists like this one\n\n'
      + '```js\nconsole.log("and fenced code");\n```';
  }
  if (/\b(error|fail|break)\b/.test(q)) {
    process.stderr.write('asked to fail, so failing\n');
    process.exit(3);
  }
  return `You said: "${original}". I am only the example assistant, so that is as far `
    + 'as my thinking goes — but it got here from your phone, through Supabase, to this '
    + 'PC, and the answer went back the same way.';
}

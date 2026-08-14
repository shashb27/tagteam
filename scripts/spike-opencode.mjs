// Spike: capture exact opencode SDK SSE event shapes during session.prompt.
// Plan A: in-process createOpencode({ port: 0 }).
import { createOpencode } from '@opencode-ai/sdk';

const log = (label, obj) => console.log(label, JSON.stringify(obj));

async function run({ label, promptText }) {
  console.log(`\n===== RUN: ${label} =====`);
  const { client, server } = await createOpencode({ port: 0 });
  log('server.url', server.url);

  const session = await client.session.create({ body: { title: 'spike' } });
  const sessionId = session?.data?.id ?? session?.id;
  log('sessionId', sessionId);

  const events = await client.event.subscribe();

  const promptP = client.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: 'text', text: promptText }] },
  });

  const seen = [];
  const timer = setTimeout(() => {
    console.log('TIMEOUT-30s');
    process.exit(0);
  }, 30000);

  for await (const ev of events.stream) {
    seen.push(ev);
    log('EV', ev);
    // Stop when the assistant message reports a finish/stop reason, or session goes idle.
    if (ev.type === 'message.updated' && ev.properties?.info?.finish) {
      clearTimeout(timer);
      break;
    }
    if (ev.type === 'session.idle') {
      clearTimeout(timer);
      break;
    }
  }
  await promptP.catch((e) => console.log('PROMPT_ERR', e?.message));
  server.close();
  return seen;
}

await run({ label: 'text-only', promptText: 'Reply with the single word OK.' });
await run({ label: 'tool-use', promptText: 'Use the Glob tool to list files in the current directory, then say done.' });
console.log('\n===== DONE =====');
process.exit(0);

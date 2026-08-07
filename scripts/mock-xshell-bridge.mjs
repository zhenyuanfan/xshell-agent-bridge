import { randomUUID } from 'node:crypto';
import { connectToDaemon } from '../src/client.mjs';

const client = await connectToDaemon();
const id = `mock-${randomUUID()}`;
let screen = 'Mock Xshell session ready\nuser@demo:~$ ';

async function bridgeRequest(path, { method = 'GET', body } = {}) {
  return client.request(path, { method, body });
}

await bridgeRequest('/bridge/register', {
  method: 'POST',
  body: {
    bridgeId: id,
    metadata: { connected: true, remoteAddress: 'mock.local', remotePort: 22, rows: 24, columns: 80 },
    screen,
  },
});

process.stderr.write(`[mock-xshell] session ${id} online; Ctrl+C to stop\n`);
while (true) {
  await bridgeRequest(`/bridge/sessions/${encodeURIComponent(id)}/heartbeat`, {
    method: 'POST',
    body: { metadata: { connected: true }, screen },
  });
  const job = await bridgeRequest(`/bridge/sessions/${encodeURIComponent(id)}/next`);
  if (job) {
    if (job.action.type === 'send') {
      screen += `${job.action.text}${job.action.enter ? '\n' : ''}`;
      if (job.action.enter) screen += `mock: executed ${job.action.text}\nuser@demo:~$ `;
    } else if (job.action.type === 'interrupt') {
      screen += '^C\nuser@demo:~$ ';
    }
    await bridgeRequest(`/bridge/sessions/${encodeURIComponent(id)}/jobs/${encodeURIComponent(job.id)}`, {
      method: 'POST',
      body: { ok: true, result: { acceptedByXshell: true, mock: true } },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

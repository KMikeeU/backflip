import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5199, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const electron = process.env.ELECTRON ?? 'electron';
const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, ELECTRON_RUN_AS_NODE: '' },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

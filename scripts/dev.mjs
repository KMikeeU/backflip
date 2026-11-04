import { createServer } from 'vite';
import { launchElectron } from './electron.mjs';

const server = await createServer({ server: { port: 5199, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const child = launchElectron({ VITE_DEV_SERVER_URL: url });
child.on('error', async (error) => {
  console.error(`Could not start Electron: ${error.message}`);
  await server.close();
  process.exitCode = 1;
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

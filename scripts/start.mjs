import { launchElectron } from './electron.mjs';

const child = launchElectron();
child.on('error', (error) => {
  console.error(`Could not start Electron: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code) => process.exit(code ?? 0));

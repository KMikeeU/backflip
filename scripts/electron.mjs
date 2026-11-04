import { spawn } from 'node:child_process';
import electronPath from 'electron';

export function launchElectron(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(process.env.ELECTRON || electronPath, ['.', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
}

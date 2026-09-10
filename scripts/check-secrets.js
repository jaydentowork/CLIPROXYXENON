import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

// Checks local secret values without printing them or passing them to git.
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const env = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const secrets = Object.entries(env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key) && value.length >= 8).map(([, value]) => value);
const leaks = paths.filter(path => {
  if (path === '.env') return true;
  const content = readFileSync(path);
  return secrets.some(secret => content.includes(Buffer.from(secret)));
});
console.log(JSON.stringify({ filesChecked: paths.length, localSecretsChecked: secrets.length, leakedFiles: leaks }, null, 2));
if (leaks.length) process.exitCode = 1;

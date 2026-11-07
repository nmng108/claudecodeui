// Stand-in for `kiro-cli` used by kiro-login.test.ts: login (device flow), whoami and logout.
// Behaviour is chosen with environment variables:
//   KIRO_FAKE_LOGIN_MODE   success (default) | fail | hang
//   KIRO_FAKE_LOGIN_DIR    directory holding the fake token and the recorded arguments
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.KIRO_FAKE_LOGIN_DIR;
const tokenFile = path.join(dir, 'token');
const [command, ...args] = process.argv.slice(2);

if (command === 'whoami') {
  const account = existsSync(tokenFile) ? { email: 'dev@example.com' } : null;
  console.log(JSON.stringify({ account }));
  process.exit(account ? 0 : 1);
} else if (command === 'logout') {
  rmSync(tokenFile, { force: true });
  process.exit(0);
} else if (command === 'login') {
  appendFileSync(path.join(dir, 'login-args.txt'), `${JSON.stringify({ args, hasApiKey: 'KIRO_API_KEY' in process.env })}\n`);
  const mode = process.env.KIRO_FAKE_LOGIN_MODE || 'success';
  process.stdout.write('\n\u001b[1mConfirm the following code in the browser\u001b[0m\nCode: ABCD-EFGH\n\n');
  process.stdout.write('Open this URL: https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH\n\n');
  process.stdout.write('\u25b0\u25b1\u25b1 Logging in...\n');
  if (mode === 'hang') {
    setTimeout(() => process.exit(1), 20_000); // safety net: the test cancels long before
  } else if (mode === 'fail') {
    setTimeout(() => {
      process.stderr.write('error: the device code expired\n');
      process.exit(1);
    }, 200);
  } else {
    setTimeout(() => {
      writeFileSync(tokenFile, 'token');
      process.exit(0);
    }, 300);
  }
} else {
  process.exit(2);
}
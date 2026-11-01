// Stand-in for the interactive `kiro-cli` (the Shell tab): records how it was
// launched, prints a banner and stays alive like a terminal UI would.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const record = {
  args: process.argv.slice(2),
  hasApiKey: Boolean(process.env.KIRO_API_KEY),
  cwd: process.cwd(),
};
writeFileSync(path.join(os.homedir(), 'interactive-launch.json'), JSON.stringify(record));
console.log(`FAKE-KIRO-INTERACTIVE ${record.args.join(' ')}`);
setInterval(() => {}, 60_000);

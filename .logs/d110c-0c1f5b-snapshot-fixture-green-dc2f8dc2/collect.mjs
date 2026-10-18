import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root='/Users/aristotle/Documents/Projects/ts-drp-1',out=path.dirname(new URL(import.meta.url).pathname),files=JSON.parse(fs.readFileSync(path.join(out,'selected-files.json')));const result=spawnSync(process.execPath,[path.join(out,'run.mjs'),'collection',root,'pnpm','exec','vitest','list',...files.map(f=>path.join(root,f)),'--json'],{cwd:root,stdio:'inherit',env:process.env});process.exitCode=result.status??1;

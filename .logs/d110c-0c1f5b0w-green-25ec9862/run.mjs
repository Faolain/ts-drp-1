import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
const root = process.cwd();
const evidence = import.meta.dirname;
const anchor = "25ec98628eba5d348086ba18d6481544803e03c9";
const changed = ["examples/v3-room/src/index.ts", "packages/issuance-store/src/contract.ts"];
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (name, value) => writeFileSync(resolve(evidence, name), JSON.stringify(value, null, 2) + "\n");
const git = (...args) => {
 const result = spawnSync("git", args, {cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024});
 if (result.status !== 0) throw new Error(result.stderr);
 return result.stdout;
};
const [mode, ...args] = process.argv.slice(2);
if (mode === "snapshot") {
 const initial = resolve(evidence, "before.json");
 const prior = JSON.parse(readFileSync(resolve(root, ".logs/d110c-0c1f5b0w-red-final-import-corrected-56a264ce/before.json")));
 const paths = Object.keys(prior.sourceHashes);
 const current = {
  head: git("rev-parse", "HEAD").trim(), signature: git("log", "-1", "--format=%G?").trim(),
  remote: git("ls-remote", "origin", "refs/heads/codex/phase3a1b-p6-golden-path").split("\t")[0],
  trackedStatus: git("status", "--porcelain", "-uno"),
  stashes: git("stash", "list", "--format=%H").trim().split("\n"),
  untracked: git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).filter(p => !p.startsWith(relative(root, evidence) + "/")),
  protectedHashes: Object.fromEntries(paths.map(p => [p, hash(readFileSync(resolve(root,p)))])),
  trackedSourceHashes: Object.fromEntries(git("ls-files", "-z", "packages", "examples", "tests").split("\0").filter(Boolean).filter(p => existsSync(resolve(root,p))).map(p => [p, hash(readFileSync(resolve(root,p)))])),
 };
 save(args[0] + ".json", current);
 if (existsSync(initial) && args[0] !== "before") {
  const before = JSON.parse(readFileSync(initial));
  const allowedSourceAndBuild = [...changed,"packages/issuance-store/dist/src/contract.js"];
  const checks = {stashes: JSON.stringify(before.stashes) === JSON.stringify(current.stashes), untracked: JSON.stringify(before.untracked) === JSON.stringify(current.untracked), protected: Object.entries(before.protectedHashes).filter(([p]) => !allowedSourceAndBuild.includes(p)).every(([p,h]) => current.protectedHashes[p] === h), unrelatedSources: Object.entries(before.trackedSourceHashes).filter(([p]) => !changed.includes(p)).every(([p,h]) => current.trackedSourceHashes[p] === h)};
  save(args[0] + "-custody.json", checks);
  if (Object.values(checks).includes(false)) throw new Error("CUSTODY_CHANGED");
 }
} else if (mode === "verify-red") {
 const directory = resolve(root, ".logs/d110c-0c1f5b0w-red-final-import-corrected-56a264ce");
 const manifest = readFileSync(resolve(directory,"manifest.sha256"),"utf8");
 if (hash(manifest) !== "d17fd52d41fa67bf58fe43768e51d69da60ebaa3782931aeaece2a2614dc4d34") throw new Error("MANIFEST_CHANGED");
 for (const line of manifest.trim().split("\n")) {
  const [digest,name] = line.split("  ");
  if (hash(readFileSync(resolve(directory,name))) !== digest) throw new Error("EVIDENCE_CHANGED");
 }
 save("accepted-red.json", {anchor, manifestHash: hash(manifest), entries: manifest.trim().split("\n").length, validation: JSON.parse(readFileSync(resolve(directory,"validation.json")))});
} else if (mode === "command") {
 const [name, executable, ...commandArgs] = args;
 const started = new Date().toISOString();
 const child = spawn(executable, commandArgs, {cwd: root, env: {...process.env, NODE_OPTIONS:"--max-old-space-size=8192", NO_COLOR:"1"}});
 let stdout = "", stderr = "";
 child.stdout.on("data", chunk => {stdout += chunk;});
 child.stderr.on("data", chunk => {stderr += chunk;});
 const status = await new Promise(resolve => child.on("close", (status,signal) => resolve({status,signal})));
 writeFileSync(resolve(evidence,name+".stdout"),stdout);
 writeFileSync(resolve(evidence,name+".stderr"),stderr);
 save(name+".status.json", {executable,args:commandArgs,cwd:root,started,finished:new Date().toISOString(),...status});
 console.log(JSON.stringify({name,...status,stdoutTail:stdout.slice(-6000),stderrTail:stderr.slice(-6000)}));
 process.exitCode = status.status ?? 1;
} else if (mode === "seal") {
 const files = readdirSync(evidence).filter(name => name !== "manifest.sha256").sort();
 writeFileSync(resolve(evidence,"manifest.sha256"),files.map(name => `${hash(readFileSync(resolve(evidence,name)))}  ${name}\n`).join(""));
 console.log(JSON.stringify({files:files.length,manifest:hash(readFileSync(resolve(evidence,"manifest.sha256")))}));
} else throw new Error("Unknown mode");

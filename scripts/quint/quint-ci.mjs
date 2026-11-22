#!/usr/bin/env node
// Runs the Quint formal models on every merge. The policy (which module, which init/step, which
// invariant must hold, which pre-fix variant must violate which invariant) lives in
// scripts/quint/manifest.json; this file only executes it.
//
//   node scripts/quint/quint-ci.mjs run [--tier pr|nightly] [--jobs N] [--filter REGEX] [--json FILE]
//   node scripts/quint/quint-ci.mjs list [--tier pr|nightly] [--filter REGEX]
//   node scripts/quint/quint-ci.mjs coverage
//
// Tiers
//   pr       typecheck every .qnt; `quint test` (one sample, explicit --match of every `run`);
//            every pr-tier `hold`, `violate` and `witness` check (simulation, fixed seed).
//   nightly  the pr tier with each simulation's samples multiplied by `nightly.sampleScale`,
//            plus every check marked tier "nightly" (deeper `violate`s that need more samples,
//            Apalache `verify` at the model's recorded depth), plus the `external` runners.
//
// A run fails when: a .qnt is missing from the manifest (or the manifest names a missing file);
// a file does not typecheck; a test fails or runs fewer tests than the module declares; a `hold`
// finds a violation or never reaches one of its witnesses; a `violate` does NOT violate its
// invariant (the pre-fix counterexample went stale, or the model drifted); a `verify` disagrees
// with its `expect`; an `external` exits non-zero; anything errors or times out.
//
// Every simulation is single-threaded (--n-threads 1) with a fixed seed, so a result reproduces
// with the printed command and --jobs is the only parallelism knob.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "run";
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const repo = resolve(opt("repo", resolve(here, "../..")));
const manifestPath = resolve(opt("manifest", join(here, "manifest.json")));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tier = opt("tier", "pr");
if (!["pr", "nightly"].includes(tier)) throw new Error(`unknown tier ${tier}`);
const filter = new RegExp(opt("filter", "."));
const jobs = Number(opt("jobs", Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))));
const seed = String(opt("seed", manifest.defaults.seed));
const quint = existsSync(join(repo, "node_modules/.bin/quint")) ? join(repo, "node_modules/.bin/quint") : "quint";
const apalacheVersion = process.env.APALACHE_VERSION ?? manifest.defaults.apalacheVersion;
const scale = tier === "nightly" ? manifest.defaults.nightly.sampleScale : 1;
// A private Apalache server port: the default 8822 is shared by every quint verify on the host, and a
// concurrent run elsewhere would otherwise answer (or drop) this run's checks.
const apalachePort = Number(process.env.QUINT_APALACHE_PORT ?? 20000 + (process.pid % 10000));
let verifyCwd;
const verifyDir = () => (verifyCwd ??= mkdtempSync(join(tmpdir(), "quint-verify-")));

// ---- model inventory --------------------------------------------------------------------------------
function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (name.endsWith(".qnt")) out.push(relative(repo, path));
	}
	return out;
}
const modelFiles = () => walk(join(repo, "packages")).sort();

function coverageProblems() {
	const listed = new Map(manifest.files.map((e) => [e.file, e]));
	const problems = [];
	for (const file of modelFiles()) if (!listed.has(file)) problems.push(`${file} is not in ${relative(repo, manifestPath)}`);
	for (const file of listed.keys()) if (!existsSync(join(repo, file))) problems.push(`${relative(repo, manifestPath)} names missing ${file}`);
	for (const e of manifest.files) {
		const kinds = ["modules", "typecheckOnly", "delegated"].filter((k) => e[k] !== undefined);
		if (kinds.length !== 1) problems.push(`${e.file}: needs exactly one of modules / typecheckOnly / delegated`);
	}
	return problems;
}

// ---- process execution --------------------------------------------------------------------------------
function exec(argv, { timeout, cwd = repo, env = {} }) {
	return new Promise((done) => {
		const t0 = Date.now();
		// Own process group: on timeout the whole group dies, including the Apalache server JVM that
		// quint verify starts (killing quint alone leaves that JVM checking at full CPU).
		const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeout);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			done({ code, out, ms: Date.now() - t0, timedOut: signal === "SIGKILL" });
		});
	});
}

async function pool(items, worker) {
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(jobs, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await worker(items[i]);
			}
		})
	);
	return results;
}

const violatedIn = (out) => [...out.matchAll(/❌ (\w+)/g)].map((m) => m[1]);
const witnessCounts = (out) =>
	Object.fromEntries([...out.matchAll(/^(\w+) was witnessed in (\d+) trace/gm)].map((m) => [m[1], Number(m[2])]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- job construction ---------------------------------------------------------------------------------
function inTier(check) {
	const t = check.tier ?? (check.kind === "verify" ? "nightly" : "pr");
	return t === "pr" || tier === "nightly";
}

function simArgv(file, mod, c) {
	const samples = Math.round((c.samples ?? manifest.defaults.samples) * (c.kind === "violate" ? 1 : scale));
	const argv = [quint, "run", file, "--main", mod.main, "--init", c.init ?? "init", "--step", c.step ?? mod.step ?? "step"];
	argv.push("--max-samples", String(samples), "--max-steps", String(c.maxSteps ?? manifest.defaults.maxSteps));
	argv.push("--seed", seed, "--n-threads", "1", "--verbosity", "1");
	if (c.invariants?.length) argv.push("--invariants", ...c.invariants);
	if (c.witnesses?.length) argv.push("--witnesses", ...c.witnesses);
	return argv;
}

function buildJobs() {
	const list = [];
	const timeout = manifest.defaults.timeoutMs;
	for (const e of manifest.files) {
		if (!filter.test(e.file)) continue;
		list.push({ kind: "typecheck", file: e.file, argv: [quint, "typecheck", e.file], timeout });
		for (const mod of e.modules ?? []) {
			if (mod.tests?.length) {
				const match = `^(${mod.tests.map(escapeRe).join("|")})$`;
				list.push({ kind: "test", file: e.file, main: mod.main, expectTests: mod.tests.length, timeout,
					argv: [quint, "test", e.file, "--main", mod.main, "--match", match, "--max-samples", tier === "nightly" ? "20" : "1", "--seed", seed] });
			}
			for (const c of mod.checks ?? []) {
				if (!inTier(c)) continue;
				if (c.kind === "verify") {
					// Apalache writes _apalache-out/ into its working directory: keep it out of the checkout.
					const argv = [quint, "verify", join(repo, e.file), "--main", mod.main, "--init", c.init ?? "init", "--step", c.step ?? mod.step ?? "step",
						"--max-steps", String(c.maxSteps), "--invariant", c.invariants.join(","), "--apalache-version", apalacheVersion,
						"--server-endpoint", `localhost:${apalachePort}`];
					list.push({ kind: "verify", file: e.file, main: mod.main, check: c, argv, cwd: verifyDir(), timeout: c.timeoutMs ?? manifest.defaults.verifyTimeoutMs });
				} else {
					list.push({ kind: c.kind, file: e.file, main: mod.main, check: c, argv: simArgv(e.file, mod, c), timeout: c.timeoutMs ?? timeout });
				}
			}
		}
	}
	if (tier === "nightly") {
		for (const x of manifest.external ?? []) {
			if (!filter.test(x.name)) continue;
			list.push({ kind: "external", file: x.name, argv: x.argv, timeout: x.timeoutMs });
		}
	}
	return list;
}

// ---- judgement ----------------------------------------------------------------------------------------
function judge(j, r) {
	if (r.timedOut) return { pass: false, why: `TIMEOUT after ${j.timeout} ms` };
	const violated = /\[violation\]|Invariant violated|error: Invariant/.test(r.out);
	switch (j.kind) {
		case "typecheck":
			return r.code === 0 ? { pass: true, why: "ok" } : { pass: false, why: "does not typecheck" };
		case "test": {
			const passing = Number(r.out.match(/(\d+) passing/)?.[1] ?? 0);
			if (r.code !== 0) return { pass: false, why: "test failed" };
			if (passing !== j.expectTests) return { pass: false, why: `ran ${passing} of ${j.expectTests} tests` };
			return { pass: true, why: `${passing} tests` };
		}
		case "hold":
		case "witness": {
			if (violated) return { pass: false, why: `VIOLATED ${violatedIn(r.out).join(", ")}` };
			if (r.code !== 0) return { pass: false, why: `error (exit ${r.code})` };
			const counts = witnessCounts(r.out);
			const missing = (j.check.witnesses ?? []).filter((w) => !counts[w]);
			if (missing.length) return { pass: false, why: `VACUOUS: never reached ${missing.join(", ")}` };
			return { pass: true, why: "held" };
		}
		case "violate": {
			if (!violated) {
				if (r.code === 0 && j.check.residual)
					return { pass: false, why: "RESIDUAL CLOSED: this known-open violation no longer reproduces; if a fix closed it, turn it into a hold check" };
				return r.code === 0
					? { pass: false, why: "STALE COUNTEREXAMPLE: the pre-fix variant no longer violates; the model drifted or needs more samples" }
					: { pass: false, why: `error (exit ${r.code})` };
			}
			const hit = violatedIn(r.out);
			const wanted = j.check.invariants.filter((i) => !hit.includes(i));
			if (hit.length && wanted.length === j.check.invariants.length) return { pass: false, why: `violated ${hit.join(", ")}, not ${j.check.invariants.join(", ")}` };
			return { pass: true, why: `violated ${hit.join(", ") || j.check.invariants.join(", ")}` };
		}
		case "verify": {
			const expect = j.check.expect ?? "hold";
			const outcome = violated ? "violation" : r.code === 0 ? "hold" : "error";
			return { pass: outcome === expect, why: outcome === expect ? outcome : `expected ${expect}, got ${outcome}` };
		}
		case "external":
			return r.code === 0 ? { pass: true, why: "ok" } : { pass: false, why: `exit ${r.code}` };
		default:
			return { pass: false, why: `unknown check kind ${j.kind}` };
	}
}

// ---- commands -----------------------------------------------------------------------------------------
const label = (j) => [j.kind.padEnd(9), j.main ?? "", j.file, j.check?.step ? `step=${j.check.step}` : "", j.check?.init && j.check.init !== "init" ? j.check.init : "", j.check?.invariants && j.kind !== "hold" ? `[${j.check.invariants.join(",")}]` : ""].filter(Boolean).join(" ");

async function run() {
	const t0 = Date.now();
	const problems = coverageProblems();
	for (const p of problems) console.log(`FAIL coverage  ${p}`);
	const list = buildJobs();
	console.log(`quint-ci: tier ${tier}, ${list.length} checks, ${jobs} jobs, seed ${seed}`);
	// quint verify talks to one Apalache server (it starts one on the endpoint if none is running), so
	// verify jobs run one at a time in their own lane, beside the pool.
	const work = async (j) => {
		const r = await exec(j.argv, { timeout: j.timeout, cwd: j.cwd });
		const { pass, why } = judge(j, r);
		console.log(`${pass ? "PASS" : "FAIL"} ${label(j)} ${why} ${r.ms}ms`);
		if (!pass) console.log(`     repro: ${j.argv.map((a) => (/[\s|()^$]/.test(a) ? `'${a}'` : a)).join(" ").replaceAll(repo + "/", "")}\n${r.out.trim().split("\n").slice(-12).map((l) => "     | " + l).join("\n")}`);
		return { kind: j.kind, file: j.file, main: j.main, init: j.check?.init, step: j.check?.step, pass, why, ms: r.ms };
	};
	const verifies = list.filter((j) => j.kind === "verify");
	const lane = (async () => {
		const out = [];
		for (const j of verifies) out.push(await work(j));
		return out;
	})();
	const results = [...(await pool(list.filter((j) => j.kind !== "verify"), work)), ...(await lane)];
	const failed = results.filter((r) => !r.pass).length + problems.length;
	const cpu = results.reduce((s, r) => s + r.ms, 0);
	console.log(`\nquint-ci ${tier}: ${results.length} checks, ${failed} failed, wall ${((Date.now() - t0) / 1000).toFixed(0)}s, cpu-serial ${(cpu / 1000).toFixed(0)}s, jobs ${jobs}`);
	if (opt("json")) writeFileSync(opt("json"), JSON.stringify({ tier, jobs, seed, problems, results }, null, 2) + "\n");
	process.exit(failed ? 1 : 0);
}

if (command === "run") await run();
else if (command === "list") {
	for (const j of buildJobs()) console.log(label(j));
} else if (command === "coverage") {
	const problems = coverageProblems();
	for (const p of problems) console.log(p);
	console.log(problems.length ? `${problems.length} coverage problems` : `all ${modelFiles().length} .qnt files are in the manifest`);
	process.exit(problems.length ? 1 : 0);
} else {
	console.error("usage: quint-ci.mjs run|list|coverage [--tier pr|nightly] [--jobs N] [--filter REGEX] [--json FILE]");
	process.exit(2);
}

import fs from "node:fs";
import path from "node:path";

const mode = process.env.TRACK_P2_C_CHILD_MODE;
const contractIndex = process.argv.indexOf("--contract");
const isTopLevel = contractIndex >= 0 && !process.argv.includes("--node-worker");

if (isTopLevel) {
	const contractPath = process.argv[contractIndex + 1];
	const telemetryPath = process.env.TRACK_P2_C_TELEMETRY;
	if (contractPath === undefined || telemetryPath === undefined) throw new TypeError("missing P2-c test telemetry input");
	const contract = fs.readFileSync(contractPath);
	JSON.parse(contract.toString("utf8"));
	const directory = path.dirname(contractPath);
	const files = Object.fromEntries(
		fs
			.readdirSync(directory)
			.filter((filename) => filename !== path.basename(contractPath))
			.sort()
			.map((filename) => [filename, fs.readFileSync(path.join(directory, filename)).toString("base64")])
	);
	const telemetry = {
		arguments: process.argv.slice(1),
		contract: contract.toString("base64"),
		contractPath: path.resolve(process.cwd(), contractPath),
		cwd: process.cwd(),
		files,
	};
	const writeTelemetry = (receipt) => {
		fs.writeFileSync(telemetryPath, JSON.stringify({ ...telemetry, receipt }), { flag: "wx" });
	};
	const exitWithoutReceipt = (action) => {
		writeTelemetry();
		action();
	};
	if (mode === "nonzero") exitWithoutReceipt(() => process.exit(7));
	if (mode === "signal") exitWithoutReceipt(() => process.kill(process.pid, "SIGTERM"));
	if (mode === "empty-stdout") exitWithoutReceipt(() => process.exit(0));
	if (mode === "malformed-stdout") {
		exitWithoutReceipt(() => {
			fs.writeSync(1, "not-json\n");
			process.exit(0);
		});
	}
	if (mode === "double-stdout") {
		exitWithoutReceipt(() => {
			fs.writeSync(1, "{}\n{}\n");
			process.exit(0);
		});
	}
	const baseReceiptPath = process.env.TRACK_P2_C_BASE_RECEIPT;
	if (baseReceiptPath !== undefined) {
		const receipt = JSON.parse(fs.readFileSync(baseReceiptPath, "utf8"));
		const mutationText = process.env.TRACK_P2_C_MUTATION;
		if (mutationText !== undefined) {
			const mutation = JSON.parse(mutationText);
			let owner = receipt;
			for (const segment of mutation.path.slice(0, -1)) owner = owner[segment];
			const key = mutation.path.at(-1);
			const current = owner[key];
			if (mutation.copyPath !== undefined) {
				let copied = receipt;
				for (const segment of mutation.copyPath) copied = copied[segment];
				owner[key] = copied;
			} else if (mutation.kind === "empty") owner[key] = "";
			else if (mutation.kind === "opposite-tier") owner[key] = current === "pr" ? "nightly" : "pr";
			else if (typeof current === "boolean") owner[key] = !current;
			else if (typeof current === "number") owner[key] = current + 1;
			else if (typeof current === "string")
				owner[key] = /^[0-9a-f]{64}$/u.test(current) ? "00".repeat(32) : current === "wrong" ? "other" : "wrong";
			else if (Array.isArray(current)) owner[key] = [];
			else owner[key] = null;
		}
		writeTelemetry(receipt);
		if (mode === "diagnostic-stderr") fs.writeSync(2, "track-p2-c diagnostic stderr\n");
		fs.writeSync(1, `${JSON.stringify(receipt)}\n`);
		process.exit(0);
	}
	writeTelemetry();
	const originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk) => {
		return originalWrite(chunk);
	});
}

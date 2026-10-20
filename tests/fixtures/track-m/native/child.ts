import { type BrowserContext, type BrowserType, chromium, firefox, type Page, webkit } from "@playwright/test";

// Track M, slice 14f: the detached Node child of the process-death pattern
// (packages/storage-browser/tests/process/phase-3a1b-p4-browser-live-journal-crash-child.ts).
// It opens the recipient's page (origin B) and then the creator's page (origin A) in one
// persistent context (or a fresh one), relays RPC packets between the two pages, forwards
// both pages' TM14F console records to the parent over IPC (tagged with the page's role),
// and in mutate mode waits forever: the parent SIGKILLs the browser and this process when
// the creator worker reaches its edge.

interface ChildInput {
	readonly browserName: "chromium" | "firefox" | "webkit";
	readonly mode: "mutate" | "recover" | "run";
	readonly profileDirectory?: string;
	readonly url: string;
	readonly peerUrl: string;
}
type Role = "creator" | "recipient";

function browserType(name: ChildInput["browserName"]): BrowserType {
	if (name === "chromium") return chromium;
	if (name === "firefox") return firefox;
	return webkit;
}

let sending: Promise<void> = Promise.resolve();
function send(value: unknown): Promise<void> {
	sending = sending.then(
		() =>
			new Promise<void>((resolve) => {
				if (typeof process.send !== "function") resolve();
				else process.send(value, () => resolve());
			})
	);
	return sending;
}

async function main(): Promise<void> {
	const input = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8")) as ChildInput;
	let context: BrowserContext;
	let version: string | null = null;
	if (input.profileDirectory !== undefined) {
		context = await browserType(input.browserName).launchPersistentContext(input.profileDirectory, { headless: true });
		version = context.browser()?.version() ?? null;
	} else {
		const browser = await browserType(input.browserName).launch({ headless: true });
		version = browser.version();
		context = await browser.newContext();
	}
	void send({ kind: "child-ready", pid: process.pid, version });
	const creator = context.pages()[0] ?? (await context.newPage());
	const recipient = await context.newPage();
	const pages: Record<Role, Page> = { creator, recipient };
	let finishing = false;
	const finish = (code: number): void => {
		if (finishing) return;
		finishing = true;
		void sending
			.then(() => context.close())
			.catch(() => undefined)
			.finally(() => process.exit(code));
	};
	let recipientReady: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => (recipientReady = resolve));
	const deliver = (role: Role, value: { kind?: string }): void => {
		void send({ ...value, role });
		if (role === "recipient" && value.kind === "ready") recipientReady();
		if (role === "creator" && value.kind === "result") finish(0);
		else if ((value.kind === "worker-error" || value.kind === "page-error") && input.mode !== "mutate") finish(1);
	};
	for (const role of ["creator", "recipient"] as const) {
		const page = pages[role];
		const other = pages[role === "creator" ? "recipient" : "creator"];
		const chunks = new Map<string, string[]>();
		await page.exposeFunction("__tm14fRelay", (text: string) =>
			other.evaluate((packet) => (Reflect.get(window, "__tm14fDeliver") as (value: string) => void)(packet), text)
		);
		page.on("console", (message) => {
			const text = message.text();
			if (text.startsWith("TM14F:")) deliver(role, JSON.parse(text.slice("TM14F:".length)) as { kind?: string });
			else if (text.startsWith("TM14FC:")) {
				const [, id, index, total] = text.split(":", 4);
				const header = `TM14FC:${id}:${index}:${total}:`;
				const parts = chunks.get(id!) ?? new Array<string>(Number(total)).fill("");
				parts[Number(index)] = text.slice(header.length);
				chunks.set(id!, parts);
				// The page logs a record's chunks in order; the last one completes it.
				if (Number(index) === Number(total) - 1) {
					chunks.delete(id!);
					deliver(role, JSON.parse(parts.join("")) as { kind?: string });
				}
			}
		});
		page.on("pageerror", (error) => deliver(role, { kind: "page-error", message: error.message } as { kind?: string }));
		page.on("crash", () => void send({ kind: "page-crash", role }));
	}
	await recipient.goto(input.peerUrl, { waitUntil: "load" });
	await ready;
	await creator.goto(input.url, { waitUntil: "load" });
	await new Promise(() => undefined);
}

void main().catch((error: unknown) => {
	void send({
		kind: "child-error",
		message: error instanceof Error ? (error.stack ?? error.message) : String(error),
	}).finally(() => process.exit(1));
});

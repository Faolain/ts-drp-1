/* eslint-disable jsdoc/require-jsdoc */
// Deliberately unresolved until the production ./host subpath exists at GREEN.
// eslint-disable-next-line import/no-unresolved
import { createWorkerHost } from "@ts-drp/worker-host/host";

function workerUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

async function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("browser fixture deadline exceeded")), milliseconds);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function runPositive(source: string): Promise<Readonly<Record<string, unknown>>> {
	const url = workerUrl(source);
	const endpoint = new Worker(url, { type: "module" });
	const host = createWorkerHost({ endpoint, readyTimeoutMs: 5_000 });
	try {
		const stream = host.submit("probe", new Uint8Array([1]));
		const chunks: Uint8Array[] = [];
		await within(
			(async (): Promise<void> => {
				for await (const chunk of stream) chunks.push(chunk);
			})(),
			5_000
		);
		const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const payload = JSON.parse(new TextDecoder().decode(chunks[0])) as Record<string, unknown>;
		return { ...payload, chunks: chunks.length, bytes, state: host.state };
	} finally {
		host.close();
		URL.revokeObjectURL(url);
	}
}

export async function runNeverReady(source: string): Promise<Readonly<Record<string, unknown>>> {
	const url = workerUrl(source);
	const endpoint = new Worker(url, { type: "module" });
	const startedAtMs = performance.now();
	const host = createWorkerHost({ endpoint, readyTimeoutMs: 100 });
	try {
		const stream = host.submit("probe", new Uint8Array());
		let code = "none";
		try {
			await within(stream.next(), 5_000);
		} catch (error) {
			code = String((error as { code?: unknown }).code);
		}
		return { code, durationMs: performance.now() - startedAtMs, state: host.state };
	} finally {
		host.close();
		URL.revokeObjectURL(url);
	}
}

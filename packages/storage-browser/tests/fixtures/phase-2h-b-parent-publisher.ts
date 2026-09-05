import { randomUUID } from "node:crypto";
import http from "node:http";

import type { Phase2hPublisher, Phase2hRunLayout } from "./phase-2h-a-publication.js";
import { validatePhase2hRecord } from "./phase-2h-a-record.js";
import type { Phase2hEngineName } from "./phase-2h-a-registry.js";
import { PHASE_2H_ENGINES } from "./phase-2h-a-registry.js";

export interface Phase2hParentPublisherServer {
	readonly submissionURLs: Readonly<Record<Phase2hEngineName, string>>;
	close(): Promise<void>;
}

const MAX_SUBMISSION_BYTES = 4_194_304;

function respond(response: http.ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		response.writeHead(status).end();
		return;
	}
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeIdleConnections();
	});
}

function readBoundedJson(request: http.IncomingMessage): Promise<unknown> {
	const declared = request.headers["content-length"];
	if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_SUBMISSION_BYTES)) {
		request.resume();
		return Promise.reject(new RangeError("submission body exceeds the Phase 2h bound"));
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		request.on("data", (chunk: Buffer) => {
			if (settled) return;
			bytes += chunk.byteLength;
			if (bytes > MAX_SUBMISSION_BYTES) {
				settled = true;
				request.resume();
				reject(new RangeError("submission body exceeds the Phase 2h bound"));
				return;
			}
			chunks.push(chunk);
		});
		request.once("end", () => {
			if (settled) return;
			settled = true;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
			} catch {
				reject(new TypeError("submission body is not JSON"));
			}
		});
		request.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
}

function soleRecord(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "record") return null;
	return Reflect.get(value, "record");
}

/**
 * Starts the one invocation-owned, loopback-only record publisher. Project
 * authority comes exclusively from an opaque project endpoint chosen here.
 * @param layout - Current create-only Phase 2h output layout.
 * @param publisher - Sole invocation-wide filesystem publisher.
 * @returns Closed project URL map and awaited shutdown owner.
 */
export function startPhase2hParentPublisher(
	layout: Phase2hRunLayout,
	publisher: Phase2hPublisher
): Promise<Phase2hParentPublisherServer> {
	const projectByPath = new Map<string, Phase2hEngineName>();
	for (const project of PHASE_2H_ENGINES) projectByPath.set(`/submit/${randomUUID()}`, project);
	let serial = Promise.resolve();
	const server = http.createServer((request, response) => {
		const project = projectByPath.get(request.url ?? "");
		if (request.method !== "POST" || project === undefined) {
			request.resume();
			respond(response, 404);
			return;
		}
		if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
			request.resume();
			respond(response, 415);
			return;
		}
		serial = serial.then(async () => {
			let body: unknown;
			try {
				body = await readBoundedJson(request);
			} catch (error) {
				respond(response, error instanceof RangeError ? 413 : 400);
				return;
			}
			const candidate = soleRecord(body);
			const validation = validatePhase2hRecord(candidate, {
				browserVersions: layout.browserVersions,
				gitSha: layout.gitSha,
				playwrightVersion: layout.playwrightVersion,
				project,
				runId: layout.runId,
			});
			if (validation.record === null || validation.errors.length !== 0) {
				respond(response, 422);
				return;
			}
			const status = publisher.submit({ project, record: validation.record });
			if (status !== "accepted") {
				respond(response, status === "rejected-bound" ? 429 : 409);
				return;
			}
			respond(response, 200, {
				owner: "phase-2h-parent/v1",
				project,
				status,
				tupleId: validation.record.tupleId,
			});
		});
		void serial.catch(() => {
			if (!response.headersSent) respond(response, 500);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new TypeError("Phase 2h parent publisher did not bind a TCP port"));
				return;
			}
			const base = `http://127.0.0.1:${address.port}`;
			const submissionURLs = Object.fromEntries(
				[...projectByPath].map(([pathname, project]) => [project, `${base}${pathname}`])
			) as Record<Phase2hEngineName, string>;
			resolve(
				Object.freeze({
					close: async (): Promise<void> => {
						let serialFailure: unknown;
						try {
							await serial;
						} catch (error) {
							serialFailure = error;
						} finally {
							await closeServer(server);
						}
						if (serialFailure !== undefined) throw serialFailure;
					},
					submissionURLs: Object.freeze(submissionURLs),
				})
			);
		});
	});
}

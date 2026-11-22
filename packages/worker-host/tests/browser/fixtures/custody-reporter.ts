/* eslint-disable jsdoc/require-jsdoc */
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { readFileSync } from "node:fs";

import { type HandshakeCustody, REQUIRED_SCENARIOS, validateCustody } from "./custody.js";

const TARGET = "ready ordering and never-ready recovery produce exact engine custody";

export default class CustodyReporter implements Reporter {
	readonly #errors: string[] = [];
	readonly #seen = new Set<string>();

	onTestEnd(test: TestCase, result: TestResult): void {
		if (test.title !== TARGET) return;
		const project = test.parent.project()?.name ?? "unknown";
		if (this.#seen.has(project)) this.#errors.push(`duplicate project result:${project}`);
		this.#seen.add(project);
		if (result.status !== "passed") {
			this.#errors.push(`${project}:status:${result.status}`);
			return;
		}
		const attachments = result.attachments.filter((attachment) => attachment.name === "phase-2f-b-custody.json");
		if (attachments.length !== 1) {
			this.#errors.push(`${project}:custody-count:${attachments.length}`);
			return;
		}
		try {
			const attachment = attachments[0];
			const bytes = attachment.body ?? (attachment.path === undefined ? undefined : readFileSync(attachment.path));
			if (bytes === undefined) throw new Error("custody body absent");
			const records = JSON.parse(bytes.toString()) as unknown;
			if (!Array.isArray(records) || records.length !== REQUIRED_SCENARIOS.length) {
				throw new Error("custody tuple count");
			}
			for (const record of records) validateCustody(record);
			const typed = records as HandshakeCustody[];
			if (typed.some((record) => record.engine !== project)) throw new Error("custody engine mismatch");
			const scenarios = typed.map((record) => record.scenario).sort();
			if (JSON.stringify(scenarios) !== JSON.stringify([...REQUIRED_SCENARIOS].sort())) {
				throw new Error("custody scenario mismatch");
			}
		} catch (error) {
			this.#errors.push(`${project}:${error instanceof Error ? error.message : String(error)}`);
		}
	}

	onEnd(_result: FullResult): Promise<{ status: "failed" } | undefined> {
		for (const project of ["firefox", "webkit"]) {
			if (!this.#seen.has(project)) this.#errors.push(`${project}:missing`);
		}
		if (this.#errors.length === 0) return Promise.resolve(undefined);
		console.error(`Phase 2f-b custody aggregation failed: ${this.#errors.join(", ")}`);
		return Promise.resolve({ status: "failed" });
	}
}

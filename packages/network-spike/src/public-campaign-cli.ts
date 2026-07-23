#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { reviewedExecutorModulePath } from "./public-campaign/executor-module.js";
import {
	createEnvironmentBlockedCampaignReport,
	createReviewedPublicCampaignDriver,
	preflightPublicCampaign,
	type PublicCampaignConfig,
	type PublicCampaignRequestExecutor,
	runPublicCampaign,
	sanitizePublicCampaignPreflight,
} from "./public-campaign/index.js";

interface CampaignExecutorModule {
	createPublicCampaignRequestExecutor(
		config: PublicCampaignConfig
	): Promise<PublicCampaignRequestExecutor> | PublicCampaignRequestExecutor;
}

void main();

async function main(): Promise<void> {
	const arguments_ = process.argv.slice(2);
	const configPath = optionValue(arguments_, "--config");
	const acknowledgement = optionValue(arguments_, "--acknowledge");
	const executorName = optionValue(arguments_, "--executor");
	const execute = arguments_.includes("--execute");

	if (configPath === undefined) {
		process.stdout.write(`${JSON.stringify(createEnvironmentBlockedCampaignReport(), null, 2)}\n`);
		process.exitCode = 2;
		return;
	}

	const input = JSON.parse(await readFile(resolve(configPath), "utf8")) as unknown;
	const preflight = preflightPublicCampaign(input, acknowledgement);
	const sanitizedPreflight = sanitizePublicCampaignPreflight(preflight);
	if (!execute) {
		process.stdout.write(`${JSON.stringify(sanitizedPreflight, null, 2)}\n`);
		process.exitCode = preflight.authorized ? 0 : 2;
		return;
	}
	if (!preflight.authorized || preflight.config === undefined) {
		process.stdout.write(
			`${JSON.stringify(
				{
					...createEnvironmentBlockedCampaignReport(),
					blockers: sanitizedPreflight.blockers,
					precomputed: sanitizedPreflight.precomputed,
				},
				null,
				2
			)}\n`
		);
		process.exitCode = 2;
		return;
	}
	if (executorName === undefined) {
		process.stderr.write(
			"--execute requires --executor <reviewed in-repository module name>; no public request was made\n"
		);
		process.exitCode = 2;
		return;
	}

	const reviewedExecutorPath = reviewedExecutorModulePath(executorName);
	const moduleUrl = pathToFileURL(reviewedExecutorPath).href;
	const executorModule = (await import(moduleUrl)) as Partial<CampaignExecutorModule>;
	if (typeof executorModule.createPublicCampaignRequestExecutor !== "function") {
		throw new Error("reviewed executor module must export createPublicCampaignRequestExecutor(config)");
	}
	const executor = await executorModule.createPublicCampaignRequestExecutor(preflight.config);
	const driver = createReviewedPublicCampaignDriver(preflight.config);
	const result = await runPublicCampaign(input, acknowledgement, driver, { executor });
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	process.exitCode = result.status === "complete" ? 0 : 2;
}

function optionValue(arguments_: string[], option: string): string | undefined {
	const index = arguments_.indexOf(option);
	return index === -1 ? undefined : arguments_[index + 1];
}

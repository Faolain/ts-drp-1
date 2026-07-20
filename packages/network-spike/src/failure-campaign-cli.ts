import {
	assertFailureCampaign,
	renderFailureCampaignHtml,
	renderFailureCampaignMarkdown,
	runFailureCampaign,
} from "./failure-campaign/index.js";

async function main(argv: string[]): Promise<void> {
	if (argv[0] !== "--fixture" || argv[1] !== "all") {
		throw new Error(
			"usage: pnpm --filter @ts-drp/network-spike failure-campaign --fixture all [--format json|markdown|html]"
		);
	}
	const formatIndex = argv.indexOf("--format");
	const format = formatIndex === -1 ? "json" : argv[formatIndex + 1];
	if (format !== "html" && format !== "json" && format !== "markdown") {
		throw new Error("failure campaign format must be json, markdown, or html");
	}
	const report = await runFailureCampaign();
	assertFailureCampaign(report);
	const output =
		format === "markdown"
			? renderFailureCampaignMarkdown(report)
			: format === "html"
				? renderFailureCampaignHtml(report)
				: `${JSON.stringify(report, undefined, 2)}\n`;
	process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

import { mergeConfig } from "vite";
import base from "../../vite.config.mts";

// Diagnostic-only in-memory observation. The production file, genuine handle,
// input, returned result and error contract are unchanged.
export default mergeConfig(base, {
	plugins: [{
		name: "f5b-segmented-result-observer",
		enforce: "pre" as const,
		transform(source: string, id: string) {
			if (!id.endsWith("/examples/v3-room/src/index.ts")) return;
			const needle = "\t\tif (!issued.ok) {\n\t\t\tif (issued.kind === \"split-required\") return issued;";
			if (!source.includes(needle)) throw new Error("F5B_OBSERVER_SITE_MISSING");
			return source.replace(needle,
				'\t\tconsole.warn("F5B_SEGMENTED_RESULT", JSON.stringify({epoch: activeHandle.epoch, count: operations.length, effect, next: lineage.next, signed, ok: issued.ok, ...(!issued.ok ? {kind: issued.kind, detail: "detail" in issued ? issued.detail : undefined} : {})}));\n' + needle);
		},
	}],
});

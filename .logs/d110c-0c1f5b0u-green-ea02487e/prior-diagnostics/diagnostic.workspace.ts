import base from "../../vite.config.mts";

export default [{
  ...base,
  root: "/Users/aristotle/Documents/Projects/ts-drp-1",
  plugins: [...base.plugins, {
    name: "diagnostic-rejected-migration-reason",
    enforce: "pre",
    transform(source, id) {
      if (id.endsWith("packages/node/src/v3-live.ts")) {
        return source.replace('if (classified === undefined || (afterKey !== undefined && classified.row.authorSequence <= afterKey[2])) {', 'if (classified === undefined || (afterKey !== undefined && classified.row.authorSequence <= afterKey[2])) { console.error("DIAGNOSTIC_REBASE_CLASSIFICATION", {selectedScope, afterKey, page});');
      }
      if (id.endsWith("examples/v3-room/src/index.ts")) {
        const marker = 'throw new TypeError("v3 room migration reopened target differs");';
        if (source.split(marker).length !== 2) throw new Error("diagnostic source marker differs");
        return source.replace(marker, 'console.error("DIAGNOSTIC_TARGET_ROWS", {before: targetAccepted.map(r => ({sequence:r.authorSequence, action:r.operation.action})), after: reopenedAccepted.map(r=>({sequence:r.authorSequence,action:r.operation.action}))});' + marker).replace('rejectRetainedBootstrap?.(error);', 'console.error("DIAGNOSTIC_SINK_FAILURE", error); rejectRetainedBootstrap?.(error);');
      }
      if (!id.endsWith("tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts")) return;
      const marker = "const results = await Promise.allSettled([issued, migration]);";
      if (source.split(marker).length !== 2) throw new Error("diagnostic marker differs");
      return source.replace(marker, marker + '\nconsole.error("DIAGNOSTIC_MIGRATION_RESULT", results[1]);').replace('() => "rejected"', '(error) => { console.error("DIAGNOSTIC_ACTIVATION_FAILURE", error); return "rejected"; }');
    }
  }]
}];

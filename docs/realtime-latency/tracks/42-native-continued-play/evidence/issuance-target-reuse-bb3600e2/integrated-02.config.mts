import baseline from "/private/tmp/issuance-projection-journal-baseline.config.mts";
import {appendFileSync} from "node:fs";
export default {
  ...baseline,
  plugins: [{
    name: "record-issuance-runtime-owner",
    enforce: "pre",
    async resolveId(id, importer) {
      if (id !== "@ts-drp/issuance-store/maintenance" &&
          !(id === "./retirement.js" && importer?.includes("/issuance-store/"))) return;
      const resolved = await this.resolve(id, importer, {skipSelf: true});
      appendFileSync("/private/tmp/issuance-projection-root-runtime-resolution.jsonl",
        JSON.stringify({id, importer, resolved}) + "\n");
      return resolved;
    },
  }, ...baseline.plugins],
  test: {
    ...baseline.test,
    name: "issuance-projection-integrated",
    include: [
      "packages/issuance-store/tests/retirement-plan-rewrite.test.ts",
      "packages/storage-node/tests/issuance-retirement-plan-rewrite.test.ts",
    ],
    testNamePattern: /./,
  },
};

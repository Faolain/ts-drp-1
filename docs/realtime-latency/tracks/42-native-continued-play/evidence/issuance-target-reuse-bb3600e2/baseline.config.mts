import base from "/Users/aristotle/Documents/Projects/ts-drp-1/vite.config.mts";
import tsconfigPaths from "/Users/aristotle/Documents/Projects/ts-drp-1/node_modules/vite-tsconfig-paths/dist/index.js";

const root = "/Users/aristotle/Documents/Projects/ts-drp-1";

export default {
  ...base,
  root,
  plugins: [base.plugins[0], tsconfigPaths({root, projects: [root + "/tsconfig.json"]})],
  test: {
    ...base.test,
    root,
    dir: root,
    globalSetup: [root + "/scripts/check-shadowed-sources.mjs"],
    name: "issuance-projection-journal-baseline",
    include: ["packages/storage-node/tests/retirement-image-cas.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.logs/**"],
    testNamePattern: /^(journal native source image distinguishes byte ceilings from malformed rows|journal retirement exposes exact bounded native rows with joined one-use custody|journal physical eight-header image is complete while role and resource bounds remain distinct)$/,
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    coverage: {enabled: false},
  },
};

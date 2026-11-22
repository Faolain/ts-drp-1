import baseline from "/private/tmp/issuance-projection-journal-baseline.config.mts";
export default {
  ...baseline,
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

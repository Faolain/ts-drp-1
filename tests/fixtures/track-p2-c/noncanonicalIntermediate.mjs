const invalidReducer = ({ state }) => ({ output: null, state: { "value": state, "\uD800": "present" } });
const unchangedReducer = ({ state }) => ({ output: null, state });
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "counter.v1::noncanonicalIntermediate",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "add": invalidReducer, "read-value": unchangedReducer, "set": unchangedReducer }
};

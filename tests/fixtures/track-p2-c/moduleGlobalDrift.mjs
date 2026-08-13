let ordinal = 0;
const driftReducer = ({ state }) => ({ output: ++ordinal, state });
const unchangedReducer = ({ state }) => ({ output: null, state });
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "counter.v1::moduleGlobalDrift",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "add": driftReducer, "read-value": unchangedReducer, "set": unchangedReducer }
};

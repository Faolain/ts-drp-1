const sparseReducer = ({ state }) => {
  const sparse = [];
  sparse[1] = state;
  return { output: null, state: sparse };
};
const unchangedReducer = ({ state }) => ({ output: null, state });
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "counter.v1::sparseIntermediate",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "add": sparseReducer, "read-value": unchangedReducer, "set": unchangedReducer }
};

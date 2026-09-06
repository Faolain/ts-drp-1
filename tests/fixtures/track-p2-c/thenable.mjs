const thenableReducer = () => ({
  then(resolve) {
    resolve({ output: null, state: 0 });
  }
});
const unchangedReducer = ({ state }) => ({ output: null, state });
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "counter.v1::thenable",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "add": thenableReducer, "read-value": unchangedReducer, "set": unchangedReducer }
};

function addReducer(input) {
  const value = input.operation.arguments.value ?? 1;
  const state = input.state + value;
  return { output: state, state };
}
function readReducer(input) {
  return { output: input.state, state: input.state };
}
function setReducer(input) {
  const state = input.operation.arguments.value ?? 0;
  return { output: state, state };
}
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "counter.v1",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "add": addReducer, "read-value": readReducer, "set": setReducer }
};

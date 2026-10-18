function clearMessageReducer(input) {
  const state = { message: "", sequence: input.state.sequence };
  return { output: state.message, state };
}
function setMessageReducer(input) {
  const state = {
    message: input.operation.arguments.message,
    sequence: input.operation.arguments.sequence
  };
  return { output: state.message, state };
}
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "message-register.v1",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "clear-message": clearMessageReducer, "set-message": setMessageReducer }
};

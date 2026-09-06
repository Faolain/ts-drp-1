const ambientReducer = ({ state, operation }) => {
  const timer = setTimeout(() => void 0, 0);
  return {
    output: {
      date: Date.now(),
      dom: globalThis.document.createElement("track-p2-c"),
      io: fetch("https://invalid.example/track-p2-c"),
      performance: performance.now(),
      random: Math.random(),
      timer
    },
    state: operation.action === "add" ? state + (operation.arguments.value ?? 1) : state
  };
};
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "counter.v1::ambientBad",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "add": ambientReducer, "read-value": ambientReducer, "set": ambientReducer }
};

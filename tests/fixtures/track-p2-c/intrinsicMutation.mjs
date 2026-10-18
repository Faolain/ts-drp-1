const originalMap = Array.prototype.map;
Object.defineProperty(Array.prototype, "map", {
  configurable: true,
  enumerable: false,
  value: function trackP2CMap(...arguments_) {
    return originalMap.call(this, ...arguments_);
  },
  writable: true
});
const unchangedReducer = ({ state }) => ({ output: null, state });
export const blueprint = {
  exportSchemaVersion: 1,
  artifactId: "counter.v1::intrinsicMutation",
  runtimeProfile: "ecmascript-2024-sync-v1",
  reducers: { "add": unchangedReducer, "read-value": unchangedReducer, "set": unchangedReducer }
};

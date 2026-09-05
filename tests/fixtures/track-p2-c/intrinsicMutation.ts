const originalMap = Array.prototype.map;
Object.defineProperty(Array.prototype, "map", {
	configurable: true,
	enumerable: false,
	value: function trackP2CMap(...arguments_) {
		return originalMap.call(this, ...arguments_);
	},
	writable: true,
});
const unchangedReducer = ({ state }) => ({ output: null, state });

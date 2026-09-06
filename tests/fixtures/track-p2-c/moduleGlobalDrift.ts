let ordinal = 0;
const driftReducer = ({ state }) => ({ output: ++ordinal, state });
const unchangedReducer = ({ state }) => ({ output: null, state });

import { splitSuite } from "./fixtures/track-o/split.js";

// Track O: every split point of the RECIPIENT's steady boundary on the opt-in retention
// path (snapshot turnover, journal, AHE units), with a kill or a refusal between each pair
// of consecutive transactions. See the fixture.
splitSuite("observer", "track-o-split-recipient");

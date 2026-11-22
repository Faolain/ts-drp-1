import { splitSuite } from "./fixtures/track-o/split.js";

// Track O: every split point of the CREATOR's steady boundary on the opt-in retention
// path (snapshot turnover, journal, signing evidence and summaries, AHE units), with a
// kill or a refusal between each pair of consecutive transactions. See the fixture.
splitSuite("creator", "track-o-split-creator");

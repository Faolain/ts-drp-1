import { fileURLToPath } from "node:url";
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([fileURLToPath(new URL("./vitest.codec-red.config.mts", import.meta.url))]);

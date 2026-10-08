import { fileURLToPath } from "node:url";

export default [fileURLToPath(new URL("./vitest.config.mts", import.meta.url))];

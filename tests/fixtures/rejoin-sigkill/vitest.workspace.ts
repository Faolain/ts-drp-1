import { fileURLToPath } from "node:url";

export default [fileURLToPath(new URL("./vitest.config.ts", import.meta.url))];

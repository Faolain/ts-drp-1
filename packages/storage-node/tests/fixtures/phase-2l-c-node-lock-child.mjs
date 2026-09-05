import { DatabaseSync } from "node:sqlite";

const [, , filename] = process.argv;
const database = new DatabaseSync(filename);

try {
	database.exec("BEGIN IMMEDIATE");
	if (typeof process.send === "function") process.send({ kind: "held" });
	process.once("message", () => {
		try {
			database.exec("ROLLBACK");
		} finally {
			database.close();
			process.disconnect?.();
		}
	});
} catch (error) {
	if (typeof process.send === "function") {
		process.send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	}
	process.exitCode = 1;
}

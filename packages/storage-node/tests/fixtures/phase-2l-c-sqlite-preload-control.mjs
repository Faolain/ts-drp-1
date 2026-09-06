import { DatabaseSync } from "node:sqlite";

import { armPhase2lCStatementTrace } from "./phase-2l-c-sqlite-preload.mjs";

const [, , filename, edge] = process.argv;
const database = new DatabaseSync(filename);
database.prepare("PRAGMA journal_mode=WAL").get();

if (edge === "admission-ddl") {
	armPhase2lCStatementTrace({ edge });
	database.exec("BEGIN IMMEDIATE");
	database.exec("CREATE TABLE control_value (id INTEGER PRIMARY KEY) WITHOUT ROWID");
} else if (edge === "commit") {
	database.exec("CREATE TABLE control_value (id INTEGER PRIMARY KEY) WITHOUT ROWID");
	armPhase2lCStatementTrace({ edge });
	database.exec("BEGIN IMMEDIATE");
	database.prepare("INSERT INTO control_value(id) VALUES(?)").run(1);
	database.exec("COMMIT");
} else {
	throw new Error(`unsupported preload control edge ${edge}`);
}

if (typeof process.send === "function") process.send({ kind: "unexpected-result" });

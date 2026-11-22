import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = import.meta.dirname;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const names = readdirSync(root).filter((name) => name !== "manifest.sha256").sort();
writeFileSync(resolve(root, "manifest.sha256"), names.map((name) => hash(readFileSync(resolve(root, name))) + "  " + name + "\n").join(""), { flag: "wx" });
console.log(JSON.stringify({ entries: names.length, sha256: hash(readFileSync(resolve(root, "manifest.sha256"))) }));

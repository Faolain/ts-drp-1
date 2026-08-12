/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const auditPath = process.env.P2_A_READ_AUDIT_PATH;
const readTargets = new Set(
	JSON.parse(process.env.P2_A_READ_AUDIT_TARGETS ?? "[]").map((value) => path.resolve(value))
);
const realpathTargets = new Set(
	JSON.parse(process.env.P2_A_REALPATH_AUDIT_TARGETS ?? "[]").map((value) => path.resolve(value))
);
const mutations = new Map(
	Object.entries(JSON.parse(process.env.P2_A_MUTATE_AFTER_FIRST_READ ?? "{}")).map(([filename, text]) => [
		path.resolve(filename),
		text,
	])
);
const audit = { reads: Object.create(null), realpaths: Object.create(null), renames: [] };
const original = {
	createReadStream: fs.createReadStream,
	open: fs.open,
	openSync: fs.openSync,
	promiseOpen: fs.promises.open.bind(fs.promises),
	promiseReadFile: fs.promises.readFile.bind(fs.promises),
	promiseRealpath: fs.promises.realpath.bind(fs.promises),
	promiseRename: fs.promises.rename.bind(fs.promises),
	readFile: fs.readFile,
	readFileSync: fs.readFileSync,
	realpath: fs.realpath,
	realpathSync: fs.realpathSync,
	rename: fs.rename,
	renameSync: fs.renameSync,
	writeFileSync: fs.writeFileSync,
};

function resolved(value) {
	return path.resolve(value instanceof URL ? value.pathname : String(value));
}

function record(bucket, targets, value) {
	const filename = resolved(value);
	if (targets.has(filename)) bucket[filename] = (bucket[filename] ?? 0) + 1;
	return filename;
}

function mutateAfterRead(filename) {
	const replacement = mutations.get(filename);
	if (replacement !== undefined) {
		mutations.delete(filename);
		original.writeFileSync(filename, replacement, "utf8");
	}
}

fs.readFileSync = function auditedReadFileSync(filename, ...arguments_) {
	const resolvedFilename = record(audit.reads, readTargets, filename);
	const bytes = Reflect.apply(original.readFileSync, fs, [filename, ...arguments_]);
	mutateAfterRead(resolvedFilename);
	return bytes;
};
fs.readFile = function auditedReadFile(filename, ...arguments_) {
	const resolvedFilename = record(audit.reads, readTargets, filename);
	const callback = arguments_.at(-1);
	if (typeof callback === "function") {
		arguments_[arguments_.length - 1] = function auditedCallback(...callbackArguments) {
			mutateAfterRead(resolvedFilename);
			return Reflect.apply(callback, this, callbackArguments);
		};
	}
	return Reflect.apply(original.readFile, fs, [filename, ...arguments_]);
};
fs.promises.readFile = async function auditedPromiseReadFile(filename, ...arguments_) {
	const resolvedFilename = record(audit.reads, readTargets, filename);
	const bytes = await Reflect.apply(original.promiseReadFile, fs.promises, [filename, ...arguments_]);
	mutateAfterRead(resolvedFilename);
	return bytes;
};
fs.openSync = function auditedOpenSync(filename, ...arguments_) {
	record(audit.reads, readTargets, filename);
	return Reflect.apply(original.openSync, fs, [filename, ...arguments_]);
};
fs.open = function auditedOpen(filename, ...arguments_) {
	record(audit.reads, readTargets, filename);
	return Reflect.apply(original.open, fs, [filename, ...arguments_]);
};
fs.promises.open = async function auditedPromiseOpen(filename, ...arguments_) {
	record(audit.reads, readTargets, filename);
	return Reflect.apply(original.promiseOpen, fs.promises, [filename, ...arguments_]);
};
fs.createReadStream = function auditedCreateReadStream(filename, ...arguments_) {
	record(audit.reads, readTargets, filename);
	return Reflect.apply(original.createReadStream, fs, [filename, ...arguments_]);
};
fs.realpathSync = function auditedRealpathSync(filename, ...arguments_) {
	record(audit.realpaths, realpathTargets, filename);
	return Reflect.apply(original.realpathSync, fs, [filename, ...arguments_]);
};
fs.realpath = function auditedRealpath(filename, ...arguments_) {
	record(audit.realpaths, realpathTargets, filename);
	return Reflect.apply(original.realpath, fs, [filename, ...arguments_]);
};
fs.promises.realpath = function auditedPromiseRealpath(filename, ...arguments_) {
	record(audit.realpaths, realpathTargets, filename);
	return Reflect.apply(original.promiseRealpath, fs.promises, [filename, ...arguments_]);
};
fs.renameSync = function auditedRenameSync(from, to, ...arguments_) {
	audit.renames.push({ from: resolved(from), to: resolved(to) });
	return Reflect.apply(original.renameSync, fs, [from, to, ...arguments_]);
};
fs.rename = function auditedRename(from, to, ...arguments_) {
	audit.renames.push({ from: resolved(from), to: resolved(to) });
	return Reflect.apply(original.rename, fs, [from, to, ...arguments_]);
};
fs.promises.rename = function auditedPromiseRename(from, to, ...arguments_) {
	audit.renames.push({ from: resolved(from), to: resolved(to) });
	return Reflect.apply(original.promiseRename, fs.promises, [from, to, ...arguments_]);
};
syncBuiltinESMExports();

process.on("exit", () => {
	if (auditPath !== undefined) original.writeFileSync(auditPath, `${JSON.stringify(audit)}\n`, "utf8");
});

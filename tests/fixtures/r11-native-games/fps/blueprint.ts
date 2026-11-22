// Bounded single-player first-person arena rules. The admitted controller owns
// movement/turn/fire commands; a command never supplies a claimed hit/winner.
// Camera/rendering, real-time scheduling and multiplayer host migration are not
// part of this native lifecycle workload.
function dense(value) {
	if (value === null || typeof value !== "object") return false;
	let n = 0;
	for (const key in value) { if (key !== "" + n) return false; n += 1; }
	return n === value.length;
}
function exact(value, keys) {
	if (value === null || typeof value !== "object" || dense(value)) return false;
	let n = 0;
	for (const key in value) { if (!keys.includes(key)) return false; n += 1; }
	return n === keys.length;
}
function integer(value, lo, hi) {
	if (typeof value !== "number" || value % 1 !== 0 || value < lo || value > hi) throw "FPS integer outside declared workload";
	return value === 0 ? 0 : value;
}
function wall(x, y) { return x < 0 || x > 7 || y < 0 || y > 7 || (x === 3 && (y === 3 || y === 4)); }
function state(value) {
	if (!exact(value, ["version", "kind", "controller", "step", "status", "player", "bot", "history"]) ||
		value.version !== 1 || value.kind !== "fps" || typeof value.controller !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.controller) || !["playing", "won"].includes(value.status) ||
		!exact(value.player, ["x", "y", "heading", "health", "ammo"]) || !exact(value.bot, ["x", "y", "health"])) throw "invalid FPS state";
	const player = { x: integer(value.player.x, 0, 7), y: integer(value.player.y, 0, 7),
		heading: integer(value.player.heading, 0, 3), health: integer(value.player.health, 1, 3), ammo: integer(value.player.ammo, 0, 3) };
	const bot = { x: integer(value.bot.x, 0, 7), y: integer(value.bot.y, 0, 7), health: integer(value.bot.health, 0, 2) };
	if (wall(player.x, player.y) || wall(bot.x, bot.y) || (player.x === bot.x && player.y === bot.y) ||
		(value.status === "won") !== (bot.health === 0)) throw "FPS state has impossible geometry or result";
	const step = integer(value.step, 0, 128), history = [];
	if (!dense(value.history) || value.history.length !== step) throw "FPS bounded transcript differs";
	for (let index = 0; index < step; index++) {
		const row = value.history.at(index);
		if (row.action === "fpsMove" && exact(row, ["action", "step", "forward", "turn"]) && integer(row.step, 0, 127) === index)
			history.push({ action: "fpsMove", step: index, forward: integer(row.forward, 0, 1), turn: integer(row.turn, -1, 1) });
		else if (row.action === "fpsShot" && exact(row, ["action", "step"]) && integer(row.step, 0, 127) === index)
			history.push({ action: "fpsShot", step: index });
		else throw "FPS transcript action differs";
	}
	return { version: 1, kind: "fps", controller: value.controller, step, status: value.status, player, bot, history };
}
function admitted(input, keys) {
	const current = state(input.state), operation = input.operation;
	if (!exact(input.executionContext, ["author"]) || input.executionContext.author !== current.controller ||
		!exact(operation, keys) || integer(operation.step, 0, 127) !== current.step || current.status !== "playing") throw "FPS command is not authorized/current";
	return current;
}
function fpsMoveReducer(input) {
	const current = admitted(input, ["action", "step", "forward", "turn"]), op = input.operation;
	if (op.action !== "fpsMove") throw "FPS movement action differs";
	const turn = integer(op.turn, -1, 1), forward = integer(op.forward, 0, 1);
	const heading = (current.player.heading + turn + 4) % 4;
	const dx = heading === 0 ? 1 : heading === 2 ? -1 : 0;
	const dy = heading === 1 ? 1 : heading === 3 ? -1 : 0;
	const x = current.player.x + dx * forward, y = current.player.y + dy * forward;
	if (wall(x, y) || (x === current.bot.x && y === current.bot.y)) throw "FPS movement collides";
	current.player.x = x; current.player.y = y; current.player.heading = heading; current.step += 1;
	current.history.push({ action: "fpsMove", step: current.step - 1, forward, turn });
	return { state: current, output: { x, y, heading } };
}
function fpsShotReducer(input) {
	const current = admitted(input, ["action", "step"]);
	if (input.operation.action !== "fpsShot" || current.player.ammo === 0) throw "FPS shot is unavailable";
	const heading = current.player.heading;
	const dx = heading === 0 ? 1 : heading === 2 ? -1 : 0;
	const dy = heading === 1 ? 1 : heading === 3 ? -1 : 0;
	let x = current.player.x, y = current.player.y, hit = false;
	// The finite arena bounds line-of-fire work; no ray can traverse history.
	for (let distance = 1; distance <= 7; distance++) {
		x += dx; y += dy;
		if (wall(x, y)) break;
		if (x === current.bot.x && y === current.bot.y) { hit = true; break; }
	}
	current.player.ammo -= 1; current.step += 1;
	current.history.push({ action: "fpsShot", step: current.step - 1 });
	if (hit) current.bot.health -= 1;
	if (current.bot.health === 0) current.status = "won";
	return { state: current, output: { hit, winner: current.status === "won" ? "player" : null } };
}
function causalJoinReducer(input) { return { state: state(input.state), output: null }; }

// Genuine orthodox board/piece/turn/check/checkmate rules for bounded short
// hot-seat games. Castling, en passant and draw adjudication are intentionally
// not supported by this workload; Fool's Mate uses none of those moves.
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
	if (typeof value !== "number" || value % 1 !== 0 || value < lo || value > hi) throw "chess integer outside declared workload";
	return value === 0 ? 0 : value;
}
function abs(value) { return value < 0 ? -value : value; }
function color(piece) { return "PNBRQK".includes(piece) ? 1 : "pnbrqk".includes(piece) ? -1 : 0; }
function square(value) {
	if (typeof value !== "string" || !/^[a-h][1-8]$/.test(value)) throw "invalid chess square";
	return "abcdefgh".indexOf(value[0]) + ("12345678".indexOf(value[1])) * 8;
}
function state(value) {
	if (!exact(value, ["version", "kind", "controller", "board", "turn", "ply", "status", "winner", "history"]) || value.version !== 1 || value.kind !== "chess" ||
		typeof value.controller !== "string" || !/^[0-9a-f]{64}$/.test(value.controller) ||
		typeof value.board !== "string" || value.board.length !== 64 || !/^[.PNBRQKpnbrqk]{64}$/.test(value.board) ||
		(value.turn !== 1 && value.turn !== -1) || !["playing", "checkmate", "stalemate"].includes(value.status) ||
		![0, 1, -1].includes(value.winner)) throw "invalid chess state";
	let whiteKing = 0, blackKing = 0;
	for (const piece of value.board) { if (piece === "K") whiteKing += 1; if (piece === "k") blackKing += 1; }
	if (whiteKing !== 1 || blackKing !== 1 || (value.status === "checkmate") !== (value.winner !== 0)) throw "invalid chess king/result";
	const ply = integer(value.ply, 0, 128), history = [];
	if (!dense(value.history) || value.history.length !== ply) throw "chess bounded transcript differs";
	for (let index = 0; index < ply; index++) {
		const row = value.history.at(index);
		if (!exact(row, ["action", "ply", "from", "to"]) || row.action !== "chessMove" || integer(row.ply, 0, 127) !== index) throw "chess transcript action differs";
		square(row.from); square(row.to); history.push({ action: "chessMove", ply: index, from: row.from, to: row.to });
	}
	return { version: 1, kind: "chess", controller: value.controller, board: value.board,
		turn: value.turn, ply, status: value.status, winner: value.winner, history };
}
function pathClear(board, from, to) {
	const fx = from % 8, fy = (from - fx) / 8, tx = to % 8, ty = (to - tx) / 8;
	const dx = tx > fx ? 1 : tx < fx ? -1 : 0, dy = ty > fy ? 1 : ty < fy ? -1 : 0;
	let x = fx + dx, y = fy + dy;
	for (let step = 0; step < 7; step++) {
		if (x === tx && y === ty) return true;
		if (board[x + y * 8] !== ".") return false;
		x += dx; y += dy;
	}
	return false;
}
function attacks(board, from, to) {
	if (from === to) return false;
	const piece = board.at(from), side = color(piece);
	if (side === 0) return false;
	const fx = from % 8, fy = (from - fx) / 8, tx = to % 8, ty = (to - tx) / 8, dx = tx - fx, dy = ty - fy;
	const kind = piece.toUpperCase();
	if (kind === "P") return abs(dx) === 1 && dy === side;
	if (kind === "N") return (abs(dx) === 1 && abs(dy) === 2) || (abs(dx) === 2 && abs(dy) === 1);
	if (kind === "K") return abs(dx) <= 1 && abs(dy) <= 1;
	if (kind === "B") return abs(dx) === abs(dy) && pathClear(board, from, to);
	if (kind === "R") return (dx === 0 || dy === 0) && pathClear(board, from, to);
	return (dx === 0 || dy === 0 || abs(dx) === abs(dy)) && pathClear(board, from, to);
}
function inCheck(board, side) {
	const king = board.indexOf(side === 1 ? "K" : "k");
	if (king < 0) throw "chess king missing";
	for (let from = 0; from < 64; from++) if (color(board.at(from)) === -side && attacks(board, from, king)) return true;
	return false;
}
function ordinaryMove(board, from, to, side) {
	if (from === to || color(board.at(from)) !== side || color(board.at(to)) === side || board.at(to).toUpperCase() === "K") return null;
	const piece = board.at(from), fx = from % 8, fy = (from - fx) / 8, tx = to % 8, ty = (to - tx) / 8;
	let allowed = attacks(board, from, to);
	if (piece.toUpperCase() === "P") {
		allowed = fx === tx && board[to] === "." && (ty - fy === side ||
			(fy === (side === 1 ? 1 : 6) && ty - fy === side * 2 && board[from + side * 8] === "."));
		if (abs(tx - fx) === 1 && ty - fy === side && color(board.at(to)) === -side) allowed = true;
	}
	if (!allowed) return null;
	const next = board.slice(); next[from] = ".";
	// Automatic queen promotion is the supported promotion choice in this
	// workload. Its short acceptance game does not reach promotion.
	next[to] = piece.toUpperCase() === "P" && (ty === 0 || ty === 7) ? (side === 1 ? "Q" : "q") : piece;
	return inCheck(next, side) ? null : next;
}
function hasOrdinaryMove(board, side) {
	// Fixed board domains bound checkmate search independently of session age.
	for (let from = 0; from < 64; from++) {
		if (color(board.at(from)) !== side) continue;
		for (let to = 0; to < 64; to++) if (ordinaryMove(board, from, to, side) !== null) return true;
	}
	return false;
}
function chessMoveReducer(input) {
	const current = state(input.state), op = input.operation;
	if (!exact(input.executionContext, ["author"]) || input.executionContext.author !== current.controller ||
		!exact(op, ["action", "ply", "from", "to"]) || op.action !== "chessMove" ||
		integer(op.ply, 0, 127) !== current.ply || current.status !== "playing") throw "chess move is not authorized/current";
	const board = current.board.split(""), moved = ordinaryMove(board, square(op.from), square(op.to), current.turn);
	if (moved === null) throw "illegal chess move";
	const nextSide = -current.turn, legal = hasOrdinaryMove(moved, nextSide), checked = inCheck(moved, nextSide);
	const status = legal ? "playing" : checked ? "checkmate" : "stalemate";
	current.history.push({ action: "chessMove", ply: current.ply, from: op.from, to: op.to });
	return { state: { ...current, board: moved.join(""), turn: nextSide, ply: current.ply + 1,
		status, winner: status === "checkmate" ? current.turn : 0 }, output: { from: op.from, to: op.to, status } };
}
function causalJoinReducer(input) { return { state: state(input.state), output: null }; }

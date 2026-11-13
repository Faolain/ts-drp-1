import type { V3ZoneApi } from "./v3-zone";

/**
 * Bind the page's zone controls (create, join, copy invite, WASD moves) to a zone, on the main
 * thread or in a room worker.
 * @param zone The zone's page API.
 */
export function bindControls(zone: Pick<V3ZoneApi, "create" | "join" | "move" | "snapshot">): void {
	const createButton = document.getElementById("createGrid");
	const joinButton = document.getElementById("joinGrid");
	const gridInput = document.getElementById("gridInput");
	const enrollmentInput = document.getElementById("zoneMemberEnrollment");
	const copyButton = document.getElementById("copyGridId");
	if (
		!(createButton instanceof HTMLButtonElement) ||
		!(joinButton instanceof HTMLButtonElement) ||
		!(gridInput instanceof HTMLInputElement) ||
		!(enrollmentInput instanceof HTMLInputElement) ||
		!(copyButton instanceof HTMLButtonElement)
	) {
		throw new TypeError("v3 zone controls are unavailable");
	}
	createButton.addEventListener("click", () => {
		void zone.create(enrollmentInput.value).catch((error: unknown) => console.error("Failed to create v3 zone", error));
	});
	joinButton.addEventListener("click", () => {
		void zone.join(gridInput.value).catch((error: unknown) => console.error("Failed to join v3 zone", error));
	});
	gridInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") joinButton.click();
	});
	document.addEventListener("keydown", (event) => {
		if (
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement ||
			event.target instanceof HTMLSelectElement
		) {
			return;
		}
		// move() checks the live room/channel owner. Readiness must not build the
		// complete diagnostic/ACL/durable-digest snapshot on every input event.
		if (event.key === "w") zone.move(0, 1);
		if (event.key === "a") zone.move(-1, 0);
		if (event.key === "s") zone.move(0, -1);
		if (event.key === "d") zone.move(1, 0);
	});
	copyButton.addEventListener("click", () => {
		void navigator.clipboard.writeText(zone.snapshot().invite);
	});
}

import fs from "node:fs";

/**
 *
 */
export default function globalTeardown(): void {
	const assetDirectory = process.env.PHASE_2B_ASSET_DIR;
	if (assetDirectory !== undefined) fs.rmSync(assetDirectory, { recursive: true, force: true });
}

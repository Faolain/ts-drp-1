const releaseAt = performance.now() + 1_500;
while (performance.now() < releaseAt) {
	// The real gate intentionally delays module evaluation before ready installation.
}

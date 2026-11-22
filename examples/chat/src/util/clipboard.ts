import { showToast, ToastType } from "./toast";

/**
 * Setup the copy button
 * @returns Joined-lifecycle teardown for listeners, observer and reset timer.
 */
export function setupCopyButton(): () => void {
	const copyButton = document.getElementById("copyButton") as HTMLButtonElement;
	const chatIdElement = document.getElementById("chatId") as HTMLDivElement;

	if (!copyButton || !chatIdElement) return () => undefined;
	const status = document.getElementById("copyChatStatus");
	let accepting = true;
	let reset: ReturnType<typeof setTimeout> | undefined;

	// Initially hide the button
	copyButton.style.display = "none";

	// Function to handle copy
	const copyToClipboard = async (): Promise<void> => {
		const textToCopy = chatIdElement.getAttribute("data-invite") || "";
		if (!accepting || textToCopy === "") return;

		try {
			await navigator.clipboard.writeText(textToCopy);
			if (!accepting) return;
			copyButton.classList.add("copied");
			if (status !== null) status.textContent = "Signed chat invite copied.";

			// Reset the button state after 2 seconds
			if (reset !== undefined) clearTimeout(reset);
			reset = setTimeout(() => {
				copyButton.classList.remove("copied");
			}, 2000);

			showToast("Copied to clipboard!", ToastType.INFO, 2000);
		} catch (_err) {
			if (!accepting) return;
			if (status !== null)
				status.textContent = "Could not copy the signed chat invite. It remains visible for manual copying.";
			showToast("Could not copy. Use the visible signed invite for manual copying.", ToastType.ERROR, 3000);
		}
	};

	// Add click handler
	const click = (): void => {
		void copyToClipboard();
	};
	copyButton.addEventListener("click", click);

	// Create an observer to watch for changes in the chatId element
	const observer = new MutationObserver((mutations) => {
		mutations.forEach((mutation) => {
			if (mutation.type === "childList" || mutation.type === "attributes") {
				// Show/hide button based on whether there's content
				const hasContent = (chatIdElement.getAttribute("data-invite")?.length ?? 0) > 0;
				copyButton.style.display = hasContent ? "block" : "none";
			}
		});
	});

	// Start observing the chatId element
	observer.observe(chatIdElement, { childList: true, attributes: true, attributeFilter: ["data-invite"] });
	return () => {
		accepting = false;
		observer.disconnect();
		copyButton.removeEventListener("click", click);
		if (reset !== undefined) clearTimeout(reset);
	};
}

/**
 * Copy to clipboard
 * @param text - The text to copy
 */
export async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		showToast("Copied to clipboard!", ToastType.INFO, 2000);
	} catch (_err) {
		showToast("Failed to copy to clipboard", ToastType.ERROR, 3000);
	}
}

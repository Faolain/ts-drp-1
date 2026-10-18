import { context } from "@opentelemetry/api";

/**
 * Initializes and enables the Zone-based context manager for OpenTelemetry.
 */
export const initContextManager = async (): Promise<void> => {
	// The dependency patches promises and browser callbacks at evaluation time.
	// Load it only after explicit tracing enablement, never during SDK import.
	const { ZoneContextManager } = await import("@opentelemetry/context-zone");
	const contextManager = new ZoneContextManager();
	contextManager.enable();
	context.setGlobalContextManager(contextManager);
};

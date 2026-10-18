declare module "rollback-observer-under-test" {
	export const authenticateCreatorClosedRollbackData: undefined | ((input: unknown) => Promise<unknown>);
	export const resolveCreatorClosedRollbackDataObservation: undefined | ((value: unknown) => unknown);
}

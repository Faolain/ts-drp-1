import { environment, request } from "./browser-owner.js";
import { type RoleCase, roleRun, roleSetup } from "./role-contract.js";

Object.assign(globalThis, {
	boundedRoleSetup: (name: string, selected: RoleCase): Promise<unknown> => roleSetup(selected, environment(name)),
	boundedRoleRun: (name: string, selected: RoleCase): Promise<unknown> => roleRun(selected, environment(name)),
	boundedRoleDelete: (name: string): Promise<unknown> => request(indexedDB.deleteDatabase(name)),
});

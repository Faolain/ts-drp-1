import { reportInertRole } from "./inert-role.js";

reportInertRole("crash");
setInterval(() => undefined, 2_147_483_647);

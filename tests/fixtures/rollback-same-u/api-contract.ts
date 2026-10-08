import type { AheBoundedActiveRead } from "@ts-drp/storage";

import type { AccountingFactory, ProofAccounting } from "./contract.js";
import { createCreatorClosedRollbackProofAccounting } from "../../../packages/node/src/internal/creator-closed-rollback-data.js";

const factory: AccountingFactory = createCreatorClosedRollbackProofAccounting;
const owner: ProofAccounting = factory([] as AheBoundedActiveRead["blobs"]);
owner.charge(new Uint8Array(1));
// @ts-expect-error There is no caller-selected second U or budget authority.
factory([], 262144);
// @ts-expect-error Accounting cannot reset its fixed operation budget.
owner.chargedBytes = 0;
// @ts-expect-error Byte charging takes no domain label or identity hint.
owner.charge(new Uint8Array(1), "ts-drp/epoch-anchor/v3");

import type { IFinalityState } from "@ts-drp/types";
import { expectTypeOf } from "vitest";

expectTypeOf<IFinalityState["addSignature"]>().returns.toEqualTypeOf<boolean>();

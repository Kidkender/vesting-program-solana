import { BN } from "@coral-xyz/anchor";
import { toRawUnitFromBN } from "./utils";

// Constants
export const DECIMALS = 6;
export const TOTAL_AMOUNT_INIT = toRawUnitFromBN(new BN(15_000_000_000));
export const BUFFER_SECONDS = 15;
export const START_TIME = Math.floor(Date.now() / 1000) + BUFFER_SECONDS;
export const SECOND_PER_MONTH = BigInt(2629776);

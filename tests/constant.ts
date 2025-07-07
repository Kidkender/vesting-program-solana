import { toRawUnit } from "./utils";

// Constants
export const DECIMALS = 6;
export const TOTAL_AMOUNT_INIT = toRawUnit(15_000);
export const BUFFER_SECONDS = 5;
export const START_TIME = Math.floor(Date.now() / 1000) + BUFFER_SECONDS;
export const SECOND_PER_MONTH = BigInt(2629776);

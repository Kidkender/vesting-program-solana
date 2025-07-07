// Kiểm tra tràn số và các vấn đề liên quan

console.log("=== CHECKING FOR OVERFLOW ISSUES ===");

// 1. Kiểm tra giới hạn JavaScript Number
const jsMaxSafeInteger = Number.MAX_SAFE_INTEGER;
const targetAmount = 10500000000000000;
const actualAmount = 70526629399845;

console.log("JavaScript Number.MAX_SAFE_INTEGER:", jsMaxSafeInteger);
console.log("Target amount:", targetAmount);
console.log("Is target > MAX_SAFE_INTEGER?", targetAmount > jsMaxSafeInteger);

// 2. Kiểm tra BigInt conversion
const targetBigInt = BigInt("10500000000000000");
const actualBigInt = BigInt("70526629399845");

console.log("\nBigInt values:");
console.log("Target BigInt:", targetBigInt.toString());
console.log("Actual BigInt:", actualBigInt.toString());

// 3. Kiểm tra u64 limit (Solana token amounts are u64)
const u64Max = BigInt("18446744073709551615"); // 2^64 - 1
console.log("\nU64 limits:");
console.log("U64 MAX:", u64Max.toString());
console.log("Target < U64 MAX?", targetBigInt < u64Max);

// 4. Kiểm tra có pattern overflow không
const ratio = Number(actualBigInt) / Number(targetBigInt);
console.log("\nOverflow pattern analysis:");
console.log("Ratio (actual/target):", ratio);
console.log("Ratio as percentage:", (ratio * 100).toFixed(6) + "%");

// 5. Kiểm tra bit patterns
console.log("\nBit pattern analysis:");
console.log("Target in hex:", targetBigInt.toString(16));
console.log("Actual in hex:", actualBigInt.toString(16));

// 6. Kiểm tra có phải 32-bit overflow không
const int32Max = 2147483647;
const uint32Max = 4294967295;
console.log("\n32-bit overflow check:");
console.log("INT32_MAX:", int32Max);
console.log("UINT32_MAX:", uint32Max);
console.log("Target > UINT32_MAX?", targetAmount > uint32Max);

// 7. Tính toán có thể bị overflow
const difference = targetBigInt - actualBigInt;
console.log("\nDifference analysis:");
console.log("Difference:", difference.toString());
console.log("Missing amount:", difference.toString());

// 8. Kiểm tra decimal conversion
const decimals = 6;
const tokenAmount = 10500000000; // 10.5B tokens
const rawAmount = tokenAmount * Math.pow(10, decimals);
console.log("\nDecimal conversion check:");
console.log("Token amount:", tokenAmount);
console.log("Raw amount (JS Number):", rawAmount);
console.log("Raw amount matches target?", rawAmount === targetAmount);

// 9. Safe BigInt conversion
const safeBigIntConversion =
  BigInt(tokenAmount) * BigInt(Math.pow(10, decimals));
console.log("Safe BigInt conversion:", safeBigIntConversion.toString());
console.log(
  "Safe conversion matches target?",
  safeBigIntConversion === targetBigInt
);

// 10. Kiểm tra có phải lỗi trong toRawUnit function không
function toRawUnitFixed(amount: number, decimals: number = 6): BigInt {
  return BigInt(amount) * BigInt(10) ** BigInt(decimals);
}

const fixedRawAmount = toRawUnitFixed(10500000000, 6);
console.log("\nFixed toRawUnit result:", fixedRawAmount.toString());
console.log("Fixed matches target?", fixedRawAmount === targetBigInt);

// 11. Possible overflow scenarios
console.log("\n=== POSSIBLE OVERFLOW SCENARIOS ===");
console.log("1. JavaScript Number precision loss");
console.log("2. 32-bit integer overflow in some calculation");
console.log("3. Solana runtime u64 conversion issue");
console.log("4. BN.js overflow in Anchor");
console.log("5. SPL Token instruction parameter overflow");

// 12. Recommended fixes
console.log("\n=== RECOMMENDED FIXES ===");
console.log("1. Use only BigInt for large numbers");
console.log("2. Avoid JavaScript Number for amounts > MAX_SAFE_INTEGER");
console.log("3. Use string literals for BigInt construction");
console.log("4. Check BN.js usage in your code");

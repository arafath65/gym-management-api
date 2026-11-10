require("dotenv").config();

const crypto = require("crypto");
const readline = require("readline");
const db = require("../src/config/db");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question) =>
  new Promise((resolve) => rl.question(question, resolve));

const hashValue = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

async function main() {
  try {
    const organizationId = Number(
      await ask("Organization ID: ")
    );

    const branchIdInput = await ask(
      "Registered branch ID (blank for none): "
    );

    const branchId = branchIdInput.trim()
      ? Number(branchIdInput)
      : null;

    const deviceUuid = (
      await ask("Device UUID: ")
    ).trim();

    const deviceName = (
      await ask("Device name: ")
    ).trim();

    const deviceType = (
      await ask("Device type (android_tablet/android_mobile/other): ")
    ).trim();

    if (
      !Number.isInteger(organizationId) ||
      organizationId <= 0 ||
      !deviceUuid ||
      !deviceName ||
      !["android_tablet", "android_mobile", "other"].includes(deviceType)
    ) {
      throw new Error("Invalid input");
    }

    const activationCode = crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase();

    const activationCodeHash = hashValue(activationCode);

    const [result] = await db.query(
      `INSERT INTO devices (
         organization_id,
         registered_branch_id,
         device_uuid,
         device_name,
         device_type,
         status,
         activation_code_hash,
         activation_expires_at
       )
       VALUES (?, ?, ?, ?, ?, 'pending', ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
      [
        organizationId,
        branchId,
        deviceUuid,
        deviceName,
        deviceType,
        activationCodeHash,
      ]
    );

    console.log("\nDevice registered as pending.");
    console.log("Device ID:", result.insertId);
    console.log("Activation code:", activationCode);
    console.log("Expires in 15 minutes.");
    console.log("\nUse this code in the Flutter app to activate the device.");
  } catch (error) {
    console.error("Device registration failed:", error.message);
  } finally {
    rl.close();
    await db.end();
  }
}

main();
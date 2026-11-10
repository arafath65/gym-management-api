
require("dotenv").config();

const bcrypt = require("bcrypt");
const db = require("../src/config/db");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question) =>
  new Promise((resolve) => rl.question(question, resolve));

async function createPlatformAdmin() {
  try {
    const fullName = (await ask("Super Admin full name: ")).trim();
    const email = (await ask("Super Admin email: ")).trim().toLowerCase();
    const password = await ask("Super Admin password: ");

    if (!fullName || !email || !password) {
      console.log("Name, email, and password are required.");
      return;
    }

    if (password.length < 8) {
      console.log("Password must be at least 8 characters.");
      return;
    }

    const [existing] = await db.query(
      "SELECT id FROM platform_admins WHERE email = ? LIMIT 1",
      [email]
    );

    if (existing.length > 0) {
      console.log("A Super Admin with this email already exists.");
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [result] = await db.query(
      `INSERT INTO platform_admins
       (full_name, email, password_hash, status)
       VALUES (?, ?, ?, 'active')`,
      [fullName, email, passwordHash]
    );

    console.log("\nSuper Admin created successfully.");
    console.log("Admin ID:", result.insertId);
    console.log("Name:", fullName);
    console.log("Email:", email);
    console.log("Password stored as a bcrypt hash.");
  } catch (error) {
    console.error("Super Admin creation failed:", error.message);
  } finally {
    rl.close();
    await db.end();
  }
}

createPlatformAdmin();

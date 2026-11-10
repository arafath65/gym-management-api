require("dotenv").config();

const express = require("express");
const cors = require("cors");
const db = require("./config/db");
const organizationRoutes = require("./routes/organizationRoutes");
const branchRoutes = require("./routes/branchRoutes");
const deviceRoutes = require("./routes/deviceRoutes");

const platformAdminRoutes = require("./routes/platformAdminRoutes");
const licenseRoutes = require("./routes/licenseRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/organizations", organizationRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/devices", deviceRoutes);

app.use("/api/platform-admin", platformAdminRoutes);
app.use("/api/licenses", licenseRoutes);


app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Innovex Gym Management API is running",
  });
});

app.get("/api/health", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS database_connected");

    res.json({
      success: true,
      api: "connected",
      database: rows[0].database_connected === 1 ? "connected" : "error",
    });
  } catch (error) {
    console.error("Database connection error:", error.message);

    res.status(500).json({
      success: false,
      api: "running",
      database: "disconnected",
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Gym Management API running at http://localhost:${PORT}`);
});
const db = require("../src/config/db");

const {
  syncAllGymAdminRolePermissions,
} = require("../src/services/gymAdminPermissionService");

const main = async () => {
  let connection;

  try {
    connection = await db.getConnection();

    await connection.beginTransaction();

    const result = await syncAllGymAdminRolePermissions(connection);

    await connection.commit();

    console.log("\nGym Admin permission synchronization completed.");

    console.log(
      JSON.stringify(
        {
          success: true,
          organizationsProcessed: result.organizationsProcessed,
          results: result.results,
        },
        null,
        2
      )
    );
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Rollback failed:", rollbackError.message);
      }
    }

    console.error(
      "Gym Admin permission synchronization failed:",
      error
    );

    process.exitCode = 1;
  } finally {
    if (connection) {
      connection.release();
    }

    await db.end();
  }
};

main();
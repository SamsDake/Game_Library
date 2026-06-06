import { Database } from "../server/src/db";

async function main() {
  const db = new Database(process.env.DATABASE_URL);
  if (!db.enabled) {
    console.warn("DATABASE_URL is not set; migration skipped.");
    return;
  }
  await db.migrate();
  await db.close();
  console.log("PostGIS migration complete.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

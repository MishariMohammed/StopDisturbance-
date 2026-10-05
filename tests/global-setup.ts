import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://sd:sd@localhost:5432/stopdisturbance_test";
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url, DATABASE_URL_DIRECT: url }, stdio: "ignore" });
}

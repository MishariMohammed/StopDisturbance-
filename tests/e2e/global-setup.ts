import { seed } from "./seed";

export default async function globalSetup() {
  try {
    process.loadEnvFile?.(".env");
  } catch {}
  await seed();
}

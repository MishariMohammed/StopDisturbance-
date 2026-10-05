import { randomBytes } from "node:crypto";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sd:sd@localhost:5432/stopdisturbance_test";
process.env.DATABASE_URL_DIRECT = process.env.DATABASE_URL;
process.env.APP_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-123";
process.env.OWNER_EMAILS = "owner@gmail.com, Owner@Outlook.com";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";
process.env.TOKEN_ENC_KEYS = JSON.stringify({ "1": randomBytes(32).toString("base64"), "2": randomBytes(32).toString("base64") });
process.env.TOKEN_ENC_KEY_CURRENT = "1";
process.env.LOG_LEVEL = "silent";

import { beforeEach, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";
import { checkAndPinSubject, isOwnerEmail } from "@/lib/auth/owner";
import { db } from "@/lib/db";
import { resetDb } from "./helpers";

beforeEach(resetDb);

describe("owner allow-list", () => {
  it("matches configured emails case-insensitively", () => {
    expect(isOwnerEmail("OWNER@gmail.com")).toBe(true);
    expect(isOwnerEmail("owner@outlook.com")).toBe(true);
    expect(isOwnerEmail("someone@gmail.com")).toBe(false);
    expect(isOwnerEmail(undefined)).toBe(false);
  });

  it("rejects a non-owner at user creation (403)", async () => {
    const hook = auth().options.databaseHooks!.user!.create!.before!;
    await expect(
      hook({ id: "u1", email: "intruder@gmail.com", name: "x", emailVerified: true, createdAt: new Date(), updatedAt: new Date() }, null),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      hook({ id: "u2", email: "owner@gmail.com", name: "o", emailVerified: true, createdAt: new Date(), updatedAt: new Date() }, null),
    ).resolves.toBeUndefined();
  });

  it("rejects a session for a user no longer on the list", async () => {
    await db.user.create({ data: { id: "u3", email: "former@gmail.com", name: "f" } });
    const hook = auth().options.databaseHooks!.session!.create!.before!;
    await expect(
      hook({ id: "s", userId: "u3", token: "t", expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date() }, null),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("pins the first Google subject and refuses a different one", async () => {
    expect(await checkAndPinSubject("google", "sub-1")).toBe(true);
    expect(await checkAndPinSubject("google", "sub-1")).toBe(true);
    expect(await checkAndPinSubject("google", "sub-2")).toBe(false);
    expect(await checkAndPinSubject("microsoft", "oid-1")).toBe(true);
    expect(await checkAndPinSubject("github", "x")).toBe(false);
  });
});

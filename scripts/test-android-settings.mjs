#!/usr/bin/env node
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
if (!packageRoot) throw new Error("usage: node scripts/test-android-settings.mjs <dsh-package-directory>");
const work = await mkdtemp(join(tmpdir(), "dsh-android-settings-test-"));
await mkdir(join(work, "node_modules", "@deepseek-ai"), { recursive: true });
await symlink(resolve(packageRoot, "node_modules/@deepseek-ai/dsh-atomic-write"),
  join(work, "node_modules/@deepseek-ai/dsh-atomic-write"));
await copyFile(new URL("./android-settings-document.mjs", import.meta.url), join(work, "helper.mjs"));
const { prepareAndroidSettingsDocument } = await import(pathToFileURL(join(work, "helper.mjs")));
const original = Object.fromEntries(["HOME", "DSH_ANDROID", "DSH_ANDROID_APP_UID"].map(key => [key, process.env[key]]));
after(async () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(work, { recursive: true, force: true });
});
async function fixture(name) {
  const home = join(work, name);
  const dir = join(home, ".dsh", "profiles", "web");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), "{}\n");
  process.env.HOME = home;
  process.env.DSH_ANDROID = "1";
  process.env.DSH_ANDROID_APP_UID = String(process.getuid());
  return { home, dir, file: join(dir, "cordis.patch.yml") };
}
test("non-Android preparation leaves the desktop opener in control", async () => {
  process.env.DSH_ANDROID = "0";
  assert.equal(await prepareAndroidSettingsDocument("/desktop/settings.yml"), false);
});
test("a fresh active profile gets a valid private YAML patch", async () => {
  const f = await fixture("fresh");
  assert.equal(await prepareAndroidSettingsDocument(f.file), true);
  assert.equal(await readFile(f.file, "utf8"), "[]\n");
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
});
test("existing profile content is preserved across concurrent opens", async () => {
  const f = await fixture("existing");
  const before = "- id: theme\n  config:\n    appearance: dark\n";
  await writeFile(f.file, before, { mode: 0o600 });
  assert.deepEqual(await Promise.all([prepareAndroidSettingsDocument(f.file), prepareAndroidSettingsDocument(f.file)]), [true, true]);
  assert.equal(await readFile(f.file, "utf8"), before);
});
test("arbitrary profile paths are refused", async () => {
  const f = await fixture("path");
  await assert.rejects(prepareAndroidSettingsDocument(join(f.home, "other.yml")), /active web profile/);
});
test("a linked configuration cannot expose another file", async () => {
  const f = await fixture("linked-file");
  const other = join(work, "other.yml");
  await writeFile(other, "private sentinel\n");
  await symlink(other, f.file);
  await assert.rejects(prepareAndroidSettingsDocument(f.file), /app-owned file/);
  assert.equal(await readFile(other, "utf8"), "private sentinel\n");
});
test("a linked profile directory is refused before document creation", async () => {
  const f = await fixture("linked-dir");
  const other = join(work, "outside-profile");
  await mkdir(other);
  await rm(f.dir, { recursive: true });
  await symlink(other, f.dir);
  await assert.rejects(prepareAndroidSettingsDocument(f.file), /app-owned/);
  await assert.rejects(stat(join(other, "cordis.patch.yml")), { code: "ENOENT" });
});
test("an untrusted owner binding cannot open the document", async () => {
  const f = await fixture("owner");
  process.env.DSH_ANDROID_APP_UID = String(process.getuid() + 1);
  await assert.rejects(prepareAndroidSettingsDocument(f.file), /app-owned/);
});

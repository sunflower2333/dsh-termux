import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** Prepare only the active Android profile for the native configuration opener. */
export async function prepareAndroidSettingsDocument(path) {
  if (process.env.DSH_ANDROID !== "1") return false;
  const home = process.env.HOME;
  const uid = Number(process.env.DSH_ANDROID_APP_UID);
  if (!home || !/^\d+$/.test(process.env.DSH_ANDROID_APP_UID || "") || uid < 0) {
    throw new Error("Android configuration owner is unavailable");
  }
  const expected = join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
  if (typeof path !== "string" || path !== expected || resolve(path) !== expected) {
    throw new Error("Android can open only the active web profile configuration");
  }
  for (const directory of [home, join(home, ".dsh"), join(home, ".dsh", "profiles"), dirname(expected)]) {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || await realpath(directory) !== directory) {
      throw new Error("Android configuration directory is not app-owned");
    }
  }
  await withFileLock(join(dirname(expected), "package.json"), async () => {
    let entry;
    try {
      entry = await lstat(expected);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // An unchanged profile need not have a patch yet. Materialize its empty
      // YAML sequence under the same lock used by ConfigEditor, preserving
      // existing configuration rather than replacing it with an export.
      await writeFileAtomic(expected, "[]\n", { mode: 0o600 });
      entry = await lstat(expected);
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid) {
      throw new Error("Android configuration document is not an app-owned file");
    }
  });
  return true;
}

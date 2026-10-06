#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const nativeDocumentsHelper = `
/* dsh-android-workspace-documents-v1 */
async function androidWorkspaceDocuments(configured) {
\tconst directory = configured ?? process.env.DSH_ANDROID_DOCUMENTS_DIR;
\tconst durable = process.env.DSH_ANDROID_DURABLE_ROOT;
\tconst uid = process.env.DSH_ANDROID_APP_UID;
\tif (typeof directory !== "string" || !posix.isAbsolute(directory) || typeof durable !== "string" || !posix.isAbsolute(durable) || posix.normalize(durable) === "/" || !/^\\d+$/.test(uid ?? "") || !Number.isSafeInteger(Number(uid))) throw new Error("Android working directory requires the app-owned Documents directory; no fallback was selected");
\tconst [rootPath, documentPath, documentStat] = await Promise.all([androidWorkspaceRealpath(durable), androidWorkspaceRealpath(directory), androidWorkspaceLstat(directory)]);
\tif (!documentStat.isDirectory() || documentStat.isSymbolicLink() || documentStat.uid !== Number(uid) || documentPath === rootPath || !documentPath.startsWith(rootPath + "/")) throw new Error("Android Documents must be an app-owned directory inside the app data root; no fallback was selected");
\treturn documentPath;
}
`;

export async function patchAndroidWorkspace(root, { nativeShell = false } = {}) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js");
  const source = await readFile(filename, "utf8");
  const marker = "// dsh-android-documents: app-private default workspace";
  if (!source.includes(marker)) {
    const before = "\tlet directory = documentsDirectory;";
    if (source.split(before).length !== 2) throw new Error("Android workspace: expected one Documents resolver");
    const after = `${before}
  \t${marker}
  \tif (directory === void 0 && platform === "android") {
  \t\tdirectory = process.env.DSH_ANDROID_DOCUMENTS_DIR ?? paths.join(internals.home ?? homedir(), "Documents");
  \t}`;
    await writeFile(filename, source.replace(before, after));
  }
  console.log("patched: dsh Android: app-private Documents workspace");
  if (!nativeShell) return;

  function addNativeHelper(source) {
    if (source.includes("/* dsh-android-workspace-documents-v1 */")) return source;
    return 'import { lstat as androidWorkspaceLstat, realpath as androidWorkspaceRealpath } from "node:fs/promises";\n' + source + nativeDocumentsHelper;
  }
  let controller = await readFile(filename, "utf8");
  const controllerMarker = "/* dsh-android-workspace-default-v1 */";
  if (!controller.includes(controllerMarker)) {
    const before = "\tlet directory = documentsDirectory;";
    if (controller.split(before).length !== 2) throw new Error("Android native workspace: unknown default Documents resolver");
    const after = `${before}
\t${controllerMarker}
\tif (platform === "android" && process.env.DSH_ANDROID === "1") directory = await androidWorkspaceDocuments(directory);`;
    controller = addNativeHelper(controller.replace(before, after));
    await writeFile(filename, controller);
  }

  // Android's HOME stores runtime configuration, not working projects. Start
  // the real filesystem browser in Documents and keep explicit browse paths.
  const browseFilename = join(root, "node_modules/@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js");
  const browse = await readFile(browseFilename, "utf8");
  const browseMarker = "/* dsh-android-workspace-browser-v1 */";
  if (!browse.includes(browseMarker)) {
    const before = "\t\tconst home = homedir();";
    if (browse.split(before).length !== 2) throw new Error("Android native workspace: unknown filesystem browser home resolver");
    const after = `\t\t${browseMarker}
\t\tconst home = process.platform === "android" && process.env.DSH_ANDROID === "1" ? await androidWorkspaceDocuments() : homedir();`;
    await writeFile(browseFilename, addNativeHelper(browse.replace(before, after)));
  }
  console.log("patched: Android workspace browser starts in verified app-owned Documents; invalid defaults never fall back");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: patch-android-workspace.mjs <dsh-package-directory>");
  await patchAndroidWorkspace(process.argv[2], { nativeShell: process.argv.includes("--native-shell") });
}

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

const nativeSelectedPathHelper = `
/* dsh-android-workspace-selected-path-v1 */
async function androidSelectedWorkspacePath(requested) {
\tif (typeof requested !== "string" || requested.length < 2 || requested.length > 4096 || !posix.isAbsolute(requested) || /[\\u0000-\\u001f\\u007f]/.test(requested) || requested.split("/").some(part => part === "." || part === "..")) throw new Error("Android workspace requires an absolute local directory path");
\tconst canonical = await androidWorkspaceRealpath(requested);
\tconst directory = await androidWorkspaceLstat(canonical);
\tif (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Android workspace must be a local directory");
\tawait androidWorkspaceAccess(canonical, androidWorkspaceFsConstants.R_OK | androidWorkspaceFsConstants.W_OK | androidWorkspaceFsConstants.X_OK);
\tconst listing = await androidWorkspaceOpendir(canonical);
\tawait listing.close();
\treturn canonical;
}
`;

export async function patchAndroidWorkspaceSelectedPath(root) {
  const filename = join(root, "node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js");
  let source = await readFile(filename, "utf8");
  const marker = "/* dsh-android-workspace-selected-validation-v1 */";
  const updates = [
    ['import { lstat as androidWorkspaceLstat, realpath as androidWorkspaceRealpath } from "node:fs/promises";', 'import { access as androidWorkspaceAccess, lstat as androidWorkspaceLstat, opendir as androidWorkspaceOpendir, realpath as androidWorkspaceRealpath } from "node:fs/promises";\nimport { constants as androidWorkspaceFsConstants } from "node:fs";'],
    ['\t\t\ttry {\n\t\t\t\tconst existing = await this.ctx.workspaceRegistry.resolveByPath(request.path);', '\t\t\ttry {\n\t\t\t\tconst path = process.platform === "android" && process.env.DSH_ANDROID === "1" ? await androidSelectedWorkspacePath(request.path) : request.path;\n\t\t\t\tconst existing = await this.ctx.workspaceRegistry.resolveByPath(path);'],
    ['workspace: workspaceView(await this.ctx.workspaceRegistry.create(request.path)),', 'workspace: workspaceView(await this.ctx.workspaceRegistry.create(path)),'],
  ];
  if (source.includes(marker)) {
    if (source.split(marker).length !== 2 || source.split(nativeSelectedPathHelper).length !== 2 || updates.some(([, replacement]) => source.split(replacement).length !== 2)) throw new Error("Android workspace: damaged selected-path validation patch");
    return;
  }
  for (const [anchor, replacement] of updates) {
    if (source.split(anchor).length !== 2) throw new Error(`Android workspace: unsupported selected-path validation anchor (${anchor.slice(0, 80)})`);
    source = source.replace(anchor, replacement);
  }
  await writeFile(filename, `${marker}\n${source}${nativeSelectedPathHelper}`);
  console.log("patched: Android workspace registration validates readable writable canonical local directories");
}

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
  await patchAndroidWorkspaceSelectedPath(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("usage: patch-android-workspace.mjs <dsh-package-directory>");
  await patchAndroidWorkspace(process.argv[2], { nativeShell: process.argv.includes("--native-shell") });
}

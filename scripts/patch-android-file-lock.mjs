#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function patchAndroidFileLock(root) {
  const filename = join(root, "node_modules/@deepseek-ai/node-addon-system/lib/flock.js");
  const source = await readFile(filename, "utf8");
  if (source.includes("/* dsh-android-file-lock */")) return;
  const anchor = "    const { platform, arch } = process;\n";
  if (source.split(anchor).length !== 2) {
    throw new Error("Android file lock: unknown upstream binding loader");
  }
  const androidBinding = `    /* dsh-android-file-lock */
    if (platform === 'android') {
        const require = createRequire(import.meta.url);
        const koffi = require('koffi');
        const libc = koffi.load('libc.so');
        const flock = libc.func('int flock(int fd, int operation)');
        binding = {
            tryLock(fd, callback) {
                if (typeof fd !== 'number') throw new TypeError('fd must be a number');
                if (!Number.isInteger(fd) || fd < -2147483648 || fd > 2147483647) {
                    throw new RangeError('fd must be a signed C int');
                }
                if (typeof callback !== 'function') throw new TypeError('callback must be a function');
                // Android uses the Linux LOCK_EX | LOCK_NB values. This never
                // waits for another holder. Read errno on the same thread as
                // the syscall before completing the existing asynchronous API.
                const result = flock(fd, 2 | 4);
                const errno = result === 0 ? 0 : koffi.errno();
                queueMicrotask(() => callback(errno));
            },
        };
        return binding;
    }
`;
  await writeFile(filename, source.replace(anchor, anchor + androidBinding));
  console.log("patched: Android session write leases use real Bionic nonblocking flock");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-android-file-lock.mjs <dsh-package-directory>");
  await patchAndroidFileLock(resolve(process.argv[2]));
}

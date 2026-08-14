#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const filename = process.argv[2];
if (!filename) throw new Error("usage: patch-node-pty-gyp.mjs <binding.gyp>");

let source = await readFile(filename, "utf8");
const before = "['OS==\"mac\" or OS==\"solaris\"', {";
const after = "['OS==\"mac\" or OS==\"solaris\" or OS==\"android\"', {";
if (source.split(before).length - 1 !== 1) {
  throw new Error("node-pty: expected one libutil platform condition");
}
source = source.replace(before, after);
await writeFile(filename, source);

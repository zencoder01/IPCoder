import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const outFile = resolve("assets/editor/codemirror.bundle.txt");

await mkdir(dirname(outFile), { recursive: true });

const result = await build({
  entryPoints: [resolve("src/editor/codemirror-entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  write: false,
  minify: true,
  legalComments: "none",
});

const [output] = result.outputFiles;

if (!output?.text) {
  throw new Error("CodeMirror bundle generation failed: no output text produced");
}

await writeFile(outFile, output.text, "utf8");

console.log(`CodeMirror bundle written to ${outFile}`);

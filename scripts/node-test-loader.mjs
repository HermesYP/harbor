import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensions = [".ts", ".tsx", ".js", ".mjs"];

async function existingModuleUrl(basePath) {
  const candidates = [
    basePath,
    ...extensions.map((extension) => `${basePath}${extension}`),
    ...extensions.map((extension) => path.join(basePath, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return pathToFileURL(candidate).href;
    } catch {
      // Continue until a matching source module is found.
    }
  }

  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let sourcePath = null;

  if (specifier.startsWith("@/")) {
    sourcePath = path.join(root, "src", specifier.slice(2));
  } else if (specifier.startsWith(".") && context.parentURL) {
    sourcePath = fileURLToPath(new URL(specifier, context.parentURL));
  }

  if (sourcePath) {
    const url = await existingModuleUrl(sourcePath);
    if (url) return { url, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}

// Static assets imported from source modules resolve to an empty default so
// the surrounding module can be imported in Node tests.
const ASSET_RE = /\.(png|jpe?g|gif|webp|avif|ico|svg|mp4|webm|woff2?|ttf|otf)$/i;

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && ASSET_RE.test(fileURLToPath(url))) {
    return { format: "module", source: 'export default "";', shortCircuit: true };
  }

  // Transpile workspace TypeScript like the .tsx path below: Node's
  // strip-only mode rejects repo patterns such as constructor parameter
  // properties (e.g. anilist/client.ts), which would make those modules
  // unimportable from behavioral tests.
  const filePath = url.startsWith("file:") ? fileURLToPath(url) : "";
  if (
    (url.endsWith(".ts") || url.endsWith(".tsx")) &&
    filePath &&
    !filePath.includes("node_modules")
  ) {
    let source = await readFile(filePath, "utf8");
    // Vite injects import.meta.env; Node has no equivalent, and modules that
    // read it (config/endpoints.ts) would otherwise crash at import time and
    // stay untestable. Tests may set globalThis.__HARBOR_TEST_ENV__.
    source = source.replace(
      /import\.meta\.env\b/g,
      "(globalThis.__HARBOR_TEST_ENV__ ?? {})",
    );
    const output = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: filePath,
    });
    return { format: "module", source: output.outputText, shortCircuit: true };
  }

  return nextLoad(url, context);
}

// Lets `node --experimental-strip-types` run the app's .ts modules in tests
// and scripts: they import siblings without an extension ("./roleTag"), as
// Next expects. On "module not found" for a relative import, retry with .ts.
import { register } from "node:module";

const hook = `
  const EXTS = [".ts", ".js", ".mjs", ".cjs", ".json"];
  export async function resolve(specifier, context, next) {
    try {
      return await next(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (err && err.code === "ERR_MODULE_NOT_FOUND" && relative && !EXTS.some((e) => specifier.endsWith(e))) {
        return next(specifier + ".ts", context);
      }
      throw err;
    }
  }
`;

register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

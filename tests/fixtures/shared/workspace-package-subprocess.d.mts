/**
 * Resolves exact import-only package exports from one workspace package graph,
 * then executes a separate fresh Node child with only those resolved file URLs.
 * @param input - Exact child, package anchor, expected export targets and Node arguments.
 * @returns Exact UTF-8 child stdout.
 */
export function runWorkspacePackageSubprocess(input: any): Buffer<ArrayBufferLike> & string;
/**
 * Creates a fresh-process Node import hook bound to exact freshly built files.
 * @param input - Bare specifiers mapped to their exact built targets.
 * @returns One `--import` argument that registers the closed resolver.
 */
export function workspacePackageImportHook(input: any): string;
//# sourceMappingURL=workspace-package-subprocess.d.mts.map
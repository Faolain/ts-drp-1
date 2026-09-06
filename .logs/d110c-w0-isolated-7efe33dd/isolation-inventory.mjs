import fs from 'node:fs';
import path from 'node:path';
import { root as main, read, write, hash } from './common.mjs';
const { root } = read('checkout.json');
const symlinks = [], builtFiles = [];
const visit = (directory, collectBuilt = false) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const physical = fs.realpathSync(file);
      if (!physical.startsWith(root + '/')) throw Error('Isolated dependency symlink escapes checkout: ' + file);
      symlinks.push({ file: path.relative(root, file), physical });
    } else if (entry.isDirectory()) visit(file, collectBuilt);
    else if (entry.isFile() && collectBuilt) builtFiles.push({ file: path.relative(root, file), physical: fs.realpathSync(file), sha256: hash(fs.readFileSync(file)) });
  }
};
visit(path.join(root, 'node_modules'));
for (const group of ['packages', 'examples']) for (const entry of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageRoot = path.join(root, group, entry.name);
  if (fs.existsSync(path.join(packageRoot, 'node_modules'))) visit(path.join(packageRoot, 'node_modules'));
  if (fs.existsSync(path.join(packageRoot, 'dist'))) visit(path.join(packageRoot, 'dist'), true);
}
const regression = JSON.parse(fs.readFileSync(path.join(main, '.logs/d110c-w0-regression-readiness-7efe33dd/runtime-roster.json')));
const graph = read('graph-comparison.json');
const excludedAmbient = new Set(graph.mainOnlySources.map(source => source.physical));
const remappedRuntimeInputs = [], environmentOnlyInputOmissions = [];
for (const [file, expected] of Object.entries(regression.inputHashes)) {
  if (!file.startsWith(main + '/')) {
    if (!excludedAmbient.has(file)) throw Error('Unattributed external main input: ' + file);
    environmentOnlyInputOmissions.push({ file, sha256: expected, reason: 'Actual main-only ancestor ambient declaration; absent from genuine isolated compiler resolution' });
    continue;
  }
  const relative = path.relative(main, file);
  const isolated = fs.realpathSync(path.join(root, relative));
  if (!isolated.startsWith(root + '/') || hash(fs.readFileSync(isolated)) !== expected) throw Error('Remapped common runtime input mismatch: ' + relative);
  remappedRuntimeInputs.push({ file: relative, physical: isolated, sha256: expected });
}
if (process.env.NODE_PATH || process.env.NODE_OPTIONS) throw Error('Unexpected inherited Node module-resolution override');
write('source-isolation.json', { root, main, dependencySymlinkCount: symlinks.length, symlinks, allDependencyLinksInsideCheckout: true, builtFileCount: builtFiles.length, builtFiles, allFreshBuiltFilesInsideCheckout: true, remappedRuntimeInputs, environmentOnlyInputOmissions, noMainSourceNodeModulesDistOrNativeReuse: true, nodePathAndNodeOptionsAbsent: true, sourceGraph: 'graph-comparison.json', independentOfflineInstall: 'install/status.json', independentNativeDownload: 'native-artifacts.json', independentSourceBuild: 'build/status.json', testsExecuted: 0 });
console.log(JSON.stringify({ dependencySymlinks: symlinks.length, builtFiles: builtFiles.length, mappedRuntimeInputs: remappedRuntimeInputs.length, actualEnvironmentOnlyOmissions: environmentOnlyInputOmissions.length, noMainSourceOrRuntimeReuse: true }));

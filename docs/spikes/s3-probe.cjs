const path = require('node:path');
const dir = process.argv[2], cfg = process.argv[3];
const ts = require(require.resolve('typescript', { paths: [dir] }));
const file = path.join(dir, cfg);
const read = ts.readConfigFile(file, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file), undefined, file);
const t0 = Date.now();
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
const checker = program.getTypeChecker();
const own = program.getSourceFiles().filter(f => !f.fileName.includes('/node_modules/'));
let sem = 0, syn = 0, byCode = {};
for (const sf of own) {
  for (const d of program.getSemanticDiagnostics(sf)) { sem++; byCode[d.code] = (byCode[d.code] || 0) + 1; }
  syn += program.getSyntacticDiagnostics(sf).length;
}
// resolution probe: count identifiers in own files whose symbol is unresolved
let ids = 0, unresolved = 0;
for (const sf of own) ts.forEachChild(sf, function v(n) { if (ts.isIdentifier(n) && !ts.isPropertyAssignment(n.parent)) { ids++; if (!checker.getSymbolAtLocation(n)) unresolved++; } ts.forEachChild(n, v); });
console.log(JSON.stringify({ ts: ts.version, rootFiles: parsed.fileNames.length, configErrors: parsed.errors.length, ownFiles: own.length, allFiles: program.getSourceFiles().length, syntactic: syn, semantic: sem, byCode, identifiers: ids, unresolvedIdentifiers: unresolved, ms: Date.now() - t0 }));

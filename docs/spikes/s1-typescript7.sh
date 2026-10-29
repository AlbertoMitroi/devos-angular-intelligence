set -e
cd /tmp && mkdir s1 && cd s1 && npm init -y >/dev/null
npm view typescript@6 version --json | tail -3
npm install --ignore-scripts --no-audit --no-fund typescript@7.0.2 >/dev/null 2>&1
echo "== typescript@7.0.2 package.json"
node -e 'const p=require("typescript/package.json");console.log(JSON.stringify({version:p.version,main:p.main,exports:p.exports,bin:p.bin,deps:p.dependencies,optionalDeps:p.optionalDependencies},null,1))'
ls node_modules/typescript node_modules/typescript/lib | head -40
echo "== require(typescript)"
node -e 'try{const ts=require("typescript");console.log("keys",Object.keys(ts).length, typeof ts.createProgram, ts.version)}catch(e){console.log("require failed:",e.message.split("\n")[0])}'
node --input-type=module -e 'try{const ts=await import("typescript");console.log("esm keys",Object.keys(ts).slice(0,40), typeof ts.createProgram)}catch(e){console.log("import failed:",e.message.split("\n")[0])}'
ls node_modules/@typescript 2>/dev/null || true

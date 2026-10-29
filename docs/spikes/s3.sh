set -e
cp -R /eshop/apps/angular /tmp/app && cd /tmp/app
start=$(date +%s)
npm install --ignore-scripts --no-audit --no-fund > /tmp/install.log 2>&1 || { echo "install failed (plain)"; grep -E "ERR" /tmp/install.log | head -20; npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps > /tmp/install2.log 2>&1 || { echo "install failed (legacy-peer-deps)"; grep ERR /tmp/install2.log | head; }; }
echo "install seconds: $(( $(date +%s) - start ))"; tail -3 /tmp/install.log
node -e 'for (const p of ["typescript","@angular/core","@angular/compiler","@abp/ng.core"]) console.log(p, require(p + "/package.json").version)'
# packages with install scripts that were skipped
node -e '
const fs=require("fs"),path=require("path");const lock=JSON.parse(fs.readFileSync("package-lock.json"));
const s=Object.entries(lock.packages).filter(([k,v])=>v.hasInstallScript).map(([k])=>k);console.log("hasInstallScript:",s.length,s.join(" "))'
node /spike/probe.cjs /tmp/app tsconfig.app.json

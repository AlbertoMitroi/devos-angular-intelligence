set -e
cd /tmp && mkdir s1 && cd s1 && npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund typescript@7.0.2 >/dev/null 2>&1
grep -n -E "^export (declare )?(class|function|interface)|^\s+(get[A-Z]\w*|create\w*)\(" node_modules/typescript/dist/api/sync/api.d.ts | head -60
echo "== README API section"; grep -n -i -A3 "unstable" node_modules/typescript/README.md | head -30

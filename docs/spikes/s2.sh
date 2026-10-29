set -e
for v in 22.2.3 18.1.4 17.3.12 16.2.12; do
  d=/tmp/ng$v; mkdir -p $d; cd $d; npm init -y >/dev/null
  npm install --ignore-scripts --no-audit --no-fund @angular/compiler@$v >/dev/null 2>&1
  echo "=== @angular/compiler@$v"; node /spike/probe.mjs $d 2>&1 | head -40
done

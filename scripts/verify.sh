#!/usr/bin/env bash
# The single local verify command (Step 1). Needs only Docker.
# 1. builds the test stage (type check, unit tests, contract drift check run inside it),
# 2. builds the runtime and action images,
# 3. checks the image self-description (Node, TypeScript, @angular/compiler, SQLite FTS5, non-root user),
# 4. analyzes every fixture twice with the runtime image (read-only /src) and compares the runs byte for byte,
#    including the canonical dump of index.sqlite; runs verify and the expected.yml comparison,
# 5. runs the action image in GitHub Action mode against a simulated workspace.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tag="${AI_VERIFY_TAG:-angular-intelligence:verify}"
work="$root/.verify"
user="$(id -u):$(id -g)"
only="${AI_VERIFY_ONLY:-}"

step() { printf '\n== %s\n' "$*"; }

rm -rf "$work/repos" "$work/out" "$work/workspace"
mkdir -p "$work/repos" "$work/out" "$work/cache"

step "test stage"
docker build --target test -t "$tag-test" "$root"

step "runtime and action images"
docker build --target runtime -t "$tag" "$root"
docker build --target action -t "$tag-action" "$root"

step "self-test"
docker run --rm --network none "$tag" version --json | tee "$work/version.json"
grep -q '"fts5":true' "$work/version.json"
grep -q '"node":"v24.22.2"' "$work/version.json"
grep -q '"typescript":"6.0.3"' "$work/version.json"
grep -q '"angularCompiler":"22.2.3"' "$work/version.json"
[ "$(docker run --rm --entrypoint id "$tag" -u)" != "0" ]

step "fixture repositories"
for fixture in "$root"/tests/fixtures/*/; do
  name="$(basename "$fixture")"
  if [ -n "$only" ] && [ "$name" != "$only" ]; then continue; fi
  docker run --rm --user "$user" -e HOME=/tmp --entrypoint bash \
    -v "$root/tests/fixtures:/fixtures:ro" -v "$work/repos:/repos" \
    "$tag" /opt/angular-intelligence/scripts/fixture-repo.sh "/fixtures/$name" "/repos/$name"
done

step "fixture analyses"
failed=0
for repo in "$work"/repos/*/; do
  name="$(basename "$repo")"
  expected=0
  if [ -f "$root/tests/fixtures/$name/expected.yml" ]; then
    expected="$(sed -n 's/^exitCode: *\([0-9][0-9]*\).*/\1/p' "$root/tests/fixtures/$name/expected.yml" | head -n 1)"
  fi
  config_args=()
  config_mount=()
  if [ -f "$root/tests/fixtures/$name/config.yml" ]; then
    config_mount=(-v "$root/tests/fixtures/$name/config.yml:/config/config.yml:ro")
    config_args=(--config /config/config.yml)
  fi
  for run in 1 2; do
    mkdir -p "$work/out/$name-$run"
    set +e
    docker run --rm --user "$user" -e HOME=/tmp --tmpfs /work:rw,exec,size=4g \
      -v "$repo:/src:ro" -v "$work/out/$name-$run:/out" -v "$work/cache:/cache" ${config_mount[@]+"${config_mount[@]}"} \
      "$tag" analyze --src /src --out /out ${config_args[@]+"${config_args[@]}"} > "$work/out/$name-$run.events.ndjson" 2> "$work/out/$name-$run.log"
    code=$?
    set -e
    if [ "$code" -ne "$expected" ]; then
      echo "analyze $name run $run: exit code $code, expected $expected" >&2
      tail -n 20 "$work/out/$name-$run.log" >&2
      failed=1
      continue 2
    fi
  done
  if [ -f "$work/out/$name-1/manifest.json" ]; then
    # Byte comparison inside the image, so the check is the same on every host (index.sqlite through its dump).
    docker run --rm --entrypoint diff -v "$work/out:/runs:ro" "$tag" -r -x run.json -x index.sqlite "/runs/$name-1" "/runs/$name-2"
    for run in 1 2; do
      docker run --rm -v "$work/out:/runs:ro" "$tag" query "/runs/$name-$run" dump > "$work/out/$name-$run.index-dump.txt"
    done
    cmp "$work/out/$name-1.index-dump.txt" "$work/out/$name-2.index-dump.txt"
    echo "$name: two runs identical (graph, snippets, context packs, index dump)"
    docker run --rm -v "$work/out:/runs:ro" "$tag" verify "/runs/$name-1"
  else
    echo "$name: no manifest (exit code $expected)"
  fi
  if [ -f "$root/tests/fixtures/$name/expected.yml" ]; then
    if ! docker run --rm --entrypoint node -v "$root/tests/fixtures:/fixtures:ro" -v "$work/out:/runs:ro" "$tag-test" \
      tests/check-expected.ts "/fixtures/$name/expected.yml" "/runs/$name-1" "$expected"; then
      failed=1
    fi
  fi
done
if [ "$failed" -ne 0 ]; then
  echo "fixture analyses failed" >&2
  exit 1
fi

if [ -z "$only" ] || [ "$only" = "a01-standalone" ]; then
  step "GitHub Action mode"
  mkdir -p "$work/workspace"
  cp -R "$work/repos/a01-standalone" "$work/workspace/repo"
  : > "$work/workspace/github-output"
  docker run --rm \
    -e GITHUB_WORKSPACE=/github/workspace -e GITHUB_OUTPUT=/github/workspace/github-output \
    -e INPUT_PATH=repo -e INPUT_OUTPUT=intelligence-out -e "INPUT_FAIL-ON=failed" \
    -v "$work/workspace:/github/workspace" -w /github/workspace \
    "$tag-action" gha > "$work/action.log"
  grep -qx 'status=complete' "$work/workspace/github-output"
  grep -qx 'manifest-path=intelligence-out/manifest.json' "$work/workspace/github-output"
  test -f "$work/workspace/intelligence-out/manifest.json"
  cat "$work/workspace/github-output"
fi

step "verify passed"

#!/usr/bin/env bash
# The driver's unsandboxed gate re-run after one applychecks run.
#
#   bash gates.sh <worktree> <rundir>
#
# Every selected gate runs even when an earlier one fails. Outcomes land in <rundir>/gates.txt and each gate's
# output in gate-<name>.log; the script exits non-zero when any gate failed.
set -u
worktree=$1
run_dir=$2
shift 2
for flag in "$@"; do
	echo "unknown flag: $flag" >&2
	exit 2
done
cd "$worktree" || exit 1
any_gate_failed=0
run_gate() {
	local gate_name=$1
	shift
	"$@" > "$run_dir/gate-$gate_name.log" 2>&1
	local exit_code=$?
	echo "$gate_name exit=$exit_code" >> "$run_dir/gates.txt"
	[ "$exit_code" -eq 0 ] || any_gate_failed=1
}
snapshot_worktree() (
	: > "$1" || exit
	trap 'rm -f "$run_dir/snapshot.index"' EXIT
	# Seed from the real index so tracked files stay included even if ignored.
	cp "$(git rev-parse --git-path index)" "$run_dir/snapshot.index" || exit
	export GIT_INDEX_FILE="$run_dir/snapshot.index"
	git add -A && git write-tree > "$1"
)
: > "$run_dir/gates.txt"
git status --porcelain > "$run_dir/status.txt"
if [ -s "$run_dir/status.txt" ]; then
	run_gate snapshot-before-check snapshot_worktree "$run_dir/tree-before-check.txt"
	run_gate check pnpm run check
	run_gate snapshot-after-check snapshot_worktree "$run_dir/tree-after-check.txt"
	run_gate test pnpm run test
	run_gate build npx turbo run build
else
	echo "no changes, per-run gates skipped" >> "$run_dir/gates.txt"
fi
echo done >> "$run_dir/gates.txt"
exit "$any_gate_failed"

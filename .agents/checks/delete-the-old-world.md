# delete-the-old-world

A change that renames, replaces, or removes a concept leaves zero live residue of the old world anywhere in the tree.

**Verdict test:** infer from the change under review what was retired — names, types, features, shapes, mechanisms. Sweep the tree for survivors. Any live reference to, accommodation of, or leftover from the retired thing FAILs.

## FAIL when, after the change

- The old name still denotes the same concept anywhere — code, configs, comments, error codes, test titles, docs, env templates, CI. A rename is finished when a search for the old name yields only intentional history.
- Compat shims, aliases, or dual-shape handling keep the old shape working: accepting old + new config forms, a deprecated-field alias, a `matchExcel`/`legacyMode`-style toggle reproducing legacy behavior nobody requested.
- The new model is mapped back onto the retained old structure with adapters/remapping — the "I fixed what broke" state. Code touched by a model change must express the new model natively, not paper over the cracks.
- Dead machinery survives: functions, branches, union arms, or fixtures reachable only from the retired design — including symbols that are lexically "used" (referenced by other dead code) and therefore invisible to linters.
- Vestigial scaffolding outlives its reason: pass-through wrappers, threaded-but-unused params, single-impl injection seams, `type X = any` workarounds — code that would not exist if the removed thing had never existed.
- Comments/doc-blocks still describe a cut feature, or cite a removed type as the current contract.
- Spike/probe/debug scaffolding (`scripts/spike-*.ts`, debugging env hacks) remains after the real path exists.

## Do NOT flag

- Intentional historical records: archived docs, changelogs, migration notes that describe the old world *as history*. Classify every survivor: live reference (FAIL) vs archival record (fine).
- Compat that was explicitly requested or sanctioned.
- Anything under `internal/archived/` or equivalent — tombstones are never edited.

## How to inspect

1. From the change under review, list the retired concepts: every renamed identifier, removed type/function/file, replaced mechanism, dropped feature.
2. For each, search the tree for the old term and for structures that only made sense pre-change.
3. Ask the counterfactual: "would this code exist if the removed thing had never existed?" If no, and it still does — FAIL.

## Calibration

> "i want to make sure there are no old/defunct/useless functions/codepaths/fallbacks/names/identifiers/concepts or anything else left in the code that would make it hard to understand"

> "We're building something to supercede, not something for byte-replacement. We do not need any backwards compat or incorrect bullshit."

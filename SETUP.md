# Contribution graph — setup

Target repo: `deepakvamsi/deepakvamsi` (profile README repo).

## Files to copy
- `.github/workflows/contrib-graph.yml`
- `README.md`  (your existing bio + the embed)

## Folder naming
The upstream action hardcodes its output to `./profile-3d-contrib`
(`src/file-writer.ts:3`) and there is no setting to change it — `fileName`
cannot relocate the directory, since `mkdirSync` only creates that one folder.

So the workflow generates there, then moves the single SVG we want to:

    assets/contrib-graph/contributions-3d.svg

and deletes `profile-3d-contrib/`. That folder never gets committed.
To use different names, change them in BOTH the "Relocate generated graph"
step and the README embed path.

## Steps
1. Copy both files into a clone of `deepakvamsi/deepakvamsi`, same paths.
2. Commit and push to `main`.
3. Repo -> Settings -> Actions -> General -> Workflow permissions ->
   **Read and write permissions**. Without this the push step fails.
4. Repo -> Actions -> "Contribution Graph" -> **Run workflow**.
   The README image is broken until this first run completes.
5. Refreshes daily at 18:00 UTC.

## Note on the 30-day request
This action renders a **full-year** calendar only. No input or settings field
windows it to the last 30 days (checked against the action README, `src/type.ts`
and `src/index.ts`). The reference SVG you linked is also a full year.

## Other styles
Swap the source filename in the "Relocate generated graph" step for any of:
profile-green.svg, profile-season-animate.svg, profile-season.svg,
profile-night-view.svg, profile-night-green.svg, profile-night-rainbow.svg,
profile-gitblock.svg

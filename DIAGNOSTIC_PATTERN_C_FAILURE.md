# Pattern C First-Encounter Fix — Diagnostic Report

**Date:** 2026-06-30
**Scope:** read-only investigation. No code modified, no scraper run, no DB mutation,
no migration executed. (One read-only `SELECT` was issued for evidence; it does not
mutate.)

**Headline:** The fix code IS present in `src/index.js`, but **every run in the logs
predates the moment the fix was saved to disk.** The runs that produced the bad data
used the OLD gate. This is **Failure Mode A** (the new code had not been deployed/
saved when those runs executed) — with an important secondary data-state finding
that means re-running alone will *not* recover the affected rows.

---

## 1. Code state verification

The new gate IS in place. `src/index.js` line 253:

```js
253:        if (existing.is_terminal === true && (existing.recheck_count || 0) > 0) {
```

This is the NEW form (requires `recheck_count > 0`), not the old
`if (existing.is_terminal === true)`. Surrounding context (lines 240–262):

```js
240:      const existing = await applicationsRepository.findByUid(app.title).catch(() => null);
241:      let knownUrls = new Set();
242:      let recheckCount = 0;
243:      if (existing) {
244:        recheckCount = (existing.recheck_count || 0) + 1;
        ...comment...
253:        if (existing.is_terminal === true && (existing.recheck_count || 0) > 0) {
254:          runManager.log(`Skipping terminal application: ${app.title} (status: ${existing.status || 'n/a'})`);
255:          await applicationsRepository.upsertApplication(
256:            { ...applyPlanitMetadata(app), scrape_status: 'skipped_terminal' },
257:            { lastChecked: true, recheckCount }
258:          ).catch(...);
261:          results.push({ ...app, platform: ..., scrape_status: 'skipped_terminal', documents: [] });
262:          continue;
263:        }
```

**But the file was saved AFTER all logged runs (see §4, §5):**
- `src/index.js` mtime: **2026-06-30 14:46:39 +0530 = 09:16:39 UTC**
- Latest log entry of any kind: **2026-06-30 08:13:54 UTC**
- Latest run that skipped 2024/0299: started **08:02:01 UTC**, skip logged **08:13 UTC**

So the gate shown above was **not on disk** when the runs executed. The runs used the
prior version (`if (existing.is_terminal === true)`), which skips terminal apps
regardless of `recheck_count`.

---

## 2. Full application-loop flow (`src/index.js`)

Main loop begins at **line 216** (`for (const app of queue)`). Order of gates and
exits per application:

| Step | Line(s) | Action / gate | `continue`? | Adapter run? |
|---|---|---|---|---|
| Postcode filter | 220–230 | `shouldProcess` fail → upsert `skipped_filter` | **229** | no |
| **Terminal gate** | 240–263 | `findByUid`; if `is_terminal===true && recheck_count>0` → upsert `skipped_terminal` `{lastChecked,recheckCount}` | **262** | **no** |
| Status upsert | 272 | upsert `queued`/`skipped_resume` `{recheckCount}` | — | — |
| Resume fast-path | (≤302) | if `app.skipped_resume` → download carried docs, then continue | **302** | no (resume only) |
| Missing URL | 313–320 | no `detectUrl` → upsert `missing_url` | **320** | no |
| Detect/route | 323–328 | `detectPlatform` + `routeAdapter` | — | — |
| Capita override | 350–353 | if `generic` & comments-URL present → `adapter='capita'` | — | — |
| Generic-disabled | 360–366 | if `generic` & not enabled → upsert `generic_disabled` | **366** | no |
| **Adapter dispatch** | 375–457 | idox / arcus / salesforce / **capita (435)** / generic (454) | — | **yes** |
| Post-scrape upsert | 494–498 | upsert `scrapeStatus` `{lastChecked,documentsChanged,recheckCount}` | — | — |

`continue` statements (every skip): **229** (filter), **262** (terminal), **302**
(resume), **320** (missing_url), **366** (generic_disabled).

`upsertApplication` call sites that set `recheck_count`/`is_terminal`:
- **256** skipped_terminal — passes `{lastChecked:true, recheckCount}` → **bumps
  recheck_count even though the adapter never runs.** ← the mechanism that moved the
  stuck rows off `recheck_count=0` (see §8).
- **272** queued — passes `{recheckCount}`.
- **494** post-scrape — passes `{lastChecked, documentsChanged, recheckCount}`.
- **224 / 319 / 363** (skipped_filter / missing_url / generic_disabled) — no opts, so
  `recheck_count` omitted; `is_terminal` still set from status by `mapApplication`.

Adapter call (capita), lines 431–442:
```js
431:      } else if (adapter === 'capita') {
435:          docsObject = await scrapeCapitaDocuments(app, scrapeUrl);
436:          success = docsObject.metrics && docsObject.metrics.success;
437:        } catch (err) {
438:          error = err; success = false;
439:          runManager.log(`Capita extraction error: ${err.message}`, 'ERROR');
440:        }
```
Each adapter branch wraps the call in try/catch that logs an `ERROR` and sets
`success=false` — a crash would be **logged**, not silent. No such error appears for
2024/0299 (see §4), consistent with the adapter never having been reached.

---

## 3. `mapApplication` / `upsertApplication` behavior

`src/db/repositories/applicationsRepository.js` — conditional emission:

```js
71:  if (opts.lastChecked === true) row.last_checked_at = now;
81:  if (app.status) row.is_terminal = isTerminalStatus(app.status);   // true for "FINAL DECISION"
84:  if (opts.documentsChanged === true) row.documents_last_changed_at = now;
87:  if (typeof opts.recheckCount === 'number') row.recheck_count = opts.recheckCount;
```

- `is_terminal` is emitted whenever `app.status` is present (it is, via Planit), set
  to `isTerminalStatus(status)`. For status `"FINAL DECISION"` → **`true`**. This is
  emitted at **every** upsert site that carries Planit metadata — including the
  initial batch upsert before the loop and the `skipped_terminal` upsert.
- `recheck_count` is emitted only when the caller passes a numeric `opts.recheckCount`.
  The `skipped_terminal` (256) and `queued` (272) and post-scrape (494) sites all pass
  it; the value is always `(existing.recheck_count || 0) + 1`.

There is no separate `markChecked`/`setScrapeStatus` helper — all updates go through
`upsertApplication`→`mapApplication`.

---

## 4. Log evidence

Logs exist (RunManager writes `logs/<date>/run.log`, see runManager.js L13/69/73/94).
Today's log: `logs/2026-06-30/run.log` (465 lines, 06:08:51Z → 08:13:54Z).

**2024/0299 (the failing app) — all matches:**
```
405: [07:36:06.805Z] [INFO] [filter] PASS 2024/0299  (area: SW)
406: [07:36:06.833Z] [INFO] Skipping terminal application: 2024/0299 (status: FINAL DECISION)
460: [08:13:53.938Z] [INFO] [filter] PASS 2024/0299  (area: SW)
461: [08:13:53.972Z] [INFO] Skipping terminal application: 2024/0299 (status: FINAL DECISION)
```
- `"Skipping terminal application: 2024/0299"` **appears twice** → the terminal gate
  fired on both runs. The OLD gate (is_terminal alone) is the only one that fires for
  a row whose `recheck_count` was 0 or 1 at the time.
- `"[capita] Wandsworth 2024/0299"` — **never appears.** The adapter did not run.
- No `requires_different_path` / `portal_unreachable` / `blocked_anti_bot` /
  `[change] 2024/0299` lines exist. Consistent with the app being skipped before
  routing/adapter.

**2024/0307 (the "working" app) — for contrast:**
```
388: [07:21:09.618Z] Processing application: 2024/0307 (Council: Wandsworth)
389: [07:21:09.965Z] Detected Platform: NORTHGATE (adapter: capita) for .../comments.aspx?case=2024/0307
391: [07:21:13.276Z] Successfully processed: 2024/0307 (Council: Wandsworth, Docs: 97)
392: [07:21:13.277Z] [change] 2024/0307: +97 -0
```
2024/0307 was **not** skipped because its `status="REGISTERED"` (active, see §8) — it
never hit the terminal gate. Its success therefore does **not** demonstrate the
first-encounter fix; it exercises the ordinary active-app path.

---

## 5. Git state

```
Branch: madhav (up to date with origin/madhav)
Last commits:
  7eaf026 new dashboard changes
  727785d react dashboard created
  61b47c5 scraper- idox, arcus, salesforce
  ...
```
**All of the recent work is UNCOMMITTED** (working-tree modifications), including the
Pattern C fix:
```
modified: src/index.js, src/core/runManager.js,
          src/db/repositories/applicationsRepository.js,
          src/db/repositories/documentsRepository.js,
          src/detector.js, src/download/downloadManager.js, src/planit.js, ...
```
There is no commit containing the fix, so `git diff HEAD~1 src/index.js` would not
show it. The fix lives only in the working tree. Timeline that matters:

- Working-tree `src/index.js` saved: **09:16 UTC** (file mtime).
- All logged runs: **06:08–08:13 UTC** → **before** 09:16 UTC.

⇒ The runs executed an earlier working-tree version (old gate). No run has occurred
since the new gate was saved.

---

## 6. Additional skip paths found

The only pre-adapter skip that **also bumps `recheck_count` while `is_terminal=true`**
is the terminal gate (line 262, upsert at 256 with `{recheckCount}`). The other
pre-adapter `continue`s:
- `skipped_filter` (229) and `missing_url` (320) and `generic_disabled` (363/366) do
  **not** pass `recheckCount` (so they don't bump it), though they do set
  `is_terminal` from status. For 2024/0299 the log shows the **terminal** skip, not
  these.
- `generic_disabled` cannot apply here anyway: `.env` has `GENERIC_ENABLED=true` (§7).

No hidden/alternate skip path is implicated. The single explanation matching the log
is the terminal gate firing under the old code.

---

## 7. Config / env review

`.env`:
```
LOCATION=Wandsworth
GENERIC_ENABLED=true
START_DATE=2024-01-01
END_DATE=2024-01-30
```
- The failing run used **date range 2024-01-01..2024-01-30** (log lines 359, 414 —
  "Mode: date range, 2024-01-01 to 2024-01-30", LIMIT=20). 2024/0299 falls in this
  window and **PASSED the postcode filter** (`[filter] PASS 2024/0299 (area: SW)`), so
  the filter is not the cause.
- No `DRY_RUN` / `SKIP_DOWNLOAD` / `NO_DOCUMENTS` flags present.
- `GENERIC_ENABLED=true` rules out the `generic_disabled` skip.

---

## 8. CONCLUSION

**Primary cause — Failure Mode A (code not deployed at run time).**
The new gate (`is_terminal === true && recheck_count > 0`, index.js:253) is present in
the working tree but was **saved at 09:16 UTC, after every logged run (≤08:13 UTC).**
The runs that produced the bad data executed the prior gate
(`if (existing.is_terminal === true)`), which skips terminal applications
unconditionally. Direct proof: `logs/2026-06-30/run.log` lines 406 & 461 —
`Skipping terminal application: 2024/0299` — with **no** `[capita] ... 2024/0299`,
`[change] 2024/0299`, or adapter-error line anywhere. The adapter was never reached.
Mode B (alternate skip path) is not supported — the only matching skip is the terminal
gate; Mode C (silent adapter failure) is not supported — adapter errors are logged and
none exist for 2024/0299, and the "Processing application"/"Detected Platform" lines
that precede every adapter call are absent for it.

**Secondary finding — the current data state will defeat the fix on the next run, and
migration 009 can no longer reset it.** This is critical for choosing the next step:

- Read-only DB snapshot (now):
  | uid | status | is_terminal | recheck_count | scrape_status | docs |
  |---|---|---|---|---|---|
  | 2024/0299 | FINAL DECISION | true | **2** | skipped_terminal | 0 |
  | 2024/2282 | FINAL DECISION | true | **1** | skipped_terminal | 0 |
  | 2024/0307 | REGISTERED | false | 1 | scraped | 97 |
- `SELECT COUNT(*) WHERE is_terminal=true AND recheck_count=0` → **0**.

Mechanism: each old-code terminal **skip** still ran the `skipped_terminal` upsert with
`{recheckCount = existing.recheck_count + 1}` (index.js:256–257), so the never-scraped
terminal rows were incremented on every skipping run (the two 2024-01 date-range runs
took 2024/0299 from 0→1→2; the once-seen new apps reached 1). As a result:
- **Migration 009** resets only `is_terminal=true AND recheck_count=0` — which now
  matches **0 rows**. Re-applying it as written will not touch 2024/0299 (recheck=2)
  or 2024/2282 (recheck=1).
- **The new gate** skips `is_terminal=true AND recheck_count>0` — which is exactly
  these rows. So even after the new code is live, the next run will **again** skip them
  with `skipped_terminal` and never fetch their documents.

In short: the fix is correct for *genuinely first-encounter* rows (`recheck_count=0`),
but the affected production rows are no longer in that state — the old-code skips
pushed them to `recheck_count≥1`, placing them outside both the migration's reset
condition and the new gate's first-encounter path. 2024/0307 only "works" because it is
`status=REGISTERED` (active) and was independently reset to `is_terminal=false` during
the migration-008 testing — it never tested the terminal-first-encounter path.

**Evidence trail:** §1 (gate present) + §5 (file saved 09:16 UTC) + §4 (runs ≤08:13
UTC, skip logged, adapter never logged) ⇒ Mode A. §2/§3 (skipped_terminal upsert passes
`{recheckCount}`) + §8 DB snapshot (recheck_count 1–2, docs 0) + migration-009 target
count 0 ⇒ the data-state interaction that blocks recovery.

*(No fix proposed, per instructions. The above states only what the evidence shows.)*

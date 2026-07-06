# Accumulated duplicate `BaseItemImageInfos` rows cause library-scan RAM blowups / OOM

## Status

- **Confirmed:** some items accumulate large numbers of exact-duplicate `BaseItemImageInfos` rows,
  and once bloated they make library scans balloon RAM and (with no memory limit) OOM-kill the
  process. Deduplicating the table resolves the scan problem.
- **Not reproduced:** the *doubling* itself does not reproduce on stock **12.0-rc2** in runtime
  testing (see [Runtime testing](#runtime-testing)). The duplicate rows appear to be **legacy** from
  an earlier version; the exact code path that first created them is **unconfirmed**.

## Symptom (confirmed)

For certain items, `BaseItemImageInfos` holds many exact duplicates of the same
`(ItemId, ImageType, Path)`, even though only the few real image files exist on disk. On one real
DB a single Movie had **262,144** rows (4 real images × 65,536 duplicates); several other popular
movies had 32–256. Counts are powers of two, i.e. the rows **doubled** some number of times in the
past.

Once an item is bloated, every scan that touches it loads all those rows into memory and
delete-then-re-inserts them, causing: large RAM spikes (observed **OOM-kill** of the container
mid-scan), WAL growth and `INSERT INTO BaseItemImageInfos` write storms, thread-pool starvation /
the scan appearing "stuck" on the same items, and **no errors at the default `Information` log
level**. Observed on **12.0-rc2** (Jellyfin-SQLite).

## Why only images accumulate (confirmed design factor)

`BaseItemImageInfos` uses a **random surrogate GUID primary key** (`MapImageToEntity` sets
`Id = Guid.NewGuid()`), so duplicate inserts never collide and pile up. Every sibling table
(`BaseItemProviders`, `BaseItemMetadataFields`, `UserData`, …) has a **composite natural key** that
absorbs duplicate inserts — which is why, whatever produced the duplicates, **only
`BaseItemImageInfos` grew**. A natural unique key on `(ItemId, ImageType, Path)` would have made this
class of bug impossible.

## When the duplicates were created (data evidence)

- **≤ 10.10.x (immune).** Images were stored by `SqliteItemRepository` as a single pipe-delimited
  string column in `library.db` — no per-image rows, no surrogate key. Serialize/deserialize was
  faithful, so images could not multiply.
- **10.11.0 (2025-10-19) onward.** The EF `jellyfin.db` backend introduced the `BaseItemImageInfos`
  table (GUID PK). On the affected server, `library.db` (pre-migration, Oct 2025) still had the
  correct 4 images for the worst item; the same item was at 262,144 in `jellyfin.db` with a **stale**
  `DateLastRefreshed` (2025-12-14). So the duplication happened **after** the EF migration and via a
  path that writes images **without** updating `DateLastRefreshed` (i.e. an image-only save such as
  `LibraryManager.UpdateImagesAsync` → `SaveImagesAsync`, not a full metadata refresh).

The precise trigger that made those image-only saves persist duplicates is **unconfirmed** — see
below.

## Runtime testing

On the affected server (stock **12.0-rc2**), after cleaning the table:

1. `touch`ed the poster of **The Godfather** (1 `UserData` row) and ran a scan. The Primary image's
   `DateModified` updated to the touch time (so `UpdateImagesAsync` → `SaveImagesAsync` **ran** and
   rewrote the images) and `DateLastRefreshed` stayed stale — but the row count stayed **4** (no
   duplication).
2. Repeated with **Ice Age: Dawn of the Dinosaurs** (12 `UserData` rows). Same result: images
   rewritten, count stayed **4**.

Conclusions from these tests:

- The doubling **does not reproduce** on 12.0-rc2 via the scan / image-refresh path.
- `UserData` count is **not** a multiplier (12 rows → still 4).
- The item-load query returns a **clean** image list on this build, so the duplicate rows are not
  being regenerated during normal operation.

## Hypothesis (unconfirmed — contradicted by the tests above)

Initial analysis suspected duplicate materialization on read: `BaseItemRepository.PrepareItemQuery`
uses `AsNoTracking()` + `AsSingleQuery()` while `ApplyNavigations` eagerly `.Include()`s several
collections (`Images`, `Provider`, `UserData`, `LinkedChildEntities`, …). A single query with
multiple collection includes and no identity resolution can, in principle, materialize duplicate
entries into `entity.Images` (a JOIN cartesian), which a delete-then-insert would then persist. The
runtime tests above **did not** confirm this on 12.0-rc1 (the read returned clean image lists), so
this remains a hypothesis at best and is not the demonstrated cause on the current build. It may have
applied to an earlier 10.11.x / 12-nightly build that has since changed.

## Remediation (confirmed effective) and hardening

- **Data cleanup (fixes the reported problem).** Deduplicate `BaseItemImageInfos`, keeping one row
  per `(ItemId, ImageType, Path)`. On the affected DB this cut 292,690 → 30,234 rows (310 MB → 225 MB
  after `VACUUM`), integrity check `ok`, and scans no longer OOM. Provided as migration
  `20260705120000_DeduplicateImageInfos` (auto-backs-up the DB first), or as a one-off SQL
  `DELETE … WHERE rowid NOT IN (SELECT MIN(rowid) … GROUP BY ItemId, ImageType, Path)` + `VACUUM`
  on a stopped server.
- **Defensive guards (prevent any future accumulation regardless of source).** `SaveImagesAsync` and
  the update branch of `UpdateOrInsertItems` now `DistinctBy((ImageType, Path))` before persisting,
  so duplicate image entries can never be written and any already-duplicated in-memory set collapses
  on the next save. `PrepareItemQuery` was also switched to `AsNoTrackingWithIdentityResolution()` as
  belt-and-suspenders against the cartesian hypothesis. These are defensive; they are not proven to
  fix a currently-reproducing bug.

## Manual remediation (per item, no code changes)

Duplicates also collapse whenever a refresh rebuilds/prunes an item's `ImageInfos` from the actual
files instead of persisting the stored set:

- **A refresh that replaces images** ("Replace all images"/"Replace all metadata"/Identify) rebuilds
  the image set from disk before saving (observed: an item at 32 rows dropped back to 4, and
  `DateLastRefreshed` updated).
- **A missing underlying image file** — `BaseItem.ValidateImages()` drops any `ImageInfos` entry
  whose local file no longer exists.

## Suggested follow-ups

- Add a **unique index / natural key** on `BaseItemImageInfos(ItemId, ImageType, Path)` so the
  database itself rejects duplicates — this alone would neutralize the whole bug class.
- If the historical trigger matters for an upstream fix, reproduce on an early **10.11.x** build (or
  exercise the non-scan `UpdateImagesAsync` callers with a full-DTO single-user load) to identify the
  exact path that persisted duplicates.
- `UpdateImagesAsync` writes images without updating `DateLastRefreshed`, which hid the growth;
  consider surfacing image-only writes in diagnostics.

## Affected files (in this patch)

- `Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs` (defensive)
- `Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs` (defensive dedup guards)
- `Jellyfin.Server/Migrations/Routines/20260705120000_DeduplicateImageInfos.cs` (new — data cleanup)

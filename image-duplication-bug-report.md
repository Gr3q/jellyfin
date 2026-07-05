# BaseItemImageInfos rows duplicate exponentially across library scans

## Summary

For certain items, rows in `BaseItemImageInfos` are **duplicated every time a library scan re-saves
the item** — the count doubles on each such scan (1 → 2 → 4 → … → hundreds of thousands of rows for
one item), even though only the few real image files exist on disk. The rows are exact duplicates
of the same `(ItemId, ImageType, Path)`.

(Not every scan re-saves an item, so the growth is bursty rather than continuous — see
[Why it is intermittent](#why-it-is-intermittent).)

Once an item has accumulated many duplicates, each scan loads them all into memory and
delete-then-re-inserts them, causing: large RAM spikes (observed **OOM-kills** of the container
mid-scan), massive WAL growth and `INSERT INTO BaseItemImageInfos` write storms, thread-pool
starvation / the scan appearing "stuck" on the same items, and **no errors at the default
`Information` log level**. Observed on **12.0-rc1** (Jellyfin-SQLite); one real DB had a single
Movie with **262,144** image rows (4 real images × 65,536 duplicates).

## Root cause (three factors combine)

1. **Duplicate materialization on read.** `BaseItemRepository.PrepareItemQuery`
   (`BaseItemRepository.QueryBuilding.cs`) uses `AsNoTracking()` **and** `AsSingleQuery()`, while
   `ApplyNavigations` eagerly `.Include()`s multiple collections (`Images`, `Provider`,
   `LockedFields`, `UserData`, `LinkedChildEntities`, …). Multiple collection includes in one query
   produce a JOIN cartesian product, and `AsNoTracking()` does **no identity resolution**, so each
   collection navigation is materialized with duplicate entries: `entity.Images` gets
   `|Images| × |other included collections|` copies. The multiplier is ≥ 2 whenever the item has
   ≥ 2 rows in another included collection (e.g. ≥ 2 users with `UserData`) — which is why
   popular/watched items blow up.
2. **Duplicates persisted verbatim.** During a scan, unchanged children go
   `Folder.ValidateChildrenInternal` → `LibraryManager.UpdateImagesAsync` →
   `IItemPersistenceService.SaveImagesAsync`; changed items go through `UpdateOrInsertItems`. Both
   delete all of the item's image rows then re-insert `item.ImageInfos` / `entity.Images`
   **without deduplication**, writing the inflated set back.
3. **Duplicates cannot collapse.** `BaseItemImageInfos` uses a **random surrogate GUID primary
   key** (`MapImageToEntity` sets `Id = Guid.NewGuid()`), so duplicate inserts never collide. Every
   sibling table (`BaseItemProviders`, `BaseItemMetadataFields`, `UserData`, …) has a **composite
   natural key** that absorbs duplicate inserts — which is exactly why **only `BaseItemImageInfos`
   grows**.

`UpdateImagesAsync` also does **not** update `DateLastRefreshed`, so affected items keep a stale
refresh date while their image rows silently multiply — making the problem invisible.

## Why it is intermittent

Doubling only happens when the item is actually re-saved. For `UpdateImagesAsync` that requires at
least one image to satisfy `LibraryManager.ImageNeedsRefresh` (image `Width/Height == 0`, empty
`BlurHash`, changed file mtime, or a remote image). Between triggers the counts stay frozen, so a
plain no-change scan does not reproduce it — but re-downloading/regenerating an image or a file
mtime change starts another burst of doublings.

## How this happened, and affected versions

**Affected: 10.11.0 → 12.0-rc1. Not affected: 10.10.x and earlier.**

1. **10.10.x and earlier (immune).** Images were stored by `SqliteItemRepository` as a single
   pipe-delimited string column in `library.db` — no per-image rows, no surrogate key, no EF
   include/cartesian. Serialize/deserialize was faithful, so images could not multiply.
2. **10.11.0 (2025-10-19) introduces the EF backend and all three factors at once:** the new
   `jellyfin.db` / `BaseItemRepository` with the `BaseItemImageInfos` table keyed by a random
   `Guid.NewGuid()` (factor 3); the item read query already using `AsNoTracking()` (applied
   2024-10-09 during EF development) with `AsSingleQuery()` + multiple collection `.Include()`s
   (factor 1); and `SaveImagesAsync`/`UpdateImagesAsync` delete-then-insert of `item.ImageInfos`,
   invoked every scan for unchanged items (factor 2). On upgrade, `library.db` is migrated to
   `jellyfin.db` with the correct image counts.
3. **First triggering scan (10.11.x).** A scan loads an item via the cartesian query, so its
   in-memory `ImageInfos` already contains duplicates. If any image needs refresh, the item is
   saved: old rows are deleted and the duplicated set is inserted with fresh random GUIDs;
   `DateLastRefreshed` is left untouched.
4. **Every subsequent triggering scan doubles the rows** (the read re-duplicates the now-larger
   set, the write persists it). After N such scans a single image is present ~2^N times.
5. **Runaway state.** Once counts reach tens/hundreds of thousands, each scan's load + rewrite of
   those rows balloons RAM and stalls or OOM-kills the scan — while `DateLastRefreshed` still shows
   an old date, hiding the cause.

Note: the 2026-04-26 commit "Use AsNoTracking() when only reading" is **not** the origin — the item
query was already no-tracking from 2024-10-09; that commit only widened no-tracking usage.

## Reproduction

1. Pick a movie watched by ≥ 2 users (≥ 2 `UserData` rows) with local images.
2. Change one cached image file's mtime (`touch .../metadata/library/xx/<id>/poster.jpg`).
3. Run a library scan.
4. The item's `BaseItemImageInfos` count doubles while `DateLastRefreshed` is unchanged; RAM during
   the scan climbs. Repeat to double again.

## Fix

- **Read side (prevent duplicate materialization):** `PrepareItemQuery` now uses
  `AsNoTrackingWithIdentityResolution()` instead of `AsNoTracking()`, so the multi-include single
  query can no longer duplicate collection-navigation entries.
- **Write side (defense in depth / self-heal):** `SaveImagesAsync` and the update branch of
  `UpdateOrInsertItems` now `DistinctBy((ImageType, Path))` before persisting, so duplicate image
  entries can never be written regardless of source, and any already-duplicated in-memory set
  collapses on the next save.
- **Data cleanup:** new migration `20260705120000_DeduplicateImageInfos` removes existing duplicate
  rows, keeping one row per `(ItemId, ImageType, Path)`.

## Suggested follow-ups (not in this patch)

- Add a unique index / natural key on `BaseItemImageInfos(ItemId, ImageType, Path)` so the database
  itself rejects duplicates.
- Audit other `AsNoTracking()` read paths that call `ApplyNavigations` with `AsSingleQuery()`
  (e.g. `NextUpService`).
- `UpdateImagesAsync` writing images without touching `DateLastRefreshed` hid this bug; consider
  surfacing image-only writes in diagnostics.

## Affected files

- `Jellyfin.Server.Implementations/Item/BaseItemRepository.QueryBuilding.cs`
- `Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs`
- `Jellyfin.Server/Migrations/Routines/20260705120000_DeduplicateImageInfos.cs` (new)

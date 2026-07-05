using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Server.ServerSetupApp;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Server.Migrations.Routines;

/// <summary>
/// Removes duplicate <c>BaseItemImageInfos</c> rows that share the same item, image type and path.
/// <para>
/// A regression allowed the same logical image to be persisted many times for a single item (the
/// count doubling on every library scan), because the item load query materialized duplicate
/// navigation entries and <c>BaseItemImageInfos</c> uses a random surrogate GUID primary key that
/// does not collapse duplicate inserts. This one-off cleanup keeps a single row per
/// <c>(ItemId, ImageType, Path)</c> group and deletes the rest.
/// </para>
/// </summary>
[JellyfinMigration("2026-07-05T12:00:00", nameof(DeduplicateImageInfos))]
[JellyfinMigrationBackup(JellyfinDb = true)]
public class DeduplicateImageInfos : IAsyncMigrationRoutine
{
    private const int DeleteChunkSize = 500;

    private readonly IStartupLogger<DeduplicateImageInfos> _logger;
    private readonly IDbContextFactory<JellyfinDbContext> _dbContextFactory;

    /// <summary>
    /// Initializes a new instance of the <see cref="DeduplicateImageInfos"/> class.
    /// </summary>
    /// <param name="logger">The startup logger.</param>
    /// <param name="dbContextFactory">The database context factory.</param>
    public DeduplicateImageInfos(
        IStartupLogger<DeduplicateImageInfos> logger,
        IDbContextFactory<JellyfinDbContext> dbContextFactory)
    {
        _logger = logger;
        _dbContextFactory = dbContextFactory;
    }

    /// <inheritdoc/>
    public async Task PerformAsync(CancellationToken cancellationToken)
    {
        var context = await _dbContextFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            // Project only the columns needed to identify duplicates; keeps memory bounded even on
            // heavily inflated databases.
            var rows = await context.BaseItemImageInfos
                .Select(e => new { e.Id, e.ItemId, e.ImageType, e.Path })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var idsToDelete = rows
                .GroupBy(e => (e.ItemId, e.ImageType, e.Path))
                .Where(g => g.Count() > 1)
                .SelectMany(g => g.OrderBy(x => x.Id).Skip(1).Select(x => x.Id))
                .ToList();

            if (idsToDelete.Count == 0)
            {
                _logger.LogInformation("No duplicate BaseItemImageInfos rows found");
                return;
            }

            _logger.LogInformation("Removing {Count} duplicate BaseItemImageInfos rows", idsToDelete.Count);

            var removed = 0;
            foreach (var chunk in idsToDelete.Chunk(DeleteChunkSize))
            {
                var ids = chunk;
                removed += await context.BaseItemImageInfos
                    .Where(e => ids.Contains(e.Id))
                    .ExecuteDeleteAsync(cancellationToken)
                    .ConfigureAwait(false);
            }

            _logger.LogInformation("Removed {Count} duplicate BaseItemImageInfos rows", removed);
        }
    }
}

# Backup and Recovery Procedures

## How backups work
**Backup and recovery → Back up now** creates a backup generation in `<data folder>\backups\<id>\`:
- `database.sqlite`: a consistent copy made with SQLite's online backup mechanism
- `documents\`: copies of all attached documents
- `manifest.json`: the SHA-256 checksum of every file, the schema and app version, and record counts

A backup only appears in the list after it passes a full integrity check. Earlier generations are never overwritten. A backup is also taken automatically before any database upgrade (`pre_migration`) and before any restore (`pre_restore`).

**Copy the `backups` folder to an external drive or another approved location regularly.** By default, backups are on the same disk as the live data.

## Restore from inside the application (normal case)
1. Sign in as a user with the *Restore from backup* permission (Super Admin by default).
2. Open **Backup and recovery** and use **Check** on the chosen backup to confirm it is valid.
3. Choose **Restore**, type `RESTORE` and confirm. The application then:
   - validates the backup's checksums, integrity and schema
   - takes a safety backup of the current data (if this step fails, the restore is cancelled)
   - replaces the database and documents together, then reopens and verifies them
   - puts the previous data back automatically if any step fails
   - signs everyone out and records the restore in the audit log
4. Sign in again. To undo the restore, restore the `Before restore` backup it created.

## Manual recovery (the application shows "The database could not be opened")
The application will not create a new empty database over an existing installation. Use this procedure on the same computer, or on a replacement computer after installing the application:

1. Close the application. Confirm it is not running in Task Manager.
2. Open `%APPDATA%\BPO Asset Management\data`.
3. Rename `database` to `database.broken-<date>`, and rename `documents` to `documents.broken-<date>`. Do not delete them.
4. Choose a backup folder in `backups\` (or on your external copy). In PowerShell, compare its checksum with `manifest.json` → `database.sha256`:
   `Get-FileHash .\database.sqlite -Algorithm SHA256`
5. Create a new `database` folder. Copy the backup's `database.sqlite` into it, renamed to `asset-management.sqlite`.
6. Copy the backup's `documents` folder to `data\documents`.
7. Start the application. It verifies the database, upgrades the schema if the backup came from an older version (taking a pre-upgrade backup first), and shows the sign-in screen.
8. Sign in and check the records. Then make a new backup.

If the application refuses a backup because it is newer than the installed version, install the matching or newer application version first.

## What to send IT support
Send the reference code shown on the error screen, and the latest `logs\app-YYYY-MM-DD.log`. Logs contain no passwords.

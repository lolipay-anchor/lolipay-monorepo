# Backups

## Why this exists

The escrow lives on Stellar and survives anything that happens to this machine. It proves that USDC moved.

It does not prove that the rupiah moved. Only Postgres and MinIO ever knew that — who was matched with whom, which bank reference was quoted, what the payment proof looked like, what evidence a dispute carried. Lose those and every in-flight or disputed trade becomes unarbitrable: you can see the on-chain half and nothing else.

And restoring both of those onto a fresh machine still gets you nothing runnable, because the coordinator cannot boot without its environment and cannot sign without its keystore. So there is a third leg: the coordinator's environment file and the Stellar CLI keystore (ten identities, including the escrow admin, the resolver and the fiat attestor).

**`/etc/lolipay` is not archived at all.** It is the directory holding `backup.key`, the passphrase every one of these archives is encrypted with; putting that inside one is the same as shipping them all in plaintext. Until 2026-09-17 the directory *was* named for archiving and the key removed again with `tar --exclude=etc/lolipay/backup.key`, which is a filter that matches one exact name: `backup.key~`, `backup.key.bak` and `backup.key.new` all walked straight through it, and the assertion on the other side — an exact match on that same one name — then reported the key **absent**. `/etc/lolipay` held exactly one file the whole time, so no archive on disk was ever affected; the trigger would have been the first passphrase **rotation**, which is the one operation that puts a second file in that directory. Naming nothing there is what removed the class: there is no exclusion to get wrong, and step 5 now refuses any member under `etc/lolipay/` whatsoever. If a non-secret file ever has to be carried from there, it gets its own explicit member — never the directory.

That is the whole justification. It is not "databases should have backups".

## What it does

`lolipay-backup.sh backup`

1. Refuses to start unless the passphrase file exists with mode 600 or 400, both containers are running, and there is at least 1 GiB free.
2. `pg_dump -Fc` out of the running Postgres container, straight into `gpg --symmetric --cipher-algo AES256`. The plaintext never touches disk.
3. Tars MinIO's `/data` through the same encryption.
4. Tars the secrets leg — coordinator environment and Stellar keystore — through the same encryption, with the same passphrase and the same retention. One scheduler, one key, one shape.
5. **Decrypts all three files end to end** to confirm they are readable and intact before doing anything else. AES256 in GPG carries an integrity check, so a damaged encrypted file fails here, and a minio archive that decrypts to fewer than two tar entries fails here too rather than on the day you need it. A file that was never encrypted is not caught: gpg 2.4.4 decrypts an unencrypted OpenPGP file with exit 0 and nothing on stderr, under the right passphrase or a wrong one, which is one reason only root may write the archive directory (`drwx------ root:root`). Decrypting is not the same as being usable, and each leg is asked a question only its own format can answer: the postgres dump is piped into `pg_restore -l` and must yield at least one table-of-contents entry. A dump of *nothing* is a valid GPG file wrapping zero bytes, decrypts perfectly and passes any `[ -s ]` test, which is exactly what this closes. The secrets archive additionally fails here unless the environment file is present **by name** and stored at mode `0600` or `0400`, the keystore identity count matches the live keystore exactly, and **no member at all** lives under `etc/lolipay/`. Names and modes only — no member's content is ever read or printed.
6. Ships off-site, if `BACKUP_OFFSITE_CMD` is set. If it is not set, it says so loudly.
7. Only then prunes `*.gpg` files older than the retention window and any `.partial` older than two hours.

The ordering in 5–7 is the point. **A failed run never deletes a good backup** — pruning is the last step — and never leaves a `.partial` file behind: a leg that fails to write is removed on the spot, and a `.partial` older than two hours is removed by the next run that reaches the prune step. What a failed run *can* leave behind is a file under its **final** name that failed step 5: each leg is renamed from `.partial` to its final name before it is verified (`dump_postgres`, `dump_minio`, `dump_secrets`), and a verification failure exits without removing anything. Such a file stays until retention removes it by age, and `restore-test`, which takes the newest `pg-*.dump.gpg` by modification time, would pick that dump. This is read from the script, not observed: the backup unit's journal holds exactly one `FATAL` in its life, the 2026-08-26 minio failure, which failed while writing and so removed its files.

If the secrets leg fails, the postgres and minio artifacts for that stamp are **kept**. The pg/minio pair is torn down together when the minio archive fails to *write* — `dump_minio` removes the postgres dump of the same stamp — but not when either of them fails *verification*: then both stay on disk under their final names, as above. The pair is atomic because a database without its object store restores to an unarbitrable trade; a database and object store without the secrets still restore, they just need the environment rebuilt by hand.

`lolipay-backup.sh restore-test` restores the newest dump into a scratch database, counts the tables, drops the scratch database, and reports how long it took. An untested backup is a belief, not a control — this is what turns it into one, and the elapsed time it prints is the real measured recovery time for the database leg.

## Install

Needs root: everything here goes through systemd as root. The `lolipay` user *is* in the
`docker` group, which is root-equivalent — a separate decision worth revisiting, and not the
reason these units run as root.

```bash
sudo mkdir -p /etc/lolipay /var/backups/lolipay
sudo chmod 700 /var/backups/lolipay

sudo install -m 600 /dev/null /etc/lolipay/backup.key
openssl rand -base64 48 | sudo tee /etc/lolipay/backup.key > /dev/null
sudo chmod 600 /etc/lolipay/backup.key
```

**Write that passphrase down somewhere that is not this machine, right now.** Every backup is encrypted with it. If the disk dies and the passphrase died with it, the backups are noise.

The scripts are executed by root, so root must own them. They are installed to `/usr/local/sbin`
and the units point there — **never** at the working tree, which `lolipay` can write and therefore
rewrite under root's feet at 03:15 every morning.

```bash
cd ops/backup
sudo install -o root -g root -m 755 lolipay-backup.sh lolipay-backup-failed.sh /usr/local/sbin/
sudo install -o root -g root -m 644 lolipay-backup.service lolipay-backup-verify.service \
  lolipay-backup-failed@.service lolipay-backup.timer lolipay-backup-verify.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lolipay-backup.timer lolipay-backup-verify.timer
```

Commit, then re-run that block, after **every** edit here: the installed copy is what actually
runs, and the two can drift silently, so they are compared on every run — `drift_report` checks
all seven installed artifacts byte for byte, and checks that each one and its directory are
root-owned and writable by nobody else.

Those are two different findings and they no longer share an outcome:

| What was found | What happens |
|---|---|
| content differs from `HEAD`, or git cannot read it there (**blind**) | **warn and back up anyway** — a stale backup is worth far more than no backup. The weekly restore test still **dies** on it, *after* completing the restore, so the proof is kept and the alert is raised. |
| an artifact or its directory is **not root-owned, or group/other-writable** | **abort**, before `dump_postgres` and before the restore, in both subcommands |

The second was warn-and-continue until 2026-09-17, which is the wrong outcome for it: root
executes all seven, so a run that notices one of them is writable by somebody else and then goes
on to dump the database and the keystore is doing privileged work under an artifact set it has
just reported as tampered.

**Two limits on that, stated rather than implied.** `drift_report` runs *inside*
`lolipay-backup.sh` and checks `lolipay-backup.sh` among its seven, so it is structurally
incapable of vouching for itself — if that file is the one that was rewritten, the rewritten copy
is what is doing the checking. It is meaningful for the other six. And aborting does **not** stop
systemd from invoking a tampered `lolipay-backup-failed.sh` as root: the abort is a non-zero exit
like any other, so `OnFailure` fires. What the abort buys is that no dump, no keystore archive and
no decryption happen first. Check the seven by hand with
`stat -c '%U:%G %a %n' /usr/local/sbin/lolipay-backup*.sh /etc/systemd/system/lolipay-backup*`.

**The reference is `HEAD`, not the checkout.** `git -C ops/backup show HEAD:./<name>` is what each
installed copy is compared against, so an uncommitted edit in the working tree — an agent mid-task,
a half-finished change at 03:15 — is invisible to this check, and the alarm means *the installed
copy no longer matches the committed source*. Before 2026-09-17 the reference was the checkout, and
a dirty tree produced a false red: had the Sunday timer landed in such a window, `drift_report ||
die` would have failed the weekly restore proof and alerted with every backup healthy and the
restore itself passed. A file git cannot read at `HEAD` — not committed, not a repository, or git
refusing the directory — is reported as **blind**, never as clean. It runs as root against a
`lolipay`-owned repository, so it passes `-c safe.directory='*'`; the repository side is a
reference, not a trust anchor, and the protection on the installed side is root ownership.

Then prove it works rather than assuming:

```bash
sudo systemctl start lolipay-backup.service
sudo journalctl -u lolipay-backup.service -n 40 --no-pager
sudo systemctl start lolipay-backup-verify.service
sudo journalctl -u lolipay-backup-verify.service -n 20 --no-pager
```

Schedule: backup daily at 03:15 UTC, restore test weekly on Sunday at 04:30 UTC — each **plus up to fifteen minutes of random delay** (`RandomizedDelaySec=900` in both timers), so a backup that starts at 03:29 is on time. Observed: the eleven scheduled backups from 2026-09-18 to 2026-09-30 started between 03:15:37 and 03:29:44. Both use `Persistent=true`, so a run missed while the machine was off happens at the next boot — observed once: the host was off from Saturday 2026-09-26 18:31 UTC (Saturday's backup had already run, at 03:27:20) to Monday 2026-09-28 07:19 UTC, which missed Sunday's backup, Sunday's restore test and Monday's backup. A persistent timer fires once at boot however many runs it missed, so there was one catch-up backup (started 07:29:00) and one restore test (passed 07:20:29).

```bash
systemctl cat lolipay-backup.timer lolipay-backup-verify.timer
sudo journalctl -u lolipay-backup.service -o short-iso --no-pager --since 2026-09-18 -g 'Starting lolipay-backup'
journalctl --list-boots
```

## Off-site — still missing

**A copy on the same disk as the data is not a backup.** It survives a bad migration and a dropped table. It does not survive the disk, the filesystem, or the provider terminating the instance, which are the cases that make a trade unarbitrable.

Nothing is configured, and nothing was installed to configure it with — there is no `rclone`, `restic`, `aws` or `mc` on this host. And everything a recovery would need sits on one disk: the data volumes, every artifact in `/var/backups/lolipay` and the passphrase in `/etc/lolipay/backup.key` are on `/dev/vda1`, the only data partition of this VM (`lsblk`). Whether the provider snapshots that volume cannot be read from the host — it is a QEMU guest whose cloud-init ran once at first boot, from the `DataSourceEc2` datasource, and now reports `disabled` — so that is a question for the provider console, not for this file.

Set `BACKUP_OFFSITE_CMD` in `lolipay-backup.service` to a command that copies `$BACKUP_FILE` somewhere else. It runs once per artifact, through `bash -c`, and a non-zero exit fails the whole run before anything is pruned.

```
Environment='BACKUP_OFFSITE_CMD=rclone copyto "$BACKUP_FILE" "remote:lolipay/$(basename "$BACKUP_FILE")"'
```

**Quote the whole assignment**, as above. `systemd.exec(5)`: *"If you need to assign a value containing spaces or the equals sign to a variable, put quotes around the whole assignment."* Without the outer quotes systemd splits the line on whitespace, keeps `BACKUP_OFFSITE_CMD=rclone` and drops the rest — `systemd-analyze verify` on a unit carrying the unquoted line prints *Invalid environment assignment, ignoring: copyto* and two more like it — so every run would execute a bare `rclone`, which ships nothing whatever it exits with. The same form is already in use on this host: `ops/host/systemd/lolipay-landing.service` quotes `STELLAR_NETWORK_PASSPHRASE` the same way, and the served `stellar.toml` carries that value with its spaces intact. After setting it, read it back with `systemctl show lolipay-backup.service -p Environment`.

Until that is set, the script warns on every run and the warning is accurate.

## Restoring for real

A restore goes into a scratch database, `lolipay_restore`, and is swapped in by renaming only once it has completed. The chain drops nothing but its own scratch database: the swap renames the live `lolipay` to `lolipay_before_restore` and keeps it, in the same transaction that renames `lolipay_restore` to `lolipay`. Both renames are one `psql -c` string, which `psql` sends as one transaction, so the swap is all or nothing: with a session held on the scratch database, the second rename fails and the first is rolled back.

Of everything the decrypt-and-restore step produces, only its exit status gates the swap — the guard, the coordinator stop and the renames themselves can also stop it, but none of them looks at the data. Never judge a restore by its tables, its rows or its `Config` row. Measured on 2026-10-01 with a dump cut short inside a valid envelope: every table came back, 20 of the 21 with all their rows, `_prisma_migrations` — restored last — with none of its 31, and not one primary key, unique index or foreign key; a table count, a row count on any other table and the `Config` check all pass that. `pipefail` is what makes a damaged archive count: `gpg` reports one only after it has written out what it decrypted — all of it, for a single flipped bit — so without `pipefail` the step's status would be `pg_restore`'s alone. The chain's first line stops it under any shell but bash, silently and with status 1, because `dash`, which is `sh` on this host, rejects `set -o pipefail`. Run it in bash.

The plaintext never touches disk: `gpg` decrypts straight into `pg_restore` through a pipe, as step 2 of the backup does in the other direction. That is a decision, not a shortcut. Decrypting to a file in `/tmp` first, as this runbook once did, put a full plaintext copy of the database at a fixed, published path in a world-writable directory, and whether another account could read or replace it came down to which shell ran the block and to kernel settings. With no file there is no mode to set, nothing to refuse to overwrite and nothing to remove afterwards.

The coordinator keeps serving the live database while the scratch restore runs; the restore needs it neither running nor stopped. If the live database is serving wrong data, stop the coordinator before the chain. The chain stops it itself, just before the swap, because the rename refuses while any session is connected to `lolipay`, and the coordinator's connection pool holds at least one whenever it runs (2, then 3, when counted twice on 2026-09-30). Where no coordinator container exists yet, it skips that step.

**1. Who is connected** — run this first:

```bash
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres -Atc \
  "select datname, usename, client_addr from pg_stat_activity where datname in ('lolipay', 'lolipay_restore')"
```

**2. Restore into the scratch database, then swap:**

```bash
[ -n "${BASH_VERSION:-}" ] &&
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres \
  -c "DROP DATABASE IF EXISTS lolipay_restore;" &&
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres \
  -c "CREATE DATABASE lolipay_restore TEMPLATE template0;" &&
(set -o pipefail; sudo gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/lolipay/backup.key \
  --decrypt /var/backups/lolipay/pg-<stamp>.dump.gpg |
  sudo docker exec -i lolipayprod-postgres-1 pg_restore -U lolipay -d lolipay_restore \
    --no-owner --no-privileges --exit-on-error) &&
{ ! sudo docker container inspect lolipayprod-coordinator-1 >/dev/null 2>&1 ||
  sudo docker stop lolipayprod-coordinator-1; } &&
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres -c \
  "ALTER DATABASE lolipay RENAME TO lolipay_before_restore; ALTER DATABASE lolipay_restore RENAME TO lolipay;"
```

If the chain stopped before the swap, `lolipay` is untouched and the coordinator is still serving it. After a failed run `lolipay_restore` holds whatever `pg_restore` reached, and the chain's `DROP DATABASE IF EXISTS lolipay_restore` drops it on the next run. If the swap line itself failed, the coordinator is stopped, and what is safe next depends on the message:

- `ERROR:  database "lolipay" is being accessed by other users`, or the same for `"lolipay_restore"`: `lolipay` is untouched. Start the coordinator with block 4, find the session with block 1, and run the chain again.
- `ERROR:  database "lolipay_before_restore" already exists`: `lolipay` is the database an earlier run restored. If it has not served yet, take it through block 3 and then the comparison below, as if its swap had just happened, before either block 4 or block 5. If it has been serving since — it already went through block 3, the comparison and block 4 — the next step is block 4. To tell which: the chain stops the coordinator just before every swap. Block 4 starts it again; block 5 starts it too, but block 5 renames `lolipay_before_restore` back first, so this error cannot follow block 5. A deploy or a manual `compose up` also starts a stopped coordinator, so do neither while a restore is in progress. So if the coordinator was running when this run began, `lolipay` has served. `sudo docker inspect -f '{{.State.FinishedAt}}' lolipayprod-coordinator-1` shows when it last stopped: a time after this run began means it was running then. If anything other than block 4 may have started it — a deploy, `docker compose up`, a manual `docker start` — treat it as not yet served: take it through block 3 and the comparison, and re-apply, before block 4. An earlier time means it was already stopped, and it may still have served and been stopped before this run: if you know block 4 ran after that earlier swap, it has served; otherwise treat it as not yet served.
- `ERROR:  database "lolipay" does not exist`: **do not run block 4** — see below.

With no `lolipay` at all, block 4 would bring the coordinator up on a blank database: its container runs `npx prisma migrate deploy` before the server, and against a missing `lolipay` that creates it, applies every migration and succeeds (measured on 2026-10-01 with the coordinator's own Prisma), so the server starts on an empty database. `lolipay_restore` is complete at this point, because the chain reaches the swap only after `pg_restore` has exited 0. So put it in place, read the first line of block 3's output — its second line errors, because there is no `lolipay_before_restore` — and only then run block 4. This rename is right only when `lolipay` is absent; onto an existing `lolipay` it refuses with *already exists*:

```bash
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres -c "ALTER DATABASE lolipay_restore RENAME TO lolipay;"
```

**3. Read what each name now holds.** After a successful swap the coordinator is left stopped on purpose, so that this is read before anything serves the restored data. A complete, valid dump of the wrong data, such as the wrong stamp, passes every step above, and a coordinator started on it accepts writes that a rollback then throws away.

```bash
for db in lolipay lolipay_before_restore; do
  sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d "$db" -Atc \
    'select current_database(), (select count(*) from "Order"), (select max("createdAt") from "Order")'
done
```

**Before block 4, put back what the restore undid.** The restored database holds every provider, payment method and wallet link as it was at the stamp, so a suspension, revocation or deactivation made since is undone, and the coordinator acts on that as soon as it starts: matching offers any provider that is `APPROVED`, online and has an active payment method, and an address whose wallet link is `ACTIVE` again can sign in. While `lolipay_before_restore` exists, compare the two. A payment method's details are compared by their md5, so no bank details reach the screen, and nothing is written to disk. Lines starting `>` are the later state and lines starting `<` the restored one. In the payment-method comparison, a `<` line whose id has no `>` line is a method absent from the later state — deleted since the stamp, as a provider can delete one outright — and the restored copy brings it back, active.

```bash
for q in 'select "stellarAddress", status from "Lp" order by 1' \
  'select id, active, md5(details) from "PaymentMethod" order by 1' \
  'select "stellarAddress", status from "WalletLink" order by 1' \
  'select id, status from "Order" order by 1' \
  'select id, paused from "Config" order by 1' \
  'select code, enabled from "Market" order by 1' \
  'select "customerRef", status from "KycVerification" order by 1'; do
  diff <(sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d lolipay -Atc "$q") \
    <(sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d lolipay_before_restore -Atc "$q")
done
```

Re-apply to `lolipay` every difference where the later state is more restrictive: a provider suspended, revoked, or back to `PENDING` because it re-applied; a payment method deactivated, changed or absent; a wallet link revoked; an order cancelled. The statement for a provider only sets its status; set `addr` and `status` from the comparison:

```bash
sudo docker exec -i lolipayprod-postgres-1 psql -U lolipay -d lolipay -v ON_ERROR_STOP=1 \
  -v addr=G... -v status=SUSPENDED <<'SQL'
update "Lp" set status = :'status' where "stellarAddress" = :'addr';
SQL
```

An order cancelled since the stamp is open again in the restored database, whoever cancelled it: the admin screen cancels a suspended or revoked provider's orders that had not reached the chain, a depositor or a provider can cancel one, and an order can carry no provider at all. So orders get their own statement, with no provider or status condition. It cancels by id, not by status: as of the stamp an order can look pre-chain and have moved on since — `AWAITING_ONCHAIN` then, `FUNDED` now — and that one must not be cancelled. Set `ids` to every id whose `>` line in the order comparison reads `CANCELLED`: put them inside the quotes of `ids=''` below, separated by commas; spaces inside the quotes are ignored. Leave alone the order comparison's other lines: a `>` line with another status is an order that moved on after the stamp, and a `>` line with no `<` line is an order created after it; this step changes neither. It also cancels only an order that in `lolipay` has not reached the chain — `CREATED`, `MATCHED` or `AWAITING_ONCHAIN` — so an order that is `FUNDED` or further on is never cancelled, whatever ids are listed. Check that psql's `UPDATE n` equals the number of ids you listed whose `<` line reads `CREATED`, `MATCHED` or `AWAITING_ONCHAIN`; fewer means an id was missed, for example because the ids were separated by newlines instead of commas. Left empty, `ids` cancels nothing:

```bash
sudo docker exec -i lolipayprod-postgres-1 psql -U lolipay -d lolipay -v ON_ERROR_STOP=1 -v ids='' <<'SQL'
update "Order" set status = 'CANCELLED' where id = any(string_to_array(replace(:'ids', ' ', ''), ','))
  and status in ('CREATED', 'MATCHED', 'AWAITING_ONCHAIN');
SQL
```

A payment method deactivated since the stamp is deactivated again, and so is one absent from the later state — a `<` line whose id has no `>` line — and one whose details changed since: the restored copy carries the details as they were at the stamp, and no depositor should be sent to them until the provider confirms them. Set `id` from the comparison:

```bash
sudo docker exec -i lolipayprod-postgres-1 psql -U lolipay -d lolipay -v ON_ERROR_STOP=1 -v id=... <<'SQL'
update "PaymentMethod" set active = false where id = :'id';
SQL
```

A wallet link revoked since the stamp is revoked again. Set `addr` from the comparison:

```bash
sudo docker exec -i lolipayprod-postgres-1 psql -U lolipay -d lolipay -v ON_ERROR_STOP=1 -v addr=G... <<'SQL'
update "WalletLink" set status = 'REVOKED' where "stellarAddress" = :'addr';
SQL
```

A restore also undoes later restrictions outside those three tables, and the comparison's last three queries show the ones measured so far: `Config.paused`, the kill switch, so a restore made after an incident turns trading back on; a market's `enabled`; and a `KycVerification` row `REJECTED` since the stamp, which is meant to stick. Put each of those back in `lolipay` by hand before block 4; no template for them is written yet.

Then run the comparison again. What may still differ: a payment method deactivated because its details changed, or because it is absent from the later state, which stays a `<` line with no `>` line and now reads inactive — if it still reads active, the deactivation was missed; orders that moved on or were created after the stamp, which this step does not change; and anything the later state made less restrictive, such as an approval or a reactivation, which is a decision, not a correction. None of this writes an audit row or tells anyone: the audit rows for the original changes stay in `lolipay_before_restore`, and depositors whose orders were cancelled were told when it first happened. When `lolipay_before_restore` does not exist — a rebuilt host, or the `does not exist` case above — nothing in the restored database records what changed after the stamp, and the admin audit table cannot fill the gap: the restored copy of it stops at the stamp too, and not every such change goes through the audited admin path — a person revoking one of their own wallet links writes no audit row.

**4. Start the coordinator,** if block 3 shows the backup you meant and the later restrictions are back:

```bash
sudo docker start lolipayprod-coordinator-1
```

**5. Or roll back.** The rows the restored database took while it served then live only in `lolipay_rolled_back`. No numbered block drops that name: drop it with the command after this block once those rows have been reconciled or deliberately abandoned. While it exists, a second rollback refuses at the rename, because the name is taken, and leaves the coordinator stopped with `lolipay` unchanged; then either deal with `lolipay_rolled_back` and run this block again, or keep `lolipay` as it is and start the coordinator with block 4:

```bash
sudo docker stop lolipayprod-coordinator-1 &&
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres -c \
  "ALTER DATABASE lolipay RENAME TO lolipay_rolled_back; ALTER DATABASE lolipay_before_restore RENAME TO lolipay;" &&
sudo docker start lolipayprod-coordinator-1
```

Dropping `lolipay_rolled_back` cannot be undone:

```bash
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres \
  -c "DROP DATABASE lolipay_rolled_back;"
```

**6. Drop the old database — this cannot be undone, and it is run later.** While `lolipay_before_restore` exists, the next run of the chain refuses at the swap, because the name is taken, and leaves `lolipay` and `lolipay_before_restore` as they were, with the coordinator stopped as after any refused swap. That refusal is deliberate: the rows written after the stamp exist only in `lolipay_before_restore`, and a second restore cannot go ahead until someone has decided what happens to them. Drop it only after block 3 has been read, the restored database has served, and every row written after the stamp has been reconciled or deliberately abandoned:

```bash
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres \
  -c "DROP DATABASE lolipay_before_restore;"
```

On a rebuilt host, restore the secrets leg first: compose fills `POSTGRES_*` and `MINIO_ROOT_*` from the coordinator's environment file beside the compose file, and that leg is what puts it back. Then bring up `postgres` and `minio` only, and leave the coordinator down until the swap is done: a `docker compose … up -d` that names no service would start it on the empty `lolipay` the postgres image creates, before anything is restored. The chain works there with no coordinator container; the swap keeps that empty database as `lolipay_before_restore`, and block 3's second line errors because it has no tables. Bring the coordinator up with compose afterwards. Neither compose step has been measured; the environment-file dependency is read from `docker-compose.prod.yml`.

`DROP` and `CREATE` of the scratch database are two calls because `psql` runs a single `-c` string as one transaction, and `DROP DATABASE` refuses to run inside one: written as one `-c`, the pair fails with *cannot run inside a transaction block* and neither drops nor creates anything. The scratch database is made from `template0`, as pg_restore(1) advises, so that nothing added to `template1` — by whatever the restore is recovering from, say — is copied into it. The two renames are one `-c` for the opposite reason: `ALTER DATABASE … RENAME` may run inside a transaction, and that is what makes the swap atomic. The `pg_restore` flags are the ones the weekly restore test proves, `--exit-on-error` included, so a partial restore fails loudly instead of finishing with an error count at the bottom; that test restores into its own scratch name, `lolipay_restore_test_<pid>`, so it never collides with `lolipay_restore`. `--no-owner --no-privileges` loses nothing today: on 2026-10-01 production has one login role, `lolipay`, a superuser, and no per-database or per-role settings. That stops being true the day a non-superuser application role is added, whose ownership and grants these flags would drop, or an `ALTER DATABASE … SET` is introduced, which a restore into a database it did not create does not carry. Re-derive it rather than trusting the date: the first query below must print nothing and the second exactly `10|lolipay|t|t`. The second says `not rolname ~` rather than `rolname !~` because an interactive bash reads `!~` inside double quotes as a history expansion and runs nothing.

```bash
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres -Atc \
  "select coalesce(d.datname,'(all)'), s.setconfig from pg_db_role_setting s left join pg_database d on d.oid=s.setdatabase"
sudo docker exec lolipayprod-postgres-1 psql -U lolipay -d postgres -Atc \
  "select oid, rolname, rolsuper, rolcanlogin from pg_roles where not rolname ~ '^pg_'"
```

The restore needs room for one copy of the database per name in use — `lolipay`, `lolipay_restore` while the chain runs, `lolipay_before_restore`, and `lolipay_rolled_back` after a rollback: three after one rollback, and four if the chain is run while `lolipay_before_restore` and `lolipay_rolled_back` both still exist. It has been run only against a throwaway copy, never against production.

MinIO — **no restore of this leg has ever been rehearsed.** The weekly restore test covers the database only: none of its journal lines mention minio, on 2026-10-01 thirteen of them report a passed database restore, and nothing records a restore done by hand. What follows is read from the script and from `docker cp`, not from a run.

```bash
sudo gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/lolipay/backup.key \
  --decrypt /var/backups/lolipay/minio-<stamp>.tar.gpg \
  | sudo docker cp - lolipayprod-minio-1:/data
```

`docker cp` **merges** — it does not delete files the archive does not contain. Restoring
over a non-empty `/data` interleaves stale metadata and orphaned part files with the restored
set, which an erasure-coded backend handles worse than an empty target. Empty it first, with
the container stopped:

```bash
sudo docker stop lolipayprod-minio-1
sudo docker run --rm -v lolipayprod_minio-data:/data alpine find /data -mindepth 1 -delete
sudo docker start lolipayprod-minio-1
```

Then run the decrypt-and-copy above, and restart the container afterwards.

The `tar` form that used to be documented here **cannot work**: the `minio/minio` image ships
no `tar`. That is the same defect that stopped the backup leg from ever running, and it was
left in the recovery leg for a day after the backup leg was fixed.

Secrets — the leg that decides whether any of the above can actually be served:

```bash
sudo gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/lolipay/backup.key \
  --decrypt /var/backups/lolipay/secrets-<stamp>.tar.gpg | tar -tvf -

sudo gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/lolipay/backup.key \
  --decrypt /var/backups/lolipay/secrets-<stamp>.tar.gpg \
  | sudo tar -C / -xf -
```

**List it first and read the member names; never print a member's contents.** The archive stores
paths relative to `/`, so `tar -C / -xf` puts every file back where it came from, with its original
mode and ownership — the keystore returns as `0600 lolipay`, not as root-owned. It restores the
coordinator environment and ten Stellar identities, and that is the whole of it: eleven files plus
the keystore directory entry, twelve members in all.

It restores nothing from `/etc/lolipay`, by design — that is where the passphrase you used to
decrypt this archive lives, so on a rebuild you already have it in hand. If you do not, nothing
above runs, which is why the install section says to write it down somewhere that is not this
machine.

Two things to fix by hand after extracting onto a **fresh** machine, because tar restores the
members it holds and nothing above them:

```bash
sudo chown lolipay:lolipay /home/lolipay/.config /home/lolipay/.config/stellar
sudo chmod 600 /home/lolipay/lolipay-monorepo/services/coordinator/.env
```

The archive carries `…/.config/stellar/identity/` but not its two parent directories, so on a bare
host `tar -C / -xf` creates them `root:root` and the CLI cannot read its own keystore.

**Three archives on this disk carried the environment file at mode `0664`**, which was its live mode
until it was tightened at 2026-09-16 12:17 UTC — `secrets-20260916T101156Z.tar.gpg`,
`secrets-20260916T110532Z.tar.gpg` and `secrets-20260916T121152Z.tar.gpg`. `tar -C / -xf` restores
the mode stored in the archive, so recovering from one of them would have re-created a world-readable
file holding the attestor secret. **They no longer exist**: on 2026-09-30 `ls` reports *No such file*
for all three, while the `pg-` and `minio-` files of the same three stamps are still present.
Retention did not remove them — it prunes at 60 days and they were about a day old. They were
deleted deliberately at 2026-09-17 10:44:14 UTC, because each would have restored the environment
file at mode `0664`; the host's sudo log holds the command. On 2026-10-01 the oldest secrets archive
is `secrets-20260916T121757Z.tar.gpg`, written after the tightening, and so is every one of the 24
on disk.

Re-derive that rather than trusting this paragraph. The loop prints each archive's first member with
its stored mode and nothing else:

```bash
for f in /var/backups/lolipay/secrets-*.tar.gpg; do
  printf '%s ' "$(basename "$f")"
  sudo gpg --batch --quiet --pinentry-mode loopback --passphrase-file /etc/lolipay/backup.key \
    --decrypt "$f" 2>/dev/null | tar -tvf - | head -1
done
```

The eight archives written between the tightening and 2026-09-17 08:35 predate the check described
next, so the loop is the only thing that vouches for their mode. Every one written since it was
installed at 09:11 that day was verified `-rw-------` as it was written: on 2026-10-01 the journal
holds sixteen verify lines from then on, all sixteen at that mode.

Since 2026-09-17 a **new** archive with that defect fails the run: step 5 reads the archived mode with
`tar -tvf` and refuses anything but `0600` or `0400`, the run exits non-zero and the failure handler
fires, so this stops depending on whoever is restoring remembering to look. The archive itself has
already been written under its final name by then and nothing removes it — it sits on disk until
retention takes it, and the journal names it in a `FATAL … carries … at mode` line. The `chmod 600` in
the block above is still the belt to those braces, and is harmless whichever archive you restored.

The containers are `lolipayprod-postgres-1`, `lolipayprod-minio-1` and `lolipayprod-coordinator-1`:
compose project `lolipayprod` on `services/coordinator/docker-compose.prod.yml`, which is what the
units set (`COMPOSE_PROJECT`, `COMPOSE_FILE`). List them with

```bash
sudo docker ps --filter label=com.docker.compose.project=lolipayprod --format '{{.Names}}'
```

which needs neither a working directory nor an environment file. The compose form,
`sudo docker compose -p lolipayprod -f services/coordinator/docker-compose.prod.yml ps`, works only
from a checkout that has the coordinator's environment file beside that compose file.
`docker-compose.yml` next to it is the development file; its project has no containers.

## Retention

60 days, because the escrow's `TRADE_LIFETIME` is 45 days and a trade can be contested for as long as it is readable on chain. A disputed trade has no upper bound at all, so 60 is a working margin rather than a proof — if that changes, this number should change with it.

## Known limitations

- **The MinIO archive is taken while MinIO is running.** Proof and evidence objects are written once and never modified, so a file is either fully present or absent from the archive. An object uploaded during the tar could be missed and would be caught by the next run.
- **The restore test covers the database only, and the MinIO leg has never been restored anywhere.** The MinIO archive is verified as decryptable and intact, but nothing extracts it and checks the objects, and no restore of it — by the test or by hand — is on record. The objects it holds are the payment proofs and dispute evidence: 12 objects, 3,815,540 bytes, on 2026-09-30.
- **`/var/backups/lolipay/minio-latest.tar` is not a backup of data.** It is a `docker save` of the image the MinIO container runs — 176,274,432 bytes, root `0600`, written 2026-09-18, 26 members in OCI layout — kept on purpose so a rebuilt host can `docker load` it without depending on the registry serving that tag. It is unencrypted, as a public image can be, and `prune_old` never touches it: the prune matches `*.gpg` and `*.partial` only. Nothing re-checks it.
- **Failure reaches the webhook — proven on 2026-09-17, and the sentence that stood here before was false.** It read that `OnFailure` *"has fired at least once (2026-08-26)"* and concluded *"a failed run does reach the webhook"*. Asked of systemd, the journal says otherwise: the only real unit failure is `2026-08-26T16:24:31`; the only handler invocation is `2026-08-26T16:54:31`, thirty minutes later, and it logged *"ALERT_WEBHOOK_URL is unset, so this failure reaches the journal and nobody else"*; and the wiring landed in `dc2d4ff` at `16:55:11`, **forty seconds after that handler run**. So the real failure predates the wiring, the one invocation was a hand test that delivered nothing, and the path had never carried an alert to a webhook in its life. The presence check offered as proof also measured the wrong artefact: it read the **container's** environment, while `lolipay-backup-failed.sh` reads the environment **file on disk**. Verified end to end instead, with a drop-in under `/run` pointing the verify unit at a non-existent passphrase file: the unit failed in preflight before writing anything, systemd logged `Triggering OnFailure=`, the handler ran and logged `failure reported to the alert webhook`, and it exited 0. Re-run that drill rather than trusting this paragraph — it is the only thing that proves the hop, and it has not been repeated since: the handler's journal holds those two invocations and no other. What is still true: **nothing alerts if the timer itself stops being scheduled.**
- **An undelivered alert is now itself a failed unit.** The handler used to exit 0 whether it posted, failed to post, or never had a URL to post to, so a dead webhook looked exactly like a live one. It now exits non-zero on an empty value, on a **quoted** one — the quotes are part of what it reads out of the file, so `curl` could never have used it — and on a `curl` failure. Check with `systemctl --failed`, which will name `lolipay-backup-failed@…` when an alert did not land. The URL is never printed, logged or echoed by any of this.
- **The host's serving layer is still not in the encrypted set** — git is its only copy, and none of it is inside a backup archive (the secrets leg carries the environment file and the keystore, twelve members, nothing else). Measured on 2026-09-30, after these copies were brought level with the host: the **7** enabled nginx sites, `nginx.conf` and the `conf.d` upgrade map are tracked under `ops/host/nginx/` and all nine are byte-identical to what nginx serves; of the **13** `lolipay-*` systemd units, nine are tracked — four under `ops/host/systemd/`, the five backup units here — and byte-identical to `/etc/systemd/system/`, and four have no copy at all: `lolipay-heartbeat.service`, `lolipay-heartbeat.timer`, `lolipay-frontend-serving.service`, `lolipay-frontend-serving.timer` — on-box liveness probes that exist on the host and are intentionally not tracked, described in `ops/host/README.md`. Before that, an audit between 17:40 and 18:05 UTC the same day found two tracked copies stale and five installed files with no copy. Nothing compares the host copies automatically — `drift_report` covers the seven backup artifacts only — so the check is by hand, in `ops/host/README.md`.
- **Off-site shipping is still not configured**, so every archive — now including the secrets leg — lives on the same disk as the data it protects. That is the next item and it has a precondition the founder owns by hand.

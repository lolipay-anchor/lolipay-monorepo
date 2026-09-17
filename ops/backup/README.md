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
5. **Decrypts all three files end to end** to confirm they are readable and intact before doing anything else. AES256 in GPG carries an integrity check, so a file that cannot be decrypted fails here, and a minio archive that decrypts to fewer than two tar entries fails here too rather than on the day you need it. The secrets archive additionally fails here unless the environment file is present **by name**, the keystore identity count matches the live keystore exactly, and **no member at all** lives under `etc/lolipay/`. Names only — no member's content is ever read or printed.
6. Ships off-site, if `BACKUP_OFFSITE_CMD` is set. If it is not set, it says so loudly.
7. Only then prunes anything older than the retention window.

The ordering in 5–7 is the point. **A failed run never deletes a good backup**, and never leaves a partial file behind.

If the secrets leg fails, the postgres and minio artifacts for that stamp are **kept**, unlike the pg/minio pair which is torn down together. The pair is atomic because a database without its object store restores to an unarbitrable trade; a database and object store without the secrets still restore, they just need the environment rebuilt by hand.

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
all seven installed artifacts byte for byte. A backup that finds drift **warns and backs up
anyway** (a stale backup beats no backup); the weekly restore test **fails** on drift, after
completing the restore, so the proof is kept and `OnFailure` raises the alert.

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

Schedule: backup daily at 03:15 UTC, restore test weekly on Sunday at 04:30 UTC. Both use `Persistent=true`, so a run missed while the machine was off happens at the next boot.

## Off-site — still missing

**A copy on the same disk as the data is not a backup.** It survives a bad migration and a dropped table. It does not survive the disk, the filesystem, or the provider terminating the instance, which are the cases that make a trade unarbitrable.

Nothing is configured, and nothing was installed to configure it with — there is no `rclone`, `restic`, `aws` or `mc` on this host. Set `BACKUP_OFFSITE_CMD` in `lolipay-backup.service` to a command that copies `$BACKUP_FILE` somewhere else. It runs once per artifact and a non-zero exit fails the whole run.

```
Environment=BACKUP_OFFSITE_CMD=rclone copyto "$BACKUP_FILE" "remote:lolipay/$(basename "$BACKUP_FILE")"
```

Until that is set, the script warns on every run and the warning is accurate.

## Restoring for real

```bash
sudo gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/lolipay/backup.key \
  --decrypt /var/backups/lolipay/pg-<stamp>.dump.gpg > /tmp/restore.dump

sudo docker exec -i <pg-container> psql -U lolipay -d postgres \
  -c "DROP DATABASE IF EXISTS lolipay; CREATE DATABASE lolipay;"

sudo docker exec -i <pg-container> pg_restore -U lolipay -d lolipay \
  --no-owner --no-privileges < /tmp/restore.dump

shred -u /tmp/restore.dump
```

MinIO:

```bash
sudo gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/lolipay/backup.key \
  --decrypt /var/backups/lolipay/minio-<stamp>.tar.gpg \
  | sudo docker cp - <minio-container>:/data
```

`docker cp` **merges** — it does not delete files the archive does not contain. Restoring
over a non-empty `/data` interleaves stale metadata and orphaned part files with the restored
set, which an erasure-coded backend handles worse than an empty target. Empty it first, with
the container stopped:

```bash
sudo docker stop <minio-container>
sudo docker run --rm -v lolipayprod_minio-data:/data alpine find /data -mindepth 1 -delete
sudo docker start <minio-container>
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
host `tar -C / -xf` creates them `root:root` and the CLI cannot read its own keystore. And any
archive taken before 2026-09-16 12:17 UTC carries the environment file at mode **664**, which was
the live mode until it was tightened — restoring one of those reintroduces a world-readable file
holding the attestor secret. Check the mode with `tar -tvf` before extracting, not after.

Get the container names with `sudo docker compose -f services/coordinator/docker-compose.yml ps`.

## Retention

60 days, because the escrow's `TRADE_LIFETIME` is 45 days and a trade can be contested for as long as it is readable on chain. A disputed trade has no upper bound at all, so 60 is a working margin rather than a proof — if that changes, this number should change with it.

## Known limitations

- **The MinIO archive is taken while MinIO is running.** Proof and evidence objects are written once and never modified, so a file is either fully present or absent from the archive. An object uploaded during the tar could be missed and would be caught by the next run.
- **The restore test covers the database only.** The MinIO archive is verified as decryptable and intact, but nothing extracts it and checks the objects.
- ~~**Failure is only visible in the journal.** `ALERT_WEBHOOK_URL` is not set anywhere~~ — **corrected 2026-09-16: both clauses were false.** `OnFailure=lolipay-backup-failed@…` is wired on both service units and has fired at least once (2026-08-26), and `ALERT_WEBHOOK_URL` is present in the running coordinator's environment, checked by presence and never by value. So a failed run does reach the webhook. What is still true: nothing alerts if the timer itself stops being scheduled.
- **The host's serving layer is still not in the encrypted set** — measured 2026-09-16, and the previous wording was wrong in both numbers. There are **7** enabled nginx site files, not six: six are tracked under `ops/host/nginx/sites-available/`, of which five are byte-identical to what nginx serves, `lolipay` **differs from the served copy**, and `lolipay-www` is tracked nowhere. There are **11** lolipay systemd units, not four: nine are tracked, and `lolipay-heartbeat.service` / `lolipay-heartbeat.timer` are tracked nowhere. None of these are inside a backup archive — git is the only copy, and for three of them there is no copy at all.
- **Off-site shipping is still not configured**, so every archive — now including the secrets leg — lives on the same disk as the data it protects. That is the next item and it has a precondition the founder owns by hand.

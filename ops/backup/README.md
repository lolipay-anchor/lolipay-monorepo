# Backups

## Why this exists

The escrow lives on Stellar and survives anything that happens to this machine. It proves that USDC moved.

It does not prove that the rupiah moved. Only Postgres and MinIO ever knew that — who was matched with whom, which bank reference was quoted, what the payment proof looked like, what evidence a dispute carried. Lose those and every in-flight or disputed trade becomes unarbitrable: you can see the on-chain half and nothing else.

That is the whole justification. It is not "databases should have backups".

## What it does

`lolipay-backup.sh backup`

1. Refuses to start unless the passphrase file exists with mode 600 or 400, both containers are running, and there is at least 1 GiB free.
2. `pg_dump -Fc` out of the running Postgres container, straight into `gpg --symmetric --cipher-algo AES256`. The plaintext never touches disk.
3. Tars MinIO's `/data` through the same encryption.
4. **Decrypts both files end to end** to confirm they are readable and intact before doing anything else. AES256 in GPG carries an integrity check, so a truncated or corrupted file fails here rather than on the day you need it.
5. Ships off-site, if `BACKUP_OFFSITE_CMD` is set. If it is not set, it says so loudly.
6. Only then prunes anything older than the retention window.

The ordering in 4–6 is the point. **A failed run never deletes a good backup**, and never leaves a partial file behind.

`lolipay-backup.sh restore-test` restores the newest dump into a scratch database, counts the tables, drops the scratch database, and reports how long it took. An untested backup is a belief, not a control — this is what turns it into one, and the elapsed time it prints is the real measured recovery time for the database leg.

## Install

Needs root: the `lolipay` user is not in the `docker` group, and the group is empty, so everything here goes through systemd as root.

```bash
sudo mkdir -p /etc/lolipay /var/backups/lolipay
sudo chmod 700 /var/backups/lolipay

openssl rand -base64 48 | sudo tee /etc/lolipay/backup.key > /dev/null
sudo chmod 600 /etc/lolipay/backup.key
```

**Write that passphrase down somewhere that is not this machine, right now.** Every backup is encrypted with it. If the disk dies and the passphrase died with it, the backups are noise.

```bash
sudo cp ops/backup/lolipay-backup*.service ops/backup/lolipay-backup*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lolipay-backup.timer lolipay-backup-verify.timer
```

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
  | sudo docker exec -i <minio-container> tar -C /data -xf -
```

Get the container names with `sudo docker compose -f services/coordinator/docker-compose.yml ps`.

## Retention

60 days, because the escrow's `TRADE_LIFETIME` is 45 days and a trade can be contested for as long as it is readable on chain. A disputed trade has no upper bound at all, so 60 is a working margin rather than a proof — if that changes, this number should change with it.

## Known limitations

- **The MinIO archive is taken while MinIO is running.** Proof and evidence objects are written once and never modified, so a file is either fully present or absent from the archive. An object uploaded during the tar could be missed and would be caught by the next run.
- **The restore test covers the database only.** The MinIO archive is verified as decryptable and intact, but nothing extracts it and checks the objects.
- **Failure is only visible in the journal.** `ALERT_WEBHOOK_URL` is not set anywhere, so the coordinator's alerting path does nothing. Until that is wired, add `OnFailure=` to both service units pointing at whatever notification you do have — otherwise a backup that has been failing for a month looks exactly like one that has been working.
- **The host's own configuration is not backed up here.** Six nginx site files and four systemd units exist only on this machine and in no repository. Losing them means rebuilding the serving layer from memory.

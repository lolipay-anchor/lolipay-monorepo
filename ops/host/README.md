# Host configuration

The serving layer — seven nginx sites, `nginx.conf`, the websocket upgrade map and the systemd
units — lived only on the VPS and in no repository. Losing the machine meant rebuilding it from
memory. These are copies, kept here so that is no longer true.

**They are a record, not the source of truth.** Nothing deploys from this directory. If you
change something in `/etc`, copy it back here in the same commit, or the next person will trust
a file that has drifted. That is what happened from 2026-08-27 until the copies here were brought
level: the API site gained its `/auth` rate limit and the landing unit four `Environment=` keys,
the copies here kept the old versions, and in that time the restore steps below would have
reinstalled both regressions. Nothing
compares these copies automatically — `drift_report` in `ops/backup/` covers the seven backup
artifacts only — so compare by hand:

```bash
for f in ops/host/nginx/sites-available/*; do
  cmp "$f" "/etc/nginx/sites-available/$(basename "$f")" && echo "$(basename "$f") identical"
done
cmp ops/host/nginx/nginx.conf /etc/nginx/nginx.conf && echo nginx.conf identical
cmp ops/host/nginx/conf.d/lolipay-upgrade.conf /etc/nginx/conf.d/lolipay-upgrade.conf && echo upgrade map identical
for u in ops/host/systemd/*; do
  cmp "$u" "/etc/systemd/system/$(basename "$u")" && echo "$(basename "$u") identical"
done
for s in $(ls /etc/nginx/sites-enabled); do
  [ -e "ops/host/nginx/sites-available/$s" ] || echo "no copy of site $s"
done
for u in $(ls /etc/systemd/system | grep -F lolipay); do
  [ -e "ops/host/systemd/$u" ] || [ -e "ops/backup/$u" ] || echo "no copy of unit $u"
done
```

Every `cmp` must say `identical`, the site loop must print nothing, and the unit loop must name
exactly the four probe units below and nothing else. On 2026-09-30 that is what the block prints:
13 `identical` lines — 7 sites, `nginx.conf`, the upgrade map and the 4 units tracked here — and
four `no copy of unit` lines: `lolipay-heartbeat.service`, `lolipay-heartbeat.timer`,
`lolipay-frontend-serving.service`, `lolipay-frontend-serving.timer`, on-box liveness probes that
exist on the host and are intentionally not tracked here (see below). The five backup units in
`ops/backup/` are not in the `cmp` loop above; `drift_report` compares them byte for byte on every
backup run, and the last loop only confirms they have a copy.

## Layout

```
nginx/nginx.conf         the http block, which carries the lolipay_auth rate-limit zone the API site references
nginx/sites-available/   one file per subdomain; `lolipay` is the API, `lolipay-www` redirects www to the apex
nginx/conf.d/            the websocket upgrade map, which must live in the http block
systemd/                 one unit per Next.js app
```

The five backup units are in `ops/backup/`, with their own install steps.

## Restoring after a rebuild

Certificates come before anything in the block below. Six of the seven site files — all but
`lolipay-frontends`, a port-80 redirect — reference a certificate under `/etc/letsencrypt` and
include two files certbot keeps there, `options-ssl-nginx.conf` and `ssl-dhparams.pem`, so the
block's `nginx -t` cannot pass until all of them exist. `certbot certonly --standalone` issues
certificates but never writes those two files; the nginx plugin writes them, and only after it has
checked that the configuration it finds already loads (certbot 2.9.0, the version on this host).
One way through, not rehearsed: on a fresh install, while the stock `default` site is still
enabled, issue each lineage listed further down with the authenticator listed for it — the nginx
plugin's first run writes the two files — or restore all of `/etc/letsencrypt` from a copy, which
none of the backups in `ops/backup/` holds; then run the block.

`nginx.conf` goes first: the `lolipay` site references `zone=lolipay_auth`, and without the zone
`nginx -t` fails for every site at once. A fresh nginx install also enables a `default` site,
which this host does not enable; the block removes it, and starts nginx if it is not running.

```bash
sudo cp ops/host/nginx/nginx.conf /etc/nginx/nginx.conf
sudo cp ops/host/nginx/conf.d/* /etc/nginx/conf.d/
sudo cp ops/host/nginx/sites-available/* /etc/nginx/sites-available/
sudo rm -f /etc/nginx/sites-enabled/default
for s in lolipay lolipay-admin lolipay-app lolipay-frontends lolipay-landing lolipay-lp lolipay-www; do
  sudo ln -sf "/etc/nginx/sites-available/$s" "/etc/nginx/sites-enabled/$s"
done
sudo nginx -t && sudo systemctl reload-or-restart nginx

sudo cp ops/host/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lolipay-web lolipay-lp lolipay-admin lolipay-landing
```

Then the backup units, from `ops/backup/README.md`. The two on-box liveness probes described below
are intentionally not tracked here and come back by hand.

TLS is not here. Certificates are issued by certbot and live in `/etc/letsencrypt`, and the site
files reference them, so a rebuilt host needs them before these configs load. There are four
lineages for the six names: `api.lolipay.app`; `app.lolipay.app`, which also carries
`admin.lolipay.app` and `lp.lolipay.app`; `lolipay.app`; and `www.lolipay.app`. The first three
renew through the nginx authenticator (`certbot --nginx`); `www.lolipay.app` renews through the
webroot at `/var/www/html`, which is why `lolipay-www` serves `/.well-known/acme-challenge/` from
there on port 80. `certbot.timer` does the renewing.

## The two probes — on the host, intentionally not tracked here

`lolipay-heartbeat.timer` runs `lolipay-heartbeat.service` every two minutes: it asks
`https://api.lolipay.app/health` the way a user would and pages after three consecutive
failures. `lolipay-frontend-serving.timer` runs `lolipay-frontend-serving.service` every five
minutes: it checks that each of the four Next.js apps is serving the build its last deploy
recorded, and pages after three consecutive bad probes. Both are `oneshot` units run as `lolipay`,
and both are on-box liveness probes that exist on the host and are intentionally not tracked here:
they and the scripts they run belong to the host's local tooling, which stays out of this
repository and out of every backup archive.

Two things follow. A rebuilt host does not get them from this directory — they come back by hand.
And **both run on this host**: a machine that is down cannot report itself down, and nothing off
the box watches it. As of 2026-09-30 the heartbeat has never posted an alert — its journal has
`DOWN` lines but no `ALERT POSTED` line — and the frontend probe has posted once: four alerts at
2026-09-21 15:19 UTC, when no deploy had yet recorded a build for any of the four (all four
`BLIND`), and four recovery notices at 17:52. The pattern below is lowercase on purpose: an
all-lowercase `-g` matches regardless of case, and an uppercase one misses `recovery notice
posted`.

```bash
sudo journalctl -u lolipay-heartbeat.service --no-pager -g posted
sudo journalctl -u lolipay-frontend-serving.service --no-pager -g posted
```

## What is not here

The coordinator, Postgres and MinIO run under docker compose — project `lolipayprod` on
`services/coordinator/docker-compose.prod.yml`, three containers — and are restored from
`ops/backup/README.md`, not from this directory. None of the three containers declares a
healthcheck (`docker inspect --format '{{json .Config.Healthcheck}}' <name>` prints `null` for
all three), so `Up` in `docker ps` says the process exists, not that it answers.

## The API site, and why it looks the way it does

Three things in `nginx/sites-available/lolipay` were corrected on 2026-08-22 and should not be
reverted; the `/auth` rate-limit block added on 2026-08-27 is explained in `ops/nginx/README.md`.

**`client_max_body_size 6m`** — the default is 1 MB while the application accepts 5 MB uploads.
A payment-proof photo from a phone is routinely between the two, so nginx rejected it with an
HTML 413 the API client could not parse. The provider saw a generic failure and believed the
proof had been filed. Six is deliberately above the application's own limit, so the application
is the one that answers, in JSON.

**`Connection $lolipay_connection_upgrade`** — this was previously the literal string
`upgrade` on every request. Ordinary HTTP calls then carried an upgrade header with nothing to
upgrade to, which defeats upstream keepalive. The map sends `upgrade` only when the client
actually asked for one, and `close` otherwise.

**`proxy_read_timeout 60s` on `location /`** — it was 3600s for everything, so any stalled
plain HTTP request held a worker connection for an hour. The long timeout now applies only to
the websocket block, which genuinely needs it.

**`location /socket.io/`** — the websocket block, and the one place that forwards the `Upgrade`
header. It is for socket.io, which the coordinator's realtime gateway serves under the namespace
`/ws` and the clients open with `io(baseUrl + '/ws')`; a socket.io namespace is not an HTTP path,
and every request for it arrives at `/socket.io/`. Until 2026-09-30 this block was written as
`location /ws`, matched nothing, and every upgrade fell through to `location /`, which forwards no
`Upgrade` header. So from 2026-08-22, when `521df7e` moved the `Upgrade` header off `location /`
into a `/ws` block no request reaches, until 2026-09-30, no websocket could connect through nginx;
before that `location /` forwarded it. Nothing looked broken, because socket.io's long-polling
requests to the same path were served through `location /` all along. The one line was changed by
hand at 20:27 UTC on 2026-09-30, and the first `101 Switching Protocols` lines in the logs kept on
this host (from 2026-09-16, as of 2026-10-01) are the two right after it, at 20:28:58 and 20:29:16. Check with
`sudo zgrep -h socket.io /var/log/nginx/access.log* | awk '$9==101'`.

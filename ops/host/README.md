# Host configuration

The serving layer — six nginx sites and four systemd units — lived only on the VPS and in no
repository. Losing the machine meant rebuilding it from memory. These are copies, kept here so
that is no longer true.

**They are a record, not the source of truth.** Nothing deploys from this directory. If you
change something in `/etc`, copy it back here in the same commit, or the next person will trust
a file that has drifted.

## Layout

```
nginx/sites-available/   one file per subdomain; `lolipay` is the API
nginx/conf.d/            the websocket upgrade map, which must live in the http block
systemd/                 one unit per Next.js app
```

## Restoring after a rebuild

```bash
sudo cp ops/host/nginx/sites-available/* /etc/nginx/sites-available/
sudo cp ops/host/nginx/conf.d/* /etc/nginx/conf.d/
for s in lolipay lolipay-admin lolipay-app lolipay-lp lolipay-landing lolipay-frontends; do
  sudo ln -sf "/etc/nginx/sites-available/$s" "/etc/nginx/sites-enabled/$s"
done
sudo nginx -t && sudo systemctl reload nginx

sudo cp ops/host/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lolipay-web lolipay-lp lolipay-admin lolipay-landing
```

TLS is not here. Certificates are issued by certbot and live in `/etc/letsencrypt`; a rebuilt
host needs `certbot --nginx` run again for each name before these configs will load.

## The API site, and why it looks the way it does

Three things in `nginx/sites-available/lolipay` were corrected on 2026-08-22 and should not be
reverted:

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
`/ws`, which genuinely needs it.

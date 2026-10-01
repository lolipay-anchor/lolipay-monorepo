# nginx for api.lolipay.app

`api.lolipay.app.conf` is a copy of what is installed at
`/etc/nginx/sites-enabled/lolipay`, kept here so the deployed configuration is
reviewable in the repository rather than only on the host. The same bytes are
tracked a second time at `ops/host/nginx/sites-available/lolipay`, which is the
copy the rebuild steps in `ops/host/README.md` install; after any change,
`cmp ops/nginx/api.lolipay.app.conf ops/host/nginx/sites-available/lolipay`
must be silent. (It was not from 2026-08-27, when the `/auth` block below went onto
the host, until that copy was brought level with it; in that time the rebuild steps
would have installed the site without the block.)

## The rate limit on /auth

`nginx.conf` — tracked at `ops/host/nginx/nginx.conf` — carries the zone, because
a zone must live in the `http` block:

```
limit_req_zone $binary_remote_addr zone=lolipay_auth:10m rate=10r/s;
```

and the `~ ^/auth` location applies it with `burst=20 nodelay`, answering `429`
rather than nginx's default `503` (`limit_req_status 429`). A host rebuilt with the
site file but without this `nginx.conf` fails `nginx -t` on an unknown zone.

**It is deliberately far above the application's own limit in rate, and that is the point.**
The coordinator already throttles per IP — 120/min on `/auth`, 30/min on
`/auth/challenge` and `/auth/verify`, and 60/min on routes that set no limit of
their own; an address that goes over one of them is refused on that route for a
minute (`RATE_LIMIT_POLICY` in `app.module.ts`, applied as a global guard;
"per IP" holds behind nginx because `http-setup.ts` trusts one proxy hop). It is
far above them in rate, not in burst: one address gets ten requests a second with
twenty in hand (`rate=10r/s`, `burst=20 nodelay`), so of a burst arriving at once
nginx passes 21, one plus the twenty in hand, and answers the rest `429`, even
where the application would have accepted every one. That is still far above
anything a wallet's login sends. What it adds is a layer the application cannot
provide for itself: a volumetric flood on `/auth` is refused before it reaches Node,
so saturating the process costs the attacker a proxy connection instead of a request
handler, a route match and a throttle lookup. That holds for the lowercase path only:
`location ~ ^/auth` is case-sensitive and the coordinator's routing is not, so
`/AUTH` reaches the service past this limit, where the service's own per-address
limit still applies. The nginx limit also survives a coordinator restart, which the
in-memory throttle does not.

Setting its rate at or near the application's limit would have been worse than
leaving it out: it would move the limit into a layer with no visibility into who is
calling, and make the two limits indistinguishable when one fires. The burst is the
one place nginx refuses first, and its bucket is per address
(`$binary_remote_addr`), not per login. A login is two requests, the second built
from the answer to the first, and a person's two are seconds apart, because the
wallet's signature sits between them. So it takes more than 21 people pressing login
at the same instant behind one shared address, such as a mobile carrier's NAT, before
nginx refuses one with `429`. About eleven are enough only for automated clients whose
second request follows the first within about a tenth of a second, which puts both in
one burst.

**Verify after any change here, and do it from an address that has not just been
used to test the limit.** A first attempt at this reported SEP-10 at 14/17 and the
obvious reading was that the limit had broken the deliverable. It had not: three
clean runs afterwards were 17/17. What failed the first run was not established. A
40-request burst from this same host twenty seconds earlier was blamed, but nginx's
bucket earns back its twenty in about two seconds at `rate=10r/s`, and the
coordinator allows 120 a minute on each of GET and POST `/auth`, counted
separately. nginx logs each refusal it makes as `limiting requests`, so if it happens
again, `sudo zgrep -c 'limiting requests' /var/log/nginx/error.log*` shows whether
nginx refused anything. A rate limit can make the tester the source of its own false
positive.

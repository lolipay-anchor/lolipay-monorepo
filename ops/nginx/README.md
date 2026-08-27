# nginx for api.lolipay.app

`api.lolipay.app.conf` is a copy of what is installed at
`/etc/nginx/sites-enabled/lolipay`, kept here so the deployed configuration is
reviewable in the repository rather than only on the host.

## The rate limit on /auth

`nginx.conf` carries the zone, because a zone must live in the `http` block:

```
limit_req_zone $binary_remote_addr zone=lolipay_auth:10m rate=10r/s;
```

and the `~ ^/auth` location applies it with `burst=20 nodelay`.

**It is deliberately far above the application's own limit, and that is the point.**
The coordinator already throttles per IP — 120/min on `/auth`, 30/min on
`/auth/challenge` and `/auth/verify` — so this never fires for traffic the
application would have accepted. What it adds is a layer the application cannot
provide for itself: a volumetric flood is refused before it reaches Node, so
saturating the process costs the attacker a proxy connection instead of a request
handler, a route match and a throttle lookup. It also survives a coordinator
restart, which the in-memory throttle does not.

Setting it at or near the application's limit would have been worse than leaving it
out: it would move the limit into a layer with no visibility into who is calling,
and make the two limits indistinguishable when one fires.

**Verify after any change here, and do it from an address that has not just been
used to test the limit.** A first attempt at this reported SEP-10 at 14/17 and the
obvious reading was that the limit had broken the deliverable. It had not — a
40-request burst twenty seconds earlier, from this same host, had drained the
bucket. Three clean runs afterwards were 17/17. A rate limit makes the tester the
most likely source of its own false positive.

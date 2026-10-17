# Cloudflare Origin CA certificate

This directory holds the TLS certificate/key the Caddy `proxy` service presents to Cloudflare on
the Cloudflare-to-origin leg. **Never commit `origin.pem` or `origin-key.pem`** — both are already
excluded by the repo's `.gitignore` (`*.pem`, `*.key`), but double-check before pushing regardless.

## Why an Origin CA cert, not a self-signed one

`tls internal` (self-signed) only guarantees the Cloudflare-to-origin leg is *encrypted*; under
Cloudflare's "Full" SSL/TLS mode it never checks *who* it's talking to. Since this origin's IP is
public, anyone who discovers it could stand up their own TLS endpoint there and Cloudflare (or a
browser bypassing Cloudflare) wouldn't be able to tell the difference. A Cloudflare Origin CA
certificate, combined with Cloudflare's "Full (strict)" mode, closes that gap: Cloudflare only
accepts a connection whose certificate it actually issued for this domain.

## Setup

1. **Generate the certificate** in the Cloudflare dashboard: your domain → **SSL/TLS** →
   **Origin Server** → **Create Certificate**. Defaults are fine (RSA, 15-year validity,
   hostname `assets.shyld.co.in`). Cloudflare shows the certificate and private key once —
   copy both immediately.
2. Save them on the VM as:
   - `caddy/origin.pem` — the certificate Cloudflare displayed
   - `caddy/origin-key.pem` — the private key Cloudflare displayed
   (Paste each into a file with a text editor, e.g. `nano caddy/origin.pem`; set restrictive
   permissions afterward: `chmod 600 caddy/origin-key.pem`.)
3. In the Cloudflare dashboard, switch **SSL/TLS → Overview → Encryption mode** from "Full" to
   **"Full (strict)"** — this makes Cloudflare actually validate the certificate above instead of
   accepting anything encrypted.
4. Recreate the proxy container to pick up the mounted files: `docker compose up -d proxy`.

## Optional further hardening

- **Authenticated Origin Pulls**: configure Caddy to require a client certificate from Cloudflare
  (Cloudflare's pull certificate is the same well-known one for every customer, published at
  <https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/>). This
  stops anyone from connecting to the origin directly at all, Cloudflare or not.
- **Firewall the origin to Cloudflare's IP ranges**: restrict the cloud security group's port 443
  rule to Cloudflare's published ranges (<https://www.cloudflare.com/ips/>) instead of
  `0.0.0.0/0`, so only Cloudflare's edge can reach the origin on that port at all.

Neither is required for "Full (strict)" to be effective on its own, but both reduce what a
discovered origin IP can be used for.

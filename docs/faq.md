# FAQ

## Is this Google Fit?

No. This targets Google Health API v4, not the legacy Google Fit REST API.

## Is this Health Connect?

No. Health Connect is Android/on-device. This connector uses Google Health API v4 over OAuth and HTTPS.

## Is it stable?

It is beta. Google Health API v4 is live for builders, but official release
notes continue to document scope and data-type changes. Check the release notes
before production launch decisions.

## Does it expose raw sensors?

No. `raw` mode means upstream Google Health API JSON for supported endpoints, not raw accelerometer telemetry.

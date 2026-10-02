# @usecontextlayer/twilio

ContextLayer's Twilio-side functionality, deployed as ONE Serverless service by design: every function this package accretes lands in the same service, feature-prefixed by path. Today that is the founder-contact call gate — four Functions implementing the keypress answer screen behind Slate's "Talk to founder" button (the whisper asks for 1, any key accepts — the gate's job is that voicemail can't press anything).

## The deployed service

- Service `contextlayer` (`ZSc036d2115ee2fb63c6245fd545ea2900`), environment suffix `production`, domain `contextlayer-6931-production.twil.io`.
- The `Slate founder call` TwiML App's voice webhook points at `/founder-call` on that domain; the (831) number's voice webhook points there too (the unadvertised dial-in path). Neither is touched by deploys.
- All Functions are `.protected.js` — they answer only Twilio-signed requests. Function paths carry their feature prefix (`founder-call-*`); a future feature adds its own prefix in the same `functions/` dir.

## Deploying

The `deploy` script is the one canonical command — release CI runs it on every release (`deploy-twilio` in `.github/workflows/release.yml`), and locally it is:

```sh
doppler run -p <project> -c <config> -- pnpm --filter @usecontextlayer/twilio run deploy
```

Replace `<project>` and `<config>` with the Doppler config holding the Twilio credentials; run `doppler me` first to verify the ContextLayer workplace. The explicit `run` matters: bare `pnpm deploy` is pnpm's own builtin, not this script. The script pins `--service-sid` (CI has no `.twiliodeployinfo`; the pin is what stops a credentialed run from ever creating a second service) and `--environment production` (the domain suffix names the environment — the toolkit's bare `--production` flag would target a DIFFERENT, suffix-less environment). Credentials come from `TWILIO_ACCOUNT_SID` + `TWILIO_API_KEY_SID`/`TWILIO_API_KEY_SECRET` env — the toolkit ignores `TWILIO_API_KEY`-style env vars, hence the explicit `--username/--password` flags in the script.

## Environment variables (the deployed service's, not this repo's)

- One service means ONE env namespace shared by every feature here; every deploy UPSERTS the service env from the local `.env` — absent keys survive; retiring one takes a Variables DELETE against the Serverless API, not just dropping the line.
- `CTX_FOUNDER_CELL` (the number the gate dials) is the one variable today. Use the selected Doppler config locally and the corresponding GitHub Actions secret in CI; keep the resource name consistent across consumers.
- The caller ID the founder's phone shows (the 831) is hardcoded in `functions/founder-call.protected.js`: a public infrastructure constant of the same class as the service-sid pin, and required because the customer leg is a browser client (`from = client:founder_call` is invalid for PSTN dialing).

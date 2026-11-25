# ALEXA XMD deployment

## Website pairing

After the app starts, open the Heroku app URL. The homepage accepts a WhatsApp number in international format, calls `POST /api/pair/start`, and displays the real Baileys pairing code from `GET /api/pair/:id`. On WhatsApp, open **Linked devices → Link a device → Link with phone number** and enter the displayed code.

The health endpoint is `/health`.

## Required Heroku Config Vars

Set these in Heroku Config Vars, not in source code:

- `TELEGRAM_TOKEN` (optional; the website pairing service can run without Telegram)
- `OWNER_TELEGRAM_ID` (optional when Telegram is disabled)
- `OWNER_NAME`
- `SUDO_NUMBER`
- `PANEL_DOMAIN` and `PANEL_APIKEY` if Pterodactyl panel commands are needed
- `PANEL_EGG`, `PANEL_NEST`, and `PANEL_LOC` when different from the defaults

## GitHub automatic deployment

The repository contains `.github/workflows/deploy-heroku.yml`. Add these GitHub Actions repository secrets:

- `HEROKU_API_KEY`
- `HEROKU_APP_NAME`
- `HEROKU_EMAIL`

Every push to `main` then deploys the current commit to Heroku. The app must already exist and the Heroku account must be verified before the first deployment.

## Important persistence note

Heroku's filesystem is ephemeral. WhatsApp auth files and JSON databases can be lost after dyno replacement or restart. For production, add an external persistent session/database store or use a host with persistent disk. The website pairing flow itself is real, but pairing must be repeated after a lost local session.

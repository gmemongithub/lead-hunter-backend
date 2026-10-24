# backend

Ei folder er backend onno kew build korbe. Shob requirement ekhane: **[BACKEND_PROMPT.md](./BACKEND_PROMPT.md)** (English, self-contained, backend developer ba AI ke ei file tai dao).

Extension (frontend) backend er sathe shudhu **login, license, device** niye kotha bole. Scraping, field, filter, result, export browser e hoy, backend e kono endpoint lagbe na.

## Ekhon ki obostha

`frontend/sidepanel/core/config.js` e `AUTH_ENABLED: false`. Mane login + license check ekhon bondho, extension shorashori kaj kore.

## Backend ready hole frontend connect

1. Backend deploy hole base URL pabe, jemon `https://api.yourdomain.com/v1`
2. `frontend/sidepanel/core/config.js` e:
   - `AUTH_ENABLED: true`
   - `API_BASE_URL` = oi URL
   - `WEBSITE_URL` = main website URL (pricing, forgot-password page e link jabe)
3. Root `manifest.json` e host permission add koro (CORS niye jhamela na hoy):

       "host_permissions": ["https://api.yourdomain.com/*"]

## Request flow

    Login screen -> POST /auth/login -> {tokens, user, license} -> chrome.storage e save
    Prottek API call -> Authorization: Bearer <accessToken>
    401 hole -> POST /auth/refresh -> notun token -> same request retry
    Refresh token bad hole -> local logout -> Login screen
    Panel khulle + prottek 12 ghonta -> POST /license/verify -> license update
    Run start hole -> frontend cached license check kore (expired hole start hobe na)
    Network na thakle -> purano (cached) license e kaj cholbe, jotokkhon na server "expired" bole

# Security hardening

## Before deployment

1. Rotate the Firebase service-account key that was previously stored in the standalone backend folder. Revoke it in Google Cloud IAM and create a replacement only if needed.
2. Store the replacement as the `FIREBASE_SERVICE_ACCOUNT` deployment secret. Use the one-line JSON format in `backend-server/.env.example` as a shape reference only.
3. Set `CORS_ALLOWED_ORIGINS` to the exact HTTPS browser origins that need the API. A desktop Electron client does not need an origin entry.
4. Set `STUDY_AI_SERVER_URL` to an HTTPS URL for any non-local backend.

## Current controls

- Firebase credentials are required from environment variables and are not loaded from files.
- Session tokens expire after eight hours by default and are bound to a device identifier.
- The API accepts session tokens only through the `Authorization` header.
- Sensitive responses are not cached; server headers, CORS restrictions, request-size limits, and in-memory rate limits are enabled.
- The Electron windows use context isolation, disable renderer Node access, and expose only approved IPC channels.

## Recommended next steps

- Configure Firestore TTL on the `sessions.expiresAt` field to automatically remove expired session records.
- Add a shared store such as Redis for rate limits when deploying more than one server instance.
- Enable dependency scanning in CI and rotate provider API keys whenever access logs indicate misuse.

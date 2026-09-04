const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Express App
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// You will need to download your Firebase Service Account JSON file 
// from Firebase Project Settings -> Service Accounts, and put it in this folder as 'serviceAccountKey.json'
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", err);
  }
}

if (!serviceAccount) {
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (err) {
    console.warn("Could not find serviceAccountKey.json locally:", err.message);
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  console.warn("Initializing Firebase Admin with default credentials (or none)");
  admin.initializeApp();
}
const db = admin.firestore();

// Firestore-backed session loader helper (for Vercel serverless statelessness)
async function getSession(sessionToken) {
    if (!sessionToken) return null;
    try {
        const doc = await db.collection('sessions').doc(sessionToken).get();
        return doc.exists ? doc.data() : null;
    } catch (e) {
        console.error("[Firestore] getSession error:", e.message);
        return null;
    }
}

// 1. Login Endpoint (catch anything with 'login' in the path)
app.post(/.*login.*/, async (req, res) => {
    try {
        const { licenseKey, hwid } = req.body;
        console.log(`[LOGIN HIT!] Route: ${req.path} | Key: ${licenseKey}, HWID: ${hwid}`);

        // Verify against Firebase:
        const licenseRef = db.collection('licenses').doc(licenseKey);
        const doc = await licenseRef.get();
        
        if (!doc.exists || !doc.data().isActive) {
            return res.json({ error: 'invalid_license' });
        }
        
        const userData = doc.data();

        // Get client IP address
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

        // Update the main license document in Firestore
        try {
            await licenseRef.update({
                lastIp: ip,
                lastEndpoint: 'login',
                lastSeen: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (writeError) {
            console.error("Failed to update lastSeen in Firestore:", writeError);
        }

        // Add a log entry to the sub-collection in Firestore
        try {
            await licenseRef.collection('logs').add({
                detail: 'login successful',
                endpoint: 'login',
                errorMsg: '',
                hwid: hwid || '',
                ip: ip,
                mode: '',
                provider: '',
                question: '',
                questionLen: 0,
                status: 'success',
                ts: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (logError) {
            console.error("Failed to write login log in Firestore:", logError);
        }
        
        // Parse the multi-line apiKey string into an array of keys
        let keys = [];
        if (userData.apiKey) {
            keys = userData.apiKey.split('\n').map(k => k.trim()).filter(k => k.length > 0);
        }

        // Generate a secure session token
        const sessionToken = crypto.randomBytes(32).toString('hex');
        
        // Store user session in Firestore (persistent & stateless across Vercel instances)
        await db.collection('sessions').doc(sessionToken).set({
            licenseKey,
            apiKeys: keys,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ sessionToken: sessionToken, success: true, valid: true });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ error: 'server_error' });
    }
});

// 2. Transcribe Endpoint — converts audio to text via Gemini
app.post('/transcribe', async (req, res) => {
    try {
        const { audioBase64, mimeType } = req.body;
        const sessionToken = req.body?.sessionToken || req.headers['authorization']?.replace('Bearer ', '');

        if (!sessionToken) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        
        const userSession = await getSession(sessionToken);
        if (!userSession) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        if (!audioBase64) {
            return res.json({ error: 'No audio data provided' });
        }
        if (!userSession.apiKeys || userSession.apiKeys.length === 0) {
            return res.status(401).json({ error: 'No API keys configured' });
        }

        // Resilient API key rotation pool selection (stateless, handles rate-limiting / high-demand errors)
        const shuffledKeys = [...userSession.apiKeys].sort(() => Math.random() - 0.5);
        const keysToTry = shuffledKeys.slice(0, 3); // try up to 3 keys from the pool on failure
        console.log(`[TRANSCRIBE] Trying up to 3 random keys from pool of ${userSession.apiKeys.length} for License: ${userSession.licenseKey}`);

        // Determine audio MIME type for Gemini
        let geminiMime = 'audio/webm';
        if (mimeType) {
            if (mimeType.includes('ogg')) geminiMime = 'audio/ogg';
            else if (mimeType.includes('mp3')) geminiMime = 'audio/mp3';
            else if (mimeType.includes('wav')) geminiMime = 'audio/wav';
            else if (mimeType.includes('webm')) geminiMime = 'audio/webm';
        }

        // Try multiple Gemini models for transcription (audio support varies)
        const modelCandidates = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];
        const versionCandidates = ['v1beta', 'v1'];

        let lastError = null;
        let transcribedText = null;
        let success = false;

        for (const currentKey of keysToTry) {
            const keyDisplay = `...${currentKey.substring(currentKey.length - 6)}`;
            for (const version of versionCandidates) {
                for (const model of modelCandidates) {
                    try {
                        const geminiUrl = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${currentKey}`;

                        const response = await fetch(geminiUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{
                                    parts: [
                                        { text: "Transcribe the following audio accurately. Return ONLY the spoken words as plain text. Do not add any commentary, labels, timestamps, or formatting. If no speech is detected, return an empty string." },
                                        {
                                            inlineData: {
                                                mimeType: geminiMime,
                                                data: audioBase64
                                            }
                                        }
                                    ]
                                }]
                            })
                        });

                        const data = await response.json();

                        if (response.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                            transcribedText = data.candidates[0].content.parts[0].text.trim();
                            lastError = null;
                            success = true;
                            break;
                        }

                        lastError = data?.error?.message || (data && JSON.stringify(data)) || 'Unknown error';
                        console.error(`[TRANSCRIBE] Model ${model}/${version} failed with key ${keyDisplay}:`, lastError);
                    } catch (e) {
                        lastError = e.message;
                        console.error(`[TRANSCRIBE] Request error for ${model}/${version} with key ${keyDisplay}:`, e.message);
                    }
                }
                if (success) break;
            }
            if (success) break;
        }

        if (success && transcribedText !== null) {
            console.log(`[TRANSCRIBE] Success: "${transcribedText.substring(0, 60)}..."`);
            return res.json({ text: transcribedText });
        } else {
            console.error('[TRANSCRIBE] All keys and models failed:', lastError);
            return res.json({ error: { message: lastError || 'Transcription failed' } });
        }

    } catch (error) {
        console.error('[TRANSCRIBE] Error:', error);
        res.status(500).json({ error: { message: 'Server transcription error: ' + error.message } });
    }
});

// 3. Update Check and Catch-All Endpoint for Answering
app.all('/*', async (req, res) => {
    try {
        console.log(`[REQUEST] Route: ${req.path} | Method: ${req.method}`);
        
        // Mock the update endpoint!
        if (req.path.includes('update') || req.path.includes('version')) {
            console.log("-> Replying to update check: No updates.");
            return res.json({ update: false, hasUpdate: false, version: "2.0.3" });
        }

// Real expiry/sync/ping endpoint: license must exist + isActive must be true.
        // Your Engoulp-like client quits when it receives an invalid response.
        const isExpiryCheck = req.path.includes('expir') || req.path.includes('sync') ||
                              req.path.includes('ping') || req.path.includes('heartbeat') ||
                              req.path.includes('remain') || req.path.includes('time') ||
                              req.path.includes('status') || req.path.includes('valid');
        if (isExpiryCheck && !req.body?.question) {
            const sessionToken = req.body?.sessionToken || req.headers['authorization']?.replace('Bearer ', '');

            const userSession = await getSession(sessionToken);
            if (!userSession) {
                return res.status(401).json({ status: 'invalid', valid: false, error: 'unauthorized' });
            }

            // Re-check license in Firestore every time (so deleting/deactivating the key invalidates app)
            const licenseRef = db.collection('licenses').doc(userSession.licenseKey);
            const doc = await licenseRef.get();

            if (!doc.exists || !doc.data()?.isActive) {
                return res.json({ status: 'invalid', valid: false, active: false, remainingMs: 0, remainingSecs: 0 });
            }

            return res.json({
                status: 'active',
                valid: true,
                active: true,
                // If you don’t have expiresAt, treat as “no expiry remaining” but still valid.
                remainingMs: 9999999999,
                remainingSecs: 9999999,
                expiresAt: new Date(Date.now() + 9999999999).toISOString()
            });
        }

        // Try to find the session token either from body or headers
        const sessionToken = req.body?.sessionToken || req.headers['authorization']?.replace('Bearer ', '');
        
        // Find user session
        const userSession = await getSession(sessionToken);

        const question = req.body?.question || "";
        
        // If no question and no recognized endpoint, return active status (expiry/ping/unknown)
        if (!question || question === "") {
            console.log(`-> No question in body, returning active status for: ${req.path}`);
            return res.json({ status: 'active', remainingMs: 9999999999, valid: true });
        }
        
        // If we don't have a session with keys, we can't answer
        if (!userSession || userSession.apiKeys.length === 0) {
            return res.status(401).json({ error: 'unauthorized', answer: "You are not logged in or have no keys set up." });
        }

        // ALL keys shuffled — try every single one, don't limit to 3
        const allKeys = [...userSession.apiKeys].sort(() => Math.random() - 0.5);
        console.log(`[AI REQUEST] Exhaustive retry — ${allKeys.length} key(s) × models for License: ${userSession.licenseKey}`);

        // --- CALL GEMINI API ---
        const forcedModelRaw = process.env.GEMINI_MODEL;
        const forcedVersion   = process.env.GEMINI_VERSION;

        // Full model fallback list — newest/most reliable first
        // Even if GEMINI_MODEL env var is set we still fall back to the rest if it fails
        const BASE_MODELS = [
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-flash-latest',
            'gemini-2.5-flash-lite',
        ];

        const forcedModel = (forcedModelRaw || '').trim().toLowerCase() || null;
        // Put forced model first (if set), then all other fallbacks
        const modelCandidates = forcedModel
            ? [forcedModel, ...BASE_MODELS.filter(m => m !== forcedModel)]
            : BASE_MODELS;

        const API_BASE    = 'https://generativelanguage.googleapis.com';
        const API_VERSION = forcedVersion || 'v1beta';

        let lastError = null;
        let response  = null;
        let data      = null;
        let success   = false;

        // Strategy: outer loop = models, inner loop = keys
        // Why: a 404 (model not found) is the SAME for all keys → skip model immediately
        // A 429/401/403 is key-specific → try next key with same model
        modelLoop:
        for (const model of modelCandidates) {
            for (const currentKey of allKeys) {
                const keyDisplay = `...${currentKey.slice(-6)}`;
                const geminiUrl  = `${API_BASE}/${API_VERSION}/models/${model}:generateContent?key=${currentKey}`;
                try {
                    const parts = [{ text: question }];
                    if (req.body.imageBase64) {
                        const mimeMatch  = req.body.imageBase64.match(/^data:(image\/[a-zA-Z0-9.-]+);base64,/);
                        const mimeType   = mimeMatch ? mimeMatch[1] : 'image/png';
                        const cleanB64   = req.body.imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
                        parts.push({ inlineData: { mimeType, data: cleanB64 } });
                    }

                    response = await fetch(geminiUrl, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            contents: [{ parts }],
                            generationConfig: {
                                temperature: 0.0,
                                topP: 0.95,
                                maxOutputTokens: 8192
                            }
                        })
                    });
                    data = await response.json();

                    if (response.ok) {
                        console.log(`[AI REQUEST] Success: model=${model} key=${keyDisplay}`);
                        success = true;
                        break modelLoop;          // got answer — stop everything
                    }

                    const httpStatus = response.status;
                    const errMsg     = data?.error?.message || '';
                    lastError        = data;
                    console.warn(`[AI REQUEST] Failed model=${model} key=${keyDisplay} status=${httpStatus}: ${errMsg}`);

                    // 404 = model not found / deprecated — useless to try other keys
                    if (httpStatus === 404) {
                        console.warn(`[AI REQUEST] Model ${model} returned 404 — skipping all keys for this model`);
                        continue modelLoop;       // jump straight to next model
                    }
                    // 400 with "model not found" text — same as 404
                    if (httpStatus === 400 && errMsg.toLowerCase().includes('not found')) {
                        console.warn(`[AI REQUEST] Model ${model} not found (400) — skipping`);
                        continue modelLoop;
                    }
                    // 429 = rate limit / 401-403 = bad key → just try next key (same model)

                } catch (e) {
                    lastError = { error: { message: e.message } };
                    console.error(`[AI REQUEST] Network error model=${model} key=${keyDisplay}:`, e.message);
                }
            }
            if (success) break;
        }

        if (!success || !response?.ok) {
            const msg = lastError?.error?.message || 'All models and keys exhausted';
            console.error('[AI REQUEST] All attempts failed:', msg);
            return res.json({ error: 'AI Provider Error: ' + msg });
        }

        const answerText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate an answer.";

        
        // Send it back to the desktop app exactly how it expects it!
        return res.json({ answer: answerText });

    } catch (error) {
        console.error("Answer Error:", error);
        res.status(500).json({ error: 'server_error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`n==============================================`);
    console.log(`🚀 Study AI Backend Server running on port ${PORT}`);
    console.log(`==============================================n`);
});

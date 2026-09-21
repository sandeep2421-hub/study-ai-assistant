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

// ── Model & AI Configuration (Shared Module with Circuit Breakers) ─────────────
const {
    GEMINI_TIMEOUT_MS,
    TOTAL_REQUEST_DEADLINE_MS,
    MODEL_CONFIG,
    isKeyAvailable,
    recordKeySuccess,
    recordKeyError,
    isModelAvailable,
    recordModelUnavailable,
    recordModelBusy,
    recordModelSuccess,
    getMimeTypeFromBase64
} = require('./gemini-config');

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

        const keysToTry = [...userSession.apiKeys].slice(0, 3);
        console.log(`[TRANSCRIBE] Trying up to 3 keys for License: ${userSession.licenseKey}`);

        let geminiMime = 'audio/webm';
        if (mimeType) {
            if (mimeType.includes('ogg')) geminiMime = 'audio/ogg';
            else if (mimeType.includes('mp3')) geminiMime = 'audio/mp3';
            else if (mimeType.includes('wav')) geminiMime = 'audio/wav';
            else if (mimeType.includes('webm')) geminiMime = 'audio/webm';
        }

        const modelCandidates = [MODEL_CONFIG.primary, ...MODEL_CONFIG.fallbacks].filter(isModelAvailable);
        const version = 'v1beta';

        let lastError = null;
        let transcribedText = null;
        let success = false;

        for (const currentKey of keysToTry) {
            const keyDisplay = `...${currentKey.substring(currentKey.length - 6)}`;
            for (const model of modelCandidates) {
                try {
                    const geminiUrl = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${currentKey}`;

                    const response = await fetch(geminiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
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

                    const httpStatus = response.status;
                    lastError = data?.error?.message || `HTTP ${httpStatus}`;
                    console.error(`[TRANSCRIBE] Model ${model} failed with key ${keyDisplay} (status ${httpStatus}):`, lastError);

                    if (httpStatus === 429) {
                        break; // Switch key immediately
                    }
                } catch (e) {
                    lastError = e.message;
                    console.error(`[TRANSCRIBE] Request error for ${model} with key ${keyDisplay}:`, e.message);
                }
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

        // Try to find the session token either from body or headers
        const sessionToken = req.body?.sessionToken || req.headers['authorization']?.replace('Bearer ', '');
        
        // Find user session
        const userSession = await getSession(sessionToken);

        // Desktop Study AI Assistant System Prompt
        const SYSTEM_STUDY_AI_PROMPT = "CRITICAL ZERO-MISTAKE & 100% COMPILER PASS PROTOCOL:\nYou are a competitive programming world champion and expert technical assessment solver.\nAnalyze the problem with absolute precision and provide a 100% complete, flawless solution that passes ALL test cases on the FIRST ATTEMPT.\n\n1. FOR CODING & DATA STRUCTURES (CAMPUS / COMPANY ASSESSMENTS & ONLINE JUDGES):\n   - FULL PROBLEM SCOPE & NARRATIVE ANALYSIS: Carefully read the problem title and introductory story. If the problem describes multiple operations (e.g., search + reversal, insert + display, filter + aggregate, sorting + query), implement and output ALL operations.\n   - OUTPUT FORMAT & PARTIAL VIEW INFERENCE: If the problem description or Output Format is partially scrolled or cut off in the screenshot, infer the standard full output format required by the platform (e.g. Line 1: Status message like \"Data point is present in the dataset\" / \"Data point isn't present in the dataset\", Line 2: Reversed space-separated list of elements).\n   - EXACT STRING MATCHING: Match the exact wording, casing, punctuation, and contractions from the problem statement (e.g., \"Data point isn't present in the dataset\" vs \"Data point is present in the dataset\").\n   - COMPLETE RUNNABLE IMPLEMENTATION:\n     * For competitive programming / standard I/O judges (NeoColab, HackerRank, CodeTantra, Mettl): Provide complete runnable code with standard input reading (Java: Scanner/BufferedReader, C++: cin with fast I/O, Python: sys.stdin.read().split()) and exact formatting without extra debug text.\n     * For class/method judges (LeetCode): Match the exact class Solution and method signature.\n   - OPTIMAL TIME & SPACE COMPLEXITY: Implement the most optimal algorithmic approach (O(N) or O(N log N)) to prevent any Time Limit Exceeded (TLE) errors.\n   - ZERO CODE COMMENTS: Do not include internal comments inside the code block so that auto-typing completes cleanly and quickly.\n\n2. FOR MCQs (Code-Trace / Logic / Theory):\n   - FIRST LINE: State directly: \"**🎯 Correct Option: Option <Letter> - <Option Text>**\"\n   - STEP-BY-STEP TRACE: Show line-by-line variable state transitions, loop conditions, and execution output.\n   - TRAP EXPLANATION: Briefly explain why other options are incorrect.\n\n3. FOR NUMERICAL / FILL-IN-THE-BLANKS: State the exact required value or output.";

        const question = (req.body?.question || "").trim();
        const imageBase64 = req.body?.imageBase64 || "";
        const extraImages = Array.isArray(req.body?.extraImages) ? req.body.extraImages : [];
        const history = Array.isArray(req.body?.history) ? req.body.history : [];
        
        // If no question and no image, return active status (expiry/ping/unknown)
        if (!question && !imageBase64 && extraImages.length === 0) {
            console.log(`-> No question or image in body, returning active status for: ${req.path}`);
            return res.json({ status: 'active', remainingMs: 9999999999, valid: true });
        }
        
        // Format effective prompt with Study AI Assistant instructions
        let effectivePrompt = question;
        if (!effectivePrompt) {
            effectivePrompt = SYSTEM_STUDY_AI_PROMPT;
        } else if (!effectivePrompt.includes('CRITICAL ZERO-MISTAKE')) {
            effectivePrompt = `${SYSTEM_STUDY_AI_PROMPT}\n\n[QUESTION / INPUT]:\n${effectivePrompt}`;
        }
        
        // If we don't have a session with keys, we can't answer
        if (!userSession || !userSession.apiKeys || userSession.apiKeys.length === 0) {
            return res.status(401).json({ error: 'unauthorized', answer: "You are not logged in or have no keys set up." });
        }

        const allKeys = userSession.apiKeys;
        console.log(`[AI REQUEST] Request for License: ${userSession.licenseKey} with ${allKeys.length} key(s)`);

        // Build contents payload (multi-turn history bounded to last 4 turns + current turn)
        let contents = [];
        if (history.length > 0) {
            const recentHistory = history.slice(-4);
            let expectedRole = 'user';
            for (const h of recentHistory) {
                const role = (h.role === 'assistant' || h.role === 'model' || h.role === 'ai') ? 'model' : 'user';
                const text = (h.content || '').trim();
                if (!text) continue;
                if (role === expectedRole) {
                    contents.push({ role, parts: [{ text }] });
                    expectedRole = expectedRole === 'user' ? 'model' : 'user';
                } else if (contents.length > 0 && role === contents[contents.length - 1].role) {
                    contents[contents.length - 1].parts[0].text += '\n' + text;
                }
            }
            while (contents.length > 0 && contents[0].role !== 'user') contents.shift();
            while (contents.length > 0 && contents[contents.length - 1].role !== 'model') contents.pop();
        }

        // Current turn parts
        const currentParts = [{ text: effectivePrompt }];
        if (imageBase64) {
            const mimeType = getMimeTypeFromBase64(imageBase64);
            const cleanB64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
            if (cleanB64) currentParts.push({ inlineData: { mimeType, data: cleanB64 } });
        }
        if (extraImages.length > 0) {
            for (const img of extraImages.slice(0, 3)) {
                if (!img) continue;
                const mimeType = getMimeTypeFromBase64(img);
                const cleanB64 = img.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
                if (cleanB64) currentParts.push({ inlineData: { mimeType, data: cleanB64 } });
            }
        }

        contents.push({ role: 'user', parts: currentParts });

        // --- CALL GEMINI API ---
        const forcedModelRaw = process.env.GEMINI_MODEL;

        const activeKeys = allKeys.filter(isKeyAvailable);
        const keysToUse = activeKeys.length > 0 ? activeKeys : allKeys;

        const allModels = [MODEL_CONFIG.primary, ...MODEL_CONFIG.fallbacks];
        const candidateModels = forcedModelRaw ? [forcedModelRaw.trim()] : allModels.filter(isModelAvailable);
        const modelsToTry = candidateModels.length > 0 ? candidateModels : allModels;

        const API_BASE = 'https://generativelanguage.googleapis.com';
        const API_VERSION = 'v1beta';

        let lastError = null;
        let response = null;
        let data = null;
        let success = false;
        let attemptCount = 0;
        const overallStart = Date.now();

        // Smart Key-First Rotation: Key -> Preferred Model -> Fallback Model
        keyLoop:
        for (let keyIdx = 0; keyIdx < keysToUse.length; keyIdx++) {
            const currentKey = keysToUse[keyIdx];
            const keyDisplay = `...${currentKey.slice(-6)}`;

            for (let modelIdx = 0; modelIdx < modelsToTry.length; modelIdx++) {
                const elapsedTotal = Date.now() - overallStart;
                const remainingTotal = TOTAL_REQUEST_DEADLINE_MS - elapsedTotal;
                if (remainingTotal <= 1500) {
                    console.warn(`[AI REQUEST] ⏱ Total request deadline (${TOTAL_REQUEST_DEADLINE_MS / 1000}s) reached -> aborting further fallbacks`);
                    break keyLoop;
                }

                const model = modelsToTry[modelIdx];
                if (!isModelAvailable(model)) continue;

                attemptCount++;
                const apiStart = Date.now();
                const currentAttemptTimeout = Math.min(GEMINI_TIMEOUT_MS, remainingTotal);

                const geminiUrl = `${API_BASE}/${API_VERSION}/models/${model}:generateContent?key=${currentKey}`;
                try {
                    response = await fetch(geminiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: AbortSignal.timeout(currentAttemptTimeout),
                        body: JSON.stringify({
                            contents: contents,
                            generationConfig: {
                                temperature: 0.1,
                                topP: 0.95,
                                maxOutputTokens: 8192
                            }
                        })
                    });
                    data = await response.json();
                    const apiDuration = Date.now() - apiStart;
                    const totalDuration = Date.now() - overallStart;

                    if (response.ok) {
                        recordKeySuccess(currentKey);
                        recordModelSuccess(model);
                        console.log(`[AI REQUEST] ✓ SUCCESS | Model: ${model} | Key: ${keyDisplay} | API: ${apiDuration}ms | Total: ${totalDuration}ms | Attempts: ${attemptCount}`);
                        success = true;
                        break keyLoop;
                    }

                    const httpStatus = response.status;
                    const errMsg = data?.error?.message || `HTTP ${httpStatus}`;
                    lastError = data;
                    console.warn(`[AI REQUEST] ⚠️ Error ${httpStatus} | Model: ${model} | Key: ${keyDisplay} | API: ${apiDuration}ms: ${errMsg}`);

                    if (httpStatus === 404 || (httpStatus === 400 && errMsg.toLowerCase().includes('not found'))) {
                        recordModelUnavailable(model, errMsg);
                        continue; // Try next model immediately
                    }

                    if (httpStatus === 503 || httpStatus === 500 || errMsg.toLowerCase().includes('high demand') || errMsg.toLowerCase().includes('overloaded')) {
                        recordModelBusy(model, 30000, errMsg);
                        console.warn(`[AI REQUEST] Model ${model} high demand (503) -> switching immediately to fallback model`);
                        continue;
                    }

                    if (httpStatus === 429) {
                        recordKeyError(currentKey, 429, errMsg);
                        console.warn(`[AI REQUEST] Rate limit (429) on key ${keyDisplay} -> switching to next key`);
                        break; // Switch key immediately
                    }

                    if (httpStatus === 401 || httpStatus === 403) {
                        recordKeyError(currentKey, httpStatus, errMsg);
                        console.warn(`[AI REQUEST] Key ${keyDisplay} invalid (${httpStatus}) -> disabling key`);
                        break; // Switch key
                    }

                } catch (e) {
                    const apiDuration = Date.now() - apiStart;
                    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
                    const msg = isTimeout ? `Request timed out after ${Math.round(currentAttemptTimeout / 1000)}s` : e.message;
                    lastError = { error: { message: msg } };
                    console.error(`[AI REQUEST] ❌ Network/Timeout | Model: ${model} | Key: ${keyDisplay} | API: ${apiDuration}ms:`, msg);
                }
            }
        }

        if (!success || !response?.ok) {
            const msg = lastError?.error?.message || 'All models and keys exhausted';
            console.error('[AI REQUEST] All attempts failed:', msg);
            return res.json({ error: 'AI Provider Error: ' + msg });
        }

        const answerText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate an answer.";

        return res.json({ answer: answerText });

    } catch (error) {
        console.error("Answer Error:", error);
        res.status(500).json({ error: 'server_error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n==============================================`);
    console.log(`🚀 Study AI Backend Server running on port ${PORT}`);
    console.log(`==============================================\n`);
});

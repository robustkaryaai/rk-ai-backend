import https from 'https';
import { db } from './services/appwriteClient.js';
import { supabase } from './services/supabaseClient.js';
import { Query } from 'node-appwrite';
import dotenv from 'dotenv';
dotenv.config();

const INTERVAL_MS = 5000; // 5 seconds
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://rk-ai-backend.onrender.com';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'user-files';

async function performPulse() {
    try {
        // 1. Anti-Sleep Ping
        https.get(RENDER_URL, (res) => {
            // We just want to ping it, no need to log every 5 seconds to avoid log spam
        }).on('error', (err) => {
            // ignore
        });

        // 2. Token & Deadline Management (Appwrite)
        if (process.env.APPWRITE_DB_ID && process.env.APPWRITE_DEVICES_COLLECTION) {
            const now = new Date().toISOString();
            
            // Find devices whose usageResetAt has passed
            const expiredTokensRes = await db.listDocuments(
                process.env.APPWRITE_DB_ID,
                process.env.APPWRITE_DEVICES_COLLECTION,
                [
                    Query.lessThanEqual('usageResetAt', now),
                    Query.limit(50) // Process in batches
                ]
            );

            for (const device of expiredTokensRes.documents) {
                console.log(`[PulseWorker] Resetting usage for device ${device.slug}`);
                const nextReset = new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
                
                await db.updateDocument(
                    process.env.APPWRITE_DB_ID,
                    process.env.APPWRITE_DEVICES_COLLECTION,
                    device.$id,
                    {
                        tokensUsed: 0,
                        imagesUsed: 0,
                        videosUsed: 0,
                        usageResetAt: nextReset
                    }
                );
            }
        }
    } catch (err) {
        console.error(`[PulseWorker] Error during pulse:`, err);
    }
}

export function startPulseWorker() {
    console.log(`[PulseWorker] Starting 24/7 worker loop (Interval: ${INTERVAL_MS}ms)`);
    // Run immediately once
    performPulse();
    // Then set interval
    setInterval(performPulse, INTERVAL_MS);
}

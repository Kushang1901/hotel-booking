const { getCollection } = require('../config/db');

/**
 * Add or update a failed message for retry queue
 * @param {object} retryData 
 * @param {string} retryData.bookingId
 * @param {string} retryData.recipient
 * @param {string} retryData.message
 * @param {string} retryData.error
 */
async function addFailedRetry(retryData) {
    try {
        const collection = getCollection('whatsapp_failed_retries');
        const now = new Date();
        // Set next attempt to 5 minutes from now (basic backoff)
        const nextAttempt = new Date(now.getTime() + 5 * 60 * 1000);

        const existing = await collection.findOne({ bookingId: retryData.bookingId });

        if (existing) {
            if (existing.attempts >= existing.maxAttempts) {
                // Already reached maximum retries, just update status
                await collection.updateOne(
                    { bookingId: retryData.bookingId },
                    {
                        $set: {
                            status: 'MAX_ATTEMPTS_REACHED',
                            error: retryData.error,
                            lastAttemptAt: now,
                            updatedAt: now
                        }
                    }
                );
                return;
            }

            const newAttempts = existing.attempts + 1;
            // Backoff formula: multiply delay by attempt count (5m, 10m, 15m)
            const multiplier = newAttempts; 
            const newNextAttempt = new Date(now.getTime() + multiplier * 5 * 60 * 1000);

            await collection.updateOne(
                { bookingId: retryData.bookingId },
                {
                    $set: {
                        attempts: newAttempts,
                        error: retryData.error,
                        lastAttemptAt: now,
                        nextAttemptAt: newNextAttempt,
                        status: newAttempts >= existing.maxAttempts ? 'MAX_ATTEMPTS_REACHED' : 'PENDING',
                        updatedAt: now
                    }
                }
            );
        } else {
            // First time failing
            await collection.insertOne({
                bookingId: retryData.bookingId,
                recipient: retryData.recipient,
                message: retryData.message,
                attempts: 1,
                maxAttempts: 3,
                lastAttemptAt: now,
                nextAttemptAt: nextAttempt,
                status: 'PENDING',
                error: retryData.error,
                createdAt: now,
                updatedAt: now
            });
        }
    } catch (error) {
        console.error("❌ Error in addFailedRetry:", error);
    }
}

/**
 * Gets all pending failed retries due for another attempt
 */
async function getPendingRetries() {
    try {
        const collection = getCollection('whatsapp_failed_retries');
        const now = new Date();
        return await collection.find({
            status: 'PENDING',
            nextAttemptAt: { $lte: now }
        }).toArray();
    } catch (error) {
        console.error("❌ Error in getPendingRetries:", error);
        return [];
    }
}

/**
 * Remove a successfully retried message from the retry queue
 * @param {string} bookingId 
 */
async function removeRetry(bookingId) {
    try {
        const collection = getCollection('whatsapp_failed_retries');
        await collection.deleteOne({ bookingId });
    } catch (error) {
        console.error("❌ Error in removeRetry:", error);
    }
}

/**
 * Fetch all failed retries for the dashboard
 */
async function getAllFailedRetries() {
    try {
        const collection = getCollection('whatsapp_failed_retries');
        return await collection.find({}).sort({ updatedAt: -1 }).toArray();
    } catch (error) {
        console.error("❌ Error in getAllFailedRetries:", error);
        return [];
    }
}

module.exports = {
    addFailedRetry,
    getPendingRetries,
    removeRetry,
    getAllFailedRetries
};

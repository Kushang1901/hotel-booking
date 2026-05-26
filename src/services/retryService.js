const retryModel = require('../models/failedRetry');
const logModel = require('../models/notificationLog');
const bookingModel = require('../models/bookingNotification');
const whatsappService = require('./whatsappService');

let retryIntervalTimer = null;
let isProcessing = false;

/**
 * Periodically processes pending retries from the queue
 */
async function processPendingRetries() {
    if (isProcessing) return;
    
    // Meta Cloud API is always online and ready to send messages!

    isProcessing = true;
    console.log("🔄 Background Retry Service: Checking for pending failed WhatsApp messages...");

    try {
        const pending = await retryModel.getPendingRetries();
        if (pending.length === 0) {
            console.log("✅ Background Retry Service: No pending retries due at this time.");
            isProcessing = false;
            return;
        }

        console.log(`🔄 Background Retry Service: Found ${pending.length} message(s) due for retry.`);

        for (const retry of pending) {
            console.log(`🔄 Retrying booking notification ${retry.bookingId} to ${retry.recipient} (Attempt #${retry.attempts})...`);
            
            try {
                // Send the pre-compiled message text directly
                await whatsappService.sendMessage(retry.recipient, retry.message);
                
                console.log(`✅ Retry success for ${retry.bookingId}! Clean up retry queue.`);
                
                // 1. Log success
                await logModel.logNotification({
                    bookingId: retry.bookingId,
                    recipient: retry.recipient,
                    message: retry.message,
                    status: 'SUCCESS'
                });

                // 2. Mark booking notification as SENT
                await bookingModel.markNotificationSent(retry.bookingId);

                // 3. Remove from retry queue
                await retryModel.removeRetry(retry.bookingId);

            } catch (error) {
                console.error(`❌ Retry attempt #${retry.attempts} failed for booking ${retry.bookingId}:`, error.message);
                
                // Increment attempt count and schedule next attempt, or flag max reached
                await retryModel.addFailedRetry({
                    bookingId: retry.bookingId,
                    recipient: retry.recipient,
                    message: retry.message,
                    error: error.message
                });

                // Mark booking notification status with the latest error
                await bookingModel.markNotificationFailed(retry.bookingId, error.message);
            }
        }

    } catch (error) {
        console.error("❌ Background Retry Service error during processing:", error);
    } finally {
        isProcessing = false;
    }
}

/**
 * Triggers an immediate retry processing run (e.g. triggered manually from the dashboard)
 */
async function triggerImmediateRetry() {
    console.log("⚡ Manual retry processing triggered...");
    await processPendingRetries();
}

/**
 * Starts the background retry scheduler
 * @param {number} intervalMs - Interval in milliseconds (default: 5 minutes)
 */
function startRetryScheduler(intervalMs = 5 * 60 * 1000) {
    if (retryIntervalTimer) {
        console.log("⚠️ Background Retry Scheduler already running.");
        return;
    }

    console.log(`🚀 Starting Background Retry Scheduler (Running every ${intervalMs / 1000}s)`);
    
    // Execute once initially on startup after 1 minute
    setTimeout(() => {
        processPendingRetries();
    }, 60 * 1000);

    // Schedule periodic execution
    retryIntervalTimer = setInterval(async () => {
        await processPendingRetries();
    }, intervalMs);
}

/**
 * Stops the background retry scheduler
 */
function stopRetryScheduler() {
    if (retryIntervalTimer) {
        clearInterval(retryIntervalTimer);
        retryIntervalTimer = null;
        console.log("🛑 Stopped Background Retry Scheduler.");
    }
}

module.exports = {
    startRetryScheduler,
    stopRetryScheduler,
    processPendingRetries,
    triggerImmediateRetry
};

const { getCollection } = require('../config/db');

/**
 * Log a WhatsApp notification attempt
 * @param {object} logData 
 * @param {string} logData.bookingId
 * @param {string} logData.recipient
 * @param {string} logData.message
 * @param {string} logData.status - 'SUCCESS' | 'FAILED'
 * @param {string} [logData.error]
 */
async function logNotification(logData) {
    try {
        const collection = getCollection('whatsapp_notification_logs');
        const entry = {
            bookingId: logData.bookingId,
            recipient: logData.recipient,
            message: logData.message,
            status: logData.status,
            error: logData.error || null,
            timestamp: new Date()
        };
        const result = await collection.insertOne(entry);
        return { ...entry, _id: result.insertedId };
    } catch (error) {
        console.error("❌ Error in logNotification:", error);
        throw error;
    }
}

/**
 * Fetch recent notification logs
 * @param {number} limit 
 */
async function getRecentLogs(limit = 10) {
    try {
        const collection = getCollection('whatsapp_notification_logs');
        return await collection.find({})
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
    } catch (error) {
        console.error("❌ Error in getRecentLogs:", error);
        return [];
    }
}

module.exports = {
    logNotification,
    getRecentLogs
};

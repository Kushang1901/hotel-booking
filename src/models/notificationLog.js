const { prisma } = require('../config/db');

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
        const entry = {
            bookingId: logData.bookingId,
            recipient: logData.recipient,
            message: logData.message,
            status: logData.status,
            error: logData.error || null,
            timestamp: new Date()
        };
        const result = await prisma.whatsAppNotificationLog.create({
            data: entry
        });
        return { ...entry, id: result.id };
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
        return await prisma.whatsAppNotificationLog.findMany({
            orderBy: {
                timestamp: 'desc'
            },
            take: limit
        });
    } catch (error) {
        console.error("❌ Error in getRecentLogs:", error);
        return [];
    }
}

module.exports = {
    logNotification,
    getRecentLogs
};

const { prisma } = require('../config/db');

/**
 * Check if a booking already has a sent or pending notification.
 * @param {string} bookingId 
 */
async function hasNotification(bookingId) {
    try {
        const record = await prisma.whatsAppBookingNotification.findUnique({
            where: { bookingId }
        });
        return record ? record.status === 'SENT' : false;
    } catch (error) {
        console.error("❌ Error in hasNotification:", error);
        return false;
    }
}

/**
 * Mark a booking notification as successfully sent
 * @param {string} bookingId 
 * @param {object} payload 
 */
async function markNotificationSent(bookingId, payload = {}) {
    try {
        const now = new Date();
        await prisma.whatsAppBookingNotification.upsert({
            where: { bookingId },
            update: {
                status: 'SENT',
                sentAt: now,
                payload,
                lastError: null,
                updatedAt: now
            },
            create: {
                bookingId,
                status: 'SENT',
                sentAt: now,
                payload,
                lastError: null,
                updatedAt: now
            }
        });
    } catch (error) {
        console.error("❌ Error in markNotificationSent:", error);
    }
}

/**
 * Mark a booking notification as failed
 * @param {string} bookingId 
 * @param {string} errorMsg 
 * @param {object} payload 
 */
async function markNotificationFailed(bookingId, errorMsg, payload = {}) {
    try {
        const now = new Date();
        await prisma.whatsAppBookingNotification.upsert({
            where: { bookingId },
            update: {
                status: 'FAILED',
                payload,
                lastError: errorMsg,
                updatedAt: now
            },
            create: {
                bookingId,
                status: 'FAILED',
                payload,
                lastError: errorMsg,
                updatedAt: now
            }
        });
    } catch (error) {
        console.error("❌ Error in markNotificationFailed:", error);
    }
}

module.exports = {
    hasNotification,
    markNotificationSent,
    markNotificationFailed
};

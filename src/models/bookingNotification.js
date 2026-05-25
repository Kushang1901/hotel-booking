const { getCollection } = require('../config/db');

/**
 * Check if a booking already has a sent or pending notification.
 * @param {string} bookingId 
 */
async function hasNotification(bookingId) {
    try {
        const collection = getCollection('whatsapp_booking_notifications');
        const record = await collection.findOne({ bookingId });
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
        const collection = getCollection('whatsapp_booking_notifications');
        const now = new Date();
        await collection.updateOne(
            { bookingId },
            {
                $set: {
                    status: 'SENT',
                    sentAt: now,
                    payload,
                    lastError: null,
                    updatedAt: now
                }
            },
            { upsert: true }
        );
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
        const collection = getCollection('whatsapp_booking_notifications');
        const now = new Date();
        await collection.updateOne(
            { bookingId },
            {
                $set: {
                    status: 'FAILED',
                    payload,
                    lastError: errorMsg,
                    updatedAt: now
                }
            },
            { upsert: true }
        );
    } catch (error) {
        console.error("❌ Error in markNotificationFailed:", error);
    }
}

module.exports = {
    hasNotification,
    markNotificationSent,
    markNotificationFailed
};

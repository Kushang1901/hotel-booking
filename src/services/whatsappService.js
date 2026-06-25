const sessionModel = require('../models/whatsappSession');
const logModel = require('../models/notificationLog');
const retryModel = require('../models/failedRetry');
const bookingModel = require('../models/bookingNotification');

let isClientReady = true;

/**
 * Formats a raw phone number to a clean, all-digits country-prefixed string
 * @param {string} phone 
 */
function formatWhatsAppNumber(phone) {
    if (!phone) return null;
    let cleanPhone = phone.replace(/\D/g, ""); // Remove all non-digits
    
    // Default to Indian country code (91) if it's a 10-digit number
    if (cleanPhone.length === 10) {
        cleanPhone = "91" + cleanPhone;
    }
    
    return cleanPhone;
}

/**
 * Stub initialization of the WhatsApp connection status
 */
async function initializeWhatsAppClient() {
    console.log("ℹ️ WhatsApp Service initialized (stubs active - Meta integration disabled).");
    try {
        const ownerNumber = process.env.WHATSAPP_OWNER_NUMBER || '919824402132';
        await sessionModel.setConnected(ownerNumber);
        isClientReady = true;
    } catch (error) {
        console.error("❌ Failed to set connected status in DB:", error);
    }
    return true;
}

/**
 * Stub: Bypasses Meta Cloud API message dispatch
 * @param {string} to - Raw phone number
 * @param {string} messageText - Text content
 */
async function sendMessage(to, messageText) {
    console.log(`📤 WhatsApp stub: message to ${to} bypassed (Meta API disabled).`);
    return { success: true, message: "Meta API integration is disabled." };
}

/**
 * Stub: Bypasses Booking Notification to the Owner
 * @param {object} booking - Booking schema object
 */
async function sendBookingNotificationToOwner(booking) {
    const bookingId = booking.bookingId;
    console.log(`🛎️ WhatsApp stub: Owner booking notification for ID ${bookingId} bypassed (Meta API disabled).`);
    return { success: true, message: "Meta API integration is disabled." };
}

/**
 * Gets the active client instance placeholder
 */
function getClient() {
    return true;
}

module.exports = {
    initializeWhatsAppClient,
    sendMessage,
    sendBookingNotificationToOwner,
    formatWhatsAppNumber,
    getClient
};

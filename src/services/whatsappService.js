const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const sessionModel = require('../models/whatsappSession');
const logModel = require('../models/notificationLog');
const retryModel = require('../models/failedRetry');
const bookingModel = require('../models/bookingNotification');

let sock = null;
let isClientReady = false;
let isInitializing = false;

/**
 * Clears the local Baileys session files directory to trigger clean scans on logout
 */
function clearAuthDirectory() {
    const sessionPath = path.join(__dirname, '../../session_auth_data');
    if (fs.existsSync(sessionPath)) {
        console.log("🧹 Clearing local Baileys session directory...");
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {
            console.error("Error clearing session folder:", err.message);
        }
    }
}

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
 * Initializes the Baileys WhatsApp client, manages event streams, and syncs status to MongoDB
 */
async function initializeWhatsAppClient() {
    if (isInitializing) {
        console.log("ℹ️ Baileys initialization is already in progress...");
        return null;
    }
    isInitializing = true;
    
    try {
        console.log("🚀 Initializing Baileys WhatsApp WebSocket Connection...");
        await sessionModel.updateSession({ status: 'CONNECTING', qrCode: null });

        const { state, saveCreds } = await useMultiFileAuthState('session_auth_data');
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'warn' }),
            printQRInTerminal: true
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // 1. Handle scannable QR Code generation
            if (qr) {
                console.log("📥 New Baileys QR Code generated. Saving to DB...");
                await sessionModel.saveQrCode(qr);
            }
            
            // 2. Handle Connection Closure (Disconnect/Reconnect)
            if (connection === 'close') {
                isClientReady = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.warn(`⚠️ Baileys connection closed. Status Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    await sessionModel.updateSession({ status: 'CONNECTING', error: 'Reconnecting...' });
                    setTimeout(() => {
                        isInitializing = false; // Allow reconnection attempt
                        initializeWhatsAppClient();
                    }, 5000);
                } else {
                    console.log("🔌 WhatsApp logged out. Cleaning up credentials...");
                    clearAuthDirectory();
                    await sessionModel.setDisconnected("Logged out by user/Meta.");
                }
            } 
            // 3. Handle Connection Successful
            else if (connection === 'open') {
                console.log("🎉 Baileys WhatsApp Client is CONNECTED!");
                isClientReady = true;
                const myNumber = sock.user.id.split(':')[0];
                await sessionModel.setConnected(myNumber);
            }
        });
        
    } catch (error) {
        console.error("❌ Failed to initialize Baileys Client:", error);
        isClientReady = false;
        await sessionModel.setDisconnected("Init error: " + error.message);
    } finally {
        isInitializing = false;
    }
    
    return sock;
}

/**
 * Sends a WhatsApp message via Baileys WebSocket API
 * @param {string} to - Phone number
 * @param {string} messageText - Message body
 */
async function sendMessage(to, messageText) {
    if (!sock || !isClientReady) {
        throw new Error("WhatsApp client not ready. Message postponed.");
    }

    let cleanTo = to.includes('@s.whatsapp.net') ? to.split('@')[0] : to.replace(/\D/g, "");
    if (cleanTo.length === 10) {
        cleanTo = "91" + cleanTo;
    }
    const formattedTo = `${cleanTo}@s.whatsapp.net`;

    try {
        console.log(`📤 Sending WhatsApp message via Baileys to: ${formattedTo}...`);
        const result = await sock.sendMessage(formattedTo, { text: messageText });
        console.log(`✅ WhatsApp message sent! Msg JID: ${result.key.id}`);
        return result;
    } catch (error) {
        console.error(`❌ Failed to send WhatsApp message via Baileys to ${formattedTo}:`, error);
        throw error;
    }
}

/**
 * Formulates and sends a Booking Notification to the Owner
 * @param {object} booking - Booking schema object
 */
async function sendBookingNotificationToOwner(booking) {
    const ownerNumber = process.env.WHATSAPP_OWNER_NUMBER || '919824402132';
    const bookingId = booking.bookingId;
    
    // Deduplication check
    const alreadySent = await bookingModel.hasNotification(bookingId);
    if (alreadySent) {
        console.log(`ℹ️ Booking notification already sent for ${bookingId}. Skipping duplicate.`);
        return { success: true, duplicate: true };
    }

    // Format Dates nicely in Indian Standard Time (IST) or standard date string
    const checkInDateStr = new Date(booking.checkIn).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit', year: 'numeric' });
    const checkOutDateStr = new Date(booking.checkOut).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit', year: 'numeric' });

    // Infer number of guests
    let guestsCount = 2; // Default fallback
    let extraMattressDetail = "";

    if (booking.rooms && booking.rooms.length > 0) {
        guestsCount = booking.rooms.reduce((acc, r) => acc + (Number(r.guests) || 2), 0);
        const totalMattresses = booking.rooms.reduce((acc, r) => acc + ((r.guests > 2 && r.roomType !== 'Standard') ? (r.guests - 2) : 0), 0);
        if (totalMattresses > 0) {
            extraMattressDetail = ` (+ ${totalMattresses} Extra Mattress${totalMattresses > 1 ? 'es' : ''})`;
        }
    } else if (booking.guests) {
        guestsCount = Number(booking.guests);
        if (booking.extraMattress) {
            extraMattressDetail = ` (+ 1 Extra Mattress)`;
        }
    } else if (booking.extraMattress) {
        guestsCount = 3;
        extraMattressDetail = ` (+ 1 Extra Mattress)`;
    }

    // Format room details string
    let roomDetails = booking.roomType;
    if (booking.rooms && booking.rooms.length > 0) {
        roomDetails = booking.rooms.map(r => `${r.quantity}x ${r.roomType} (${r.selectedSubtype})`).join(", ");
    } else if (booking.selectedSubtype) {
        roomDetails = `${booking.roomType} (${booking.selectedSubtype})`;
    }

    // Format guest phone number nicely
    let cleanGuestPhone = booking.phone ? booking.phone.replace(/\D/g, "") : "";
    if (cleanGuestPhone.length === 10) {
        cleanGuestPhone = "91" + cleanGuestPhone;
    }

    // Compile beautiful message template
    const textMessage = `🛎️ *NEW HOTEL BOOKING SUCCESS* 🛎️\n\n` +
        `Dear Owner,\n` +
        `A new stay reservation has been successfully booked and confirmed!\n\n` +
        `📝 *Booking Information:*\n` +
        `• *Booking ID:* ${bookingId}\n` +
        `• *Guest Name:* ${booking.guestName}\n` +
        `• *Phone Number:* +${cleanGuestPhone}\n\n` +
        `🛏️ *Room Details:*\n` +
        `• *Room Type:* ${roomDetails}\n` +
        `• *Stay Period:* ${checkInDateStr} to ${checkOutDateStr}\n` +
        `• *Total Guests:* ${guestsCount} Person${guestsCount > 1 ? 's' : ''}${extraMattressDetail}\n\n` +
        `💰 *Tariff & Payment:*\n` +
        `• *Sum Stay Tariff:* ₹${booking.totalAmount.toLocaleString("en-IN")}\n` +
        `• *Paid Advance:* ₹${booking.paidAmount.toLocaleString("en-IN")}\n` +
        `• *Due Balance:* *₹${booking.dueAmount.toLocaleString("en-IN")}*\n` +
        `• *Payment Status:* ${booking.paymentStatus}\n\n` +
        `✍️ *Special Requests:* ${booking.specialRequests || 'None'}\n\n` +
        `🎉 *Hotel Devang, Dwarka*`;

    try {
        await sendMessage(ownerNumber, textMessage);
        
        // Log Success in DB
        await logModel.logNotification({
            bookingId,
            recipient: ownerNumber,
            message: textMessage,
            status: 'SUCCESS'
        });

        await bookingModel.markNotificationSent(bookingId, booking);
        await retryModel.removeRetry(bookingId); // Clean up from retry queue

        return { success: true };
    } catch (error) {
        console.error(`❌ Owner notification failed for booking ${bookingId}:`, error);

        // Log Failure in DB
        await logModel.logNotification({
            bookingId,
            recipient: ownerNumber,
            message: textMessage,
            status: 'FAILED',
            error: error.message
        });

        await bookingModel.markNotificationFailed(bookingId, error.message, booking);

        // Add to failed retries queue
        await retryModel.addFailedRetry({
            bookingId,
            recipient: ownerNumber,
            message: textMessage,
            error: error.message
        });

        return { success: false, error: error.message };
    }
}

/**
 * Manually logs out the Baileys client and purges state
 */
async function logout() {
    console.log("🔌 Manual logout requested for Baileys Client...");
    try {
        if (sock) {
            await sock.logout();
            sock.end();
            sock = null;
        }
    } catch (err) {
        console.error("Error logging out of Baileys socket:", err.message);
    }
    isClientReady = false;
    clearAuthDirectory();
    await sessionModel.setDisconnected("Manually logged out by owner.");
    return { success: true };
}

/**
 * Gets the active client instance JID placeholder status
 */
function getClient() {
    return sock;
}

module.exports = {
    initializeWhatsAppClient,
    sendMessage,
    sendBookingNotificationToOwner,
    logout,
    formatWhatsAppNumber,
    getClient
};

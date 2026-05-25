const { Client, LocalAuth } = require('whatsapp-web.js');
const sessionModel = require('../models/whatsappSession');
const logModel = require('../models/notificationLog');
const retryModel = require('../models/failedRetry');
const bookingModel = require('../models/bookingNotification');

let client = null;
let isInitializing = false;
let reconnectTimer = null;

/**
 * Formats a raw phone number to the WhatsApp JID format: [countryCode][number]@c.us
 * @param {string} phone 
 */
function formatWhatsAppNumber(phone) {
    if (!phone) return null;
    let cleanPhone = phone.replace(/\D/g, ""); // Remove all non-digits
    
    // Default to Indian country code (91) if it's a 10-digit number
    if (cleanPhone.length === 10) {
        cleanPhone = "91" + cleanPhone;
    }
    
    if (!cleanPhone.endsWith("@c.us")) {
        cleanPhone = cleanPhone + "@c.us";
    }
    
    return cleanPhone;
}

/**
 * Initializes the whatsapp-web.js Client with persistent LocalAuth
 */
async function initializeWhatsAppClient() {
    if (client) {
        console.log("⚠️ WhatsApp Client already initialized or initializing.");
        return client;
    }

    if (isInitializing) return;
    isInitializing = true;

    try {
        console.log("🚀 Initializing WhatsApp Web Client...");
        await sessionModel.updateSession({ status: 'CONNECTING', qrCode: null });

        client = new Client({
            authStrategy: new LocalAuth({
                clientId: sessionModel.CLIENT_ID
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-software-rasterizer'
                ],
                // On VPS it might be helpful to run with no-sandbox flags to avoid Chromium crashes
            }
        });

        // 🟢 EVENT: QR Code Received
        client.on('qr', async (qr) => {
            console.log("📲 WhatsApp QR Code generated. Scan now on the dashboard!");
            await sessionModel.saveQrCode(qr);
        });

        // 🟢 EVENT: Authenticated Successfully
        client.on('authenticated', () => {
            console.log("✅ WhatsApp Web authenticated successfully!");
        });

        // 🟢 EVENT: Authentication Failed
        client.on('auth_failure', async (msg) => {
            console.error("❌ WhatsApp Authentication failure:", msg);
            await sessionModel.setDisconnected("Authentication failed: " + msg);
            scheduleReconnect();
        });

        // 🟢 EVENT: Client Ready
        client.on('ready', async () => {
            console.log("🎉 WhatsApp Client is READY to send messages!");
            const myNumber = client.info?.wid?.user || 'Unknown';
            await sessionModel.setConnected(myNumber);
        });

        // 🟢 EVENT: Disconnected
        client.on('disconnected', async (reason) => {
            console.warn("⚠️ WhatsApp Client disconnected:", reason);
            await sessionModel.setDisconnected("Disconnected: " + reason);
            
            // Clean up puppeteer/client state
            try {
                await client.destroy();
            } catch (e) {
                console.error("Error destroying disconnected client:", e);
            }
            client = null;
            
            scheduleReconnect();
        });

        // Start initialization
        await client.initialize();

    } catch (error) {
        console.error("❌ Failed to initialize WhatsApp Client:", error);
        await sessionModel.setDisconnected("Init error: " + error.message);
        isInitializing = false;
        client = null;
        scheduleReconnect();
    } finally {
        isInitializing = false;
    }

    return client;
}

/**
 * Schedule a client reconnection with a delay
 */
function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    console.log("🔄 Scheduling WhatsApp reconnect in 10 seconds...");
    reconnectTimer = setTimeout(async () => {
        console.log("🔄 Attempting to reconnect WhatsApp client...");
        await initializeWhatsAppClient();
    }, 10000);
}

/**
 * Sends a WhatsApp message
 * @param {string} to - Raw phone number or formatted JID
 * @param {string} messageText - Text content
 */
async function sendMessage(to, messageText) {
    if (!client) {
        throw new Error("WhatsApp client not ready. Message postponed.");
    }

    const formattedTo = to.includes('@c.us') ? to : formatWhatsAppNumber(to);
    if (!formattedTo) {
        throw new Error("Invalid phone number format: " + to);
    }

    try {
        console.log(`📤 Sending WhatsApp message to: ${formattedTo}...`);
        const response = await client.sendMessage(formattedTo, messageText);
        console.log(`✅ WhatsApp message sent! Message ID: ${response.id.id}`);
        return response;
    } catch (error) {
        console.error(`❌ Failed to send WhatsApp message to ${formattedTo}:`, error);
        throw error;
    }
}

/**
 * Formulates and sends a Booking Notification to the Owner
 * @param {object} booking - Booking schema object
 */
async function sendBookingNotificationToOwner(booking) {
    const ownerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    
    if (!ownerNumber) {
        console.warn("⚠️ WHATSAPP_OWNER_NUMBER not set in .env. Cannot notify hotel owner.");
        return { success: false, error: "WHATSAPP_OWNER_NUMBER not set in environment variables" };
    }

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
        // If extraMattress is boolean and true, guests is likely >= 3
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

    // Compile beautiful message template
    const textMessage = `🛎️ *NEW HOTEL BOOKING SUCCESS* 🛎️\n\n` +
        `Dear Owner,\n` +
        `A new stay reservation has been successfully booked and confirmed!\n\n` +
        `📝 *Booking Information:*\n` +
        `• *Booking ID:* ${bookingId}\n` +
        `• *Guest Name:* ${booking.guestName}\n` +
        `• *Phone Number:* +${booking.phone.replace(/\D/g, "")}\n\n` +
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
        await retryModel.removeRetry(bookingId); // Clean up from retry queue if it was there

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
 * Gets the active client instance
 */
function getClient() {
    return client;
}

module.exports = {
    initializeWhatsAppClient,
    sendMessage,
    sendBookingNotificationToOwner,
    formatWhatsAppNumber,
    getClient
};

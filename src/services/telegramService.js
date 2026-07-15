const axios = require('axios');
const Sentry = require("@sentry/node");

// Helper to escape HTML tags to prevent parsing errors on Telegram
function escapeHTML(text) {
    if (!text) return "";
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Formulates and sends a Booking Notification to all registered Telegram subscribers
 * @param {object} booking - Booking schema object
 */
async function sendBookingNotificationToOwner(booking) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!botToken) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN not set in .env. Cannot notify hotel owner.");
        return { success: false, error: "Telegram bot token missing in .env" };
    }

    const { prisma } = require('../config/db');
    let chatIds = [];
    try {
        const subscribers = await prisma.telegramSubscriber.findMany();
        chatIds = subscribers.map(sub => sub.chatId);
    } catch (err) {
        console.error("❌ Failed to fetch telegram subscribers:", err.message);
    }

    // Fallback to TELEGRAM_CHAT_ID if environment variable is set and no users have subscribed yet
    if (chatIds.length === 0 && process.env.TELEGRAM_CHAT_ID) {
        chatIds.push(process.env.TELEGRAM_CHAT_ID);
    }

    if (chatIds.length === 0) {
        console.warn("⚠️ No telegram subscribers registered and no fallback TELEGRAM_CHAT_ID found.");
        return { success: false, error: "No subscribers found to send message to." };
    }

    const bookingId = booking.bookingId || "N/A";
    
    // Format Dates nicely in Indian Standard Time (IST) or standard date string
    const checkInDateStr = booking.checkIn 
        ? new Date(booking.checkIn).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit', year: 'numeric' })
        : "N/A";
    const checkOutDateStr = booking.checkOut
        ? new Date(booking.checkOut).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit', year: 'numeric' })
        : "N/A";

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
    let roomDetails = booking.roomType || "N/A";
    if (booking.rooms && booking.rooms.length > 0) {
        roomDetails = booking.rooms.map(r => `${r.quantity}x ${r.roomType} (${r.selectedSubtype})`).join(", ");
    } else if (booking.selectedSubtype) {
        roomDetails = `${booking.roomType} (${booking.selectedSubtype})`;
    }

    const cleanPhone = booking.phone ? booking.phone.toString().replace(/\D/g, "") : "N/A";
    const guestName = escapeHTML(booking.guestName || booking.guest_name);
    const roomDetailsEscaped = escapeHTML(roomDetails);
    const totalAmount = (booking.totalAmount || 0).toLocaleString("en-IN");
    const paidAmount = (booking.paidAmount || 0).toLocaleString("en-IN");
    const dueAmount = (booking.dueAmount || 0).toLocaleString("en-IN");
    const paymentStatus = escapeHTML(booking.paymentStatus || "N/A");
    const specialRequests = escapeHTML(booking.specialRequests || booking.message || 'None');

    // Compile beautiful HTML message template for Telegram
    const htmlMessage = `<b>🛎️ NEW HOTEL BOOKING SUCCESS 🛎️</b>\n\n` +
        `Dear Owner,\n` +
        `A new stay reservation has been successfully booked and confirmed!\n\n` +
        `<b>📝 Booking Information:</b>\n` +
        `• <b>Booking ID:</b> ${bookingId}\n` +
        `• <b>Guest Name:</b> ${guestName}\n` +
        `• <b>Phone Number:</b> +${cleanPhone}\n\n` +
        `<b>🛏️ Room Details:</b>\n` +
        `• <b>Room Type:</b> ${roomDetailsEscaped}\n` +
        `• <b>Stay Period:</b> ${checkInDateStr} to ${checkOutDateStr}\n` +
        `• <b>Total Guests:</b> ${guestsCount} Person${guestsCount > 1 ? 's' : ''}${extraMattressDetail}\n\n` +
        `<b>💰 Tariff & Payment:</b>\n` +
        `• <b>Sum Stay Tariff:</b> ₹${totalAmount}\n` +
        `• <b>Paid Advance:</b> ₹${paidAmount}\n` +
        `• <b>Due Balance:</b> <b>₹${dueAmount}</b>\n` +
        `• <b>Payment Status:</b> ${paymentStatus}\n\n` +
        `<b>✍️ Special Requests:</b> ${specialRequests}\n\n` +
        `🎉 <b>Hotel Devang, Dwarka</b>`;

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    let successCount = 0;
    const errors = [];

    for (const id of chatIds) {
        try {
            console.log(`📤 Sending Telegram booking message to subscriber ${id}...`);
            await axios.post(url, {
                chat_id: id,
                text: htmlMessage,
                parse_mode: "HTML"
            });
            successCount++;
        } catch (error) {
            const errorMsg = error.response?.data?.description || error.message;
            console.error(`❌ Failed to send Telegram booking message to subscriber ${id}:`, errorMsg);
            errors.push({ chatId: id, error: errorMsg });
            Sentry.captureException(error);
        }
    }

    if (successCount > 0) {
        console.log(`✅ Telegram booking notification successfully sent to ${successCount} subscribers.`);
        return { success: true, count: successCount, errors };
    } else {
        return { success: false, error: "Failed to notify any subscriber", errors };
    }
}

/**
 * Handle incoming updates from Telegram (webhook or polling)
 * @param {object} update - Telegram update body
 */
async function handleTelegramUpdate(update) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    // 1. Handle Callback Query (Inline Keyboard Buttons)
    if (update.callback_query) {
        const callbackQuery = update.callback_query;
        const chatId = callbackQuery.message.chat.id.toString();
        const data = callbackQuery.data;
        const username = callbackQuery.from?.username || null;
        const firstName = callbackQuery.from?.first_name || null;
        const lastName = callbackQuery.from?.last_name || null;

        try {
            // Acknowledge the callback query to clear the loading indicator
            await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id
            });

            // Make sure the subscriber is registered
            const { prisma } = require('../config/db');
            await prisma.telegramSubscriber.upsert({
                where: { chatId },
                update: { username, firstName, lastName },
                create: { chatId, username, firstName, lastName }
            });

            if (data === 'view_history') {
                const bookings = await prisma.booking.findMany({
                    orderBy: { createdAt: 'desc' },
                    take: 10
                });

                if (bookings.length === 0) {
                    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        chat_id: chatId,
                        text: `📭 <b>No bookings found</b> in the database.`,
                        parse_mode: 'HTML'
                    });
                    return;
                }

                let historyMsg = `<b>📊 Recent Bookings (Last ${bookings.length}):</b>\n\n`;
                bookings.forEach((b, idx) => {
                    const checkInDate = b.checkIn 
                        ? new Date(b.checkIn).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit' })
                        : (b.check_in || "N/A");
                    const checkOutDate = b.checkOut
                        ? new Date(b.checkOut).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit' })
                        : (b.check_out || "N/A");
                    const guest = escapeHTML(b.guestName || b.guest_name || "N/A");
                    
                    const cmdId = (b.bookingId || b.id).toString().replace(/-/g, '_');
                    historyMsg += `${idx + 1}. <b>${guest}</b> (${checkInDate} to ${checkOutDate})\n` +
                                 `   • ID: <code>${b.bookingId || "N/A"}</code>\n` +
                                 `   • Details: /view_${cmdId}\n\n`;
                });

                await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    chat_id: chatId,
                    text: historyMsg,
                    parse_mode: 'HTML'
                });
            }
        } catch (err) {
            console.error("❌ Error handling callback query:", err);
            Sentry.captureException(err);
        }
        return;
    }

    // 2. Handle standard text Messages
    if (!update.message || !update.message.text) return;

    const message = update.message;
    const chatId = message.chat.id.toString();
    const text = message.text.trim();
    const username = message.from?.username || null;
    const firstName = message.from?.first_name || null;
    const lastName = message.from?.last_name || null;

    try {
        const { prisma } = require('../config/db');

        if (text.startsWith('/start')) {
            // Register subscriber in DB
            await prisma.telegramSubscriber.upsert({
                where: { chatId },
                update: { username, firstName, lastName },
                create: { chatId, username, firstName, lastName }
            });

            const fullName = [firstName, lastName].filter(Boolean).join(" ");
            const displayName = fullName || "User";

            const welcomeMsg = `🛎️ Welcome respected <b>${escapeHTML(displayName)}</b>...\n\n` +
                `Want to see all hotel bookings?`;

            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: chatId,
                text: welcomeMsg,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "📊 View Booking History",
                                callback_data: "view_history"
                            }
                        ]
                    ]
                }
            });
        } 
        else if (text === '📊 View Booking History' || text.startsWith('/history')) {
            const bookings = await prisma.booking.findMany({
                orderBy: { createdAt: 'desc' },
                take: 10
            });

            if (bookings.length === 0) {
                await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    chat_id: chatId,
                    text: `📭 <b>No bookings found</b> in the database.`,
                    parse_mode: 'HTML'
                });
                return;
            }

            let historyMsg = `<b>📊 Recent Bookings (Last ${bookings.length}):</b>\n\n`;
            bookings.forEach((b, idx) => {
                const checkInDate = b.checkIn 
                    ? new Date(b.checkIn).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit' })
                    : (b.check_in || "N/A");
                const checkOutDate = b.checkOut
                    ? new Date(b.checkOut).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit' })
                    : (b.check_out || "N/A");
                const guest = escapeHTML(b.guestName || b.guest_name || "N/A");
                
                // Translate '-' to '_' because Telegram commands only support alphanumeric + underscores
                const cmdId = (b.bookingId || b.id).toString().replace(/-/g, '_');
                historyMsg += `${idx + 1}. <b>${guest}</b> (${checkInDate} to ${checkOutDate})\n` +
                             `   • ID: <code>${b.bookingId || "N/A"}</code>\n` +
                             `   • Details: /view_${cmdId}\n\n`;
            });

            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: chatId,
                text: historyMsg,
                parse_mode: 'HTML'
            });
        } 
        else if (text.startsWith('/view_')) {
            const cmdId = text.substring(6).trim();
            // Translate back to the original database hyphenated identifier format
            const searchId = cmdId.replace(/_/g, '-');

            const booking = await prisma.booking.findFirst({
                where: {
                    OR: [
                        { bookingId: searchId },
                        { id: searchId }
                    ]
                }
            });

            if (!booking) {
                await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    chat_id: chatId,
                    text: `❌ Booking with ID <b>${escapeHTML(searchId)}</b> not found.`,
                    parse_mode: 'HTML'
                });
                return;
            }

            // Format check-in/out
            const checkInDateStr = booking.checkIn 
                ? new Date(booking.checkIn).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit', year: 'numeric' })
                : (booking.check_in || "N/A");
            const checkOutDateStr = booking.checkOut
                ? new Date(booking.checkOut).toLocaleDateString("en-IN", { day: '2-digit', month: '2-digit', year: 'numeric' })
                : (booking.check_out || "N/A");

            let guestsCount = 2;
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

            let roomDetails = booking.roomType || "N/A";
            if (booking.rooms && booking.rooms.length > 0) {
                roomDetails = booking.rooms.map(r => `${r.quantity}x ${r.roomType} (${r.selectedSubtype})`).join(", ");
            } else if (booking.selectedSubtype) {
                roomDetails = `${booking.roomType} (${booking.selectedSubtype})`;
            }

            const cleanPhone = (booking.phone || booking.contact) ? (booking.phone || booking.contact).toString().replace(/\D/g, "") : "N/A";
            const guestName = escapeHTML(booking.guestName || booking.guest_name || "N/A");
            const roomDetailsEscaped = escapeHTML(roomDetails);
            const totalAmount = (booking.totalAmount || 0).toLocaleString("en-IN");
            const paidAmount = (booking.paidAmount || 0).toLocaleString("en-IN");
            const dueAmount = (booking.dueAmount || 0).toLocaleString("en-IN");
            const paymentStatus = escapeHTML(booking.paymentStatus || "N/A");
            const bookingStatus = escapeHTML(booking.bookingStatus || "N/A");
            const specialRequests = escapeHTML(booking.specialRequests || booking.message || 'None');

            const detailsMsg = `<b>🛎️ BOOKING FULL DETAILS 🛎️</b>\n\n` +
                `• <b>Booking ID:</b> <code>${booking.bookingId || "N/A"}</code>\n` +
                `• <b>Guest Name:</b> ${guestName}\n` +
                `• <b>Phone Number:</b> +${cleanPhone}\n` +
                `• <b>Stay Period:</b> ${checkInDateStr} to ${checkOutDateStr}\n` +
                `• <b>Room Details:</b> ${roomDetailsEscaped}\n` +
                `• <b>Total Guests:</b> ${guestsCount} Person${guestsCount > 1 ? 's' : ''}${extraMattressDetail}\n\n` +
                `<b>💰 Tariff & Payment:</b>\n` +
                `• <b>Sum Stay Tariff:</b> ₹${totalAmount}\n` +
                `• <b>Paid Advance:</b> ₹${paidAmount}\n` +
                `• <b>Due Balance:</b> <b>₹${dueAmount}</b>\n` +
                `• <b>Payment Status:</b> ${paymentStatus}\n\n` +
                `• <b>Booking Status:</b> ${bookingStatus}\n` +
                `• <b>Special Requests:</b> ${specialRequests}\n` +
                `• <b>Created At:</b> ${booking.createdAt ? new Date(booking.createdAt).toLocaleString("en-IN") : "N/A"}`;

            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: chatId,
                text: detailsMsg,
                parse_mode: 'HTML'
            });
        } 
        else if (text === '❓ Help' || text.startsWith('/help')) {
            const helpMsg = `📖 <b>Hotel Devang Bot Help Menu</b>\n\n` +
                `• Press <b>📊 View Booking History</b> or type /history to see recent bookings.\n` +
                `• Tap on the <code>/view_[id]</code> link on any booking item to see full stay details.\n` +
                `• /start - Subscribe to booking notifications.\n` +
                `• /help - Display this help menu.`;

            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: chatId,
                text: helpMsg,
                parse_mode: 'HTML'
            });
        }
    } catch (err) {
        console.error("❌ Error handling Telegram update:", err);
        Sentry.captureException(err);
    }
}

/**
 * Configure Telegram webhooks in production or start long polling in development
 */
async function initTelegramBot() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN not set in .env. Bot features are disabled.");
        return;
    }

    if (process.env.NODE_ENV === 'production') {
        const serverUrl = process.env.SERVER_URL || 'https://hotel-booking-1-gg1m.onrender.com';
        try {
            await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, {
                url: `${serverUrl}/api/telegram-webhook`
            });
            console.log(`✅ Telegram webhook successfully registered at: ${serverUrl}/api/telegram-webhook`);
        } catch (err) {
            console.error("❌ Failed to set Telegram webhook:", err.message);
        }
    } else {
        console.log("🤖 Starting Telegram bot in long-polling mode (Development)...");
        try {
            await axios.post(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
            console.log("🗑️ Webhook deleted to enable long polling.");
        } catch (err) {
            console.warn("⚠️ Failed to delete Telegram webhook:", err.message);
        }
        startLongPolling(botToken);
    }
}

let offset = 0;
function startLongPolling(botToken) {
    // Run long polling asynchronously
    (async () => {
        while (true) {
            try {
                const response = await axios.post(`https://api.telegram.org/bot${botToken}/getUpdates`, {
                    offset,
                    timeout: 20
                });
                const updates = response.data.result || [];
                for (const update of updates) {
                    offset = update.update_id + 1;
                    await handleTelegramUpdate(update);
                }
            } catch (err) {
                console.error("⚠️ Telegram long polling fetch error:", err.message);
                // Pause for 5 seconds before retrying
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    })().catch(err => {
        console.error("❌ Fatal error in Telegram long polling loop:", err);
    });
}

module.exports = {
    sendBookingNotificationToOwner,
    handleTelegramUpdate,
    initTelegramBot
};

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
 * Formulates and sends a Booking Notification to the Owner via Telegram
 * @param {object} booking - Booking schema object
 */
async function sendBookingNotificationToOwner(booking) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!botToken || !chatId) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env. Cannot notify hotel owner.");
        return { success: false, error: "Telegram keys missing in .env" };
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
    try {
        console.log(`📤 Sending Telegram booking message to owner...`);
        const response = await axios.post(url, {
            chat_id: chatId,
            text: htmlMessage,
            parse_mode: "HTML"
        });
        console.log(`✅ Telegram message sent! Message ID: ${response.data.result.message_id}`);
        return { success: true };
    } catch (error) {
        const errorMsg = error.response?.data?.description || error.message;
        console.error(`❌ Failed to send Telegram booking message:`, errorMsg);
        Sentry.captureException(error);
        return { success: false, error: errorMsg };
    }
}

module.exports = {
    sendBookingNotificationToOwner
};

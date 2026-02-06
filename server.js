require('dotenv').config();

// ----------------------
// 🔔 SENTRY INITIALIZATION (AT TOP)
// ----------------------
const Sentry = require("@sentry/node");

Sentry.init({
    dsn: "https://85d2d49ed3791ee151e850d24b9042ad@o4510370568470528.ingest.us.sentry.io/4510370686369792",
    sendDefaultPii: true,
});

const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();

// ----------------------
// 🛡 SENTRY REQUEST HANDLER
// ----------------------
app.use(Sentry.Handlers.requestHandler());

// ----------------------
// 🌐 CORS ALLOWED DOMAINS
// ----------------------
app.use(cors({
    origin: [
        "https://hoteldevang.com",
        "https://www.hoteldevang.com",
        "https://hotel-devang.onrender.com"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true
}));

app.use(express.json());

// ----------------------
// 🗃 MONGODB CONNECTION
// ----------------------
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { tls: true });
let bookings;
let visitorSessions; // ⭐ NEW COLLECTION

// ----------------------
// 🚀 START SERVER AND CONNECT DB
// ----------------------
async function startServer() {
    try {
        await client.connect();
        const db = client.db("hotel_devang");

        bookings = db.collection("bookings");
        visitorSessions = db.collection("visitor_sessions"); // ⭐ NEW

        console.log("✅ Connected to MongoDB Atlas");

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err);
        Sentry.captureException(err);
        process.exit(1);
    }
}

// ----------------------
// 🟢 ROUTES
// ----------------------

// 📍 Health Check
app.get('/', (req, res) => {
    res.send("Hotel Devang Booking API is running ✅");
});

// 📘 Get All Bookings
app.get('/api/book', async (req, res) => {
    if (!bookings) return res.status(503).json({ success: false, error: "DB not ready" });

    try {
        const allBookings = await bookings.find().toArray();
        res.status(200).json({ success: true, data: allBookings });
    } catch (err) {
        console.error("❌ Error fetching bookings:", err);
        Sentry.captureException(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✍ Add New Booking
app.post('/api/book', async (req, res) => {
    console.log("📥 Received booking request:", req.body);

    if (!bookings)
        return res.status(503).json({ success: false, error: 'Server initializing, try again' });

    try {
        const { guest_name, phone, check_in, check_out, room_type, message, device } = req.body;


        if (!guest_name || !phone || !check_in || !check_out || !room_type) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }

        const bookingData = {
            guest_name,
            contact: phone,
            check_in,
            check_out,
            room_type,
            message: message || "None",
            device: device || "Unknown",
            timestamp: new Date()
        };


        // 🚫 Prevent Duplicate Bookings
        const existing = await bookings.findOne({
            guest_name: bookingData.guest_name,
            contact: bookingData.contact,
            check_in: bookingData.check_in,
            check_out: bookingData.check_out,
            room_type: bookingData.room_type
        });

        if (existing) {
            console.log("⚠️ Duplicate booking ignored");
            return res.status(200).json({ success: false, message: "Duplicate booking" });
        }

        const result = await bookings.insertOne(bookingData);
        console.log("✅ Booking saved:", result.insertedId);

        res.status(200).json({ success: true, id: result.insertedId });
    } catch (err) {
        console.error("❌ Error saving booking:", err);
        Sentry.captureException(err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// ⭐ NEW API FOR COOKIE USER SESSION TRACKING ⭐
app.post('/api/log-session', async (req, res) => {
    try {
        const { sessionId, page, eventType, timestamp } = req.body;

        await visitorSessions.insertOne({
            sessionId,
            page,
            eventType, // "page_visit" or "page_exit"
            timestamp: new Date(timestamp),
            userAgent: req.headers['user-agent'],
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
        });

        res.status(200).json({ success: true, message: "Session logged" });
    } catch (err) {
        console.error("❌ Error logging session:", err);
        Sentry.captureException(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ----------------------
// 🛑 SENTRY ERROR HANDLER - MUST BE LAST
// ----------------------
app.use(Sentry.Handlers.errorHandler());

// 🚀 Start Server
startServer();



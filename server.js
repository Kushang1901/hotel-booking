require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // 👈 needed for reCAPTCHA verification
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { tls: true });

let bookings;

// ✅ Connect to MongoDB Atlas before starting server
async function startServer() {
    try {
        await client.connect();
        const db = client.db("hotel_devang");
        bookings = db.collection("bookings");
        console.log("✅ Connected to MongoDB Atlas");

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err);
        process.exit(1);
    }
}

// ✅ Default route for Render health check
app.get('/', (req, res) => {
    res.send("Hotel Devang Booking API is running ✅");
});

// ✅ GET all bookings (for debugging)
app.get('/api/book', async (req, res) => {
    if (!bookings) {
        return res.status(503).json({ success: false, error: "DB not ready" });
    }

    try {
        const allBookings = await bookings.find().toArray();
        res.status(200).json({ success: true, data: allBookings });
    } catch (err) {
        console.error("❌ Error fetching bookings:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✅ Verify reCAPTCHA with Google
async function verifyRecaptcha(token, remoteip) {
    const secret = process.env.RECAPTCHA_SECRET_KEY; // 👈 keep in .env
    const url = `https://www.google.com/recaptcha/api/siteverify`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                secret: secret,
                response: token,
                remoteip: remoteip
            })
        });
        return await response.json();
    } catch (err) {
        console.error("❌ Error verifying reCAPTCHA:", err);
        return { success: false };
    }
}

// ✅ POST a new booking (with duplicate prevention + reCAPTCHA)
app.post('/api/book', async (req, res) => {
    console.log("📥 Received booking request:", req.body);

    if (!bookings) {
        return res.status(503).json({ success: false, error: 'Server initializing, try again' });
    }

    try {
        const { guest_name, phone, check_in, check_out, room_type, message, token } = req.body;

        // 1️⃣ Verify reCAPTCHA token
        const recaptchaRes = await verifyRecaptcha(token, req.ip);
        if (!recaptchaRes.success || recaptchaRes.score < 0.5) {
            console.log("⚠️ reCAPTCHA failed:", recaptchaRes);
            return res.status(403).json({ success: false, error: "reCAPTCHA verification failed" });
        }

        const bookingData = {
            guest_name,
            contact: phone,
            check_in,
            check_out,
            room_type,
            message,
            timestamp: new Date()
        };

        // 2️⃣ Prevent duplicate entries
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

        // 3️⃣ Save booking
        const result = await bookings.insertOne(bookingData);
        console.log("✅ Booking saved:", result.insertedId);
        res.status(200).json({ success: true, id: result.insertedId });

    } catch (err) {
        console.error("❌ Error saving booking:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

startServer();

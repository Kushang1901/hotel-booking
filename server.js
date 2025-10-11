require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // For reCAPTCHA verification
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors()); // Allow requests from all domains, or you can restrict to your frontend domain
app.use(express.json());

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { tls: true });

let bookings;

// Connect to MongoDB Atlas
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

// Default route for health check
app.get('/', (req, res) => {
    res.send("Hotel Devang Booking API is running ✅");
});

// GET all bookings (for debugging)
app.get('/api/book', async (req, res) => {
    if (!bookings) return res.status(503).json({ success: false, error: "DB not ready" });

    try {
        const allBookings = await bookings.find().toArray();
        res.status(200).json({ success: true, data: allBookings });
    } catch (err) {
        console.error("❌ Error fetching bookings:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Verify reCAPTCHA v3
async function verifyRecaptcha(token, remoteip) {
    const secret = process.env.RECAPTCHA_SECRET_KEY; // from .env
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

        const data = await response.json();
        // v3 provides a score (0.0 to 1.0). Accept only if score >= 0.5
        if (!data.success || data.score < 0.5) {
            console.log("⚠️ reCAPTCHA failed:", data);
            return false;
        }
        return true;
    } catch (err) {
        console.error("❌ Error verifying reCAPTCHA:", err);
        return false;
    }
}

// POST a new booking
app.post('/api/book', async (req, res) => {
    console.log("📥 Received booking request:", req.body);

    if (!bookings) return res.status(503).json({ success: false, error: 'Server initializing, try again' });

    try {
        const { guest_name, phone, check_in, check_out, room_type, message, token } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, error: "reCAPTCHA token missing" });
        }

        const isHuman = await verifyRecaptcha(token, req.ip);
        if (!isHuman) {
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

        // Prevent duplicate bookings
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

        // Save booking
        const result = await bookings.insertOne(bookingData);
        console.log("✅ Booking saved:", result.insertedId);
        res.status(200).json({ success: true, id: result.insertedId });

    } catch (err) {
        console.error("❌ Error saving booking:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

startServer();

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch'); // ⬅️ Added for captcha verification

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;

// ✅ DO NOT add useNewUrlParser or useUnifiedTopology
const client = new MongoClient(uri, {
    tls: true
});

let bookings;

// ✅ Connect to MongoDB Atlas
client.connect()
    .then(() => {
        const db = client.db("hotel_devang");
        bookings = db.collection("bookings");
        console.log("✅ Connected to MongoDB Atlas");
    })
    .catch(err => {
        console.error("❌ MongoDB connection failed:", err.stack);
    });

app.post('/api/book', async (req, res) => {
    console.log("📥 Received booking request:", req.body);

    if (!bookings) {
        console.error("❌ bookings collection not ready yet");
        return res.status(503).json({ success: false, error: 'Server initializing, try again' });
    }

    try {
        // 🔐 Step 1: Verify reCAPTCHA token
        const token = req.body["g-recaptcha-response"] || req.body.recaptcha;
        if (!token) {
            return res.status(400).json({ success: false, error: "Captcha is required" });
        }

        const secretKey = process.env.RECAPTCHA_SECRET;
        const verifyRes = await fetch("https://www.google.com/recaptcha/api/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `secret=${secretKey}&response=${token}&remoteip=${req.ip}`
        });

        const captchaResult = await verifyRes.json();
        if (!captchaResult.success) {
            console.error("❌ reCAPTCHA failed:", captchaResult["error-codes"]);
            return res.status(403).json({ success: false, error: "Captcha verification failed" });
        }

        // ✅ Step 2: Save booking if captcha passed
        const bookingData = {
            guest_name: req.body.guest_name,
            contact: req.body.email,
            check_in: req.body.check_in,
            check_out: req.body.check_out,
            room_type: req.body.room_type,
            message: req.body.message,
            timestamp: new Date()
        };

        const result = await bookings.insertOne(bookingData);
        console.log("✅ Booking saved:", result.insertedId);
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("❌ Error saving booking:", err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

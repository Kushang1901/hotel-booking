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
const axios = require("axios");

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
        "https://hotel-devang.onrender.com",
        "http://localhost:3000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:5173",
        "http://localhost:8000"
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
        const {
            guest_name,
            phone,
            check_in,
            check_out,
            room_type,
            message,
            device,
            recaptchaToken
        } = req.body;

        // 🔒 1️⃣ Check reCAPTCHA token exists
        if (!recaptchaToken) {
            return res.status(400).json({ success: false, error: "reCAPTCHA token missing" });
        }

        // 🔒 2️⃣ Verify reCAPTCHA with Google
        const verifyURL = "https://www.google.com/recaptcha/api/siteverify";

        const recaptchaResponse = await axios.post(
            verifyURL,
            null,
            {
                params: {
                    secret: process.env.RECAPTCHA_SECRET,
                    response: recaptchaToken
                }
            }
        );

        if (!recaptchaResponse.data.success) {
            return res.status(400).json({
                success: false,
                error: "reCAPTCHA verification failed"
            });
        }

        // 🔹 3️⃣ Validate Required Fields
        if (!guest_name || !phone || !check_in || !check_out || !room_type) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields"
            });
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

        // 🚫 4️⃣ Prevent Duplicate Bookings
        const existing = await bookings.findOne({
            guest_name: bookingData.guest_name,
            contact: bookingData.contact,
            check_in: bookingData.check_in,
            check_out: bookingData.check_out,
            room_type: bookingData.room_type
        });

        if (existing) {
            console.log("⚠️ Duplicate booking ignored");
            return res.status(200).json({
                success: false,
                message: "Duplicate booking"
            });
        }

        // ✅ 5️⃣ Save Booking
        const result = await bookings.insertOne(bookingData);
        console.log("✅ Booking saved:", result.insertedId);

        res.status(200).json({
            success: true,
            id: result.insertedId
        });

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

// ────────────────────────────────────────────────────────────────
// 🌐 PUBLIC ENDPOINTS FOR WEBSITES (NO INVENTORY TABLE INTEGRATION)
// ────────────────────────────────────────────────────────────────

// 📍 GET Real-Time Availability Check (No inventories collection used)
app.get('/api/public/availability', async (req, res) => {
    try {
        const { checkIn, checkOut } = req.query;
        if (!checkIn || !checkOut) {
            return res.status(400).json({ error: "checkIn and checkOut dates are required." });
        }

        const checkInDate = new Date(checkIn);
        const checkOutDate = new Date(checkOut);
        checkInDate.setHours(0, 0, 0, 0);
        checkOutDate.setHours(0, 0, 0, 0);

        if (checkInDate >= checkOutDate) {
            return res.status(400).json({ error: "checkOut must be after checkIn." });
        }

        // Fetch physical rooms. If not seeded, fallback to default physical room layout.
        const db = client.db("hotel_devang");
        const roomsCollection = db.collection("rooms");
        const rooms = await roomsCollection.find({}).toArray();

        let totalCounts = {
            Standard: 2,
            Deluxe: 31,
            "Super Deluxe": 8,
            Suite: 2
        };

        if (rooms && rooms.length > 0) {
            totalCounts = {
                Standard: rooms.filter((r) => r.roomType === "Standard").length,
                Deluxe: rooms.filter((r) => r.roomType === "Deluxe").length,
                "Super Deluxe": rooms.filter((r) => r.roomType === "Super Deluxe").length,
                Suite: rooms.filter((r) => r.roomType === "Suite").length
            };
        }

        // Count overlapping active bookings
        const activeOverlappingBookings = await bookings.find({
            bookingStatus: { $ne: "Cancelled" },
            checkIn: { $lt: checkOutDate },
            checkOut: { $gt: checkInDate }
        }).toArray();

        const bookedCounts = {
            Standard: 0,
            Deluxe: 0,
            "Super Deluxe": 0,
            Suite: 0
        };

        activeOverlappingBookings.forEach((b) => {
            const type = b.roomType;
            if (bookedCounts[type] !== undefined) {
                bookedCounts[type]++;
            }
        });

        const availability = {
            Standard: Math.max(0, totalCounts.Standard - bookedCounts.Standard),
            Deluxe: Math.max(0, totalCounts.Deluxe - bookedCounts.Deluxe),
            "Super Deluxe": Math.max(0, totalCounts["Super Deluxe"] - bookedCounts["Super Deluxe"]),
            Suite: Math.max(0, totalCounts.Suite - bookedCounts.Suite)
        };

        res.status(200).json({
            success: true,
            availability,
            totalCounts,
            bookedCounts
        });
    } catch (err) {
        console.error("❌ Public Availability API error:", err);
        Sentry.captureException(err);
        res.status(500).json({ error: "Internal server error", details: err.message });
    }
});

// 📍 POST Secure Booking Registration (No inventories collection used)
app.post('/api/public/book', async (req, res) => {
    try {
        const {
            guestName,
            phone,
            roomType,
            selectedSubtype,
            checkIn,
            checkOut,
            extraMattress,
            specialRequests,
            recaptchaToken
        } = req.body;

        if (!guestName || !phone || !roomType || !checkIn || !checkOut) {
            return res.status(400).json({ error: "Missing guest, room type, or date details." });
        }

        // Verify reCAPTCHA token if sent
        if (recaptchaToken) {
            const verifyURL = "https://www.google.com/recaptcha/api/siteverify";
            const recaptchaResponse = await axios.post(
                verifyURL,
                null,
                {
                    params: {
                        secret: process.env.RECAPTCHA_SECRET,
                        response: recaptchaToken
                    }
                }
            );

            if (!recaptchaResponse.data.success) {
                return res.status(400).json({ error: "reCAPTCHA verification failed." });
            }
        }

        const checkInDate = new Date(checkIn);
        const checkOutDate = new Date(checkOut);
        checkInDate.setHours(0, 0, 0, 0);
        checkOutDate.setHours(0, 0, 0, 0);

        if (checkInDate >= checkOutDate) {
            return res.status(400).json({ error: "Check-out date must be after check-in date." });
        }

        // Prevent Duplicate Bookings
        const existing = await bookings.findOne({
            guestName,
            phone,
            checkIn: checkInDate,
            checkOut: checkOutDate,
            roomType
        });

        if (existing) {
            return res.status(200).json({
                success: false,
                message: "Duplicate booking"
            });
        }

        // Auto Room Allocation: find overlapping active bookings for this roomType
        const overlappingBookings = await bookings.find({
            roomType,
            bookingStatus: { $ne: "Cancelled" },
            checkIn: { $lt: checkOutDate },
            checkOut: { $gt: checkInDate }
        }).toArray();

        const occupiedRooms = overlappingBookings.map((b) => b.assignedRoom);

        // Fetch physical rooms from MongoDB
        const db = client.db("hotel_devang");
        const roomsCollection = db.collection("rooms");
        const roomsOfType = await roomsCollection.find({ roomType }).toArray();
        let availableRooms = roomsOfType.filter((r) => !occupiedRooms.includes(r.roomNumber));

        let assignedRoom = "TBD";
        if (availableRooms.length > 0) {
            assignedRoom = availableRooms[0].roomNumber;
        } else if (roomsOfType.length === 0) {
            // Seeding fallback: allocate a random logical room if rooms collection is empty
            const typePrefixes = { Standard: "10", Deluxe: "20", "Super Deluxe": "30", Suite: "40" };
            const prefix = typePrefixes[roomType] || "20";
            let roomNum = prefix + Math.floor(1 + Math.random() * 9);
            while (occupiedRooms.includes(roomNum)) {
                roomNum = prefix + Math.floor(1 + Math.random() * 9);
            }
            assignedRoom = roomNum;
        } else {
            return res.status(409).json({
                error: `Selected room type '${roomType}' is fully booked or unavailable for the selected dates.`
            });
        }

        // Calculate billing amount
        const timeDiff = Math.abs(checkOutDate.getTime() - checkInDate.getTime());
        const nights = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
        
        const baseSubtype = selectedSubtype || `${roomType} AC Room`;
        
        function getRoomRate(subtype) {
            switch (subtype.toLowerCase()) {
                case "standard-ac":
                case "standard ac room":
                    return 1400;
                case "standard-non-ac":
                case "standard non-ac":
                case "standard non-ac room":
                    return 1100;
                case "deluxe ac room":
                case "deluxe-ac":
                case "deluxe ac":
                    return 1700;
                case "deluxe-non-ac":
                case "deluxe non-ac":
                case "deluxe non-ac room":
                    return 1400;
                case "super-deluxe-ac":
                case "super deluxe ac":
                case "super deluxe ac room":
                    return 1900;
                case "super-deluxe-non-ac":
                case "super deluxe non-ac":
                case "super deluxe non-ac room":
                    return 1600;
                case "suite-ac":
                case "suite ac room":
                case "suite ac":
                    return 3000;
                default:
                    return 1500;
            }
        }
        
        const ratePerNight = getRoomRate(baseSubtype);
        let totalAmount = ratePerNight * nights;
        if (extraMattress) {
            totalAmount += 300 * nights;
        }

        // Generate Unique Booking ID: HD-YYYYMMDD-[3 RANDOM DIGITS]
        const dateStr = checkInDate.toISOString().split("T")[0].replace(/-/g, "");
        const randDigits = Math.floor(100 + Math.random() * 900);
        const bookingId = `HD-${dateStr}-${randDigits}`;

        const newBooking = {
            bookingId,
            guestName,
            phone,
            roomType,
            selectedSubtype: baseSubtype,
            assignedRoom,
            checkIn: checkInDate,
            checkOut: checkOutDate,
            totalAmount,
            paidAmount: 0,
            dueAmount: totalAmount,
            paymentStatus: "Unpaid",
            bookingStatus: "Confirmed",
            specialRequests: specialRequests || "",
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await bookings.insertOne(newBooking);

        res.status(200).json({
            success: true,
            booking: newBooking
        });
    } catch (err) {
        console.error("❌ Public Book API error:", err);
        Sentry.captureException(err);
        res.status(500).json({ error: "Internal server error", details: err.message });
    }
});

// ----------------------
// 🛑 SENTRY ERROR HANDLER - MUST BE LAST
// ----------------------
app.use(Sentry.Handlers.errorHandler());

// 🚀 Start Server
startServer();


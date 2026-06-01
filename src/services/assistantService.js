require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const { connectDB, client } = require('../config/db');

const DEFAULT_COUNTS = {
  Standard: 2,
  Deluxe: 31,
  'Super Deluxe': 8,
  Suite: 2,
};

const DEFAULT_DETAILS = {
  Standard: {
    capacity: 2,
    maxOccupancy: 3,
    extraMattressAllowed: true,
    extraMattressPrice: 300,
    amenities: ['AC', 'WiFi', 'TV'],
  },
  Deluxe: {
    capacity: 2,
    maxOccupancy: 4,
    extraMattressAllowed: true,
    extraMattressPrice: 350,
    amenities: ['AC', 'WiFi', 'TV', 'Hot Water'],
  },
  'Super Deluxe': {
    capacity: 2,
    maxOccupancy: 4,
    extraMattressAllowed: true,
    extraMattressPrice: 350,
    amenities: ['AC', 'WiFi', 'TV', 'Hot Water', 'Sea View'],
  },
  Suite: {
    capacity: 2,
    maxOccupancy: 4,
    extraMattressAllowed: true,
    extraMattressPrice: 500,
    amenities: ['AC', 'WiFi', 'TV', 'Living Area'],
  },
};

const DEFAULT_PRICES = {
  'Standard|AC': 1500,
  'Standard|Non-AC': 1200,
  'Deluxe|AC': 1700,
  'Deluxe|Non-AC': 1400,
  'Super Deluxe|AC': 1900,
  'Super Deluxe|Non-AC': 1600,
  'Suite|AC': 3000,
};

const DEFAULT_POLICIES = {
  checkin: '12:30 PM',
  checkout: '10:00 AM',
  cancellation: 'Please contact the hotel directly for cancellation or modification requests.',
  id: 'Government-approved photo ID is required for all adult guests at check-in.',
  parking: 'Parking is subject to availability at the hotel.',
  wifi: 'Free WiFi is available for hotel guests.',
};

function normalizeRoomType(roomType) {
  if (!roomType || typeof roomType !== 'string') {
    return 'Deluxe'; // Default to Deluxe if missing or invalid
  }

  const lookup = roomType.trim().toLowerCase();
  const normalized = {
    standard: 'Standard',
    deluxe: 'Deluxe',
    'super deluxe': 'Super Deluxe',
    suite: 'Suite',
  }[lookup];

  return normalized || 'Deluxe';
}

function normalizeSubtype(subtype, roomType) {
  if (subtype && typeof subtype === 'string') {
    return subtype.toLowerCase().includes('non') ? 'Non-AC' : 'AC';
  }

  if (roomType === 'Suite') {
    return 'AC';
  }

  return 'AC';
}

function toUtcDate(value, fieldName) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName} date`);
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatIsoDate(value) {
  return value.toISOString().split('T')[0];
}

function formatIndianDate(value) {
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function buildBookingId(checkInDate) {
  const datePart = formatIsoDate(checkInDate).replace(/-/g, '');
  const randomPart = Math.floor(100 + Math.random() * 900);
  return `HD${datePart}${randomPart}`;
}

async function getDatabase() {
  await connectDB();
  return client.db('hotel_devang');
}

async function getCollections() {
  const db = await getDatabase();

  return {
    db,
    rooms: db.collection('rooms'),
    bookings: db.collection('bookings'),
    policies: db.collection('hotel_policies'),
    roomInformation: db.collection('room_information'),
    faq: db.collection('faq'),
    chatSessions: db.collection('chat_sessions'),
    roomPrices: db.collection('room_prices'),
    seasonalPrices: db.collection('seasonal_prices'),
    blockedDates: db.collection('blockeddates'),
  };
}

async function getTotalRoomCounts() {
  const { rooms } = await getCollections();
  const records = await rooms.find({}).toArray();

  if (records.length === 0) {
    return { ...DEFAULT_COUNTS };
  }

  return records.reduce((counts, room) => {
    const type = normalizeRoomType(room.roomType || room.type || '');

    if (counts[type] !== undefined) {
      counts[type] += 1;
    }

    return counts;
  }, { ...DEFAULT_COUNTS });
}

async function getActiveBookings(checkInDate, checkOutDate) {
  const { bookings } = await getCollections();

  return bookings.find({
    bookingStatus: { $ne: 'Cancelled' },
    checkIn: { $lt: checkOutDate },
    checkOut: { $gt: checkInDate },
  }).toArray();
}

function countBookings(bookings) {
  const counts = { ...DEFAULT_COUNTS };
  Object.keys(counts).forEach((key) => {
    counts[key] = 0;
  });

  bookings.forEach((booking) => {
    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      booking.rooms.forEach((room) => {
        const type = normalizeRoomType(room.roomType || '');
        if (counts[type] !== undefined) {
          counts[type] += Number(room.quantity) || 1;
        }
      });
      return;
    }

    if (booking.roomType) {
      const type = normalizeRoomType(booking.roomType);
      if (counts[type] !== undefined) {
        counts[type] += 1;
      }
    }
  });

  return counts;
}

async function checkAvailability({ roomType, checkIn, checkOut }) {
  const normalizedRoomType = normalizeRoomType(roomType);
  const checkInDate = toUtcDate(checkIn, 'checkIn');
  const checkOutDate = toUtcDate(checkOut, 'checkOut');

  if (checkInDate >= checkOutDate) {
    throw new Error('checkOut must be after checkIn');
  }

  const totalCounts = await getTotalRoomCounts();
  const activeBookings = await getActiveBookings(checkInDate, checkOutDate);
  const bookedCounts = countBookings(activeBookings);

  // 1. Fetch blocked dates overlapping with the selected range
  const { blockedDates } = await getCollections();
  const overlappingBlocks = await blockedDates.find({
    startDate: { $lt: checkOutDate },
    endDate: { $gte: checkInDate }
  }).toArray();

  const isHotelFullyBlocked = overlappingBlocks.some(block => block.roomType === 'All' || block.roomType === 'all');
  const blockedRoomTypes = new Set(
    overlappingBlocks
      .filter(block => block.roomType !== 'All' && block.roomType !== 'all')
      .map(block => normalizeRoomType(block.roomType))
  );

  let roomsLeft = Math.max(0, (totalCounts[normalizedRoomType] || 0) - (bookedCounts[normalizedRoomType] || 0));

  if (isHotelFullyBlocked || blockedRoomTypes.has(normalizedRoomType)) {
    roomsLeft = 0;
  }

  return {
    available: roomsLeft > 0,
    roomsLeft,
    roomType: normalizedRoomType,
    checkIn: formatIsoDate(checkInDate),
    checkOut: formatIsoDate(checkOutDate),
  };
}

async function getRoomPrice({ roomType, date, subtype }) {
  const normalizedRoomType = normalizeRoomType(roomType);
  const targetDate = date ? toUtcDate(date, 'date') : new Date();
  const normalizedSubtype = normalizeSubtype(subtype, normalizedRoomType);
  const { roomPrices, seasonalPrices } = await getCollections();

  const seasonalOverride = await seasonalPrices.findOne({
    roomType: normalizedRoomType,
    subtype: normalizedSubtype,
    startDate: { $lte: targetDate },
    endDate: { $gte: targetDate },
  });

  if (seasonalOverride) {
    return {
      roomType: normalizedRoomType,
      subtype: normalizedSubtype,
      date: formatIsoDate(targetDate),
      price: seasonalOverride.price,
      source: 'seasonal',
    };
  }

  const dbPrice = await roomPrices.findOne({
    roomType: normalizedRoomType,
    subtype: normalizedSubtype,
  });

  if (dbPrice) {
    return {
      roomType: normalizedRoomType,
      subtype: normalizedSubtype,
      date: formatIsoDate(targetDate),
      price: dbPrice.price,
      source: 'database',
    };
  }

  const fallbackPrice = DEFAULT_PRICES[`${normalizedRoomType}|${normalizedSubtype}`] || DEFAULT_PRICES[`${normalizedRoomType}|AC`] || 1500;

  return {
    roomType: normalizedRoomType,
    subtype: normalizedSubtype,
    date: formatIsoDate(targetDate),
    price: fallbackPrice,
    source: 'default',
  };
}

async function getRoomDetails({ roomType }) {
  const normalizedRoomType = normalizeRoomType(roomType);
  const { roomInformation } = await getCollections();
  const record = await roomInformation.findOne({ roomType: normalizedRoomType });

  if (record) {
    return {
      roomType: normalizedRoomType,
      capacity: record.capacity ?? DEFAULT_DETAILS[normalizedRoomType].capacity,
      maxOccupancy: record.maxOccupancy ?? DEFAULT_DETAILS[normalizedRoomType].maxOccupancy,
      extraMattressAllowed: record.extraMattressAllowed ?? DEFAULT_DETAILS[normalizedRoomType].extraMattressAllowed,
      extraMattressPrice: record.extraMattressPrice ?? DEFAULT_DETAILS[normalizedRoomType].extraMattressPrice,
      amenities: Array.isArray(record.amenities) && record.amenities.length > 0 ? record.amenities : DEFAULT_DETAILS[normalizedRoomType].amenities,
      description: record.description || '',
    };
  }

  return {
    roomType: normalizedRoomType,
    ...DEFAULT_DETAILS[normalizedRoomType],
    description: '',
  };
}

async function getPolicy({ policy }) {
  if (!policy || typeof policy !== 'string') {
    throw new Error('policy is required');
  }

  const normalizedPolicy = policy.trim().toLowerCase().replace(/[^a-z]/g, '');
  const { policies } = await getCollections();
  const records = await policies.find({}).toArray();

  const match = records.find((record) => {
    const title = String(record.title || record.policy || record.key || '').toLowerCase().replace(/[^a-z]/g, '');
    return title.includes(normalizedPolicy) || normalizedPolicy.includes(title);
  });

  if (match) {
    return {
      policy: match.title || policy,
      value: match.content || match.value || '',
    };
  }

  const fallbackValue = {
    checkin: DEFAULT_POLICIES.checkin,
    checkout: DEFAULT_POLICIES.checkout,
    cancellation: DEFAULT_POLICIES.cancellation,
    id: DEFAULT_POLICIES.id,
    identification: DEFAULT_POLICIES.id,
    parking: DEFAULT_POLICIES.parking,
    wifi: DEFAULT_POLICIES.wifi,
  }[normalizedPolicy] || '';

  return {
    policy,
    value: fallbackValue,
  };
}

async function searchFaq({ query }) {
  if (!query || typeof query !== 'string') {
    throw new Error('query is required');
  }

  const normalizedQuery = query.trim().toLowerCase();
  const { faq } = await getCollections();
  const records = await faq.find({}).toArray();

  const bestMatch = records.find((record) => {
    const question = String(record.question || '').toLowerCase();
    return question.includes(normalizedQuery) || normalizedQuery.includes(question);
  });

  if (bestMatch) {
    return {
      question: bestMatch.question || '',
      answer: bestMatch.answer || '',
    };
  }

  return {
    question: query,
    answer: 'No matching FAQ was found in the hotel database.',
  };
}

async function allocateRoomNumber(roomType, checkInDate, checkOutDate) {
  const { rooms, bookings } = await getCollections();
  const roomsOfType = await rooms.find({ roomType }).toArray();
  const overlappingBookings = await bookings.find({
    roomType,
    bookingStatus: { $ne: 'Cancelled' },
    checkIn: { $lt: checkOutDate },
    checkOut: { $gt: checkInDate },
  }).toArray();

  const occupiedRooms = overlappingBookings.map((booking) => booking.assignedRoom).filter(Boolean);
  const availableRooms = roomsOfType.filter((room) => !occupiedRooms.includes(room.roomNumber));

  if (availableRooms.length > 0) {
    return availableRooms[0].roomNumber;
  }

  if (roomsOfType.length === 0) {
    return 'TBD';
  }

  const typePrefixes = {
    Standard: '10',
    Deluxe: '20',
    'Super Deluxe': '30',
    Suite: '40',
  };

  const prefix = typePrefixes[roomType] || '20';
  let roomNumber = prefix + Math.floor(1 + Math.random() * 9);

  while (occupiedRooms.includes(roomNumber)) {
    roomNumber = prefix + Math.floor(1 + Math.random() * 9);
  }

  return roomNumber;
}

async function createBooking({ guestName, mobile, roomType, checkIn, checkOut, selectedSubtype, specialRequests = '' }) {
  if (!guestName || !mobile || !roomType || !checkIn || !checkOut) {
    throw new Error('guestName, mobile, roomType, checkIn and checkOut are required');
  }

  const normalizedRoomType = normalizeRoomType(roomType);
  const checkInDate = toUtcDate(checkIn, 'checkIn');
  const checkOutDate = toUtcDate(checkOut, 'checkOut');

  const availability = await checkAvailability({
    roomType: normalizedRoomType,
    checkIn: checkInDate,
    checkOut: checkOutDate,
  });

  if (!availability.available) {
    throw new Error(`Only ${availability.roomsLeft} ${normalizedRoomType} room(s) are available on these dates.`);
  }

  const nightlyPrice = await getRoomPrice({
    roomType: normalizedRoomType,
    date: checkInDate,
    subtype: selectedSubtype,
  });

  const roomDetails = await getRoomDetails({ roomType: normalizedRoomType });
  const assignedRoom = await allocateRoomNumber(normalizedRoomType, checkInDate, checkOutDate);
  const nights = Math.max(1, Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)));
  const totalAmount = nightlyPrice.price * nights;
  const bookingId = buildBookingId(checkInDate);
  const booking = {
    bookingId,
    guestName,
    phone: mobile,
    roomType: normalizedRoomType,
    selectedSubtype: nightlyPrice.subtype,
    assignedRoom,
    checkIn: checkInDate,
    checkOut: checkOutDate,
    totalAmount,
    paidAmount: 0,
    dueAmount: totalAmount,
    paymentStatus: 'Unpaid',
    bookingStatus: 'Confirmed',
    specialRequests,
    rooms: [
      {
        roomType: normalizedRoomType,
        selectedSubtype: nightlyPrice.subtype,
        quantity: 1,
        guests: roomDetails.capacity,
        extraMattress: false,
        pricePerNight: nightlyPrice.price,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { bookings } = await getCollections();
  await bookings.insertOne(booking);

  return {
    bookingId,
    booking,
  };
}

async function getBookingStatus({ bookingId }) {
  if (!bookingId || typeof bookingId !== 'string') {
    throw new Error('bookingId is required');
  }

  const { bookings } = await getCollections();
  const booking = await bookings.findOne({ bookingId });

  if (!booking) {
    throw new Error('Booking not found');
  }

  return {
    bookingId,
    status: booking.bookingStatus || 'Confirmed',
    paymentStatus: booking.paymentStatus || 'Unpaid',
  };
}

function buildSystemPrompt() {
  return [
    'You are the official AI assistant for Hotel Devang Dwarka.',
    'Be polite, concise, and professional.',
    'Never guess room availability or prices.',
    'Always use tools for live room availability, room prices, room details, policies, booking creation, booking status, and FAQs.',
    'Encourage direct booking whenever it is relevant.',
    'When the user asks about dates, convert them to ISO dates before calling tools.',
    'If the user asks for a booking but does not provide required details, ask only for the missing fields.',
    'If the question is not related to hotel operations, respond briefly and redirect to hotel services.',
  ].join(' ');
}

function getFallbackAssistantReply() {
  return [
    'Sorry — our AI assistant is temporarily unavailable.',
    'I can still help with room availability, booking details, hotel policies, or FAQs. Please try again in a few minutes.',
  ].join(' ');
}

function getToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'check_availability',
        description: 'Check live room availability for a room type and date range.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string' },
            checkIn: { type: 'string', description: 'ISO date, for example 2026-06-15' },
            checkOut: { type: 'string', description: 'ISO date, for example 2026-06-16' },
          },
          required: ['roomType', 'checkIn', 'checkOut'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_room_price',
        description: 'Get the room price for a room type on a given date.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string' },
            date: { type: 'string', description: 'ISO date, for example 2026-06-15' },
            subtype: { type: 'string', description: 'Optional AC or Non-AC subtype' },
          },
          required: ['roomType', 'date'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_room_details',
        description: 'Get room capacity, mattress policy, and amenities for a room type.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string' },
          },
          required: ['roomType'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_policy',
        description: 'Fetch a hotel policy from the database.',
        parameters: {
          type: 'object',
          properties: {
            policy: { type: 'string', description: 'Examples: checkin, checkout, cancellation, id, parking, wifi' },
          },
          required: ['policy'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_faq',
        description: 'Look up a common hotel question in the FAQ collection.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_booking',
        description: 'Create a hotel booking after confirming availability.',
        parameters: {
          type: 'object',
          properties: {
            guestName: { type: 'string' },
            mobile: { type: 'string' },
            roomType: { type: 'string' },
            checkIn: { type: 'string' },
            checkOut: { type: 'string' },
            selectedSubtype: { type: 'string' },
            specialRequests: { type: 'string' },
          },
          required: ['guestName', 'mobile', 'roomType', 'checkIn', 'checkOut'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_booking_status',
        description: 'Get the status of an existing booking using the booking ID.',
        parameters: {
          type: 'object',
          properties: {
            bookingId: { type: 'string' },
          },
          required: ['bookingId'],
        },
      },
    },
  ];
}

async function runTool(toolName, args) {
  // Normalize arguments (snake_case to camelCase)
  const normalizedArgs = {};
  Object.keys(args || {}).forEach(key => {
    const normalizedKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    normalizedArgs[normalizedKey] = args[key];
  });

  // Ensure tool consistency (fallback to camelCase version if snake_case exists in definition)
  switch (toolName) {
    case 'check_availability':
      return checkAvailability(normalizedArgs);
    case 'get_room_price':
      return getRoomPrice(normalizedArgs);
    case 'get_room_details':
      return getRoomDetails(normalizedArgs);
    case 'get_policy':
      return getPolicy(normalizedArgs);
    case 'search_faq':
      return searchFaq(normalizedArgs);
    case 'create_booking':
      return createBooking(normalizedArgs);
    case 'get_booking_status':
      return getBookingStatus(normalizedArgs);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function toGeminiContents(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .flatMap((message) => {
      if (!message) {
        return [];
      }

      if ((message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') {
        const entry = {
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        };

        if (message.functionCall) {
          entry.parts = [{ functionCall: message.functionCall }];
        }

        return [entry];
      }

      if (message.role === 'tool' && message.name && typeof message.content === 'string') {
        let responsePayload = message.content;
        try {
          responsePayload = JSON.parse(message.content);
        } catch {
          responsePayload = message.content;
        }

        return [{
          role: 'function',
          parts: [{
            functionResponse: {
              name: message.name,
              response: responsePayload,
            },
          }],
        }];
      }

      return [];
    });
}

function getGeminiToolDefinitions() {
  return {
    functionDeclarations: getToolDefinitions().map((tool) => tool.function),
  };
}

async function callGemini(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const payload = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt() }],
    },
    contents: toGeminiContents(messages),
    tools: [getGeminiToolDefinitions()],
    generationConfig: {
      temperature: 0.2,
    },
  };
  const modelCandidates = [
    process.env.GEMINI_MODEL,
    'gemini-2.0-flash',
    'gemini-flash-latest',
    'gemini-pro-latest',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
  ].filter(Boolean);

  let lastError = null;

  for (const modelName of [...new Set(modelCandidates)]) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    try {
      console.log("📤 Sending to Gemini:", JSON.stringify({ modelName, ...payload }, null, 2));
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
      });

      return response.data;
    } catch (error) {
      const errorDetail = error.response ? JSON.stringify(error.response.data) : error.message;
      lastError = errorDetail;
      const statusCode = error.response?.status;
      
      console.error(`❌ Gemini API Error for model ${modelName}:`, errorDetail);

      // Self-healing: if model is unsupported (404), rate-limited (429), or experiencing a temporary spike (503), continue to other candidates
      const shouldFallback = statusCode === 404 || statusCode === 429 || statusCode === 503;

      if (shouldFallback) {
        console.warn(`🔄 Falling back from model ${modelName} due to status ${statusCode}`);
        continue;
      }

      throw new Error(`Gemini request failed: ${errorDetail}`);
    }
  }

  throw new Error(`Gemini request failed: ${lastError || 'No supported model available'}`);
}

async function persistChatTurn({ sessionId, userMessage, botReply }) {
  const { chatSessions } = await getCollections();
  await chatSessions.insertOne({
    sessionId,
    userMessage,
    botReply,
    timestamp: new Date(),
  });
}

function getLatestUserMessage(messages, fallbackMessage) {
  if (fallbackMessage && typeof fallbackMessage === 'string') {
    return fallbackMessage;
  }

  if (!Array.isArray(messages)) {
    return '';
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }

  return '';
}

function parseDateFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  const lowered = text.toLowerCase();

  // 1. Matches DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
  // Example: 05-06-2026, 5/6/2026, 5/6
  const mNumeric = lowered.match(/\b(\d{1,2})[-/\.](\d{1,2})(?:[-/\.](\d{2,4}))?\b/);
  if (mNumeric) {
    let day = parseInt(mNumeric[1], 10);
    let month = parseInt(mNumeric[2], 10) - 1; // 0-indexed
    let year = mNumeric[3] ? parseInt(mNumeric[3], 10) : (new Date()).getFullYear();
    if (year < 100) year += 2000; // handle 2-digit years
    
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      try {
        const d = new Date(Date.UTC(year, month, day));
        if (!isNaN(d.getTime())) return d;
      } catch (e) {}
    }
  }

  // 2. Matches "5th of june", "5 june", "5th june 2026"
  const mDayMonth = lowered.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(?:of)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/i);
  if (mDayMonth) {
    let day = parseInt(mDayMonth[1], 10);
    const monAbbr = mDayMonth[2].toLowerCase();
    const year = mDayMonth[3] ? parseInt(mDayMonth[3], 10) : (new Date()).getFullYear();
    const fullNames = {
      jan: 'january', feb: 'february', mar: 'march', apr: 'april', may: 'may', jun: 'june',
      jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december'
    };
    const monthName = fullNames[monAbbr];
    if (monthName && months[monthName] !== undefined) {
      const month = months[monthName];
      try {
        const d = new Date(Date.UTC(year, month, day));
        if (!isNaN(d.getTime())) return d;
      } catch (e) {}
    }
  }

  // 3. Matches "june 5", "june 5th", "june 5th 2026"
  const mMonthDay = lowered.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/i);
  if (mMonthDay) {
    const monAbbr = mMonthDay[1].toLowerCase();
    let day = parseInt(mMonthDay[2], 10);
    const year = mMonthDay[3] ? parseInt(mMonthDay[3], 10) : (new Date()).getFullYear();
    const fullNames = {
      jan: 'january', feb: 'february', mar: 'march', apr: 'april', may: 'may', jun: 'june',
      jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december'
    };
    const monthName = fullNames[monAbbr];
    if (monthName && months[monthName] !== undefined) {
      const month = months[monthName];
      try {
        const d = new Date(Date.UTC(year, month, day));
        if (!isNaN(d.getTime())) return d;
      } catch (e) {}
    }
  }

  return null;
}

function isAvailabilityQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const lowered = text.toLowerCase();
  const hasKeywords = /avail|is there a room|rooms left|rooms free|vacan|any room|rooms for|book|stay/i.test(lowered);
  const hasDatePattern = /\b\d{1,2}\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(lowered);
  return hasKeywords && hasDatePattern;
}

async function generateAssistantReply({ sessionId, messages = [], userMessage }) {
  const activeSessionId = sessionId || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString());
  const conversation = Array.isArray(messages) && messages.length > 0
    ? messages.filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    : userMessage
      ? [{ role: 'user', content: userMessage }]
      : [];

  let iterations = 0;

  // Quick-path: if the user's latest message looks like an availability question, try to answer directly
  const latestUser = getLatestUserMessage(messages, userMessage);
  if (isAvailabilityQuestion(latestUser)) {
    const checkDate = parseDateFromText(latestUser);
    if (!checkDate) {
      // ask for clarification via normal flow
    } else {
      try {
        const types = Object.keys(DEFAULT_COUNTS);
        const checkIn = checkDate;
        const checkOut = new Date(checkIn.getTime() + 24 * 60 * 60 * 1000);
        const results = [];
        for (const t of types) {
          try {
            const avail = await checkAvailability({ roomType: t, checkIn, checkOut });
            results.push({ roomType: t, available: avail.available, roomsLeft: avail.roomsLeft });
          } catch (e) {
            results.push({ roomType: t, error: e.message });
          }
        }

        const dateStr = formatIndianDate(checkIn);
        let reply = `🙏 Greetings from **Hotel Devang Dwarka**! Here is the live room availability for **${dateStr}**:\n\n`;
        
        let allSoldOut = true;
        results.forEach(r => {
          if (!r.error && r.available) {
            allSoldOut = false;
          }
        });

        if (allSoldOut) {
          reply += `⚠️ We are sorry, but all our rooms are fully booked for this date. Please contact our reception at **+91 98244 02132** for cancellation queries or to check alternative dates.`;
        } else {
          results.forEach(r => {
            if (r.error) {
              reply += `• **${r.roomType}**: Status unknown (${r.error})\n`;
            } else if (r.available) {
              reply += `✅ **${r.roomType}**: ${r.roomsLeft} room${r.roomsLeft > 1 ? 's' : ''} available\n`;
            } else {
              reply += `❌ **${r.roomType}**: Fully booked / Sold out\n`;
            }
          });
          reply += `\nWould you like me to assist you in making a booking for **${dateStr}**?`;
        }

        try {
          await persistChatTurn({ sessionId: activeSessionId, userMessage: latestUser, botReply: reply });
        } catch (err) {
          console.error('❌ Chat persistence error in availability quick-path:', err.message);
        }

        return { sessionId: activeSessionId, reply, messages: conversation.slice(1) };
      } catch (err) {
        console.error('❌ Availability quick-path error:', err.message);
        // fall through to normal flow
      }
    }
  }

  while (iterations < 5) {
    iterations += 1;
    let completion;

    try {
      completion = await callGemini(conversation);
    } catch (error) {
      const fallbackReply = getFallbackAssistantReply();

      try {
        await persistChatTurn({
          sessionId: activeSessionId,
          userMessage: getLatestUserMessage(messages, userMessage),
          botReply: fallbackReply,
        });
      } catch (persistError) {
        console.error('❌ Chat persistence error during fallback:', persistError.message);
      }

      return {
        sessionId: activeSessionId,
        reply: fallbackReply,
        messages: conversation.slice(1),
      };
    }

    const candidate = completion?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCallPart = parts.find((part) => part.functionCall);

    if (functionCallPart && functionCallPart.functionCall) {
      const { name, args } = functionCallPart.functionCall;
      let toolResult;
      try {
        toolResult = await runTool(name, args || {});
      } catch (err) {
        toolResult = { error: err.message };
      }

      conversation.push({
        role: 'assistant',
        content: '',
        functionCall: functionCallPart.functionCall,
      });
      conversation.push({
        role: 'tool',
        name,
        content: JSON.stringify(toolResult),
      });
      continue;
    }

    const finalReply = parts
      .map((part) => part.text || '')
      .join('')
      .trim() || 'I could not generate a response right now.';
    try {
      await persistChatTurn({
        sessionId: activeSessionId,
        userMessage: getLatestUserMessage(messages, userMessage),
        botReply: finalReply,
      });
    } catch (persistError) {
      console.error('❌ Chat persistence error:', persistError.message);
    }

    return {
      sessionId: activeSessionId,
      reply: finalReply,
      messages: conversation.slice(1),
    };
  }

  throw new Error('Assistant exceeded the tool-calling limit');
}

module.exports = {
  checkAvailability,
  getRoomPrice,
  getRoomDetails,
  getPolicy,
  searchFaq,
  createBooking,
  getBookingStatus,
  generateAssistantReply,
  formatIndianDate,
};
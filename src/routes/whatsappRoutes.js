const express = require('express');
const router = express.Router();
const controller = require('../controllers/whatsappController');

// Visual Dashboard for scanning QR and auditing logs
router.get('/whatsapp/dashboard', controller.getDashboard);

// API: Get active WhatsApp client connection status
router.get('/api/whatsapp/status', controller.getStatus);

// API: Get base64 QR Code scannable image
router.get('/api/whatsapp/qr', controller.getQrCode);

// API: Trigger outbound booking WhatsApp notification to owner
router.post('/api/whatsapp/notify', controller.sendNotification);

// API: Manually process all pending retry messages
router.post('/api/whatsapp/retry', controller.triggerRetries);

// API: Logout of current WhatsApp session
router.post('/api/whatsapp/logout', controller.logout);

module.exports = router;

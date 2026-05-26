const QRCode = require('qrcode');
const sessionModel = require('../models/whatsappSession');
const logModel = require('../models/notificationLog');
const retryModel = require('../models/failedRetry');
const whatsappService = require('../services/whatsappService');
const retryService = require('../services/retryService');

/**
 * Get current WhatsApp client status
 */
async function getStatus(req, res) {
    try {
        const session = await sessionModel.getSession();
        res.status(200).json({
            success: true,
            status: session ? session.status : 'DISCONNECTED',
            ownerNumber: session ? session.ownerNumber : null,
            lastConnectedAt: session ? session.lastConnectedAt : null,
            error: session ? session.error : null
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * Get scannable QR Code image as Data URL
 */
async function getQrCode(req, res) {
    try {
        const session = await sessionModel.getSession();
        
        if (!session || session.status !== 'QR_READY' || !session.qrCode) {
            return res.status(200).json({
                success: false,
                status: session ? session.status : 'DISCONNECTED',
                message: "QR Code not ready or client is already connected."
            });
        }

        // Convert raw QR string to base64 Data URL
        const dataUrl = await QRCode.toDataURL(session.qrCode, {
            width: 300,
            margin: 2,
            color: {
                dark: '#1e293b', // Deep slate
                light: '#ffffff'
            }
        });

        res.status(200).json({
            success: true,
            status: session.status,
            qrCodeDataUrl: dataUrl
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * Handle incoming trigger booking notification request
 */
async function sendNotification(req, res) {
    try {
        const booking = req.body;

        if (!booking || !booking.bookingId || !booking.guestName || !booking.phone || !booking.roomType) {
            return res.status(400).json({ success: false, error: "Missing required booking details (bookingId, guestName, phone, roomType)." });
        }

        const result = await whatsappService.sendBookingNotificationToOwner(booking);

        if (result.success) {
            res.status(200).json({
                success: true,
                message: result.duplicate ? "Duplicate ignored, notification already sent." : "WhatsApp notification sent successfully!"
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                message: "WhatsApp failed to send, added to background retry queue."
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * Triggers a manual processing of all failed retries
 */
async function triggerRetries(req, res) {
    try {
        await retryService.triggerImmediateRetry();
        res.status(200).json({ success: true, message: "Manual retry processing triggered!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * Disconnects WhatsApp, clears session state
 */
async function logout(req, res) {
    try {
        console.log("🔌 Manual logout triggered...");
        const client = whatsappService.getClient();
        
        if (client && typeof client.logout === 'function') {
            try {
                await client.logout();
                await client.destroy();
            } catch (err) {
                console.error("Error logging out of WhatsApp client:", err.message);
            }
        }
        
        await sessionModel.setDisconnected("Manually logged out by owner.");
        
        res.status(200).json({ success: true, message: "WhatsApp session successfully cleared and logged out." });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * Render the HTML glassmorphic administrator dashboard
 */
async function getDashboard(req, res) {
    try {
        const session = await sessionModel.getSession();
        const logs = await logModel.getRecentLogs(10);
        const retries = await retryModel.getAllFailedRetries();
        
        const status = session ? session.status : 'DISCONNECTED';
        const ownerNumber = session ? session.ownerNumber : 'None';
        const lastConnectedAt = session && session.lastConnectedAt 
            ? new Date(session.lastConnectedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) 
            : 'Never';

        // Pre-render QR image if ready
        let qrDataUrl = '';
        if (status === 'QR_READY' && session.qrCode) {
            qrDataUrl = await QRCode.toDataURL(session.qrCode, {
                width: 250,
                margin: 2,
                color: {
                    dark: '#0f172a',
                    light: '#ffffff'
                }
            });
        }

        // Render sleek HTML template
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hotel Devang - WhatsApp Link</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(30, 41, 59, 0.4);
            --card-border: rgba(255, 255, 255, 0.08);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-gold: #fbbf24;
            --accent-green: #10b981;
            --accent-red: #ef4444;
            --accent-blue: #3b82f6;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Outfit', sans-serif;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        body {
            background-color: var(--bg-color);
            background-image: 
                radial-gradient(at 0% 0%, rgba(251, 191, 36, 0.05) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(59, 130, 246, 0.08) 0px, transparent 50%);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 2rem 1rem;
            display: flex;
            justify-content: center;
            align-items: center;
        }

        .container {
            width: 100%;
            max-width: 1100px;
            display: grid;
            grid-template-columns: 1.2fr 1.8fr;
            gap: 2rem;
        }

        @media (max-width: 900px) {
            .container {
                grid-template-columns: 1fr;
            }
        }

        .glass-panel {
            background: var(--card-bg);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid var(--card-border);
            border-radius: 24px;
            padding: 2.5rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        }

        .header {
            text-align: center;
            margin-bottom: 2rem;
        }

        .header h1 {
            font-size: 1.8rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--text-primary), var(--accent-gold));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.5rem;
        }

        .header p {
            color: var(--text-secondary);
            font-size: 0.95rem;
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 1.25rem;
            border-radius: 9999px;
            font-weight: 600;
            font-size: 0.85rem;
            letter-spacing: 0.05em;
            margin-bottom: 2rem;
            text-transform: uppercase;
        }

        .status-CONNECTED {
            background: rgba(16, 185, 129, 0.15);
            color: var(--accent-green);
            border: 1px solid rgba(16, 185, 129, 0.3);
        }

        .status-QR_READY {
            background: rgba(251, 191, 36, 0.15);
            color: var(--accent-gold);
            border: 1px solid rgba(251, 191, 36, 0.3);
        }

        .status-DISCONNECTED {
            background: rgba(239, 68, 68, 0.15);
            color: var(--accent-red);
            border: 1px solid rgba(239, 68, 68, 0.3);
        }

        .status-CONNECTING {
            background: rgba(59, 130, 246, 0.15);
            color: var(--accent-blue);
            border: 1px solid rgba(59, 130, 246, 0.3);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }

        .status-CONNECTED .status-dot { background-color: var(--accent-green); box-shadow: 0 0 10px var(--accent-green); }
        .status-QR_READY .status-dot { background-color: var(--accent-gold); box-shadow: 0 0 10px var(--accent-gold); }
        .status-DISCONNECTED .status-dot { background-color: var(--accent-red); }
        .status-CONNECTING .status-dot { 
            background-color: var(--accent-blue); 
            animation: pulse 1.5s infinite ease-in-out;
        }

        @keyframes pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; transform: scale(1.2); }
        }

        .qr-section {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 280px;
            margin-bottom: 2rem;
            border-radius: 16px;
            background: rgba(15, 23, 42, 0.3);
            border: 1px dashed var(--card-border);
            padding: 2rem;
            position: relative;
        }

        .qr-image-wrapper {
            background: white;
            padding: 1rem;
            border-radius: 16px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            position: relative;
        }

        .qr-image-wrapper::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 4px;
            background: var(--accent-gold);
            animation: scan 2s infinite ease-in-out;
            box-shadow: 0 0 12px var(--accent-gold);
        }

        @keyframes scan {
            0%, 100% { top: 0%; }
            50% { top: 100%; }
        }

        .success-display {
            text-align: center;
            color: var(--text-primary);
        }

        .success-icon {
            font-size: 4rem;
            color: var(--accent-green);
            margin-bottom: 1rem;
            filter: drop-shadow(0 0 15px rgba(16, 185, 129, 0.4));
        }

        .info-grid {
            width: 100%;
            margin-top: 1.5rem;
            border-top: 1px solid var(--card-border);
            padding-top: 1.5rem;
        }

        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 0.75rem;
            font-size: 0.9rem;
        }

        .info-label {
            color: var(--text-secondary);
        }

        .info-value {
            font-weight: 500;
        }

        .btn {
            display: block;
            width: 100%;
            padding: 0.85rem 1.5rem;
            border-radius: 12px;
            font-weight: 600;
            font-size: 0.95rem;
            cursor: pointer;
            border: none;
            text-align: center;
            margin-top: 1rem;
        }

        .btn-gold {
            background: linear-gradient(135deg, #fbbf24, #f59e0b);
            color: #0f172a;
            box-shadow: 0 4px 15px rgba(251, 191, 36, 0.3);
        }

        .btn-gold:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(251, 191, 36, 0.45);
        }

        .btn-outline {
            background: transparent;
            border: 1px solid var(--card-border);
            color: var(--text-primary);
        }

        .btn-outline:hover {
            background: rgba(255,255,255,0.05);
            border-color: var(--text-secondary);
        }

        .btn-red {
            background: rgba(239, 68, 68, 0.15);
            color: var(--accent-red);
            border: 1px solid rgba(239, 68, 68, 0.3);
            margin-top: 2rem;
        }

        .btn-red:hover {
            background: var(--accent-red);
            color: white;
            box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3);
        }

        .card-title {
            font-size: 1.25rem;
            font-weight: 600;
            margin-bottom: 1.5rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .card-title span {
            font-size: 0.85rem;
            color: var(--text-secondary);
            font-weight: 400;
        }

        .table-wrapper {
            width: 100%;
            overflow-x: auto;
            border-radius: 12px;
            background: rgba(15, 23, 42, 0.2);
            border: 1px solid var(--card-border);
            margin-bottom: 2rem;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 0.875rem;
        }

        th {
            background: rgba(30, 41, 59, 0.6);
            color: var(--text-secondary);
            font-weight: 500;
            padding: 0.85rem 1rem;
            border-bottom: 1px solid var(--card-border);
        }

        td {
            padding: 0.85rem 1rem;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            vertical-align: middle;
        }

        tr:last-child td {
            border-bottom: none;
        }

        .text-success { color: var(--accent-green); }
        .text-failed { color: var(--accent-red); }
        .text-pending { color: var(--accent-gold); }

        .log-msg-preview {
            max-width: 320px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--text-secondary);
        }

        .empty-state {
            padding: 3rem 1rem;
            text-align: center;
            color: var(--text-secondary);
            font-style: italic;
        }

        .retry-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.85rem 1rem;
            border-radius: 12px;
            background: rgba(15, 23, 42, 0.25);
            border: 1px solid var(--card-border);
            margin-bottom: 0.75rem;
            font-size: 0.9rem;
        }

        .retry-info h4 {
            font-weight: 500;
            margin-bottom: 0.15rem;
        }

        .retry-info p {
            font-size: 0.8rem;
            color: var(--text-secondary);
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- LEFT PANEL: CONNECTION & QR CODE -->
        <div class="glass-panel" style="display: flex; flex-direction: column; align-items: center; justify-content: flex-start;">
            <div class="header">
                <h1>HOTEL DEVANG</h1>
                <p>WhatsApp Notification Service</p>
            </div>

            <div class="status-badge status-${status}">
                <span class="status-dot"></span>
                <span>${status.replace('_', ' ')}</span>
            </div>

            <div class="qr-section" style="width: 100%;">
                ${status === 'QR_READY' && qrDataUrl ? `
                    <div class="qr-image-wrapper">
                        <img src="${qrDataUrl}" alt="Scan QR Code" style="display: block;">
                    </div>
                    <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 1.5rem; text-align: center; line-height: 1.4;">
                        Scan this QR code using the hotel's WhatsApp number (WhatsApp -> Linked Devices -> Link a Device).
                    </p>
                ` : ''}

                ${status === 'CONNECTED' ? `
                    <div class="success-display">
                        <div class="success-icon">✓</div>
                        <h3>Successfully Linked!</h3>
                        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem;">
                            Ready to send booking notifications automatically.
                        </p>
                    </div>
                ` : ''}

                ${status === 'DISCONNECTED' ? `
                    <div style="text-align: center; padding: 1rem;">
                        <p style="color: var(--accent-red); font-weight: 500; margin-bottom: 0.5rem;">Offline</p>
                        <p style="font-size: 0.85rem; color: var(--text-secondary);">
                            WhatsApp client is stopped. Click initialize to boot up the browser.
                        </p>
                    </div>
                ` : ''}

                ${status === 'CONNECTING' ? `
                    <div style="text-align: center;">
                        <p style="color: var(--accent-blue); font-weight: 500; margin-bottom: 0.5rem;">Booting Browser...</p>
                        <p style="font-size: 0.85rem; color: var(--text-secondary);">
                            Opening background Chrome session. Please wait.
                        </p>
                    </div>
                ` : ''}
            </div>

            <div class="info-grid">
                <div class="info-row">
                    <span class="info-label">Owner Phone:</span>
                    <span class="info-value">+${process.env.WHATSAPP_OWNER_NUMBER || 'Not set'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Active JID:</span>
                    <span class="info-value">${ownerNumber !== 'None' ? '+' + ownerNumber : 'N/A'}</span>
                </div>
                <div class="info-row">
                    <span class="info-label">Last Sync:</span>
                    <span class="info-value">${lastConnectedAt}</span>
                </div>
            </div>

            ${status === 'CONNECTED' ? `
                <button onclick="handleLogout()" class="btn btn-red">Disconnect WhatsApp</button>
            ` : ''}
            
            ${status === 'DISCONNECTED' ? `
                <button onclick="window.location.reload()" class="btn btn-gold">Initialize Service</button>
            ` : ''}
        </div>

        <!-- RIGHT PANEL: LOGS & RETRIES -->
        <div class="glass-panel" style="display: flex; flex-direction: column;">
            
            <!-- SECTION 1: ACTIVE RETRY QUEUE -->
            <div>
                <h2 class="card-title">
                    Failed Message Retries
                    <span>${retries.length} Pending</span>
                </h2>
                
                ${retries.length > 0 ? `
                    <div style="margin-bottom: 2rem;">
                        <div style="max-height: 200px; overflow-y: auto; padding-right: 0.5rem; margin-bottom: 1rem;">
                            ${retries.map(r => `
                                <div class="retry-item">
                                    <div class="retry-info">
                                        <h4>ID: ${r.bookingId}</h4>
                                        <p>Attempts: ${r.attempts}/${r.maxAttempts} • Last Err: ${r.error ? r.error.substring(0, 45) : 'Unknown'}</p>
                                    </div>
                                    <span class="text-${r.status.toLowerCase()}">${r.status}</span>
                                </div>
                            `).join('')}
                        </div>
                        <button onclick="handleRetry()" class="btn btn-outline" style="margin-top: 0; width: auto; font-size: 0.85rem; padding: 0.5rem 1rem;">
                            Force Process Retries Now
                        </button>
                    </div>
                ` : `
                    <div class="table-wrapper" style="border: 1px dashed var(--card-border); background: transparent; margin-bottom: 2rem;">
                        <div class="empty-state" style="padding: 1.5rem; font-size: 0.85rem;">
                            🎉 No failed retries. All notification deliveries are healthy!
                        </div>
                    </div>
                `}
            </div>

            <!-- SECTION 2: RECENT NOTIFICATION LOGS -->
            <div style="flex-grow: 1;">
                <h2 class="card-title">
                    Recent Outbound Logs
                </h2>
                
                <div class="table-wrapper" style="margin-bottom: 0;">
                    ${logs.length > 0 ? `
                        <table>
                            <thead>
                                <tr>
                                    <th>Booking ID</th>
                                    <th>Recipient</th>
                                    <th>Message</th>
                                    <th>Time</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${logs.map(log => `
                                    <tr>
                                        <td><strong>${log.bookingId}</strong></td>
                                        <td>+${log.recipient.replace('@c.us', '')}</td>
                                        <td><div class="log-msg-preview">${log.message.replace(/\\*/g, '').substring(0, 50)}...</div></td>
                                        <td>${new Date(log.timestamp).toLocaleTimeString("en-IN", { hour: '2-digit', minute: '2-digit' })}</td>
                                        <td><span class="text-${log.status === 'SUCCESS' ? 'success' : 'failed'}" style="font-weight:600;">${log.status}</span></td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    ` : `
                        <div class="empty-state">No notification logs recorded yet.</div>
                    `}
                </div>
            </div>
        </div>
    </div>

    <script>
        // Auto-refresh status by checking API every 5 seconds
        let currentStatus = "${status}";
        
        async function checkStatus() {
            try {
                const response = await fetch('/api/whatsapp/status');
                const data = await response.json();
                
                if (data.success && data.status !== currentStatus) {
                    console.log("Status changed from " + currentStatus + " to " + data.status + ". Reloading...");
                    window.location.reload();
                }
            } catch (err) {
                console.error("Error polling WhatsApp status:", err);
            }
        }

        setInterval(checkStatus, 5000);

        async function handleLogout() {
            if (!confirm("Are you sure you want to unlink and log out this WhatsApp device?")) return;
            
            try {
                const response = await fetch('/api/whatsapp/logout', { method: 'POST' });
                const data = await response.json();
                alert(data.message);
                window.location.reload();
            } catch (err) {
                alert("Failed to logout: " + err.message);
            }
        }

        async function handleRetry() {
            try {
                const response = await fetch('/api/whatsapp/retry', { method: 'POST' });
                const data = await response.json();
                alert(data.message);
                window.location.reload();
            } catch (err) {
                alert("Failed to run retry queue: " + err.message);
            }
        }
    </script>
</body>
</html>`;

        res.status(200).send(html);

    } catch (error) {
        res.status(500).send(`<h3>Error rendering dashboard:</h3><pre>${error.message}</pre>`);
    }
}

module.exports = {
    getStatus,
    getQrCode,
    sendNotification,
    triggerRetries,
    logout,
    getDashboard
};

const express = require('express');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const { handleMessage } = require('./handles/handleMessage');
const { handlePostback } = require('./handles/handlePostback');
const tokenManager = require('./handles/tokenManager');

const app = express();
const VERIFY_TOKEN = 'autopagebot';
const PORT = process.env.PORT || 3000;

// Cooldown storage (in-memory)
const cooldowns = new Map();

// Persistent server start time storage
const START_TIME_FILE = path.join(__dirname, 'start_time.json');
let serverStartTime = null;

// Load or create persistent start time
function loadServerStartTime() {
    try {
        if (fs.existsSync(START_TIME_FILE)) {
            const data = JSON.parse(fs.readFileSync(START_TIME_FILE, 'utf8'));
            serverStartTime = data.startTime;
            console.log(`📅 Server start time loaded: ${new Date(serverStartTime).toISOString()}`);
        } else {
            serverStartTime = Date.now();
            fs.writeFileSync(START_TIME_FILE, JSON.stringify({ startTime: serverStartTime }));
            console.log(`📅 Server start time created: ${new Date(serverStartTime).toISOString()}`);
        }
    } catch (error) {
        console.error('Error loading start time:', error.message);
        serverStartTime = Date.now();
    }
}

// Get server uptime in seconds
function getServerUptime() {
    return Math.floor((Date.now() - serverStartTime) / 1000);
}

// Security middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'autopagebot-secure-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'strict'
    }
}));

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// Serve static files
app.use(express.static('public'));

// API: Get server info (start time and uptime)
app.get('/api/server/info', (req, res) => {
    res.json({
        startTime: serverStartTime,
        uptime: getServerUptime(),
        currentTime: Date.now()
    });
});

// API: Get server uptime only (for real-time updates)
app.get('/api/server/uptime', (req, res) => {
    res.json({
        uptime: getServerUptime(),
        startTime: serverStartTime
    });
});

// Helper function to get all commands with alias support and cooldown
function getAllCommands() {
    const commandsPath = path.join(__dirname, 'commands');
    if (!fs.existsSync(commandsPath)) return [];

    const files = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    const commands = [];

    for (const file of files) {
        try {
            const cmd = require(path.join(commandsPath, file));

            let cmdNames = [];
            let primaryName = '';

            if (Array.isArray(cmd.name)) {
                cmdNames = cmd.name;
                primaryName = cmd.name[0];
            } else if (typeof cmd.name === 'string') {
                cmdNames = [cmd.name];
                primaryName = cmd.name;
            } else if (cmd.name) {
                cmdNames = [String(cmd.name)];
                primaryName = String(cmd.name);
            }

            let cooldownValue = parseInt(cmd.cooldown) || 0;
            if (cooldownValue < 0) cooldownValue = 0;
            if (cooldownValue > 20) cooldownValue = 20;

            commands.push({
                name: primaryName,
                aliases: cmdNames.filter(n => n !== primaryName),
                allNames: cmdNames,
                description: cmd.description || 'No description.',
                usage: cmd.usage || 'Not specified.',
                version: cmd.version || '1.0.0',
                author: cmd.author || 'AutoPageBot',
                category: cmd.category || 'others',
                cooldown: cooldownValue,
                hidden: cmd.hidden || false,
                fileName: file
            });
        } catch (err) {
            console.error(`Error loading command ${file}:`, err.message);
        }
    }

    return commands;
}

// Helper function to find command by name or alias
function findCommand(commandName) {
    const commands = getAllCommands();
    const searchName = commandName.toLowerCase();

    return commands.find(cmd => 
        cmd.name.toLowerCase() === searchName ||
        cmd.aliases.some(alias => alias.toLowerCase() === searchName)
    );
}

// Helper function to check cooldown
function checkCooldown(commandName, senderId) {
    const key = `${commandName}_${senderId}`;
    const cooldownData = cooldowns.get(key);

    if (!cooldownData) return { onCooldown: false, remaining: 0 };

    const now = Date.now();
    const remaining = Math.ceil((cooldownData.expires - now) / 1000);

    if (remaining <= 0) {
        cooldowns.delete(key);
        return { onCooldown: false, remaining: 0 };
    }

    return { onCooldown: true, remaining };
}

// Helper function to set cooldown
function setCooldown(commandName, senderId, seconds) {
    if (seconds <= 0) return;
    if (seconds > 20) seconds = 20;

    const key = `${commandName}_${senderId}`;
    cooldowns.set(key, {
        expires: Date.now() + (seconds * 1000),
        command: commandName,
        userId: senderId
    });

    setTimeout(() => {
        if (cooldowns.get(key)?.expires <= Date.now()) {
            cooldowns.delete(key);
        }
    }, seconds * 1000);
}

// Helper function to get command count
function getCommandCount() {
    const commandsPath = path.join(__dirname, 'commands');
    if (!fs.existsSync(commandsPath)) return 0;
    return fs.readdirSync(commandsPath).filter(f => f.endsWith('.js')).length;
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: getServerUptime(),
        timestamp: new Date().toISOString(),
        sessions: tokenManager.getSessionCount(),
        version: '2.1',
        verifyToken: VERIFY_TOKEN,
        commandsLoaded: getCommandCount(),
        activeCooldowns: cooldowns.size,
        serverStartTime: serverStartTime
    });
});

// API: Get all sessions with uptime
app.get('/api/sessions', async (req, res) => {
    try {
        const sessions = await tokenManager.getAllSessions();
        const sessionsWithDetails = sessions.map(s => ({
            id: s.id,
            name: s.name,
            username: s.username,
            owner: s.owner,
            connectedAt: s.connectedAt,
            lastActive: s.lastActive,
            messengerLink: s.messengerLink,
            uptime: s.connectedAt ? Math.floor((Date.now() - new Date(s.connectedAt).getTime()) / 1000) : 0
        }));

        res.json({ 
            sessions: sessionsWithDetails, 
            count: sessionsWithDetails.length,
            serverTime: new Date().toISOString(),
            serverUptime: getServerUptime()
        });
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ error: 'Failed to fetch sessions' });
    }
});

// API: Get all commands with aliases and cooldowns
app.get('/api/commands', (req, res) => {
    try {
        const commands = getAllCommands();
        res.json({ 
            commands: commands,
            count: commands.length,
            categories: [...new Set(commands.map(c => c.category))],
            cooldownRange: { min: 0, max: 20, description: 'Cooldown in seconds (0 = no cooldown, max 20)' }
        });
    } catch (error) {
        console.error('Error fetching commands:', error);
        res.status(500).json({ error: 'Failed to fetch commands' });
    }
});

// API: Get command by name or alias
app.get('/api/commands/:commandName', (req, res) => {
    const { commandName } = req.params;
    const command = findCommand(commandName);

    if (!command) {
        return res.status(404).json({ error: 'Command not found' });
    }

    res.json(command);
});

// API: Get commands by category
app.get('/api/category/:category', (req, res) => {
    const { category } = req.params;
    const commands = getAllCommands();

    const filteredCommands = commands.filter(c => 
        c.category.toLowerCase() === category.toLowerCase()
    );

    res.json({ 
        commands: filteredCommands,
        count: filteredCommands.length,
        category: category
    });
});

// API: Get command aliases info
app.get('/api/aliases/:commandName', (req, res) => {
    const { commandName } = req.params;
    const command = findCommand(commandName);

    if (!command) {
        return res.status(404).json({ error: 'Command not found' });
    }

    res.json({
        name: command.name,
        aliases: command.aliases,
        allNames: command.allNames,
        count: command.aliases.length
    });
});

// API: Get cooldown status for a command
app.get('/api/cooldown/:commandName/:userId', (req, res) => {
    const { commandName, userId } = req.params;
    const command = findCommand(commandName);

    if (!command) {
        return res.status(404).json({ error: 'Command not found' });
    }

    const cooldownStatus = checkCooldown(command.name, userId);
    res.json({
        command: command.name,
        userId: userId,
        cooldown: command.cooldown,
        onCooldown: cooldownStatus.onCooldown,
        remainingSeconds: cooldownStatus.remaining,
        message: cooldownStatus.onCooldown ? `Please wait ${cooldownStatus.remaining} seconds before using this command again.` : 'Ready to use'
    });
});

// API: Get single page info
app.get('/api/page/:pageId', async (req, res) => {
    const { pageId } = req.params;
    const tokenData = await tokenManager.getToken(pageId);

    if (!tokenData) {
        return res.status(404).json({ error: 'Page not found' });
    }

    res.json({
        id: pageId,
        name: tokenData.name,
        owner: tokenData.owner,
        connectedAt: tokenData.connectedAt,
        lastActive: tokenData.lastActive,
        uptime: Math.floor((Date.now() - new Date(tokenData.connectedAt).getTime()) / 1000)
    });
});

// API: Add new page token
app.post('/api/connect', async (req, res) => {
    const { pageToken, pageName, userName } = req.body;

    if (!pageToken) {
        return res.status(400).json({ error: 'Page token is required' });
    }

    try {
        const response = await fetch(`https://graph.facebook.com/v23.0/me?access_token=${pageToken}`);
        const data = await response.json();

        if (data.error) {
            return res.status(400).json({ error: 'Invalid token: ' + data.error.message });
        }

        const pageId = data.id;
        const name = pageName || data.name || 'Unnamed Page';
        const username = data.username || pageId;

        const existing = await tokenManager.getToken(pageId);
        if (existing) {
            return res.status(400).json({ error: 'Page already connected!' });
        }

        await tokenManager.addToken(pageId, {
            token: pageToken,
            name: name,
            username: username,
            owner: userName || 'Anonymous',
            connectedAt: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            sessionId: req.sessionID,
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.headers['user-agent']
        });

        const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;
        await setupPageWebhook(pageId, pageToken, webhookUrl);

        console.log(`✅ Page connected: ${name} (${pageId}) by ${userName || 'Anonymous'}`);

        res.json({ 
            success: true, 
            page: { id: pageId, name, username },
            message: 'Page connected successfully!'
        });
    } catch (error) {
        console.error('Connection error:', error);
        res.status(500).json({ error: 'Connection failed. Please try again.' });
    }
});

// Setup webhook for a page
const setupPageWebhook = async (pageId, pageToken, webhookUrl) => {
    try {
        const subscribeRes = await fetch(`https://graph.facebook.com/v23.0/${pageId}/subscribed_apps?access_token=${pageToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (subscribeRes.ok) {
            console.log(`✅ Webhook configured for page ${pageId}`);
        } else {
            console.log(`⚠️ Webhook subscription issue for page ${pageId}`);
        }

        const fieldsRes = await fetch(`https://graph.facebook.com/v23.0/me/messenger_profile?access_token=${pageToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                webhook: {
                    url: webhookUrl,
                    verify_token: 'bot'
                },
                fields: ['messages', 'messaging_postbacks', 'messaging_optins']
            })
        }).catch(() => null);

    } catch (error) {
        console.error(`Failed to setup webhook for ${pageId}:`, error.message);
    }
};

// Webhook verification
app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

    console.log(`Webhook verification - Mode: ${mode}, Token: ${token}`);

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verified successfully');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Webhook verification failed');
        res.sendStatus(403);
    }
});

// Webhook handler (supports multiple tokens)
app.post('/webhook', async (req, res) => {
    if (req.body.object !== 'page') {
        return res.sendStatus(404);
    }

    console.log(`📨 Webhook received: ${req.body.entry?.length || 0} entries`);

    for (const entry of req.body.entry || []) {
        const pageId = entry.id;
        const tokenData = await tokenManager.getToken(pageId);

        if (!tokenData) {
            console.log(`❌ No token found for page ${pageId}`);
            continue;
        }

        await tokenManager.updateLastActive(pageId);

        for (const event of entry.messaging || []) {
            try {
                if (event.message) {
                    await handleMessage(event, tokenData.token, pageId);
                } else if (event.postback) {
                    await handlePostback(event, tokenData.token, pageId);
                }
            } catch (error) {
                console.error(`Error processing event for ${pageId}:`, error.message);
            }
        }
    }

    res.status(200).send('EVENT_RECEIVED');
});

// API: Get tutorial info
app.get('/api/tutorial', (req, res) => {
    res.json({
        webhookUrl: `${req.protocol}://${req.get('host')}/webhook`,
        verifyToken: VERIFY_TOKEN,
        apiVersion: 'v23.0',
        docsUrl: 'https://developers.facebook.com/docs/messenger-platform',
        supportEmail: 'support@autopagebot.com'
    });
});

// API: Get system stats
app.get('/api/stats', async (req, res) => {
    const sessions = await tokenManager.getAllSessions();
    const totalMessages = await tokenManager.getTotalMessages() || 0;
    const commandsCount = getCommandCount();

    res.json({
        activeSessions: sessions.length,
        totalPages: sessions.length,
        serverUptime: getServerUptime(),
        serverStartTime: serverStartTime,
        startTime: new Date(Date.now() - getServerUptime() * 1000).toISOString(),
        version: '2.1',
        totalMessages: totalMessages,
        totalCommands: commandsCount,
        verifyToken: VERIFY_TOKEN,
        activeCooldowns: cooldowns.size
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err.stack);
    res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Start server
const start = async () => {
    try {
        // Load persistent server start time
        loadServerStartTime();
        
        await tokenManager.loadTokens();

        const dirs = ['public', 'commands', 'temp'];
        for (const dir of dirs) {
            if (!fs.existsSync(path.join(__dirname, dir))) {
                fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
                console.log(`📁 Created ${dir} directory`);
            }
        }

        const commandsPath = path.join(__dirname, 'commands');
        const existingCommands = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

        if (existingCommands.length === 0) {
            const sampleCommand = `// Sample command with aliases and cooldown
const { sendMessage } = require('../handles/sendMessage');

module.exports = {
    name: ['ping', 'pong', 'alive'],
    description: 'Check if bot is alive and responding',
    usage: 'ping',
    version: '1.0.0',
    author: 'AutoPageBot',
    category: 'system',
    cooldown: 3,

    async execute(senderId, args, pageAccessToken, event, sendMessageFunc, imageCache) {
        await sendMessage(senderId, { 
            text: '🏓 Pong! Bot is alive and running.\\n\\n⚡ Response time: Instant\\n🤖 Version: 1.0.0\\n📡 Status: Online\\n⏱️ Cooldown: 3 seconds\\n\\n💡 Tip: You can also use: ping, pong, or alive' 
        }, pageAccessToken);
    }
};`;

            fs.writeFileSync(path.join(commandsPath, 'ping.js'), sampleCommand);
            console.log('📝 Created sample command: ping.js');
        }

        app.listen(PORT, () => {
            const startDate = new Date(serverStartTime).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
            console.log(`\n🤖 AutoPageBot v2.1 Server Running`);
            console.log(`📡 URL: http://localhost:${PORT}`);
            console.log(`🔐 Verify Token: ${VERIFY_TOKEN}`);
            console.log(`📊 Active Sessions: ${tokenManager.getSessionCount()}`);
            console.log(`📚 Commands Loaded: ${getCommandCount()}`);
            console.log(`⏱️ Cooldown Range: 0-20 seconds`);
            console.log(`📅 Server Started: ${startDate}`);
            console.log(`💡 Dashboard: http://localhost:${PORT}`);
            console.log(`📚 Tutorial: http://localhost:${PORT}#tutorial\n`);
        });
    } catch (error) {
        console.error('Startup failed:', error.message);
        process.exit(1);
    }
};

start();
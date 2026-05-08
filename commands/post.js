const axios = require('axios');
const fs = require('fs').promises;
const { createReadStream, unlinkSync } = require('fs');
const path = require('path');
const FormData = require('form-data');
const { sendMessage } = require('../handles/sendMessage');

// JSON file paths
const PAGE_ID_CACHE_FILE = path.join(__dirname, '../page_id_cache.json');
const POST_LIMITS_FILE = path.join(__dirname, '../post_limits.json');

// ============================================
// HELPER FUNCTIONS
// ============================================

// Get or create JSON file
function getJsonData(filePath, defaultData = {}) {
    try {
        if (require('fs').existsSync(filePath)) {
            const data = require('fs').readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        } else {
            require('fs').writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
            return defaultData;
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error.message);
        return defaultData;
    }
}

// Save data to JSON file
function saveJsonData(filePath, data) {
    try {
        require('fs').writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`Error saving ${filePath}:`, error.message);
        return false;
    }
}

// Auto get Page ID with caching
async function getPageId(pageAccessToken) {
    try {
        let cache = getJsonData(PAGE_ID_CACHE_FILE, {});
        
        // Use cache if less than 24 hours old
        if (cache.pageId && cache.timestamp && (Date.now() - cache.timestamp) < 86400000) {
            console.log("📦 Using cached Page ID:", cache.pageId);
            return cache.pageId;
        }
        
        // Fetch fresh page ID
        const response = await axios.get('https://graph.facebook.com/v25.0/me', {
            params: { 
                access_token: pageAccessToken, 
                fields: 'id,name,username' 
            }
        });
        
        const pageId = response.data.id;
        
        // Save to cache
        cache = {
            pageId: pageId,
            pageName: response.data.name,
            username: response.data.username,
            timestamp: Date.now()
        };
        saveJsonData(PAGE_ID_CACHE_FILE, cache);
        
        console.log("🆕 Fetched new Page ID:", pageId);
        return pageId;
    } catch (error) {
        console.error("❌ Error fetching Page ID:", error.response?.data || error.message);
        throw new Error("Could not retrieve Page ID. Check your access token.");
    }
}

// Check post limits (5 per day)
function checkPostLimit(senderId) {
    const limits = getJsonData(POST_LIMITS_FILE, {});
    const today = new Date().toISOString().split('T')[0];
    
    if (!limits[senderId]) {
        limits[senderId] = { count: 0, lastReset: today, history: [] };
    }
    
    // Reset if new day
    if (limits[senderId].lastReset !== today) {
        limits[senderId] = { count: 0, lastReset: today, history: limits[senderId].history.slice(-5) };
        saveJsonData(POST_LIMITS_FILE, limits);
    }
    
    return {
        allowed: limits[senderId].count < 5,
        remaining: 5 - limits[senderId].count,
        used: limits[senderId].count,
        limit: 5
    };
}

// Record successful post
function recordPost(senderId, message, postId, postType) {
    const limits = getJsonData(POST_LIMITS_FILE, {});
    const today = new Date().toISOString().split('T')[0];
    
    if (!limits[senderId]) {
        limits[senderId] = { count: 0, lastReset: today, history: [] };
    }
    
    limits[senderId].count++;
    limits[senderId].history.unshift({
        timestamp: Date.now(),
        date: new Date().toISOString(),
        message: message.substring(0, 100),
        postId: postId,
        type: postType
    });
    
    // Keep only last 20 history entries
    if (limits[senderId].history.length > 20) {
        limits[senderId].history = limits[senderId].history.slice(0, 20);
    }
    
    saveJsonData(POST_LIMITS_FILE, limits);
}

// ============================================
// MEDIA EXTRACTION
// ============================================

async function extractRepliedMedia(event, pageAccessToken) {
    try {
        if (event.message?.reply_to?.mid) {
            console.log("🔍 Extracting media from reply...");
            return await getRepliedMedia(event.message.reply_to.mid, pageAccessToken);
        }
        
        if (event.message?.attachments?.[0]) {
            console.log("📎 Processing direct attachment...");
            return formatAttachment(event.message.attachments[0]);
        }
        
        return null;
    } catch (error) {
        console.error("Failed to extract media:", error.message);
        return null;
    }
}

async function getRepliedMedia(mid, pageAccessToken) {
    try {
        const { data } = await axios.get(
            `https://graph.facebook.com/v25.0/${mid}/attachments`,
            {
                params: {
                    access_token: pageAccessToken,
                    fields: 'id,mime_type,name,size,video_data,image_data,file_url'
                }
            }
        );
        
        if (!data?.data?.[0]) return null;
        
        const attachment = data.data[0];
        
        if (attachment.video_data?.url) {
            return {
                url: attachment.video_data.url,
                type: 'video',
                preview: attachment.video_data.preview_url,
                metadata: {
                    width: attachment.video_data.width,
                    height: attachment.video_data.height,
                    length: attachment.video_data.length,
                    size: attachment.size,
                    mime_type: attachment.mime_type,
                    name: attachment.name
                }
            };
        }
        
        if (attachment.image_data?.url) {
            const isGif = attachment.mime_type === 'image/gif';
            return {
                url: isGif ? attachment.image_data.animated_gif_url || attachment.image_data.url : attachment.image_data.url,
                type: isGif ? 'gif' : 'photo',
                preview: attachment.image_data.preview_url,
                metadata: {
                    width: attachment.image_data.width,
                    height: attachment.image_data.height,
                    size: attachment.size,
                    mime_type: attachment.mime_type,
                    name: attachment.name,
                    animated_gif_url: attachment.image_data.animated_gif_url,
                    raw_gif_image: attachment.image_data.raw_gif_image,
                    animated_webp_url: attachment.image_data.animated_webp_url
                }
            };
        }
        
        if (attachment.file_url) {
            return {
                url: attachment.file_url,
                type: attachment.mime_type?.startsWith('video/') ? 'video' : 
                      attachment.mime_type?.startsWith('image/') ? 'photo' : 'file',
                metadata: {
                    name: attachment.name,
                    size: attachment.size,
                    mime_type: attachment.mime_type
                }
            };
        }
        
        return null;
    } catch (error) {
        console.error("Failed to get replied media:", error.response?.data || error.message);
        return null;
    }
}

function formatAttachment(attachment) {
    if (!attachment?.payload?.url) return null;
    
    const type = attachment.type === 'video' ? 'video' : 
                 attachment.type === 'audio' ? 'audio' : 
                 attachment.type === 'file' ? 'file' : 'photo';
    
    return {
        url: attachment.payload.url,
        type: type,
        metadata: {
            mime_type: attachment.mime_type,
            name: attachment.name,
            size: attachment.size
        }
    };
}

// ============================================
// POSTING FUNCTIONS
// ============================================

async function postTextOnly(pageId, message, pageAccessToken) {
    console.log("📝 Creating text post...");
    const response = await axios.post(
        `https://graph.facebook.com/v25.0/${pageId}/feed`,
        { message },
        { 
            params: { access_token: pageAccessToken },
            headers: { 'Content-Type': 'application/json' }
        }
    );
    return { 
        data: { 
            post_id: response.data.id, 
            id: response.data.id, 
            type: 'text' 
        } 
    };
}

async function postPhoto(pageId, message, mediaData, pageAccessToken) {
    console.log("📸 Creating photo post...");
    console.log("Media type:", mediaData.type);
    
    let photoUrl = mediaData.url;
    
    if (mediaData.metadata?.mime_type === 'image/gif') {
        photoUrl = mediaData.metadata.animated_gif_url || mediaData.metadata.raw_gif_image || mediaData.url;
        console.log("🎞️ Using animated GIF URL");
    }
    
    const response = await axios.post(
        `https://graph.facebook.com/v25.0/${pageId}/photos`,
        { url: photoUrl, caption: message, published: true },
        { 
            params: { access_token: pageAccessToken },
            headers: { 'Content-Type': 'application/json' }
        }
    );
    
    return { 
        data: { 
            post_id: response.data.post_id || `${pageId}_${response.data.id}`, 
            id: response.data.id, 
            type: 'photo' 
        } 
    };
}

async function postVideo(pageId, message, mediaData, pageAccessToken) {
    console.log("🎥 Creating video post...");
    const videoUrl = mediaData.url;
    
    try {
        // Method 1: Direct video post
        console.log("Method 1: Trying direct video post...");
        const response = await axios.post(
            `https://graph.facebook.com/v25.0/${pageId}/videos`,
            { file_url: videoUrl, description: message },
            { 
                params: { access_token: pageAccessToken },
                headers: { 'Content-Type': 'application/json' }
            }
        );
        
        console.log("✅ Video posted successfully!");
        return { 
            data: { 
                post_id: `${pageId}_${response.data.id}`, 
                id: response.data.id, 
                type: 'video' 
            } 
        };
    } catch (error1) {
        console.log("Method 1 failed:", error1.response?.data?.error?.message);
        
        try {
            // Method 2: Download and re-upload
            console.log("Method 2: Downloading and re-uploading video...");
            const videoBuffer = await downloadMedia(videoUrl);
            
            if (!videoBuffer) {
                throw new Error("Failed to download video");
            }
            
            const form = new FormData();
            form.append('source', videoBuffer, {
                filename: 'video.mp4',
                contentType: 'video/mp4'
            });
            form.append('description', message);
            
            const response = await axios.post(
                `https://graph.facebook.com/v25.0/${pageId}/videos`,
                form,
                {
                    params: { access_token: pageAccessToken },
                    headers: { 
                        ...form.getHeaders(),
                        'Content-Type': 'multipart/form-data'
                    }
                }
            );
            
            console.log("✅ Video uploaded successfully!");
            return { 
                data: { 
                    post_id: `${pageId}_${response.data.id}`, 
                    id: response.data.id, 
                    type: 'video' 
                } 
            };
        } catch (error2) {
            console.log("Method 2 failed:", error2.message);
            
            // Method 3: Post as link
            console.log("Method 3: Posting video URL as text...");
            const response = await axios.post(
                `https://graph.facebook.com/v25.0/${pageId}/feed`,
                { 
                    message: `${message}\n\n📹 Video: ${videoUrl}`,
                    link: videoUrl 
                },
                { 
                    params: { access_token: pageAccessToken },
                    headers: { 'Content-Type': 'application/json' }
                }
            );
            
            return { 
                data: { 
                    post_id: response.data.id, 
                    id: response.data.id, 
                    type: 'link' 
                } 
            };
        }
    }
}

async function downloadMedia(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024 // 50MB limit
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error("Download failed:", error.message);
        return null;
    }
}

// ============================================
// MAIN COMMAND
// ============================================

module.exports = {
    name: ['post', 'publish', 'share'],
    usage: 'post [message] (reply to media)',
    version: '1.2.1',
    author: 'Jhon Marc Martinez',
    category: 'posting',
    cooldown: 60,

    async execute(senderId, args, pageAccessToken, event) {
        // Auto-detect Page ID
        let PAGE_ID;
        try {
            PAGE_ID = await getPageId(pageAccessToken);
        } catch (error) {
            return sendMessage(senderId, {
                text: `❌ 𝗔𝗨𝗧𝗛𝗘𝗡𝗧𝗜𝗖𝗔𝗧𝗜𝗢𝗡 𝗘𝗥𝗥𝗢𝗥

━━━━━━━━━━━━━━━━━━━━━━━

⚠️ Failed to detect Page ID.

💡 Possible causes:
• Invalid access token
• Token expired
• Page not found

━━━━━━━━━━━━━━━━━━━━━━━

Contact bot admin to fix this issue.`
            }, pageAccessToken);
        }

        // Ignore bot's own messages
        if (senderId === PAGE_ID) {
            console.log("🚫 Ignoring message from own page");
            return;
        }

        // Show help if no args
        if (!args || !args.length) {
            return sendMessage(senderId, {
                text: `📢 𝗣𝗔𝗚𝗘 𝗣𝗢𝗦𝗧 𝗖𝗢𝗠𝗠𝗔𝗡𝗗

━━━━━━━━━━━━━━━━━━━━━━━

📝 𝗨𝘀𝗮𝗴𝗲: post [your message]

✨ 𝗘𝘅𝗮𝗺𝗽𝗹𝗲𝘀:
• post Hello World!
• post Good morning everyone!
• post Check this out!

📎 𝗙𝗼𝗿 𝗺𝗲𝗱𝗶𝗮 𝗽𝗼𝘀𝘁𝘀:
• Reply to a photo with: post [caption]
• Reply to a video with: post [caption]

📊 𝗟𝗶𝗺𝗶𝘁𝘀:
• 5 posts per day
• Text, photo & video supported
• Resets at midnight

💡 Aliases: post, publish, share

━━━━━━━━━━━━━━━━━━━━━━━

🔄 Type your message or reply to media!`
            }, pageAccessToken);
        }

        // Check daily limit (5 posts per day)
        const limitCheck = checkPostLimit(senderId);
        if (!limitCheck.allowed) {
            const resetTime = new Date();
            resetTime.setDate(resetTime.getDate() + 1);
            resetTime.setHours(0, 0, 0, 0);
            const hoursLeft = Math.ceil((resetTime - Date.now()) / (1000 * 60 * 60));
            
            return sendMessage(senderId, {
                text: `❌ 𝗗𝗔𝗜𝗟𝗬 𝗟𝗜𝗠𝗜𝗧 𝗥𝗘𝗔𝗖𝗛𝗘𝗗

━━━━━━━━━━━━━━━━━━━━━━━

⚠️ You have reached your daily post limit!

📊 𝗬𝗼𝘂𝗿 𝗦𝘁𝗮𝘁𝘀:
• Posts today: ${limitCheck.used}/5
• Time until reset: ${hoursLeft} hours

━━━━━━━━━━━━━━━━━━━━━━━

💡 Why 5 posts per day?
• Prevent spam
• Fair usage for all
• Quality content matters

━━━━━━━━━━━━━━━━━━━━━━━

🕐 Resets automatically at midnight!
Come back tomorrow for more posts.`
            }, pageAccessToken);
        }

        // Extract message text
        const messageText = args.join(" ").trim();
        
        if (!messageText || messageText.startsWith("❌") || messageText.startsWith("✅")) {
            console.log("🚫 Ignoring bot response message");
            return;
        }

        console.log(`📝 Processing post: "${messageText}"`);
        console.log(`📊 User ${senderId} has ${limitCheck.remaining}/5 posts remaining today`);

        // Extract media from replied message
        const repliedMedia = await extractRepliedMedia(event, pageAccessToken);

        try {
            let response;
            let postType = 'text';

            if (repliedMedia) {
                if (repliedMedia.type === 'video') {
                    response = await postVideo(PAGE_ID, messageText, repliedMedia, pageAccessToken);
                    postType = 'video';
                } else if (repliedMedia.type === 'photo' || repliedMedia.type === 'gif') {
                    response = await postPhoto(PAGE_ID, messageText, repliedMedia, pageAccessToken);
                    postType = repliedMedia.type === 'gif' ? 'gif' : 'photo';
                } else {
                    throw new Error(`Unsupported media type: ${repliedMedia.type}`);
                }
            } else {
                response = await postTextOnly(PAGE_ID, messageText, pageAccessToken);
                postType = 'text';
            }

            // Record successful post
            recordPost(senderId, messageText, response.data.post_id || response.data.id, postType);
            
            console.log("✅ Post successful!", response.data);

            // Send success message to sender
            const remainingPosts = limitCheck.remaining - 1;
            const successMessage = `✅ 𝗣𝗢𝗦𝗧 𝗦𝗨𝗖𝗖𝗘𝗦𝗦𝗙𝗨𝗟

━━━━━━━━━━━━━━━━━━━━━━━

📝 𝗠𝗲𝘀𝘀𝗮𝗴𝗲: "${messageText.slice(0, 150)}${messageText.length > 150 ? '...' : ''}"
${repliedMedia ? `📎 𝗠𝗲𝗱𝗶𝗮 𝗧𝘆𝗽𝗲: ${postType.toUpperCase()}\n` : ''}
🆔 𝗣𝗼𝘀𝘁 𝗜𝗗: ${response.data.post_id || response.data.id}

━━━━━━━━━━━━━━━━━━━━━━━

📊 𝗬𝗼𝘂𝗿 𝗗𝗮𝗶𝗹𝘆 𝗟𝗶𝗺𝗶𝘁:
• Used today: ${limitCheck.used + 1}/5
• Remaining: ${remainingPosts}
• Reset: Midnight (12:00 AM)

━━━━━━━━━━━━━━━━━━━━━━━

✅ Post published successfully to your page!`;

            await sendMessage(senderId, { text: successMessage }, pageAccessToken);

        } catch (error) {
            console.error("❌ Error posting:", error.response?.data || error.message);
            
            const errorMsg = error.response?.data?.error?.message || error.message || "Unknown error";
            const errorMessageText = `❌ 𝗣𝗢𝗦𝗧 𝗙𝗔𝗜𝗟𝗘𝗗

━━━━━━━━━━━━━━━━━━━━━━━

⚠️ 𝗘𝗿𝗿𝗼𝗿: ${errorMsg.slice(0, 200)}

━━━━━━━━━━━━━━━━━━━━━━━

💡 𝗧𝗶𝗽𝘀:
• Reply to a photo/video message
• Or just type a text message
• Videos may need direct upload

━━━━━━━━━━━━━━━━━━━━━━━

📊 Posts used today: ${limitCheck.used}/5 (this attempt didn't count)
⏰ Try again in a few minutes!`;

            await sendMessage(senderId, { text: errorMessageText }, pageAccessToken);
        }
    }
};
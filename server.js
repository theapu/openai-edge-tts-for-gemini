/*
 * Gemini TTS API Server
 *
 * This Node.js server provides an API endpoint that mimics the OpenAI TTS API structure,
 * allowing you to generate speech from text using Google's Gemini TTS model.
 * It now includes Bearer token authentication and uses FFmpeg to output MP3 or OGG audio.
 *
 * How to Run:
 * 1. Make sure you have Node.js installed (https://nodejs.org/).
 * 2. **IMPORTANT**: You must have FFmpeg installed on your system and accessible
 * from the command line. (https://ffmpeg.org/download.html)
 * 3. Save this code as `server.js`.
 * 4. Run the server from your terminal: `node server.js`
 * 5. The server will start on http://localhost:3000.
 *
 * How to Use (with cURL):
 * Open a new terminal and run the following command.
 * Replace `your-secret-api-key` with the key defined in the `API_KEY` constant below.
 * The generated audio will be saved to a file named `speech.mp3`.
 *
 * curl http://localhost:3000/v1/audio/speech \
 * -H "Authorization: Bearer your-secret-api-key" \
 * -H "Content-Type: application/json" \
 * -d '{
 * "input": "Hello from the Gemini TTS API!",
 * "voice": "Puck",
 * "response_format": "mp3"
 * }' \
 * --output speech.mp3
 *
 * You can change the "input" text and the "voice" to any of the supported voices.
 * To get OGG, WAV or raw PCM file, change "response_format" to "ogg", "wav" or "pcm" and update the output file extension.
 */

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// --- Configuration ---
const PORT = 3000;
// NOTE: The Gemini API key is now read from environment variables.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 

// --- Security Configuration ---
// IMPORTANT: This is now read from an environment variable for security.
const API_KEY = process.env.API_KEY || "your-secret-api-key"; 

// --- Retry Configuration ---
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 5;
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS, 10) || 2000;

// A list of valid voices to prevent arbitrary values from being sent to the API.
const VALID_VOICES = new Set([
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"
]);

/**
 * Main request handler for the HTTP server.
 * @param {http.IncomingMessage} req - The request object.
 * @param {http.ServerResponse} res - The response object.
 */
const requestHandler = (req, res) => {
    // Only allow POST requests to the specified endpoint
    if (req.url === '/v1/audio/speech' && req.method === 'POST') {

        // --- Authentication ---
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            sendError(res, 401, 'Authorization header is missing or invalid. It must be in the format "Bearer <API_KEY>".');
            return;
        }

        const providedKey = authHeader.split(' ')[1];
        if (providedKey !== API_KEY) {
            sendError(res, 401, 'Invalid API Key.');
            return;
        }

        // --- Process Request Body ---
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async() => {
            try {
                const { input, voice, response_format } = JSON.parse(body);

                // --- Input Validation ---
                if (!input || typeof input !== 'string') {
                    sendError(res, 400, 'Invalid or missing "input" field.');
                    return;
                }
                if (!voice || !VALID_VOICES.has(voice)) {
                    sendError(res, 400, `Invalid or missing "voice" field. Please use one of the supported voices.`);
                    return;
                }
                
                // Determine the desired output format, defaulting to mp3
                const format = ['wav', 'pcm', 'ogg'].includes(response_format) ? response_format : 'mp3';

                // --- Call Gemini API ---
                const audioData = await generateSpeechFromGemini(input, voice);

                // The Gemini API returns raw PCM data.
                const pcmData = Buffer.from(audioData.data, 'base64');

                const sampleRateMatch = audioData.mimeType.match(/rate=(\d+)/);
                if (!sampleRateMatch) {
                    throw new Error("Could not determine sample rate from API response.");
                }
                const sampleRate = parseInt(sampleRateMatch[1], 10);
                
                if (format === 'wav') {
                    // --- Create WAV buffer and send response ---
                    const wavBuffer = createWavBuffer(pcmData, sampleRate);
                    res.writeHead(200, {
                        'Content-Type': 'audio/wav',
                        'Content-Length': wavBuffer.length
                    });
                    res.end(wavBuffer);
                } else if (format === 'pcm') {
                    // --- Send raw PCM response ---
                    res.writeHead(200, {
                        'Content-Type': `audio/l16; rate=${sampleRate}; channels=1`,
                        'Content-Length': pcmData.length
                    });
                    res.end(pcmData);
                }
                else {
                    // --- Create a WAV buffer first, then convert to the target format ---
                    const wavBuffer = createWavBuffer(pcmData, sampleRate);
                    convertAndStream(wavBuffer, format, res);
                }

            } catch (error) {
                console.error('Server Error:', error);
                // Handle JSON parsing errors or other exceptions
                if (!res.headersSent) {
                    if (error instanceof SyntaxError) {
                        sendError(res, 400, 'Invalid JSON format.');
                    } else {
                        sendError(res, 500, error.message || 'An internal server error occurred.');
                    }
                }
            }
        });
    } else {
        // Handle requests to other endpoints or methods
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
};

/**
 * Calls the Gemini TTS API to generate speech, with a retry mechanism.
 * @param {string} text - The text to convert to speech.
 * @param {string} voice - The voice to use.
 * @returns {Promise<{data: string, mimeType: string}>} - The base64 encoded audio data and its mimeType.
 */
async function generateSpeechFromGemini(text, voice) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await new Promise((resolve, reject) => {
                const payloadObject = {
                    contents: [{ parts: [{ text }] }],
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: voice }
                            }
                        }
                    },
                    model: "gemini-2.5-flash-preview-tts"
                };

                const payloadBuffer = Buffer.from(JSON.stringify(payloadObject), 'utf8');

                const options = {
                    hostname: 'generativelanguage.googleapis.com',
                    path: `/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': payloadBuffer.length
                    }
                };

                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 400) {
                            return reject(new Error(`Gemini API Error: ${data}`));
                        }
                        try {
                            const result = JSON.parse(data);
                            
                            if (result.error) {
                                return reject(new Error(`Gemini API returned an error: ${result.error.message}`));
                            }

                            let part;
                            if (result && result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts && result.candidates[0].content.parts[0]) {
                                part = result.candidates[0].content.parts[0];
                            }

                            if (part && part.inlineData) {
                                resolve(part.inlineData);
                            } else {
                                if (result.candidates && result.candidates[0] && result.candidates[0].finishReason) {
                                    reject(new Error(`Gemini API finished with reason: ${result.candidates[0].finishReason}. No audio data generated.`));
                                } else {
                                    reject(new Error('Invalid response structure from Gemini API.'));
                                }
                            }
                        } catch (e) {
                            reject(new Error(`Failed to parse Gemini API response. Raw data: ${data}`));
                        }
                    });
                });

                req.on('error', (e) => reject(e));
                req.write(payloadBuffer);
                req.end();
            });
            return result; // If the promise resolves, return and exit the loop
        } catch (error) {
            lastError = error;
            // Check if it's a retryable error and not the last attempt
            const isRetryableError = error.message === 'Invalid response structure from Gemini API.' || 
                                     error.message.startsWith('Gemini API finished with reason: OTHER');

            if (isRetryableError && attempt < MAX_RETRIES) {
                console.log(`Attempt ${attempt} failed: ${error.message}. Retrying in ${RETRY_DELAY_MS}ms...`);
                await new Promise(res => setTimeout(res, RETRY_DELAY_MS)); // Wait before retrying
            } else {
                throw error; // For other errors or after the last attempt, re-throw immediately
            }
        }
    }
    // This part should ideally not be reached, but it's a fallback
    throw lastError;
}


/**
 * Creates a WAV file buffer from raw PCM data.
 * @param {Buffer} pcmData - The raw PCM audio data (16-bit signed).
 * @param {number} sampleRate - The sample rate of the audio.
 * @returns {Buffer} A Buffer object representing the complete WAV file.
 */
function createWavBuffer(pcmData, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const dataSize = pcmData.length;

    // Total buffer size is 44 bytes for the header + the size of the PCM data
    const buffer = Buffer.alloc(44 + dataSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4); // File size - 8
    buffer.write('WAVE', 8);

    // fmt chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Chunk size
    buffer.writeUInt16LE(1, 20); // Audio format (1 = PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28); // Byte rate
    buffer.writeUInt16LE(numChannels * bitsPerSample / 8, 32); // Block align
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Write PCM data
    pcmData.copy(buffer, 44);

    return buffer;
}


/**
 * Spawns an FFmpeg process to convert a WAV buffer to the target format and streams it.
 * @param {Buffer} wavBuffer - The WAV audio data buffer.
 * @param {string} format - The target audio format ('ogg' or 'mp3').
 * @param {http.ServerResponse} res - The HTTP response object to stream to.
 */
function convertAndStream(wavBuffer, format, res) {
    let ffmpegArgs;
    let contentType;

    if (format === 'ogg') {
        contentType = 'audio/ogg';
        ffmpegArgs = [
            '-i', 'pipe:0',          // Input source: stdin (which will be the WAV buffer)
            '-c:a', 'libopus',       // Output codec: Opus
            '-f', 'ogg',             // Output format: ogg
            '-b:a', '64k',           // Output bitrate for Opus (64k is good for speech)
            'pipe:1'                 // Output destination: stdout
        ];
    } else { // Default to mp3
        contentType = 'audio/mpeg';
        ffmpegArgs = [
            '-i', 'pipe:0',          // Input source: stdin (which will be the WAV buffer)
            '-f', 'mp3',             // Output format: mp3
            '-b:a', '128k',          // Output bitrate: 128 kbps
            'pipe:1'                 // Output destination: stdout
        ];
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    // Set response header for the target audio format
    res.writeHead(200, { 'Content-Type': contentType });

    // Pipe the converted output from FFmpeg directly to the HTTP response
    ffmpeg.stdout.pipe(res);

    // Handle FFmpeg errors
    ffmpeg.stderr.on('data', (data) => {
        // Log FFmpeg errors for debugging, but don't send to client as the response has started
        console.error(`FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('error', (err) => {
        console.error('Failed to start FFmpeg process.', err);
        if (!res.headersSent) {
            sendError(res, 500, 'Failed to start audio conversion process. Is FFmpeg installed?');
        }
    });

    // Write the WAV buffer to FFmpeg's stdin and end the stream.
    ffmpeg.stdin.end(wavBuffer);
}

/**
 * Sends a standardized JSON error response.
 * @param {http.ServerResponse} res - The response object.
 * @param {number} statusCode - The HTTP status code.
 * @param {string} message - The error message.
 */
function sendError(res, statusCode, message) {
    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message } }));
    }
}

// --- Create and Start Server ---
const server = http.createServer(requestHandler);

server.listen(PORT, () => {
    console.log(`🔊 Gemini TTS API server running on http://localhost:${PORT}`);
    console.log('Endpoint: POST /v1/audio/speech');
    console.log('Awaiting requests...');
});


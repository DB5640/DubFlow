const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios'); // Added for RapidAPI requests
const gTTS = require('gtts');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { promisify } = require('util');

// Import enhanced transcript fetching
const {
  fetchTranscript,
  validateTranscriptAvailability,
} = require('./transcript-fetcher');

const app = express();
const PORT = process.env.PORT || 3001;
const execAsync = promisify(exec);

// Ruta a yt-dlp.exe (en la raíz del proyecto)
const YT_DLP_PATH = path.join(__dirname, '..', 'yt-dlp.exe');

// Configure FFmpeg/FFprobe paths for fluent-ffmpeg
// Use ffmpeg-static which includes full lavfi support
const ffmpegStatic = require('ffmpeg-static');
const FFMPEG_PATH = ffmpegStatic; // This has full ffmpeg with lavfi support
const FFPROBE_PATH = path.join(
  path.dirname(ffmpegStatic),
  'ffprobe' + (process.platform === 'win32' ? '.exe' : ''),
);

if (FFMPEG_PATH && fsSync.existsSync(FFMPEG_PATH)) {
  try {
    ffmpeg.setFfmpegPath(FFMPEG_PATH);
    console.log(
      '✅ fluent-ffmpeg configured to use ffmpeg-static:',
      FFMPEG_PATH,
    );

    // Try to set ffprobe if it exists
    if (fsSync.existsSync(FFPROBE_PATH)) {
      ffmpeg.setFfprobePath(FFPROBE_PATH);
    }
  } catch (e) {
    console.warn('⚠️ Could not set ffmpeg path for fluent-ffmpeg:', e.message);
  }
} else {
  console.warn(
    '⚠️ ffmpeg-static not found; fluent-ffmpeg will use system ffmpeg if available',
  );
}

// Middleware
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Load environment variables
require('dotenv').config();

// Optionally append a custom yt-dlp dir from .env to PATH so child
// processes can find yt-dlp if it's not globally installed.
if (process.env.YT_DLP_DIR) {
  process.env.PATH = `${process.env.PATH}${path.delimiter}${process.env.YT_DLP_DIR}`;
  console.log('✅ Appended YT_DLP_DIR to PATH:', process.env.YT_DLP_DIR);
}

// RapidAPI Configuration
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST;
const RAPIDAPI_URL =
  'https://' + process.env.RAPIDAPI_HOST + process.env.RAPIDAPI_URL_PATH;

// Initialize RapidAPI Translator
let translatorAvailable = false;
if (RAPIDAPI_KEY) {
  translatorAvailable = true;
  console.log(
    '✅ RapidAPI Translator initialized',
    `🌐 api url: ${RAPIDAPI_URL}`,
  );
} else {
  console.error(
    '❌ RapidAPI key not found. Please set RAPIDAPI_KEY in your environment variables',
  );
}

// Ensure downloads directory exists
const ensureDownloadsDir = async () => {
  const downloadsDir = path.join(__dirname, 'downloads');
  try {
    await fs.access(downloadsDir);
  } catch {
    await fs.mkdir(downloadsDir, { recursive: true });
  }
};

// Extract YouTube video ID from URL
const extractVideoId = (url) => {
  const regex =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
};

// Language code mapping for RapidAPI Google Translator
const getRapidApiLanguageCode = (language) => {
  const languageMap = {
    spanish: 'es',
    french: 'fr',
    german: 'de',
    italian: 'it',
    portuguese: 'pt',
    russian: 'ru',
    japanese: 'ja',
    korean: 'ko',
    chinese: 'zh-CN',
    'chinese simplified': 'zh-CN',
    'chinese traditional': 'zh-TW',
    hindi: 'hi',
    arabic: 'ar',
    dutch: 'nl',
    polish: 'pl',
    turkish: 'tr',
    swedish: 'sv',
    norwegian: 'no',
    danish: 'da',
    finnish: 'fi',
    greek: 'el',
    hebrew: 'he',
    thai: 'th',
    vietnamese: 'vi',
    indonesian: 'id',
    malay: 'ms',
    tagalog: 'tl',
    urdu: 'ur',
    bengali: 'bn',
    tamil: 'ta',
    telugu: 'te',
    marathi: 'mr',
    gujarati: 'gu',
    kannada: 'kn',
    malayalam: 'ml',
    punjabi: 'pa',
  };

  return languageMap[language.toLowerCase()] || language.toLowerCase();
};

// Translate text using RapidAPI Google Translator
const translateText = async (text, targetLanguage) => {
  try {
    if (!translatorAvailable) {
      throw new Error(
        'RapidAPI Translator not initialized. Please check your API key.',
      );
    }

    // Skip translation if text is too short or empty
    if (!text || text.trim().length < 2) {
      return text;
    }

    const targetLangCode = getRapidApiLanguageCode(targetLanguage);
    const options = {
      method: 'POST',
      url: RAPIDAPI_URL,
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST,
        'Content-Type': 'application/json',
      },
      data: {
        q: text.trim(),
        source: 'en', // Auto-detect source language
        target: targetLangCode,
        format: 'text',
      },
    };

    const response = await axios.request(options);

    // Extract translated text from RapidAPI response format
    if (
      response.data &&
      response.data.data &&
      response.data.data.translations &&
      response.data.data.translations.length > 0
    ) {
      const translatedText = response.data.data.translations[0].translatedText;
      return translatedText || text;
    } else {
      console.warn(
        'Unexpected response format from RapidAPI, using original text',
      );
      return text;
    }
  } catch (error) {
    console.error('RapidAPI Translation error:', error.message);

    // More specific error handling
    if (error.response) {
      const status = error.response.status;
      if (status === 401) {
        throw new Error('Invalid RapidAPI key. Please check your credentials.');
      } else if (status === 429) {
        throw new Error(
          'RapidAPI rate limit exceeded. Please check your subscription plan.',
        );
      } else if (status === 403) {
        throw new Error(
          'RapidAPI access forbidden. Please check your subscription and permissions.',
        );
      }
    }

    return text; // Return original if translation fails
  }
};

// Batch translate for better efficiency with configurable delays
const batchTranslateText = async (
  textArray,
  targetLanguage,
  batchSize = 10,
) => {
  try {
    if (!translatorAvailable) {
      throw new Error(
        'RapidAPI Translator not initialized. Please check your API key.',
      );
    }

    const targetLangCode = getRapidApiLanguageCode(targetLanguage);
    const results = [];

    // Process in smaller batches for RapidAPI (rate limiting is more strict)
    for (let i = 0; i < textArray.length; i += batchSize) {
      const batch = textArray.slice(i, i + batchSize);

      console.log(
        `🌐 Processing translation batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(textArray.length / batchSize)}`,
      );

      // Process each item in the batch individually for RapidAPI
      const batchResults = [];
      for (const item of batch) {
        if (!item.text || item.text.trim().length < 2) {
          batchResults.push({ ...item, translatedText: item.text });
          continue;
        }

        try {
          const options = {
            method: 'POST',
            url: RAPIDAPI_URL,
            headers: {
              'x-rapidapi-key': RAPIDAPI_KEY,
              'x-rapidapi-host': RAPIDAPI_HOST,
              'Content-Type': 'application/json',
            },
            data: {
              q: item.text.trim(),
              source: 'auto',
              target: targetLangCode,
              format: 'text',
            },
          };

          const response = await axios.request(options);

          let translatedText = item.text;
          if (
            response.data &&
            response.data.data &&
            response.data.data.translations &&
            response.data.data.translations.length > 0
          ) {
            translatedText =
              response.data.data.translations[0].translatedText || item.text;
          }

          batchResults.push({ ...item, translatedText });

          // Add small delay between individual requests to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (itemError) {
          console.error(
            `Translation failed for item: "${item.text.substring(0, 50)}..."`,
            itemError.message,
          );
          batchResults.push({ ...item, translatedText: item.text });

          // Add longer delay after errors
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      results.push(...batchResults);

      // Add delay between batches to avoid rate limiting
      if (i + batchSize < textArray.length) {
        const delayTime = Math.random() * 2000 + 3000; // Random delay between 3-5 seconds
        console.log(
          `⏳ Waiting ${Math.round(delayTime / 1000)}s before next batch to avoid rate limiting...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayTime));
      }
    }

    return results;
  } catch (error) {
    console.error('Batch translation error:', error.message);
    // Return original texts as fallback
    return textArray.map((item) => ({ ...item, translatedText: item.text }));
  }
};

// Generate audio using gTTS
const generateAudio = async (text, language, outputPath) => {
  return new Promise((resolve, reject) => {
    // Skip empty or very short text
    if (!text || text.trim().length < 2) {
      return reject(new Error('Text too short for TTS'));
    }

    // Map common language names to gTTS language codes
    const languageMap = {
      spanish: 'es',
      french: 'fr',
      german: 'de',
      italian: 'it',
      portuguese: 'pt',
      russian: 'ru',
      japanese: 'ja',
      korean: 'ko',
      chinese: 'zh',
      hindi: 'hi',
      arabic: 'ar',
      dutch: 'nl',
      polish: 'pl',
      turkish: 'tr',
      swedish: 'sv',
      norwegian: 'no',
      danish: 'da',
      finnish: 'fi',
      greek: 'el',
      hebrew: 'he',
      thai: 'th',
      vietnamese: 'vi',
      indonesian: 'id',
      malay: 'ms',
      tagalog: 'tl',
      urdu: 'ur',
      bengali: 'bn',
      tamil: 'ta',
      telugu: 'te',
      marathi: 'mr',
      gujarati: 'gu',
      kannada: 'kn',
      malayalam: 'ml',
      punjabi: 'pa',
    };

    const langCode = languageMap[language.toLowerCase()] || 'en';

    try {
      const gtts = new gTTS(text.trim(), langCode);

      gtts.save(outputPath, (err) => {
        if (err) {
          console.error('gTTS error:', err);
          reject(err);
        } else {
          resolve(outputPath);
        }
      });
    } catch (error) {
      console.error('gTTS creation error:', error);
      reject(error);
    }
  });
};

// Create silence audio file
const createSilence = async (duration, outputPath) => {
  return new Promise((resolve, reject) => {
    // Ensure minimum duration and maximum reasonable duration
    const safeDuration = Math.max(0.1, Math.min(duration, 3600)); // Between 0.1s and 1 hour

    ffmpeg()
      .input('anullsrc=channel_layout=stereo:sample_rate=22050')
      .inputFormat('lavfi')
      .duration(safeDuration)
      .audioCodec('pcm_s16le') // Use compatible audio codec
      .output(outputPath)
      .on('end', () => {
        console.log(`Created silence: ${safeDuration}s -> ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('Silence creation error:', err);
        reject(err);
      })
      .run();
  });
};

// Concatenate audio files
const concatenateAudio = async (audioFiles, outputPath) => {
  return new Promise((resolve, reject) => {
    // Check if we have any audio files
    if (!audioFiles || audioFiles.length === 0) {
      return reject(new Error('No audio files to concatenate'));
    }

    // If only one file, just copy it
    if (audioFiles.length === 1) {
      const command = ffmpeg(audioFiles[0])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .run();
      return;
    }

    const command = ffmpeg();

    // Add all input files
    audioFiles.forEach((file) => {
      command.input(file);
    });

    // Create filter complex for concatenation
    const filterComplex =
      audioFiles.map((_, index) => `[${index}:0]`).join('') +
      `concat=n=${audioFiles.length}:v=0:a=1[out]`;

    command
      .complexFilter(filterComplex)
      .outputOptions(['-map', '[out]'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error('FFmpeg concatenation error:', err);
        reject(err);
      })
      .run();
  });
};

// Download video using yt-dlp (more reliable than ytdl-core)
const downloadVideoOnly = async (videoId, outputPath) => {
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Use yt-dlp which is more reliable than ytdl-core
    const command = `"${YT_DLP_PATH}" -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "${videoUrl}"`;

    console.log('Executing:', command);
    const { stdout, stderr } = await execAsync(command);

    if (stderr && !stderr.includes('WARNING')) {
      console.error('yt-dlp stderr:', stderr);
    }

    // Check if file was created
    try {
      await fs.access(outputPath);
      return outputPath;
    } catch {
      throw new Error('Video file was not created successfully');
    }
  } catch (error) {
    console.error('yt-dlp error:', error);

    // Fallback: try with different format
    try {
      const fallbackCommand = `"${YT_DLP_PATH}" -f "best[ext=mp4]" --no-audio -o "${outputPath}" "https://www.youtube.com/watch?v=${videoId}"`;
      console.log('Trying fallback:', fallbackCommand);
      await execAsync(fallbackCommand);

      // Check if file was created
      await fs.access(outputPath);
      return outputPath;
    } catch (fallbackError) {
      throw new Error(
        `Failed to download video: ${error.message}. Fallback also failed: ${fallbackError.message}`,
      );
    }
  }
};

// Alternative: Download video using youtube-dl
const downloadVideoWithYoutubeDl = async (videoId, outputPath) => {
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const command = `youtube-dl -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "${videoUrl}"`;

    console.log('Executing youtube-dl:', command);
    await execAsync(command);

    // Check if file was created
    await fs.access(outputPath);
    return outputPath;
  } catch (error) {
    throw new Error(`youtube-dl failed: ${error.message}`);
  }
};

// Merge video and audio
const mergeVideoAudio = async (videoPath, audioPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-strict',
        'experimental',
        '-shortest',
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
};

// New endpoint to check transcript availability
app.post('/api/check-transcript', async (req, res) => {
  const { videoUrl } = req.body;

  try {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log(`🔍 Checking transcript for video: ${videoId}`);
    const result = await validateTranscriptAvailability(videoId);

    res.json(result);
  } catch (error) {
    console.error('Error checking transcript:', error);
    res.status(500).json({
      error: 'Failed to check transcript availability',
      details: error.message,
    });
  }
});

// Main dubbing endpoint with RapidAPI Translator
app.post('/api/dub-video', async (req, res) => {
  const { videoUrl, targetLanguage } = req.body;
  const jobId = uuidv4();

  try {
    await ensureDownloadsDir();

    console.log('🎬 Starting dubbing process...');

    // Step 1: Extract video ID
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log('📹 Video ID extracted:', videoId);

    // Step 2: Enhanced transcript fetching with retry logic
    console.log('📝 Fetching transcript with enhanced reliability...');

    let transcript;
    try {
      transcript = await fetchTranscript(videoId);
    } catch (transcriptError) {
      console.error(
        '❌ Enhanced transcript fetching failed:',
        transcriptError.message,
      );

      // Return detailed error with suggestions
      return res.status(400).json({
        error: 'Transcript fetching failed',
        details: transcriptError.message,
        suggestions: [
          'Try a different video with manual captions',
          'Check if the video has auto-generated captions enabled',
          'Ensure the video is publicly accessible',
          'Try again in a few minutes - YouTube may be rate limiting',
        ],
      });
    }

    if (!transcript || transcript.length === 0) {
      return res.status(400).json({
        error: 'Empty transcript',
        details: 'The transcript was fetched but contains no content',
        suggestions: ['Try a different video with spoken content and captions'],
      });
    }

    console.log(
      `✅ Successfully fetched ${transcript.length} transcript segments`,
    );

    // Log transcript sample for debugging
    if (transcript.length > 0) {
      console.log(
        'Transcript preview:',
        transcript
          .slice(0, 3)
          .map((t) => t.text)
          .join(' '),
      );
    }

    // Step 3: Batch translate transcript using RapidAPI
    console.log(
      '🌐 Translating transcript using RapidAPI Google Translator...',
    );

    let translatedTranscript;
    let translationErrors = 0;

    try {
      translatedTranscript = await batchTranslateText(
        transcript,
        targetLanguage,
      );

      // Count items that weren't translated (same as original)
      translationErrors = translatedTranscript.filter(
        (item) =>
          item.text === item.translatedText && item.text.trim().length >= 2,
      ).length;

      console.log(
        `✅ Translation completed. ${translationErrors} items unchanged.`,
      );
    } catch (translateError) {
      console.error('❌ Batch translation failed:', translateError.message);

      // Fallback to original texts
      translatedTranscript = transcript.map((item) => ({
        ...item,
        translatedText: item.text,
      }));
      translationErrors = transcript.length;
    }

    if (translationErrors > 0) {
      console.warn(
        `⚠️ ${translationErrors} translation issues occurred. Some text may be in original language.`,
      );
    }

    // Step 4: Generate audio clips
    console.log('🔊 Generating audio clips...');
    const audioClips = [];
    const tempDir = path.join(__dirname, 'downloads', jobId);
    await fs.mkdir(tempDir, { recursive: true });

    let successfulClips = 0;

    for (let i = 0; i < translatedTranscript.length; i++) {
      const item = translatedTranscript[i];

      // Skip very short or empty text
      if (!item.translatedText || item.translatedText.trim().length < 2) {
        console.log(`Skipping empty/short text at line ${i}`);
        continue;
      }

      const audioPath = path.join(tempDir, `line_${i}.wav`);

      try {
        await generateAudio(item.translatedText, targetLanguage, audioPath);
        audioClips.push({
          path: audioPath,
          start: item.start,
          duration: item.duration,
          index: i,
        });
        successfulClips++;
        console.log(
          `Generated audio ${successfulClips}/${translatedTranscript.length}`,
        );
      } catch (audioError) {
        console.error(
          `Error generating audio for line ${i}:`,
          audioError.message,
        );
        // Create a short silence if TTS fails
        try {
          const silenceDuration = Math.max(item.duration, 0.5); // At least 0.5 seconds
          const silencePath = path.join(tempDir, `silence_${i}.wav`);
          await createSilence(silenceDuration, silencePath);
          audioClips.push({
            path: silencePath,
            start: item.start,
            duration: silenceDuration,
            index: i,
          });
          successfulClips++;
        } catch (silenceError) {
          console.error(
            `Failed to create silence for line ${i}:`,
            silenceError.message,
          );
        }
      }
    }

    if (audioClips.length === 0) {
      throw new Error(
        'No audio clips were generated successfully. Please check the transcript and try again.',
      );
    }

    console.log(`Successfully generated ${audioClips.length} audio clips`);

    // Step 5: Create aligned audio track
    console.log('⏰ Aligning audio with timestamps...');
    const alignedAudioFiles = [];

    // Sort clips by start time
    audioClips.sort((a, b) => a.start - b.start);

    let currentTime = 0;

    for (let i = 0; i < audioClips.length; i++) {
      const clip = audioClips[i];

      // Add silence if there's a gap
      if (clip.start > currentTime) {
        const silenceDuration = clip.start - currentTime;
        if (silenceDuration > 0.1) {
          // Only add silence if gap is meaningful
          const silencePath = path.join(tempDir, `gap_${i}_${Date.now()}.wav`);
          try {
            await createSilence(silenceDuration, silencePath);
            alignedAudioFiles.push(silencePath);
          } catch (silenceError) {
            console.error(
              `Failed to create gap silence:`,
              silenceError.message,
            );
          }
        }
      }

      alignedAudioFiles.push(clip.path);
      currentTime = clip.start + clip.duration;
    }

    if (alignedAudioFiles.length === 0) {
      throw new Error(
        'No aligned audio files were created. Audio generation failed.',
      );
    }

    // Step 6: Concatenate all audio
    console.log('🔗 Concatenating audio clips...');
    const finalAudioPath = path.join(tempDir, 'final_audio.wav');

    try {
      await concatenateAudio(alignedAudioFiles, finalAudioPath);
    } catch (concatError) {
      console.error(
        'Concatenation failed, trying alternative method:',
        concatError.message,
      );

      // Alternative: Create a single silence file if concatenation fails
      const totalDuration = Math.max(
        ...audioClips.map((clip) => clip.start + clip.duration),
      );
      await createSilence(totalDuration || 10, finalAudioPath);
    }

    // Step 7: Download video
    console.log('📥 Downloading video...');
    const videoPath = path.join(tempDir, 'video.mp4');

    try {
      await downloadVideoOnly(videoId, videoPath);
    } catch (error) {
      console.error('yt-dlp failed, trying youtube-dl:', error.message);
      try {
        await downloadVideoWithYoutubeDl(videoId, videoPath);
      } catch (fallbackError) {
        throw new Error(
          `Both yt-dlp and youtube-dl failed. Please ensure one of them is installed: ${error.message}`,
        );
      }
    }

    // Step 8: Merge video and audio
    console.log('🎭 Merging video and audio...');
    const finalVideoPath = path.join(tempDir, 'dubbed_video.mp4');
    await mergeVideoAudio(videoPath, finalAudioPath, finalVideoPath);

    console.log('✅ Dubbing completed successfully!');

    res.json({
      success: true,
      jobId,
      downloadUrl: `/downloads/${jobId}/dubbed_video.mp4`,
      message: 'Video dubbed successfully using RapidAPI Google Translator!',
      transcriptSegments: transcript.length,
      translationErrors: translationErrors,
    });
  } catch (error) {
    console.error('❌ Error during dubbing process:', error);
    res.status(500).json({
      error: 'Failed to dub video',
      details: error.message,
    });
  }
});

// Get job status endpoint
app.get('/api/job-status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const jobDir = path.join(__dirname, 'downloads', jobId);
  const finalVideo = path.join(jobDir, 'dubbed_video.mp4');

  try {
    await fs.access(finalVideo);
    res.json({
      status: 'completed',
      downloadUrl: `/downloads/${jobId}/dubbed_video.mp4`,
    });
  } catch {
    res.json({
      status: 'processing',
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'YouTube Dubbing API is running',
    translateStatus: translatorAvailable
      ? 'RapidAPI Connected'
      : 'Not Connected',
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    details: error.message,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 YouTube Dubbing API server running on port ${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
  console.log(
    `🔑 RapidAPI Translator Status: ${translatorAvailable ? '✅ Connected' : '❌ Not Connected'}`,
  );
});

module.exports = app;

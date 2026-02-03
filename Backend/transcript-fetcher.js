// Enhanced transcript fetching with multiple retry attempts and fallback methods
const { YoutubeTranscript } = require('youtube-transcript');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const execAsync = promisify(exec);

// Ruta a yt-dlp.exe (asumiendo que está en la raíz del proyecto)
const YT_DLP_PATH = path.join(__dirname, '..', 'yt-dlp.exe');

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  backoffFactor: 2,
};

// Sleep utility function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calculate retry delay with exponential backoff
const calculateRetryDelay = (attempt) => {
  const delay =
    RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffFactor, attempt);
  return Math.min(delay, RETRY_CONFIG.maxDelay);
};

// Decodificar entidades HTML
const decodeHtmlEntities = (text) => {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
};

// Fallback usando yt-dlp para obtener subtítulos
const fetchTranscriptWithYtDlp = async (videoId) => {
  console.log('🔄 Trying yt-dlp fallback for transcript...');

  const tempDir = path.join(__dirname, 'downloads', 'temp_subs');
  const outputTemplate = path.join(tempDir, videoId);

  try {
    // Crear directorio temporal
    await fs.mkdir(tempDir, { recursive: true });

    // Descargar subtítulos en formato srv1 (XML similar al que usa youtube-transcript)
    // Intentar múltiples idiomas: en, en-US, en-GB como prioridad
    const command = `"${YT_DLP_PATH}" --write-sub --write-auto-sub --sub-lang "en,en-US,en-GB" --sub-format srv1 --skip-download -o "${outputTemplate}" "https://www.youtube.com/watch?v=${videoId}"`;

    console.log('Executing yt-dlp:', command);

    try {
      await execAsync(command, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    } catch (execError) {
      console.log('yt-dlp execution finished with warnings (this is normal)');
    }

    // Buscar archivo de subtítulos generado
    const files = await fs.readdir(tempDir);
    const subFile = files.find(
      (f) =>
        f.startsWith(videoId) &&
        (f.endsWith('.srv1') ||
          f.endsWith('.en.srv1') ||
          f.endsWith('.en-US.srv1') ||
          f.endsWith('.en-GB.srv1')),
    );

    if (!subFile) {
      console.log('No .srv1 file found, trying alternative formats...');

      // Intentar con formato json3
      const commandJson = `"${YT_DLP_PATH}" --write-sub --write-auto-sub --sub-lang "en,en-US,en-GB" --sub-format json3 --skip-download -o "${outputTemplate}" "https://www.youtube.com/watch?v=${videoId}"`;

      try {
        await execAsync(commandJson, {
          timeout: 60000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (execError) {
        console.log('yt-dlp json3 execution finished');
      }

      const filesJson = await fs.readdir(tempDir);
      const subFileJson = filesJson.find(
        (f) => f.startsWith(videoId) && f.endsWith('.json3'),
      );

      if (subFileJson) {
        return await parseJson3Format(path.join(tempDir, subFileJson), tempDir);
      }

      throw new Error('No subtitle file was downloaded by yt-dlp');
    }

    const subPath = path.join(tempDir, subFile);
    const subContent = await fs.readFile(subPath, 'utf-8');

    // Parsear XML srv1 (formato similar al de youtube-transcript)
    const RE_XML_TRANSCRIPT =
      /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    const results = [...subContent.matchAll(RE_XML_TRANSCRIPT)];

    if (results.length === 0) {
      throw new Error('Could not parse srv1 format - no <text> elements found');
    }

    // Limpiar archivo temporal
    try {
      await fs.unlink(subPath);
    } catch (e) {
      // Ignorar error al limpiar
    }

    console.log(
      `✅ yt-dlp fallback successful! Got ${results.length} segments`,
    );

    return results.map((result) => ({
      text: decodeHtmlEntities(result[3]),
      start: parseFloat(result[1]),
      duration: parseFloat(result[2]),
    }));
  } catch (error) {
    console.error('yt-dlp fallback failed:', error.message);

    // Limpiar directorio temporal
    try {
      const files = await fs.readdir(tempDir);
      await Promise.all(
        files.map((f) => fs.unlink(path.join(tempDir, f)).catch(() => {})),
      );
    } catch (e) {
      // Ignorar errores de limpieza
    }

    throw error;
  }
};

// Parsear formato json3 de yt-dlp
const parseJson3Format = async (jsonPath, tempDir) => {
  try {
    const jsonContent = await fs.readFile(jsonPath, 'utf-8');
    const jsonData = JSON.parse(jsonContent);

    // json3 contiene un array de eventos con start/dur/segs
    const results = [];

    if (jsonData.events) {
      for (const event of jsonData.events) {
        if (event.segs) {
          const text = event.segs.map((seg) => seg.utf8 || '').join('');
          if (text.trim()) {
            results.push({
              text: text.trim(),
              start: (event.tStartMs || 0) / 1000,
              duration: (event.dDurationMs || 0) / 1000,
            });
          }
        }
      }
    }

    // Limpiar archivo temporal
    try {
      await fs.unlink(jsonPath);
    } catch (e) {
      // Ignorar error al limpiar
    }

    if (results.length === 0) {
      throw new Error('json3 format contained no valid segments');
    }

    console.log(
      `✅ yt-dlp json3 fallback successful! Got ${results.length} segments`,
    );
    return results;
  } catch (error) {
    console.error('json3 parsing failed:', error.message);
    throw error;
  }
};

// Enhanced transcript fetching with multiple strategies
const fetchTranscriptWithRetry = async (
  videoId,
  maxRetries = RETRY_CONFIG.maxRetries,
) => {
  console.log(`📝 Attempting to fetch transcript for video: ${videoId}`);

  let lastError = null;

  // Strategy 1: Try different language codes
  const languageCodes = ['en', 'en-US', 'en-GB', null]; // null means auto-detect

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    console.log(`Attempt ${attempt + 1}/${maxRetries}`);

    // Try different language strategies on each attempt
    for (const langCode of languageCodes) {
      try {
        console.log(
          `Trying ${langCode ? `language: ${langCode}` : 'auto-detect language'}`,
        );

        const config = langCode ? { lang: langCode } : {};
        const transcript = await YoutubeTranscript.fetchTranscript(
          videoId,
          config,
        );

        if (transcript && transcript.length > 0) {
          console.log(
            `✅ Successfully fetched transcript with ${transcript.length} segments`,
          );
          return transcript.map((item) => ({
            text: item.text,
            start: parseFloat(item.offset) / 1000,
            duration: parseFloat(item.duration) / 1000,
          }));
        }
      } catch (error) {
        lastError = error;
        console.log(
          `Failed with ${langCode || 'auto-detect'}: ${error.message}`,
        );

        // If it's a "No transcript found" error, try the next language
        if (
          error.message.includes('transcript') ||
          error.message.includes('captions')
        ) {
          continue;
        }

        // For other errors, wait before retrying
        break;
      }
    }

    // Wait before next attempt (except on last attempt)
    if (attempt < maxRetries - 1) {
      const delay = calculateRetryDelay(attempt);
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await sleep(delay);
    }
  }

  // If all attempts failed, try alternative methods
  console.log('🔄 Trying alternative transcript fetching methods...');

  try {
    // Alternative method 1: Try with different video URL formats
    const alternativeFormats = [
      `https://www.youtube.com/watch?v=${videoId}`,
      `https://youtu.be/${videoId}`,
      videoId, // Just the ID
    ];

    for (const format of alternativeFormats) {
      try {
        console.log(`Trying alternative format: ${format}`);
        const transcript = await YoutubeTranscript.fetchTranscript(format);

        if (transcript && transcript.length > 0) {
          console.log(`✅ Success with alternative format!`);
          return transcript.map((item) => ({
            text: item.text,
            start: parseFloat(item.offset) / 1000,
            duration: parseFloat(item.duration) / 1000,
          }));
        }
      } catch (altError) {
        console.log(`Alternative format failed: ${altError.message}`);
      }
    }

    // Alternative method 2: Try manual transcript extraction
    const manualTranscript = await tryManualTranscriptExtraction(videoId);
    if (manualTranscript) {
      return manualTranscript;
    }
  } catch (altError) {
    console.error('Alternative methods failed:', altError.message);
  }

  // Alternative method 3: Try yt-dlp fallback
  console.log('🔧 Attempting yt-dlp fallback as last resort...');
  try {
    const ytDlpTranscript = await fetchTranscriptWithYtDlp(videoId);
    if (ytDlpTranscript && ytDlpTranscript.length > 0) {
      return ytDlpTranscript;
    }
  } catch (ytDlpError) {
    console.error('yt-dlp fallback also failed:', ytDlpError.message);
    lastError = ytDlpError;
  }

  // If everything failed, throw a comprehensive error
  throw new Error(
    `Failed to fetch transcript after ${maxRetries} attempts and all fallback methods. ` +
      `Last error: ${lastError?.message || 'Unknown error'}. ` +
      `This video may not have captions available, or the captions may be restricted. ` +
      `Please try with a different video that has manual captions.`,
  );
};

// Manual transcript extraction as fallback
const tryManualTranscriptExtraction = async (videoId) => {
  try {
    console.log('🔧 Attempting manual transcript extraction...');

    // This is a more direct approach using youtube-transcript's internal methods
    const { YoutubeTranscript } = require('youtube-transcript');

    // Try to get available transcript languages first
    const availableTranscripts =
      await YoutubeTranscript.listTranscripts(videoId);
    console.log('Available transcripts:', availableTranscripts);

    if (availableTranscripts && availableTranscripts.length > 0) {
      // Try the first available transcript
      const firstTranscript = availableTranscripts[0];
      const transcript = await firstTranscript.fetch();

      if (transcript && transcript.length > 0) {
        console.log('✅ Manual extraction successful!');
        return transcript.map((item) => ({
          text: item.text,
          start: parseFloat(item.start || item.offset) / 1000,
          duration: parseFloat(item.dur || item.duration) / 1000,
        }));
      }
    }

    return null;
  } catch (error) {
    console.log('Manual extraction failed:', error.message);
    return null;
  }
};

// Updated main transcript fetching function
const fetchTranscript = async (videoId) => {
  try {
    // Validate video ID format
    if (!videoId || typeof videoId !== 'string' || videoId.length !== 11) {
      throw new Error('Invalid YouTube video ID format');
    }

    return await fetchTranscriptWithRetry(videoId);
  } catch (error) {
    console.error('❌ Transcript fetching failed:', error.message);

    // Provide helpful error messages based on error type
    if (error.message.includes('Private video')) {
      throw new Error(
        'This video is private and its transcript cannot be accessed.',
      );
    } else if (error.message.includes('Video unavailable')) {
      throw new Error('This video is unavailable or has been removed.');
    } else if (error.message.includes('Age restricted')) {
      throw new Error(
        'This video is age-restricted and its transcript cannot be accessed.',
      );
    } else if (
      error.message.includes('transcript') ||
      error.message.includes('captions')
    ) {
      throw new Error(
        'No transcript/captions found for this video. ' +
          'Please ensure the video has either:\n' +
          '• Manual captions/subtitles\n' +
          '• Auto-generated captions enabled\n' +
          '• Public accessibility settings',
      );
    } else {
      throw error;
    }
  }
};

// Test function to validate transcript availability
const validateTranscriptAvailability = async (videoId) => {
  try {
    console.log(`🔍 Checking transcript availability for: ${videoId}`);

    const transcript = await fetchTranscript(videoId);

    return {
      available: true,
      segmentCount: transcript.length,
      totalDuration: Math.max(...transcript.map((t) => t.start + t.duration)),
      preview: transcript
        .slice(0, 3)
        .map((t) => t.text)
        .join(' '),
    };
  } catch (error) {
    return {
      available: false,
      error: error.message,
    };
  }
};

// Export the enhanced functions
module.exports = {
  fetchTranscript,
  fetchTranscriptWithRetry,
  validateTranscriptAvailability,
  RETRY_CONFIG,
};
